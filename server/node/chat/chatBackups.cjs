'use strict';

/*
 * Chat backup frame format (v1)
 * --------------------------------
 * Each .frame is independently decompressible and contains one exact chat-row
 * pre-image. The fixed prefix is:
 *   8 bytes  magic "PRCHATF1"
 *   4 bytes  little-endian JSON header length
 *   8 bytes  little-endian gzip payload length
 * It is followed by the bounded UTF-8 JSON header and one gzip member. The
 * header carries the raw length/SHA-256, media type, and version metadata. A
 * future full-backup chats/ entry can therefore use the frame bytes directly;
 * the outer archive entry supplies only row identity and framing.
 *
 * Legacy pocketrisu-chat-backup-bundle-v1 solid gzip bundles remain readable.
 * Reconciliation migrates them through bounded streaming extraction, retaining
 * the old bundle until every independently recoverable source is durable.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { decodeRisuSave } = require('../utils.cjs');

const CHAT_BACKUP_DIRNAME = 'chat-backups';
const CHAT_BACKUP_DIR_ENV = 'POCKETRISU_CHAT_BACKUP_DIR';
const CHAT_BACKUP_MAX_BYTES_KEY = 'config/chat-backup-max-bytes';
const CHAT_BACKUP_MAX_BYTES_ENV = 'POCKETRISU_CHAT_BACKUP_MAX_BYTES';
const CHAT_BACKUP_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const CHAT_BACKUP_MIN_MAX_BYTES = 1024 * 1024;
const CHAT_BACKUP_MAX_MAX_BYTES = 50 * 1024 * 1024 * 1024;
const CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES_KEY = 'config/chat-backup-max-uncompressed-bytes';
const CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES_ENV = 'POCKETRISU_CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES';
const CHAT_BACKUP_DEFAULT_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const CHAT_BACKUP_MIN_MAX_UNCOMPRESSED_BYTES = 1024 * 1024;
const CHAT_BACKUP_MAX_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024 * 1024;
const DEFAULT_COOLDOWN_MS = 45_000;
const DEFAULT_VERSIONS_PER_BUNDLE = 25;
const DEFAULT_MAX_BUNDLES_PER_CHAT = 4;
const DEFAULT_RECONCILE_DEBOUNCE_MS = 7_500;
const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';

const VERSION_FILE_RE = /^v-(\d+)-(\d+)-([a-z0-9_-]{1,24})\.bin(\.gz)?$/;
const VERSION_ID_RE = /^v-(\d+)-(\d+)-([a-z0-9_-]{1,24})$/;
const FRAME_FILE_RE = /^(v-\d+-\d+-[a-z0-9_-]{1,24})\.frame$/;
const BUNDLE_FILE_RE = /^archive-(\d+)-(\d+)\.bundle$/;
const BUNDLE_META_FILE_RE = /^archive-(\d+)-(\d+)\.meta\.json$/;
// encodePathComponent() cannot produce this physical directory name, so it
// cannot collide with a character identity while remaining portable.
const ROOT_HISTORY_DIRNAME = '%2Eroot-history';
const MIGRATED_ROOT_HISTORY_NAMESPACE_RE = /^[a-f0-9]{16}(?:-\d+)?$/;
const FRAME_FORMAT = 'pocketrisu-chat-version-frame-v1';
const FRAME_CONTENT_TYPE = 'application/vnd.pocketrisu.chat-row';
const FRAME_MAGIC = Buffer.from('PRCHATF1', 'ascii');
const FRAME_PREFIX_BYTES = 20;
const FRAME_MAX_HEADER_BYTES = 16 * 1024;

function clampInteger(value, fallback, min, max) {
    const parsed = parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function resolveChatBackupMaxBytes(options = {}) {
    const {
        kvGet,
        env = process.env,
        defaultBytes = CHAT_BACKUP_DEFAULT_MAX_BYTES,
        minBytes = CHAT_BACKUP_MIN_MAX_BYTES,
        maxBytes = CHAT_BACKUP_MAX_MAX_BYTES,
    } = options;
    let result = clampInteger(defaultBytes, CHAT_BACKUP_DEFAULT_MAX_BYTES, minBytes, maxBytes);

    try {
        const raw = kvGet?.(CHAT_BACKUP_MAX_BYTES_KEY);
        if (raw !== null && raw !== undefined) {
            result = clampInteger(Buffer.from(raw).toString('utf-8').trim(), result, minBytes, maxBytes);
        }
    } catch {
        // A config read failure falls back to the default just like snapshots.
    }

    const envValue = env?.[CHAT_BACKUP_MAX_BYTES_ENV];
    if (envValue !== null && envValue !== undefined && String(envValue).trim() !== '') {
        result = clampInteger(String(envValue).trim(), result, minBytes, maxBytes);
    }
    return result;
}

function resolveChatBackupMaxUncompressedBytes(options = {}) {
    const {
        kvGet,
        env = process.env,
        defaultBytes = CHAT_BACKUP_DEFAULT_MAX_UNCOMPRESSED_BYTES,
        minBytes = CHAT_BACKUP_MIN_MAX_UNCOMPRESSED_BYTES,
        maxBytes = CHAT_BACKUP_MAX_MAX_UNCOMPRESSED_BYTES,
    } = options;
    let result = clampInteger(
        defaultBytes,
        CHAT_BACKUP_DEFAULT_MAX_UNCOMPRESSED_BYTES,
        minBytes,
        maxBytes,
    );

    try {
        const raw = kvGet?.(CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES_KEY);
        if (raw !== null && raw !== undefined) {
            result = clampInteger(Buffer.from(raw).toString('utf-8').trim(), result, minBytes, maxBytes);
        }
    } catch {
        // A config read failure falls back to the default just like the disk budget.
    }

    const envValue = env?.[CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES_ENV];
    if (envValue !== null && envValue !== undefined && String(envValue).trim() !== '') {
        result = clampInteger(String(envValue).trim(), result, minBytes, maxBytes);
    }
    return result;
}

function resolveChatBackupDir(options = {}) {
    const cwd = path.resolve(String(options.cwd ?? process.cwd()));
    const savePath = path.resolve(cwd, String(options.savePath ?? path.join(cwd, 'save')));
    const env = options.env ?? process.env;
    const configured = env?.[CHAT_BACKUP_DIR_ENV];
    if (configured !== null && configured !== undefined && String(configured).trim() !== '') {
        return path.resolve(cwd, String(configured).trim());
    }
    return path.join(savePath, CHAT_BACKUP_DIRNAME);
}

function migrationLog(logger, level, message, error) {
    try {
        const method = typeof logger?.[level] === 'function'
            ? logger[level]
            : logger?.log;
        if (typeof method !== 'function') return;
        if (error === undefined) method.call(logger, message);
        else method.call(logger, message, error?.message || error);
    } catch {
        // A logger failure must not block startup migration or server startup.
    }
}

function filesHaveIdenticalBytes(firstPath, secondPath) {
    let firstFd;
    let secondFd;
    try {
        const firstStat = fs.statSync(firstPath);
        const secondStat = fs.statSync(secondPath);
        if (!firstStat.isFile() || !secondStat.isFile() || firstStat.size !== secondStat.size) {
            return false;
        }
        firstFd = fs.openSync(firstPath, 'r');
        secondFd = fs.openSync(secondPath, 'r');
        const firstChunk = Buffer.allocUnsafe(64 * 1024);
        const secondChunk = Buffer.allocUnsafe(64 * 1024);
        let offset = 0;
        while (offset < firstStat.size) {
            const length = Math.min(firstChunk.length, firstStat.size - offset);
            const firstRead = fs.readSync(firstFd, firstChunk, 0, length, offset);
            const secondRead = fs.readSync(secondFd, secondChunk, 0, length, offset);
            if (firstRead === 0 || firstRead !== secondRead
                || !firstChunk.subarray(0, firstRead).equals(secondChunk.subarray(0, secondRead))) {
                return false;
            }
            offset += firstRead;
        }
        return true;
    } catch {
        return false;
    } finally {
        if (firstFd !== undefined) {
            try { fs.closeSync(firstFd); } catch {}
        }
        if (secondFd !== undefined) {
            try { fs.closeSync(secondFd); } catch {}
        }
    }
}

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set([
    'EBADF',
    'EINVAL',
    'EISDIR',
    'ENOTSUP',
    'EPERM',
]);

function syncDirectoryForMigration(directory) {
    let fd;
    try {
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
        return true;
    } catch (error) {
        if (UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(error?.code)) return false;
        throw error;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch {}
        }
    }
}

function syncFileForMigration(filename) {
    let fd;
    try {
        fd = fs.openSync(filename, 'r');
        fs.fsyncSync(fd);
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch {}
        }
    }
}

function ensureDirectoryDurableSync(directory) {
    const absolute = path.resolve(directory);
    const missing = [];
    let cursor = absolute;
    while (!fs.existsSync(cursor)) {
        missing.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    if (fs.existsSync(cursor) && !fs.statSync(cursor).isDirectory()) {
        throw new Error(`Migration parent is not a directory: ${cursor}`);
    }
    for (const next of missing.reverse()) {
        try { fs.mkdirSync(next); }
        catch (error) {
            if (error?.code !== 'EEXIST' || !fs.statSync(next).isDirectory()) throw error;
        }
        syncDirectoryForMigration(path.dirname(next));
        syncDirectoryForMigration(next);
    }
}

function rootsReferToSameDirectory(firstRoot, secondRoot) {
    if (firstRoot === secondRoot) return true;
    try {
        const first = fs.statSync(firstRoot);
        const second = fs.statSync(secondRoot);
        return first.isDirectory() && second.isDirectory()
            && first.dev === second.dev && first.ino === second.ino;
    } catch {
        return false;
    }
}

function versionClaimsForFiles(directory, filenames) {
    const claims = new Set();
    for (const filename of filenames) {
        const loose = parseVersionFile(filename);
        if (loose) {
            claims.add(loose.versionId);
            continue;
        }
        const frame = FRAME_FILE_RE.exec(filename);
        if (frame) {
            claims.add(frame[1]);
            continue;
        }
        if (!/^archive-\d+-\d+\.meta\.json$/.test(filename)) continue;
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
            if (!Array.isArray(meta?.entries)) continue;
            for (const entry of meta.entries) {
                if (parseVersionId(entry?.versionId)) claims.add(entry.versionId);
            }
        } catch {
            // An invalid bundle remains a physical file group but claims no
            // logical version; filename collision handling still preserves it.
        }
    }
    return claims;
}

function directoryVersionClaims(directory) {
    let filenames = [];
    try { filenames = fs.readdirSync(directory); }
    catch { return new Set(); }
    return versionClaimsForFiles(directory, filenames);
}

function hasVersionClaimCollision(sourceDirectory, destinationDirectory, filenames) {
    const sourceClaims = versionClaimsForFiles(sourceDirectory, filenames);
    if (sourceClaims.size === 0) return false;
    const destinationClaims = directoryVersionClaims(destinationDirectory);
    return [...sourceClaims].some(versionId => destinationClaims.has(versionId));
}

function migrateLegacyChatBackups(options = {}) {
    const logger = options.logger ?? console;
    const stats = {
        copied: 0,
        deduplicated: 0,
        conflicts: 0,
        failed: 0,
    };
    let legacyRoot;
    let destinationRoot;
    try {
        if (options.legacyRoot === null || options.legacyRoot === undefined
            || options.destinationRoot === null || options.destinationRoot === undefined) {
            throw new TypeError('legacyRoot and destinationRoot are required');
        }
        legacyRoot = path.resolve(String(options.legacyRoot));
        destinationRoot = path.resolve(String(options.destinationRoot));
    } catch (error) {
        stats.failed++;
        migrationLog(logger, 'error', '[ChatBackups] Legacy migration paths are invalid:', error);
        return stats;
    }

    if (legacyRoot === destinationRoot
        || rootsReferToSameDirectory(legacyRoot, destinationRoot)
        || !fs.existsSync(legacyRoot)) return stats;

    const destinationRelativeToLegacy = path.relative(legacyRoot, destinationRoot);
    if (destinationRelativeToLegacy
        && !destinationRelativeToLegacy.startsWith('..')
        && !path.isAbsolute(destinationRelativeToLegacy)) {
        stats.failed++;
        migrationLog(
            logger,
            'error',
            `[ChatBackups] Refusing to migrate ${legacyRoot} into its own descendant ${destinationRoot}`,
        );
        return stats;
    }

    function conflictDestinationDirectory(sourceDirectory, attempt) {
        let relative = path.relative(legacyRoot, sourceDirectory);
        const relativeParts = relative.split(path.sep);
        if (relativeParts[0] === ROOT_HISTORY_DIRNAME && relativeParts.length >= 2) {
            // A conflict namespace copied from an earlier root stays a direct
            // federated read root instead of becoming an undiscoverable nest.
            relative = relativeParts.slice(2).join(path.sep);
        }
        const sourceKey = crypto.createHash('sha256')
            .update(legacyRoot)
            .digest('hex')
            .slice(0, 16);
        const namespace = attempt === 0 ? sourceKey : `${sourceKey}-${attempt}`;
        return path.join(destinationRoot, ROOT_HISTORY_DIRNAME, namespace, relative);
    }

    function stageDurableRecoveryGroup(sourceDirectory, filenames) {
        for (let attempt = 0; ; attempt++) {
            const targetDirectory = conflictDestinationDirectory(sourceDirectory, attempt);
            ensureDirectoryDurableSync(targetDirectory);
            const entries = [];
            let collision = false;
            for (const filename of filenames) {
                const source = path.join(sourceDirectory, filename);
                const recovery = path.join(targetDirectory, filename);
                try {
                    fs.copyFileSync(source, recovery, fs.constants.COPYFILE_EXCL);
                } catch (error) {
                    if (error?.code !== 'EEXIST') throw error;
                }
                if (!filesHaveIdenticalBytes(source, recovery)) {
                    collision = true;
                    break;
                }
                syncFileForMigration(recovery);
                entries.push({ filename, source, recovery });
            }
            if (collision) continue;
            syncDirectoryForMigration(targetDirectory);
            return { targetDirectory, entries };
        }
    }

    function publishCreateOnlyFromRecovery(recovery, destination) {
        let created = false;
        try {
            // Always materialize independent bytes. A hardlink would let an
            // in-place write through the ordinary path mutate protected history.
            fs.copyFileSync(recovery, destination, fs.constants.COPYFILE_EXCL);
            created = true;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
        if (!filesHaveIdenticalBytes(recovery, destination)) {
            return { created, exact: false };
        }
        syncFileForMigration(destination);
        return { created, exact: true };
    }

    function directGroupIsDurableAndExact(recoveryGroup, destinationDirectory) {
        try {
            for (const entry of recoveryGroup.entries) {
                const destination = path.join(destinationDirectory, entry.filename);
                if (!filesHaveIdenticalBytes(entry.recovery, destination)) return false;
                syncFileForMigration(destination);
            }
            syncDirectoryForMigration(destinationDirectory);
            return true;
        } catch {
            return false;
        }
    }

    function preserveStagedRecovery(recoveryGroup, conflictCount) {
        stats.copied += recoveryGroup.entries.length;
        stats.conflicts += conflictCount;
        migrationLog(
            logger,
            'warn',
            `[ChatBackups] Preserved conflicting legacy history under ${recoveryGroup.targetDirectory}`,
        );
    }

    function publishCompleteFileGroup(sourceDirectory, destinationDirectory, filenames) {
        const recoveryGroup = stageDurableRecoveryGroup(sourceDirectory, filenames);
        ensureDirectoryDurableSync(destinationDirectory);
        let created = 0;
        let directConflict = false;
        for (const entry of recoveryGroup.entries) {
            const publication = publishCreateOnlyFromRecovery(
                entry.recovery,
                path.join(destinationDirectory, entry.filename),
            );
            if (publication.created) created++;
            if (!publication.exact) directConflict = true;
        }
        syncDirectoryForMigration(destinationDirectory);

        // The historical source path is retained and the protected decoded
        // history stays durable (normalization may change its representation).
        // No compare-then-unlink protocol can safely remove a source path that
        // arbitrary filesystem peers may replace.
        if (directConflict || !directGroupIsDurableAndExact(
            recoveryGroup,
            destinationDirectory,
        )) {
            preserveStagedRecovery(recoveryGroup, 1);
            return;
        }

        stats.copied += created;
        stats.deduplicated += recoveryGroup.entries.length - created;
    }

    function preserveConflictGroup(sourceDirectory, filenames, conflictCount) {
        try {
            const recoveryGroup = stageDurableRecoveryGroup(sourceDirectory, filenames);
            preserveStagedRecovery(recoveryGroup, conflictCount);
        } catch (error) {
            stats.failed++;
            migrationLog(
                logger,
                'error',
                `[ChatBackups] Could not preserve conflicting legacy history from ${sourceDirectory}:`,
                error,
            );
        }
    }

    function moveFile(source, destination) {
        const sourceDirectory = path.dirname(source);
        const destinationDirectory = path.dirname(destination);
        const filename = path.basename(source);
        const destinationExact = fs.existsSync(destination)
            && filesHaveIdenticalBytes(source, destination);
        if (!destinationExact
            && hasVersionClaimCollision(sourceDirectory, destinationDirectory, [filename])) {
            preserveConflictGroup(sourceDirectory, [filename], 1);
            return;
        }
        if (!destinationExact && fs.existsSync(destination)) {
            preserveConflictGroup(sourceDirectory, [filename], 1);
            return;
        }

        try {
            publishCompleteFileGroup(sourceDirectory, destinationDirectory, [filename]);
        } catch (error) {
            stats.failed++;
            migrationLog(logger, 'error', `[ChatBackups] Could not copy legacy file ${source} to ${destination}:`, error);
        }
    }

    function moveFileGroup(sourceDirectory, destinationDirectory, filenames) {
        const allDestinationsExact = filenames.every((filename) => {
            const source = path.join(sourceDirectory, filename);
            const destination = path.join(destinationDirectory, filename);
            return fs.existsSync(destination) && filesHaveIdenticalBytes(source, destination);
        });
        if (allDestinationsExact) {
            try {
                publishCompleteFileGroup(sourceDirectory, destinationDirectory, filenames);
            } catch (error) {
                stats.failed++;
                migrationLog(logger, 'error', `[ChatBackups] Could not reuse duplicate legacy bundle group from ${sourceDirectory}:`, error);
            }
            return;
        }
        if (hasVersionClaimCollision(sourceDirectory, destinationDirectory, filenames)) {
            preserveConflictGroup(sourceDirectory, filenames, 1);
            return;
        }
        if (filenames.some(filename => fs.existsSync(path.join(destinationDirectory, filename)))) {
            preserveConflictGroup(sourceDirectory, filenames, 1);
            return;
        }
        try {
            publishCompleteFileGroup(sourceDirectory, destinationDirectory, filenames);
        } catch (error) {
            stats.failed++;
            migrationLog(
                logger,
                'error',
                `[ChatBackups] Could not publish complete legacy bundle group from ${sourceDirectory}:`,
                error,
            );
        }
    }

    function moveDirectory(sourceDirectory, destinationDirectory) {
        let entries;
        try {
            entries = fs.readdirSync(sourceDirectory, { withFileTypes: true });
            ensureDirectoryDurableSync(destinationDirectory);
        } catch (error) {
            stats.failed++;
            migrationLog(logger, 'error', `[ChatBackups] Could not prepare legacy directory ${sourceDirectory}:`, error);
            return;
        }

        const handledFiles = new Set();
        for (const entry of entries) {
            const source = path.join(sourceDirectory, entry.name);
            if (entry.isDirectory()) {
                moveDirectory(source, path.join(destinationDirectory, entry.name));
                continue;
            }
            if (!entry.isFile()) {
                stats.failed++;
                migrationLog(logger, 'warn', `[ChatBackups] Leaving unsupported legacy entry in place: ${source}`);
                continue;
            }
            if (handledFiles.has(entry.name)) continue;

            const bundleMatch = /^(archive-\d+-\d+)\.(bundle|meta\.json)$/.exec(entry.name);
            if (bundleMatch) {
                const group = [`${bundleMatch[1]}.bundle`, `${bundleMatch[1]}.meta.json`]
                    .filter(filename => entries.some(candidate => (
                        candidate.isFile() && candidate.name === filename
                    )));
                for (const filename of group) handledFiles.add(filename);
                moveFileGroup(sourceDirectory, destinationDirectory, group);
                continue;
            }

            handledFiles.add(entry.name);
            moveFile(source, path.join(destinationDirectory, entry.name));
        }
    }

    try {
        moveDirectory(legacyRoot, destinationRoot);
    } catch (error) {
        stats.failed++;
        migrationLog(logger, 'error', '[ChatBackups] Unexpected legacy migration failure:', error);
    }

    if (stats.copied || stats.deduplicated || stats.conflicts || stats.failed) {
        migrationLog(
            logger,
            stats.conflicts || stats.failed ? 'warn' : 'info',
            `[ChatBackups] Legacy copy complete: ${stats.copied} copied, `
            + `${stats.deduplicated} duplicate(s) reused, ${stats.conflicts} conflict(s), `
            + `${stats.failed} failure(s)`,
        );
    }
    return stats;
}

function sanitizeBackupReason(reason) {
    const sanitized = String(reason ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);
    return sanitized || 'unknown';
}

const DESTRUCTIVE_BACKUP_REASONS = new Set([
    'reroll',
    'delete-message',
    'delete-swipe',
    'script-bulk-chat',
]);

function isDestructiveBackupReason(reason) {
    return DESTRUCTIVE_BACKUP_REASONS.has(sanitizeBackupReason(reason));
}

function encodePathComponent(value) {
    // encodeURIComponent leaves traversal-only dot components literal.
    const encoded = encodeURIComponent(String(value));
    if (encoded === '.') return '%2E';
    if (encoded === '..') return '%2E%2E';
    return encoded;
}

function decodePathComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
}

function parseVersionId(versionId) {
    const match = VERSION_ID_RE.exec(versionId);
    if (!match) return null;
    const ts = Number(match[1]);
    const seq = Number(match[2]);
    if (!Number.isSafeInteger(ts) || !Number.isSafeInteger(seq)) return null;
    return { versionId, ts, seq, reason: match[3] };
}

function parseVersionFile(filename) {
    const match = VERSION_FILE_RE.exec(filename);
    if (!match) return null;
    const versionId = `v-${match[1]}-${match[2]}-${match[3]}`;
    const parsed = parseVersionId(versionId);
    if (!parsed) return null;
    return {
        ...parsed,
        filename,
        compressed: Boolean(match[4]),
    };
}

function compareVersionsOldest(a, b) {
    return a.ts - b.ts
        || a.seq - b.seq
        || a.versionId.localeCompare(b.versionId);
}

function createChatBackupStore(options) {
    const config = options || {};
    const {
        getChatBackupsRoot,
        getChatBackupsReadRoots,
        inspectChatRow,
        readChatRowRaw,
        readChatRowRawWithMetadata,
        repairChatRowMetadata,
        streamChatRowRawToFile,
        logger = console,
        now = Date.now,
        decodeChat = decodeRisuSave,
        cooldownMs = DEFAULT_COOLDOWN_MS,
        reconcileDebounceMs = DEFAULT_RECONCILE_DEBOUNCE_MS,
        byteBudgetMin = CHAT_BACKUP_MIN_MAX_BYTES,
        byteBudgetMax = CHAT_BACKUP_MAX_MAX_BYTES,
        uncompressedByteBudgetMin = CHAT_BACKUP_MIN_MAX_UNCOMPRESSED_BYTES,
        uncompressedByteBudgetMax = CHAT_BACKUP_MAX_MAX_UNCOMPRESSED_BYTES,
        runStorageOperation,
        autoReconcile = true,
        diagnostics = null,
    } = config;
    const versionsPerBundle = config.versionsPerBundle
        ?? config.bundleSize
        ?? DEFAULT_VERSIONS_PER_BUNDLE;
    const maxBundlesPerChat = config.maxBundlesPerChat
        ?? config.archiveBundleLimit
        ?? DEFAULT_MAX_BUNDLES_PER_CHAT;
    const getByteBudget = config.getByteBudget
        ?? config.byteBudgetGetter
        ?? (() => CHAT_BACKUP_DEFAULT_MAX_BYTES);
    const getUncompressedByteBudget = config.getUncompressedByteBudget
        ?? config.uncompressedByteBudgetGetter
        ?? (() => CHAT_BACKUP_DEFAULT_MAX_UNCOMPRESSED_BYTES);

    if (typeof getChatBackupsRoot !== 'function') {
        throw new TypeError('getChatBackupsRoot must be a function');
    }
    if (typeof readChatRowRaw !== 'function') {
        throw new TypeError('readChatRowRaw must be a function');
    }

    const inspectRow = typeof inspectChatRow === 'function'
        ? inspectChatRow
        : (chaId, chatId) => {
            const raw = readChatRowRaw(chaId, chatId);
            return raw === null || raw === undefined
                ? null
                : { size: raw.length, coldStorage: null };
        };
    const selectSmallRow = typeof readChatRowRawWithMetadata === 'function'
        ? readChatRowRawWithMetadata
        : (chaId, chatId) => {
            const raw = readChatRowRaw(chaId, chatId);
            return raw === null || raw === undefined
                ? null
                : { bytes: Buffer.from(raw), contentHash: null, coldStorage: null };
        };
    const streamRowToFile = typeof streamChatRowRawToFile === 'function'
        ? streamChatRowRawToFile
        : async (chaId, chatId, filePath) => {
            const raw = readChatRowRaw(chaId, chatId);
            if (raw === null || raw === undefined) return null;
            fs.writeFileSync(filePath, raw);
            return { filePath, size: raw.length, chunks: 1, maxChunkBytes: raw.length };
        };

    const bundleSize = Math.max(1, Math.floor(versionsPerBundle));
    const bundleLimit = Math.max(0, Math.floor(maxBundlesPerChat));
    const defaultVersionLimit = Math.min(
        Number.MAX_SAFE_INTEGER,
        // Keep the configured solid bundles plus one active loose batch.
        bundleSize * (bundleLimit + 1),
    );
    const versionLimit = clampInteger(
        config.maxVersionsPerChat,
        defaultVersionLimit,
        1,
        Number.MAX_SAFE_INTEGER,
    );
    const newestByChatDir = new Map();
    const verifiedFrameSemantics = new Map();
    const verifiedSourceSemantics = new Map();
    let tempCounter = 0;
    let reconcileTimer = null;
    let localReconcileQueue = Promise.resolve();

    function observe(event, details = {}) {
        try {
            diagnostics?.onEvent?.({ event, ...details });
        } catch {
            // Test/diagnostic observers must not affect recovery behavior.
        }
    }

    function log(level, message, error) {
        try {
            const method = typeof logger?.[level] === 'function'
                ? logger[level]
                : logger?.log;
            if (typeof method !== 'function') return;
            if (error === undefined) method.call(logger, message);
            else method.call(logger, message, error?.message || error);
        } catch {
            // Logging must not turn a best-effort backup into a save failure.
        }
    }

    function backupsTreeRoot() {
        return path.resolve(String(getChatBackupsRoot()));
    }

    function backupsReadRootRecords({ strictReachability = false } = {}) {
        const activeRoot = backupsTreeRoot();
        let configured = [];
        if (typeof getChatBackupsReadRoots === 'function') {
            try {
                const selected = getChatBackupsReadRoots();
                if (Array.isArray(selected)) configured = selected;
            } catch (error) {
                if (strictReachability) {
                    throw new Error(
                        `Cannot resolve retained chat-backup roots: ${error?.message || error}`,
                        { cause: error },
                    );
                }
                log('warn', '[ChatBackups] Could not resolve historical chat-backup roots:', error);
            }
        }

        const records = [];
        const recordsByIdentity = new Map();
        function addRoot(candidate, options = {}) {
            const descriptor = candidate && typeof candidate === 'object'
                ? candidate
                : { root: candidate };
            let absolute;
            try { absolute = path.resolve(String(descriptor.root)); }
            catch { return; }
            let identity = `path:${process.platform === 'win32' ? absolute.toLowerCase() : absolute}`;
            try {
                const stat = fs.statSync(absolute);
                if (stat.isDirectory()) identity = `inode:${stat.dev}:${stat.ino}`;
            } catch {
                // An offline historical root remains in the set by lexical identity.
            }
            const existing = recordsByIdentity.get(identity);
            if (existing) {
                if (options.required === true || descriptor.required === true) {
                    existing.required = true;
                }
                return;
            }
            const stableIdentity = options.identity
                ?? `historical:${crypto.createHash('sha256').update(absolute).digest('hex').slice(0, 20)}`;
            const record = {
                root: absolute,
                identity: stableIdentity,
                active: options.active === true,
                required: options.active === true
                    || options.required === true
                    || descriptor.required === true,
                originalEligible: options.originalEligible === true
                    || options.active === true,
            };
            records.push(record);
            recordsByIdentity.set(identity, record);
        }

        addRoot(activeRoot, { active: true, identity: 'active' });
        for (const candidate of configured) addRoot(candidate);
        for (const record of [...records]) {
            const conflictRoot = path.join(record.root, ROOT_HISTORY_DIRNAME);
            let entries = [];
            try { entries = fs.readdirSync(conflictRoot, { withFileTypes: true }); }
            catch (error) {
                if (error?.code === 'ENOENT') continue;
                if (strictReachability) {
                    throw new Error(
                        `Cannot verify protected chat-backup container ${conflictRoot}: `
                        + `${error?.message || error}`,
                        { cause: error },
                    );
                }
                continue;
            }
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (entry.isDirectory()) {
                    addRoot(path.join(conflictRoot, entry.name), {
                        identity: `conflict:${entry.name}`,
                        // Once a protected namespace has been observed by a
                        // destructive proof, disappearance before inventory
                        // cannot be reinterpreted as an empty reference set.
                        required: strictReachability || record.required,
                        // Root-migration recovery namespaces use a 16-hex
                        // source identity. Content-derived normalization
                        // namespaces use 20 hex and must not outrank the
                        // historical source whose alias they stabilize.
                        originalEligible: record.active
                            && MIGRATED_ROOT_HISTORY_NAMESPACE_RE.test(entry.name),
                    });
                }
            }
        }
        const [active, ...historical] = records;
        return [active, ...historical.sort((a, b) => a.identity.localeCompare(b.identity))]
            .filter(Boolean);
    }

    function backupsReadRoots() {
        return backupsReadRootRecords().map(record => record.root);
    }

    function chatDirectoryAt(root, chaId, chatId) {
        return path.join(
            root,
            encodePathComponent(chaId),
            encodePathComponent(chatId),
        );
    }

    function chatDirectory(chaId, chatId) {
        return chatDirectoryAt(backupsTreeRoot(), chaId, chatId);
    }

    async function writeFileAtomicFromSource(destination, writeSource) {
        const temp = `${destination}.${process.pid}-${tempCounter++}.tmp`;
        try {
            const result = await writeSource(temp);
            if (result === null || result === undefined) {
                try { fs.unlinkSync(temp); } catch {}
                return null;
            }
            let fileFd;
            try {
                fileFd = fs.openSync(temp, 'r');
                fs.fsyncSync(fileFd);
            } finally {
                if (fileFd !== undefined) fs.closeSync(fileFd);
            }
            fs.renameSync(temp, destination);

            let directoryFd;
            try {
                directoryFd = fs.openSync(path.dirname(destination), 'r');
                fs.fsyncSync(directoryFd);
            } catch {
                // The file itself is already durable and published at this point.
            } finally {
                if (directoryFd !== undefined) {
                    try { fs.closeSync(directoryFd); } catch {}
                }
            }
            return result;
        } catch (error) {
            try { fs.unlinkSync(temp); } catch {}
            throw error;
        }
    }

    function syncDirectory(directory) {
        let directoryFd;
        try {
            directoryFd = fs.openSync(directory, 'r');
            fs.fsyncSync(directoryFd);
        } catch {
            // Directory fsync is unavailable on some supported platforms.
        } finally {
            if (directoryFd !== undefined) {
                try { fs.closeSync(directoryFd); } catch {}
            }
        }
    }

    function durablePublishTemp(temp, destination) {
        let fileFd;
        try {
            fileFd = fs.openSync(temp, 'r');
            fs.fsyncSync(fileFd);
        } finally {
            if (fileFd !== undefined) fs.closeSync(fileFd);
        }
        ensureDirectoryDurableSync(path.dirname(destination));
        try {
            fs.linkSync(temp, destination);
        } catch (error) {
            if (error?.code === 'EPERM') {
                fs.copyFileSync(temp, destination, fs.constants.COPYFILE_EXCL);
                syncFileForMigration(destination);
            } else {
                throw error;
            }
        }
        syncDirectoryForMigration(path.dirname(destination));
        fs.unlinkSync(temp);
    }

    function unlinkAndSync(filename) {
        fs.unlinkSync(filename);
        syncDirectory(path.dirname(filename));
    }

    function statSize(filename) {
        try {
            return fs.statSync(filename).size;
        } catch {
            return 0;
        }
    }

    function gzipRawSize(filename) {
        let fd;
        try {
            const stat = fs.statSync(filename);
            if (stat.size < 4) return 0;
            fd = fs.openSync(filename, 'r');
            const trailer = Buffer.allocUnsafe(4);
            fs.readSync(fd, trailer, 0, 4, stat.size - 4);
            return trailer.readUInt32LE(0);
        } catch {
            return 0;
        } finally {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch {}
            }
        }
    }

    function readFrameHeader(filename) {
        let fd;
        try {
            const stat = fs.statSync(filename);
            if (!stat.isFile() || stat.size < FRAME_PREFIX_BYTES) return null;
            fd = fs.openSync(filename, 'r');
            const prefix = Buffer.allocUnsafe(FRAME_PREFIX_BYTES);
            if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length) return null;
            if (!prefix.subarray(0, FRAME_MAGIC.length).equals(FRAME_MAGIC)) return null;
            const headerBytes = prefix.readUInt32LE(8);
            const compressedBytesBig = prefix.readBigUInt64LE(12);
            if (headerBytes < 2 || headerBytes > FRAME_MAX_HEADER_BYTES
                || compressedBytesBig === 0n
                || compressedBytesBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            const compressedBytes = Number(compressedBytesBig);
            const payloadOffset = FRAME_PREFIX_BYTES + headerBytes;
            if (payloadOffset + compressedBytes !== stat.size) return null;
            const encodedHeader = Buffer.allocUnsafe(headerBytes);
            if (fs.readSync(fd, encodedHeader, 0, headerBytes, FRAME_PREFIX_BYTES) !== headerBytes) {
                return null;
            }
            const header = JSON.parse(encodedHeader.toString('utf-8'));
            const parsed = parseVersionId(header?.versionId);
            if (header?.format !== FRAME_FORMAT
                || header?.contentType !== FRAME_CONTENT_TYPE
                || header?.compression !== 'gzip'
                || !parsed
                || header.timestamp !== parsed.ts
                || header.sequence !== parsed.seq
                || header.reason !== parsed.reason
                || !Number.isSafeInteger(header.uncompressedSize)
                || header.uncompressedSize < 0
                || typeof header.sha256 !== 'string'
                || !/^[a-f0-9]{64}$/.test(header.sha256)) {
                return null;
            }
            return {
                ...parsed,
                size: header.uncompressedSize,
                sha256: header.sha256,
                compressedBytes,
                payloadOffset,
                diskBytes: stat.size,
                filename: path.basename(filename),
            };
        } catch {
            return null;
        } finally {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch {}
            }
        }
    }

    function frameFileFingerprint(filename) {
        const stat = fs.statSync(filename);
        return {
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
        };
    }

    function frameFingerprintsMatch(first, second) {
        return first.dev === second.dev
            && first.ino === second.ino
            && first.size === second.size
            && first.mtimeMs === second.mtimeMs
            && first.ctimeMs === second.ctimeMs;
    }

    async function readWithStableFrameIdentity(filename, reader) {
        const before = frameFileFingerprint(filename);
        const value = await reader();
        const after = frameFileFingerprint(filename);
        return {
            value,
            fingerprint: after,
            stable: frameFingerprintsMatch(before, after),
        };
    }

    function rememberVerifiedFrame(filename, frame, rawInfo, fingerprint) {
        const absolute = path.resolve(filename);
        verifiedFrameSemantics.set(absolute, {
            ...fingerprint,
            semanticIdentity: `${rawInfo.size}:${rawInfo.sha256}`,
            versionId: frame.versionId,
        });
    }

    function knownVerifiedFrameSemantic(filename, frame) {
        const absolute = path.resolve(filename);
        const cached = verifiedFrameSemantics.get(absolute);
        if (!cached || cached.versionId !== frame.versionId) return null;
        try {
            const current = frameFileFingerprint(absolute);
            if (!frameFingerprintsMatch(cached, current)) {
                verifiedFrameSemantics.delete(absolute);
                return null;
            }
            return cached.semanticIdentity;
        } catch {
            verifiedFrameSemantics.delete(absolute);
            return null;
        }
    }

    function sourceSemanticCacheKey(filenames, versionId) {
        return `${versionId}\0${filenames.map(filename => path.resolve(filename)).join('\0')}`;
    }

    function rememberVerifiedSourceSemantic(filenames, versionId, rawInfo) {
        const absoluteFiles = filenames.map(filename => path.resolve(filename));
        const key = sourceSemanticCacheKey(absoluteFiles, versionId);
        try {
            verifiedSourceSemantics.set(key, {
                files: absoluteFiles.map((filename) => {
                    const stat = fs.statSync(filename);
                    return {
                        filename,
                        dev: stat.dev,
                        ino: stat.ino,
                        size: stat.size,
                        mtimeMs: stat.mtimeMs,
                        ctimeMs: stat.ctimeMs,
                        sha256: hashFileBytes(filename),
                    };
                }),
                semanticIdentity: `${rawInfo.size}:${rawInfo.sha256}`,
            });
        } catch {
            verifiedSourceSemantics.delete(key);
        }
    }

    function knownVerifiedSourceSemantic(filenames, versionId) {
        const absoluteFiles = filenames.map(filename => path.resolve(filename));
        const key = sourceSemanticCacheKey(absoluteFiles, versionId);
        const cached = verifiedSourceSemantics.get(key);
        if (!cached || cached.files.length !== absoluteFiles.length) return null;
        try {
            for (let index = 0; index < absoluteFiles.length; index++) {
                const expected = cached.files[index];
                const stat = fs.statSync(absoluteFiles[index]);
                if (expected.filename !== absoluteFiles[index]
                    || expected.dev !== stat.dev
                    || expected.ino !== stat.ino
                    || expected.size !== stat.size
                    || expected.mtimeMs !== stat.mtimeMs
                    || expected.ctimeMs !== stat.ctimeMs
                    || expected.sha256 !== hashFileBytes(absoluteFiles[index])) {
                    verifiedSourceSemantics.delete(key);
                    return null;
                }
            }
            return cached.semanticIdentity;
        } catch {
            verifiedSourceSemantics.delete(key);
            return null;
        }
    }

    function encodeFrameHeader(entry, rawInfo) {
        const header = Buffer.from(JSON.stringify({
            format: FRAME_FORMAT,
            contentType: FRAME_CONTENT_TYPE,
            compression: 'gzip',
            uncompressedSize: rawInfo.size,
            sha256: rawInfo.sha256,
            versionId: entry.versionId,
            timestamp: entry.ts,
            sequence: entry.seq,
            reason: entry.reason,
        }), 'utf-8');
        if (header.length > FRAME_MAX_HEADER_BYTES) {
            throw new Error(`Chat backup frame header is too large for ${entry.versionId}`);
        }
        return header;
    }

    function framePrefix(headerBytes, compressedBytes = 0) {
        if (!Number.isSafeInteger(compressedBytes) || compressedBytes < 0) {
            throw new Error('Chat backup frame compressed size is invalid');
        }
        const prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
        FRAME_MAGIC.copy(prefix, 0);
        prefix.writeUInt32LE(headerBytes, 8);
        prefix.writeBigUInt64LE(BigInt(compressedBytes), 12);
        return prefix;
    }

    function readBundleMeta(chatDir, bundleFile) {
        if (!BUNDLE_FILE_RE.test(bundleFile)) return null;
        const metaFile = bundleFile.replace(/\.bundle$/, '.meta.json');
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(chatDir, metaFile), 'utf-8'));
            if (!Array.isArray(meta.entries)) return null;
            const entries = [];
            for (const entry of meta.entries) {
                const parsed = parseVersionId(entry?.versionId);
                if (!parsed
                    || !Number.isSafeInteger(entry.offset) || entry.offset < 0
                    || !Number.isSafeInteger(entry.size) || entry.size < 0) {
                    return null;
                }
                entries.push({
                    versionId: parsed.versionId,
                    ts: parsed.ts,
                    seq: parsed.seq,
                    reason: parsed.reason,
                    offset: entry.offset,
                    size: entry.size,
                });
            }
            if (meta.entryCount !== entries.length) return null;
            return {
                format: meta.format,
                entryCount: entries.length,
                compressedSize: Number(meta.compressedSize) || statSize(path.join(chatDir, bundleFile)),
                entries,
                bundleFile,
                metaFile,
            };
        } catch {
            return null;
        }
    }

    function scanChatDirectory(chatDir) {
        const loose = new Map();
        const frames = [];
        const bundles = [];
        let filenames = [];
        try {
            filenames = fs.readdirSync(chatDir);
        } catch {
            return { loose: [], frames: [], bundles: [] };
        }

        for (const filename of filenames) {
            const frameMatch = FRAME_FILE_RE.exec(filename);
            if (frameMatch) {
                const parsed = readFrameHeader(path.join(chatDir, filename));
                if (parsed?.versionId === frameMatch[1]) {
                    frames.push({
                        ...parsed,
                        storage: 'frame',
                    });
                }
                continue;
            }
            const parsed = parseVersionFile(filename);
            if (!parsed) continue;
            const existing = loose.get(parsed.versionId);
            if (!existing || parsed.compressed) {
                const fullPath = path.join(chatDir, filename);
                loose.set(parsed.versionId, {
                    ...parsed,
                    size: parsed.compressed ? gzipRawSize(fullPath) : statSize(fullPath),
                    diskBytes: statSize(fullPath),
                    storage: 'loose',
                });
            }
        }

        for (const filename of filenames) {
            if (!BUNDLE_FILE_RE.test(filename)) continue;
            const meta = readBundleMeta(chatDir, filename);
            if (!meta || !fs.existsSync(path.join(chatDir, filename))) continue;
            bundles.push({
                ...meta,
                diskBytes: statSize(path.join(chatDir, filename))
                    + statSize(path.join(chatDir, meta.metaFile)),
            });
        }

        return {
            loose: [...loose.values()].sort(compareVersionsOldest),
            frames: frames.sort(compareVersionsOldest),
            bundles,
        };
    }

    function requireReachabilityFile(filename, description) {
        let stat;
        try { stat = fs.statSync(filename); }
        catch (error) {
            throw new Error(
                `Cannot verify ${description} ${filename}: ${error?.message || error}`,
                { cause: error },
            );
        }
        if (!stat.isFile()) {
            throw new Error(`Cannot verify ${description} ${filename}: not a regular file`);
        }
        return stat;
    }

    function readBundleMetaForReachability(chatDir, bundleFile) {
        const bundlePath = path.join(chatDir, bundleFile);
        const metaFile = bundleFile.replace(/\.bundle$/, '.meta.json');
        const metaPath = path.join(chatDir, metaFile);
        requireReachabilityFile(bundlePath, 'retained chat-backup bundle');
        requireReachabilityFile(metaPath, 'retained chat-backup bundle metadata');
        const bundle = readBundleMeta(chatDir, bundleFile);
        if (!bundle || bundle.format !== 'pocketrisu-chat-backup-bundle-v1') {
            throw new Error(`Cannot verify retained chat-backup bundle metadata ${metaPath}`);
        }
        let previousEnd = 0;
        for (const entry of [...bundle.entries].sort((left, right) => left.offset - right.offset)) {
            const end = entry.offset + entry.size;
            if (!Number.isSafeInteger(end) || entry.offset < previousEnd) {
                throw new Error(`Cannot verify retained chat-backup bundle metadata ${metaPath}`);
            }
            previousEnd = end;
        }
        return bundle;
    }

    /**
     * Destructive reachability uses a strict inventory that is deliberately
     * separate from permissive list/restore discovery. A physical chat
     * directory is evidence that retained history exists; unreadable, empty,
     * or recognized-but-invalid representations cannot be reinterpreted as an
     * empty reference set.
     */
    function scanChatDirectoryForReachability(chatDir) {
        let filenames;
        try { filenames = fs.readdirSync(chatDir); }
        catch (error) {
            throw new Error(
                `Cannot verify retained chat-backup directory ${chatDir}: `
                + `${error?.message || error}`,
                { cause: error },
            );
        }
        const filenameSet = new Set(filenames);
        const loose = new Map();
        const frames = [];
        const bundles = [];

        for (const filename of filenames) {
            const frameMatch = FRAME_FILE_RE.exec(filename);
            if (frameMatch) {
                const framePath = path.join(chatDir, filename);
                requireReachabilityFile(framePath, 'retained chat-backup frame');
                const parsed = readFrameHeader(framePath);
                if (!parsed || parsed.versionId !== frameMatch[1]) {
                    throw new Error(`Cannot verify retained chat-backup frame ${framePath}`);
                }
                frames.push({ ...parsed, storage: 'frame' });
                continue;
            }
            const parsed = parseVersionFile(filename);
            if (!parsed) continue;
            const fullPath = path.join(chatDir, filename);
            const stat = requireReachabilityFile(fullPath, 'retained loose chat backup');
            const existing = loose.get(parsed.versionId);
            if (!existing || parsed.compressed) {
                loose.set(parsed.versionId, {
                    ...parsed,
                    size: parsed.compressed ? gzipRawSize(fullPath) : stat.size,
                    diskBytes: stat.size,
                    storage: 'loose',
                });
            }
        }

        for (const filename of filenames) {
            if (BUNDLE_META_FILE_RE.test(filename)) {
                const bundleFile = filename.replace(/\.meta\.json$/, '.bundle');
                if (!filenameSet.has(bundleFile)) {
                    throw new Error(
                        `Cannot verify retained chat-backup bundle metadata `
                        + `${path.join(chatDir, filename)}: bundle is missing`,
                    );
                }
                continue;
            }
            if (!BUNDLE_FILE_RE.test(filename)) continue;
            const bundle = readBundleMetaForReachability(chatDir, filename);
            bundles.push({
                ...bundle,
                diskBytes: requireReachabilityFile(
                    path.join(chatDir, bundle.bundleFile),
                    'retained chat-backup bundle',
                ).size + requireReachabilityFile(
                    path.join(chatDir, bundle.metaFile),
                    'retained chat-backup bundle metadata',
                ).size,
            });
        }

        const scan = {
            loose: [...loose.values()].sort(compareVersionsOldest),
            frames: frames.sort(compareVersionsOldest),
            bundles,
        };
        const versionCount = scan.loose.length + scan.frames.length
            + scan.bundles.reduce((total, bundle) => total + bundle.entries.length, 0);
        if (versionCount === 0) {
            throw new Error(`Cannot verify retained chat-backup directory ${chatDir}: no versions`);
        }
        return scan;
    }

    function newestTimestampOnDisk(chatDir) {
        const scan = scanChatDirectory(chatDir);
        let newest = null;
        for (const entry of scan.loose) {
            if (newest === null || entry.ts > newest) newest = entry.ts;
        }
        for (const entry of scan.frames) {
            if (newest === null || entry.ts > newest) newest = entry.ts;
        }
        for (const bundle of scan.bundles) {
            for (const entry of bundle.entries) {
                if (newest === null || entry.ts > newest) newest = entry.ts;
            }
        }
        return newest;
    }

    function nextSequence(chatDir, timestamp) {
        let next = 0;
        let filenames = [];
        try { filenames = fs.readdirSync(chatDir); } catch {}
        for (const filename of filenames) {
            const parsed = parseVersionFile(filename);
            if (parsed?.ts === timestamp) next = Math.max(next, parsed.seq + 1);
        }
        const scan = scanChatDirectory(chatDir);
        for (const entry of scan.frames) {
            if (entry.ts === timestamp) next = Math.max(next, entry.seq + 1);
        }
        for (const bundle of scan.bundles) {
            for (const entry of bundle.entries) {
                if (entry.ts === timestamp) next = Math.max(next, entry.seq + 1);
            }
        }
        return next;
    }

    function scheduleReconcile() {
        if (!autoReconcile) return;
        if (reconcileTimer !== null) clearTimeout(reconcileTimer);
        reconcileTimer = setTimeout(() => {
            reconcileTimer = null;
            reconcileChatBackups().catch(error => {
                log('error', '[ChatBackups] Reconcile failed:', error);
            });
        }, Math.max(0, reconcileDebounceMs));
        reconcileTimer.unref?.();
    }

    async function captureChatPreImage({
        chaId,
        chatId,
        reason,
        force = false,
        required = false,
    } = {}) {
        try {
            const row = inspectRow(chaId, chatId);
            if (row === null || row === undefined) return 'skipped-no-row';

            if (!force && row.size < 4096) {
                if (row.coldStorage === true) return 'skipped-cold-storage';
                if (row.coldStorage === null || row.coldStorage === undefined) {
                    try {
                        const selected = selectSmallRow(chaId, chatId);
                        if (!selected) return 'skipped-no-row';
                        const decoded = await decodeChat(selected.bytes);
                        const coldStorage = decoded?.message?.[0]?.data
                            ?.startsWith(COLD_STORAGE_HEADER) === true;
                        if (typeof repairChatRowMetadata === 'function'
                            && selected.contentHash !== null) {
                            repairChatRowMetadata(
                                selected,
                                coldStorage,
                                Array.isArray(decoded?.message) ? decoded.message.length : 0,
                            );
                        }
                        if (coldStorage) return 'skipped-cold-storage';
                    } catch (error) {
                        log('warn', '[ChatBackups] Could not inspect a small row for cold storage; preserving it:', error);
                    }
                }
            }

            const chatDir = chatDirectory(chaId, chatId);
            const currentTime = Math.floor(Number(now()));
            if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
                throw new Error('Backup clock returned an invalid timestamp');
            }

            let newest = newestByChatDir.get(chatDir);
            if (newest === undefined) {
                newest = newestTimestampOnDisk(chatDir);
                newestByChatDir.set(chatDir, newest);
            }
            if (!force && newest !== null) {
                const elapsed = currentTime - newest;
                if (elapsed >= 0 && elapsed < Math.max(0, cooldownMs)) {
                    return 'skipped-cooldown';
                }
            }

            fs.mkdirSync(chatDir, { recursive: true });
            const seq = nextSequence(chatDir, currentTime);
            const safeReason = sanitizeBackupReason(reason);
            const filename = `v-${currentTime}-${seq}-${safeReason}.bin`;
            const streamed = await writeFileAtomicFromSource(
                path.join(chatDir, filename),
                (tempPath) => streamRowToFile(chaId, chatId, tempPath),
            );
            if (!streamed) return 'skipped-no-row';
            if (streamed.size !== row.size) {
                throw new Error('Streamed chat pre-image size changed during capture');
            }
            newestByChatDir.set(chatDir, currentTime);
            scheduleReconcile();
            return 'captured';
        } catch (error) {
            log('error', '[ChatBackups] Pre-image capture failed:', error);
            if (required) throw error;
            return 'error';
        }
    }

    function cleanupStaleTemps(directory, options = {}) {
        let entries = [];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return 0; }
        let removed = 0;
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (options.skipRootHistory && entry.name === ROOT_HISTORY_DIRNAME) continue;
                removed += cleanupStaleTemps(fullPath, options);
            } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
                try {
                    fs.unlinkSync(fullPath);
                    removed++;
                } catch {}
            }
        }
        return removed;
    }

    function collectChatDirectories(root) {
        const result = [];
        let charEntries = [];
        try { charEntries = fs.readdirSync(root, { withFileTypes: true }); } catch { return result; }
        for (const charEntry of charEntries) {
            if (!charEntry.isDirectory() || charEntry.name === ROOT_HISTORY_DIRNAME) continue;
            const charDir = path.join(root, charEntry.name);
            let chatEntries = [];
            try { chatEntries = fs.readdirSync(charDir, { withFileTypes: true }); } catch { continue; }
            for (const chatEntry of chatEntries) {
                if (!chatEntry.isDirectory() || chatEntry.name === ROOT_HISTORY_DIRNAME) continue;
                result.push({
                    chaId: decodePathComponent(charEntry.name),
                    chatId: decodePathComponent(chatEntry.name),
                    chatDir: path.join(charDir, chatEntry.name),
                });
            }
        }
        return result;
    }

    function collectChatDirectoriesForReachability(rootRecord) {
        const result = [];
        let charEntries;
        try {
            charEntries = fs.readdirSync(rootRecord.root, { withFileTypes: true });
        } catch (error) {
            if (error?.code === 'ENOENT' && !rootRecord.required) return result;
            throw new Error(
                `Cannot verify retained chat-backup root ${rootRecord.root}: `
                + `${error?.message || error}`,
                { cause: error },
            );
        }
        for (const charEntry of charEntries) {
            if (!charEntry.isDirectory() || charEntry.name === ROOT_HISTORY_DIRNAME) continue;
            const charDir = path.join(rootRecord.root, charEntry.name);
            let chatEntries;
            try {
                chatEntries = fs.readdirSync(charDir, { withFileTypes: true });
            } catch (error) {
                throw new Error(
                    `Cannot verify retained chat-backup directory ${charDir}: `
                    + `${error?.message || error}`,
                    { cause: error },
                );
            }
            for (const chatEntry of chatEntries) {
                if (!chatEntry.isDirectory() || chatEntry.name === ROOT_HISTORY_DIRNAME) continue;
                result.push({
                    chaId: decodePathComponent(charEntry.name),
                    chatId: decodePathComponent(chatEntry.name),
                    chatDir: path.join(charDir, chatEntry.name),
                });
            }
        }
        return result;
    }

    async function inspectRawStream(readable, context = {}) {
        const hash = crypto.createHash('sha256');
        let size = 0;
        if (context.decompress) observe('decompress-start', context);
        try {
            for await (const chunk of readable) {
                size += chunk.length;
                if (!Number.isSafeInteger(size)) throw new Error('Chat backup size exceeds safe limits');
                hash.update(chunk);
                if (context.decompress) {
                    observe('uncompressed-chunk', {
                        ...context,
                        chunkBytes: chunk.length,
                        bufferedFrames: 0,
                    });
                }
            }
            return { size, sha256: hash.digest('hex') };
        } finally {
            if (context.decompress) observe('decompress-end', context);
        }
    }

    async function inspectRawFile(filename) {
        return inspectRawStream(fs.createReadStream(filename));
    }

    function createGunzipReadStream(filename, options) {
        const input = fs.createReadStream(filename, options);
        const gunzip = zlib.createGunzip();
        input.on('error', error => gunzip.destroy(error));
        input.pipe(gunzip);
        return gunzip;
    }

    async function inspectGzipFile(filename, context) {
        const gunzip = createGunzipReadStream(filename);
        return inspectRawStream(gunzip, { ...context, decompress: true });
    }

    async function inspectFramePayload(filename, frame, operation) {
        const end = frame.payloadOffset + frame.compressedBytes - 1;
        const gunzip = createGunzipReadStream(filename, { start: frame.payloadOffset, end });
        return inspectRawStream(gunzip, {
            operation,
            versionId: frame.versionId,
            storage: 'frame',
            decompress: true,
        });
    }

    function frameMetadataMatches(frame, entry, rawInfo) {
        return frame
            && frame.versionId === entry.versionId
            && frame.ts === entry.ts
            && frame.seq === entry.seq
            && frame.reason === entry.reason
            && frame.size === rawInfo.size
            && frame.sha256 === rawInfo.sha256;
    }

    async function verifiedFrameMatches(filename, entry, rawInfo, operation) {
        const frame = readFrameHeader(filename);
        if (!frameMetadataMatches(frame, entry, rawInfo)) return false;
        try {
            const verification = await readWithStableFrameIdentity(
                filename,
                () => inspectFramePayload(filename, frame, operation),
            );
            if (!verification.stable) return false;
            const decoded = verification.value;
            const matches = decoded.size === rawInfo.size && decoded.sha256 === rawInfo.sha256;
            if (matches) {
                rememberVerifiedFrame(filename, frame, decoded, verification.fingerprint);
            }
            return matches;
        } catch {
            return false;
        }
    }

    async function validateFramesInDirectory(chatDir, operation = 'startup-normalize-frame') {
        let verified = 0;
        let failed = 0;
        for (const frame of scanChatDirectory(chatDir).frames) {
            const filename = path.join(chatDir, frame.filename);
            try {
                const verification = await readWithStableFrameIdentity(
                    filename,
                    () => inspectFramePayload(filename, frame, operation),
                );
                if (!verification.stable) {
                    throw new Error(`Frame changed while it was being validated: ${frame.versionId}`);
                }
                const decoded = verification.value;
                if (decoded.size !== frame.size || decoded.sha256 !== frame.sha256) {
                    throw new Error(`Frame payload does not match its header: ${frame.versionId}`);
                }
                rememberVerifiedFrame(filename, frame, decoded, verification.fingerprint);
                verified++;
            } catch (error) {
                verifiedFrameSemantics.delete(path.resolve(filename));
                failed++;
                log('warn', `[ChatBackups] Failed to validate ${frame.filename}:`, error);
            }
        }
        return { verified, failed };
    }

    async function writeFrameFromSource(source, sourceCompressed, destination, entry, rawInfo) {
        ensureDirectoryDurableSync(path.dirname(destination));
        const header = encodeFrameHeader(entry, rawInfo);
        const prefix = framePrefix(header.length);
        const temp = `${destination}.${process.pid}-${tempCounter++}.tmp`;
        let ownsTemp = false;
        try {
            fs.writeFileSync(temp, Buffer.concat([prefix, header]), { flag: 'wx' });
            ownsTemp = true;
            const output = fs.createWriteStream(temp, { flags: 'a' });
            if (sourceCompressed) {
                await pipeline(fs.createReadStream(source), output);
            } else {
                await pipeline(fs.createReadStream(source), zlib.createGzip(), output);
            }

            const payloadOffset = FRAME_PREFIX_BYTES + header.length;
            const compressedBytes = statSize(temp) - payloadOffset;
            const sizeBytes = Buffer.allocUnsafe(8);
            sizeBytes.writeBigUInt64LE(BigInt(compressedBytes));
            let fd;
            try {
                fd = fs.openSync(temp, 'r+');
                fs.writeSync(fd, sizeBytes, 0, sizeBytes.length, 12);
                fs.fsyncSync(fd);
            } finally {
                if (fd !== undefined) fs.closeSync(fd);
            }
            durablePublishTemp(temp, destination);

            if (!await verifiedFrameMatches(
                destination,
                entry,
                rawInfo,
                'reconcile-new-frame',
            )) {
                throw new Error(`Published frame validation failed for ${entry.versionId}`);
            }
            return true;
        } catch (error) {
            if (ownsTemp) {
                try { fs.unlinkSync(temp); } catch {}
            } else if (error?.code === 'EEXIST') {
                error.chatBackupTempCollision = true;
            }
            throw error;
        }
    }

    async function conflictFrameDestination(chatDir, sourceRoot, entry, rawInfo) {
        const relativeChatDir = path.relative(sourceRoot, chatDir);
        const activeRoot = backupsTreeRoot();
        const sourceIsActive = path.resolve(sourceRoot) === path.resolve(activeRoot)
            || rootsReferToSameDirectory(sourceRoot, activeRoot);
        // Active-source recovery is eligible to retain the original public ID
        // if its invalid/divergent ordinary destination disappears. Derived
        // copies of non-active sources use a distinct 20-hex namespace and
        // never outrank their source's stable alias.
        const contentKey = rawInfo.sha256.slice(0, sourceIsActive ? 16 : 20);
        for (let attempt = 0; ; attempt++) {
            const namespace = attempt === 0 ? contentKey : `${contentKey}-${attempt}`;
            const destination = path.join(
                backupsTreeRoot(),
                ROOT_HISTORY_DIRNAME,
                namespace,
                relativeChatDir,
                `${entry.versionId}.frame`,
            );
            if (!fs.existsSync(destination)) return { destination, existing: false };
            if (await verifiedFrameMatches(
                destination,
                entry,
                rawInfo,
                'reconcile-existing-conflict-frame',
            )) return { destination, existing: true };
        }
    }

    function finalizeNormalizedSource(source, policy, details) {
        observe('normalization-source-finalize', {
            ...details,
            source,
            retainSource: policy.retainSource,
        });
        if (policy.retainSource) return false;
        unlinkAndSync(source);
        return true;
    }

    async function createFrameFromLoose(
        chatDir,
        entry,
        sourceRoot = backupsTreeRoot(),
        policy = { retainSource: false },
    ) {
        const source = path.join(chatDir, entry.filename);
        const normalDestination = path.join(chatDir, `${entry.versionId}.frame`);
        const rawInfo = entry.compressed
            ? await inspectGzipFile(source, {
                operation: 'reconcile-source',
                versionId: entry.versionId,
                storage: 'legacy-loose-gzip',
            })
            : await inspectRawFile(source);
        rememberVerifiedSourceSemantic([source], entry.versionId, rawInfo);

        if (await verifiedFrameMatches(
            normalDestination,
            entry,
            rawInfo,
            'reconcile-existing-frame',
        )) {
            const sourceRemoved = finalizeNormalizedSource(source, policy, {
                sourceStorage: entry.compressed ? 'loose-gzip' : 'loose',
                versionId: entry.versionId,
            });
            return { created: false, sourceRemoved, conflicted: false };
        }

        let destination = normalDestination;
        let conflicted = fs.existsSync(normalDestination);
        if (conflicted) {
            const selected = await conflictFrameDestination(chatDir, sourceRoot, entry, rawInfo);
            if (selected.existing) {
                const sourceRemoved = finalizeNormalizedSource(source, policy, {
                    sourceStorage: entry.compressed ? 'loose-gzip' : 'loose',
                    versionId: entry.versionId,
                });
                return { created: false, sourceRemoved, conflicted: true };
            }
            destination = selected.destination;
        }
        ensureDirectoryDurableSync(path.dirname(destination));
        try {
            await writeFrameFromSource(source, entry.compressed, destination, entry, rawInfo);
        } catch (error) {
            if (error?.code !== 'EEXIST' || error?.chatBackupTempCollision) throw error;
            if (await verifiedFrameMatches(
                destination,
                entry,
                rawInfo,
                'reconcile-raced-frame',
            )) {
                const sourceRemoved = finalizeNormalizedSource(source, policy, {
                    sourceStorage: entry.compressed ? 'loose-gzip' : 'loose',
                    versionId: entry.versionId,
                });
                return { created: false, sourceRemoved, conflicted };
            }
            const selected = await conflictFrameDestination(chatDir, sourceRoot, entry, rawInfo);
            if (!selected.existing) {
                await writeFrameFromSource(
                    source,
                    entry.compressed,
                    selected.destination,
                    entry,
                    rawInfo,
                );
            }
            conflicted = true;
        }
        const sourceRemoved = finalizeNormalizedSource(source, policy, {
            sourceStorage: entry.compressed ? 'loose-gzip' : 'loose',
            versionId: entry.versionId,
        });
        return { created: true, sourceRemoved, conflicted };
    }

    async function createFramesFromLoose(
        chatDir,
        sourceRoot = backupsTreeRoot(),
        policy = { retainSource: false },
    ) {
        let converted = 0;
        let created = 0;
        let conflicted = 0;
        let filenames = [];
        try { filenames = fs.readdirSync(chatDir); }
        catch { return { converted, created, conflicted }; }
        const entries = filenames
            .map(parseVersionFile)
            .filter(Boolean)
            .sort(compareVersionsOldest);
        for (const entry of entries) {
            try {
                const result = await createFrameFromLoose(chatDir, entry, sourceRoot, policy);
                if (result.sourceRemoved) converted++;
                if (result.created) created++;
                if (result.conflicted) conflicted++;
            } catch (error) {
                log('warn', `[ChatBackups] Failed to frame ${entry.filename}:`, error);
            }
        }
        return { converted, created, conflicted };
    }

    async function publishExtractedTemp(temp, destination, chatDir, entry, sourceRoot) {
        if (fs.existsSync(destination)) {
            if (filesHaveIdenticalBytes(temp, destination)) {
                fs.unlinkSync(temp);
                return;
            }
            const rawInfo = await inspectRawFile(temp);
            const selected = await conflictFrameDestination(
                chatDir,
                sourceRoot,
                entry,
                rawInfo,
            );
            if (!selected.existing) {
                ensureDirectoryDurableSync(path.dirname(selected.destination));
                await writeFrameFromSource(
                    temp,
                    false,
                    selected.destination,
                    entry,
                    rawInfo,
                );
            }
            fs.unlinkSync(temp);
            return;
        }
        try {
            durablePublishTemp(temp, destination);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            return publishExtractedTemp(temp, destination, chatDir, entry, sourceRoot);
        }
    }

    async function migrateLegacyBundleToLoose(
        chatDir,
        bundle,
        sourceRoot = backupsTreeRoot(),
        policy = { retainSource: false },
    ) {
        const ordered = [...bundle.entries].sort((a, b) => a.offset - b.offset
            || compareVersionsOldest(a, b));
        let previousEnd = 0;
        for (const entry of ordered) {
            const end = entry.offset + entry.size;
            if (!Number.isSafeInteger(end) || entry.offset < previousEnd) {
                throw new Error(`Bundle ${bundle.bundleFile} has overlapping or invalid ranges`);
            }
            previousEnd = end;
        }

        let index = 0;
        let absoluteOffset = 0;
        let current = null;

        async function openCurrent(entry) {
            if (current) return current;
            const destination = path.join(chatDir, `${entry.versionId}.bin`);
            const temp = `${destination}.${process.pid}-${tempCounter++}.tmp`;
            current = {
                entry,
                destination,
                temp,
                handle: await fs.promises.open(temp, 'wx'),
                written: 0,
            };
            return current;
        }

        async function finishCurrent() {
            if (!current || current.written !== current.entry.size) return;
            const completed = current;
            await completed.handle.sync();
            await completed.handle.close();
            const rawInfo = await inspectRawFile(completed.temp);
            await publishExtractedTemp(
                completed.temp,
                completed.destination,
                chatDir,
                completed.entry,
                sourceRoot,
            );
            rememberVerifiedSourceSemantic(
                [bundlePath, path.join(chatDir, bundle.metaFile)],
                completed.entry.versionId,
                rawInfo,
            );
            current = null;
            index++;
        }

        async function finishZeroLengthEntries(upToOffset) {
            while (index < ordered.length
                && ordered[index].size === 0
                && ordered[index].offset <= upToOffset) {
                await openCurrent(ordered[index]);
                await finishCurrent();
            }
        }

        const bundlePath = path.join(chatDir, bundle.bundleFile);
        const gunzip = createGunzipReadStream(bundlePath);
        observe('decompress-start', {
            operation: 'legacy-migration',
            storage: 'legacy-bundle',
            bundleFile: bundle.bundleFile,
        });
        try {
            for await (const chunk of gunzip) {
                const chunkStart = absoluteOffset;
                const chunkEnd = chunkStart + chunk.length;
                observe('uncompressed-chunk', {
                    operation: 'legacy-migration',
                    storage: 'legacy-bundle',
                    bundleFile: bundle.bundleFile,
                    chunkBytes: chunk.length,
                    bufferedFrames: current ? 1 : 0,
                });
                await finishZeroLengthEntries(chunkStart);
                while (index < ordered.length && ordered[index].offset < chunkEnd) {
                    const entry = ordered[index];
                    const entryEnd = entry.offset + entry.size;
                    if (entryEnd <= chunkStart) {
                        throw new Error(`Bundle ${bundle.bundleFile} ended an entry unexpectedly`);
                    }
                    const overlapStart = Math.max(entry.offset, chunkStart);
                    const overlapEnd = Math.min(entryEnd, chunkEnd);
                    const state = await openCurrent(entry);
                    const slice = chunk.subarray(overlapStart - chunkStart, overlapEnd - chunkStart);
                    if (slice.length > 0) {
                        let sliceOffset = 0;
                        while (sliceOffset < slice.length) {
                            const result = await state.handle.write(slice.subarray(sliceOffset));
                            if (result.bytesWritten <= 0) {
                                throw new Error(`Could not extract ${entry.versionId}`);
                            }
                            sliceOffset += result.bytesWritten;
                            state.written += result.bytesWritten;
                        }
                    }
                    if (state.written === entry.size) await finishCurrent();
                    else break;
                }
                absoluteOffset = chunkEnd;
            }
            await finishZeroLengthEntries(absoluteOffset);
            if (current || index !== ordered.length || absoluteOffset < previousEnd) {
                throw new Error(`Bundle ${bundle.bundleFile} ended before all entries were extracted`);
            }
        } catch (error) {
            if (current) {
                try { await current.handle.close(); } catch {}
                try { fs.unlinkSync(current.temp); } catch {}
                current = null;
            }
            throw error;
        } finally {
            observe('decompress-end', {
                operation: 'legacy-migration',
                storage: 'legacy-bundle',
                bundleFile: bundle.bundleFile,
            });
        }

        // Active-root compaction may withdraw a bundle only after every raw
        // entry is durable. Federated historical/protected roots are retained:
        // no compare-then-unlink protocol can protect a peer replacement.
        observe('normalization-source-finalize', {
            source: bundlePath,
            metadataSource: path.join(chatDir, bundle.metaFile),
            sourceStorage: 'legacy-bundle',
            bundleFile: bundle.bundleFile,
            retainSource: policy.retainSource,
        });
        const bundleSources = [bundlePath, path.join(chatDir, bundle.metaFile)];
        const sourceChanged = policy.retainSource && ordered.some(entry => (
            knownVerifiedSourceSemantic(bundleSources, entry.versionId) === null
        ));
        if (!policy.retainSource) {
            unlinkAndSync(path.join(chatDir, bundle.metaFile));
            try { unlinkAndSync(bundlePath); } catch {}
        }
        return { sourceChanged };
    }

    async function migrateLegacyBundles(
        chatDir,
        sourceRoot = backupsTreeRoot(),
        policy = { retainSource: false },
    ) {
        let migrated = 0;
        let sourcesChanged = 0;
        const bundles = scanChatDirectory(chatDir).bundles;
        for (const bundle of bundles) {
            try {
                const result = await migrateLegacyBundleToLoose(
                    chatDir,
                    bundle,
                    sourceRoot,
                    policy,
                );
                migrated++;
                if (result.sourceChanged) sourcesChanged++;
            } catch (error) {
                log('warn', `[ChatBackups] Failed to migrate ${bundle.bundleFile}:`, error);
            }
        }
        return { migrated, sourcesChanged };
    }

    function uniqueVersions(scan) {
        const byId = new Map();
        for (const bundle of scan.bundles) {
            for (const entry of bundle.entries) byId.set(entry.versionId, entry);
        }
        for (const entry of scan.frames) byId.set(entry.versionId, entry);
        for (const entry of scan.loose) byId.set(entry.versionId, entry);
        return [...byId.values()].sort(compareVersionsOldest);
    }

    async function removeVersionEverywhere(chatDir, versionId) {
        let legacyBundlesMigrated = 0;
        const legacyClaims = scanChatDirectory(chatDir).bundles
            .filter(bundle => bundle.entries.some(entry => entry.versionId === versionId));
        for (const bundle of legacyClaims) {
            await migrateLegacyBundleToLoose(chatDir, bundle);
            legacyBundlesMigrated++;
        }

        let deleted = false;
        for (const suffix of ['.bin', '.bin.gz', '.frame']) {
            const filename = path.join(chatDir, `${versionId}${suffix}`);
            if (!fs.existsSync(filename)) continue;
            try {
                observe('version-delete', {
                    versionId,
                    storage: suffix === '.frame' ? 'frame' : 'loose',
                    filename: path.basename(filename),
                });
                unlinkAndSync(filename);
                deleted = true;
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        return { deleted, legacyBundlesMigrated };
    }

    async function enforceChatVersionLimit(chatDir) {
        let versionsRemoved = 0;
        let bundlesRemoved = 0;
        let bundlesRewritten = 0;
        let uncompressedVersionsRemoved = 0;
        const maxUncompressedBytes = clampInteger(
            getUncompressedByteBudget(),
            CHAT_BACKUP_DEFAULT_MAX_UNCOMPRESSED_BYTES,
            uncompressedByteBudgetMin,
            uncompressedByteBudgetMax,
        );

        while (true) {
            const versions = uniqueVersions(scanChatDirectory(chatDir));
            const uncompressedBytes = versions.reduce((total, entry) => total + entry.size, 0);
            const overCount = versions.length > versionLimit;
            const overUncompressed = uncompressedBytes > maxUncompressedBytes;
            // Match global-budget behavior by retaining the newest recovery
            // point even when that one frame alone exceeds an operator cap.
            if ((!overCount && !overUncompressed) || versions.length <= 1) {
                return {
                    versionsRemoved,
                    bundlesRemoved,
                    bundlesRewritten,
                    uncompressedVersionsRemoved,
                    uncompressedBytes,
                    maxUncompressedBytes,
                };
            }

            const oldest = versions[0];
            try {
                const result = await removeVersionEverywhere(chatDir, oldest.versionId);
                const stillPresent = uniqueVersions(scanChatDirectory(chatDir))
                    .some(entry => entry.versionId === oldest.versionId);
                if (!result.deleted || stillPresent) throw new Error(`Could not remove ${oldest.versionId}`);
                versionsRemoved++;
                bundlesRemoved += result.legacyBundlesMigrated;
                if (overUncompressed) uncompressedVersionsRemoved++;
            } catch (error) {
                log('warn', `[ChatBackups] Failed to enforce version limit in ${chatDir}:`, error);
                const remaining = uniqueVersions(scanChatDirectory(chatDir));
                return {
                    versionsRemoved,
                    bundlesRemoved,
                    bundlesRewritten,
                    uncompressedVersionsRemoved,
                    uncompressedBytes: remaining.reduce((total, entry) => total + entry.size, 0),
                    maxUncompressedBytes,
                };
            }
        }
    }

    function treeBytes(directory) {
        let entries = [];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return 0; }
        let total = 0;
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) total += treeBytes(fullPath);
            else if (entry.isFile()) total += statSize(fullPath);
        }
        return total;
    }

    async function enforceGlobalBudget(root, chatDirs) {
        let totalBytes = treeBytes(root);
        const maxBytes = clampInteger(
            getByteBudget(),
            CHAT_BACKUP_DEFAULT_MAX_BYTES,
            byteBudgetMin,
            byteBudgetMax,
        );
        if (totalBytes <= maxBytes) return { removed: 0, totalBytes, maxBytes };

        const evictable = [];
        for (const { chatDir } of chatDirs) {
            const scan = scanChatDirectory(chatDir);
            const allVersions = uniqueVersions(scan);
            const newestId = allVersions.at(-1)?.versionId ?? null;

            for (const entry of allVersions) {
                if (entry.versionId === newestId) continue;
                evictable.push({
                    chatDir,
                    entry,
                    age: entry,
                    versionCount: 1,
                    name: entry.versionId,
                });
            }
        }

        // Independent frames let the disk budget preserve strict global oldest-
        // first ordering without discarding newer neighbors from one container.
        evictable.sort((a, b) => compareVersionsOldest(a.age, b.age)
            || a.versionCount - b.versionCount
            || a.chatDir.localeCompare(b.chatDir)
            || a.name.localeCompare(b.name));

        let removed = 0;
        for (const item of evictable) {
            if (totalBytes <= maxBytes) break;
            try {
                const result = await removeVersionEverywhere(
                    item.chatDir,
                    item.entry.versionId,
                );
                totalBytes = treeBytes(root);
                if (result.deleted) removed++;
            } catch (error) {
                log('warn', `[ChatBackups] Failed to evict ${item.entry.versionId}:`, error);
            }
        }
        return { removed, totalBytes, maxBytes };
    }

    function pruneEmptyDirectories(directory, keepRoot = directory) {
        if (path.resolve(directory) === path.resolve(path.join(keepRoot, ROOT_HISTORY_DIRNAME))) {
            return;
        }
        let entries = [];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                pruneEmptyDirectories(path.join(directory, entry.name), keepRoot);
            }
        }
        if (directory === keepRoot) return;
        try {
            if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
        } catch {}
    }

    async function reconcileOnDisk() {
        const root = backupsTreeRoot();
        fs.mkdirSync(root, { recursive: true });
        const stats = {
            staleTempsRemoved: cleanupStaleTemps(root, { skipRootHistory: true }),
            gzipped: 0,
            framesCreated: 0,
            bundlesCreated: 0,
            bundlesRotated: 0,
            legacyBundlesMigrated: 0,
            versionsTrimmed: 0,
            uncompressedVersionsTrimmed: 0,
            totalUncompressedBytes: 0,
            maxUncompressedBytes: 0,
            budgetItemsRemoved: 0,
            totalBytes: 0,
            maxBytes: 0,
        };

        const chatDirs = collectChatDirectories(root);
        for (const { chatDir } of chatDirs) {
            const initialFrames = await createFramesFromLoose(chatDir);
            stats.gzipped += initialFrames.converted;
            stats.framesCreated += initialFrames.created;
            const legacy = await migrateLegacyBundles(chatDir);
            stats.legacyBundlesMigrated += legacy.migrated;
            stats.bundlesRotated += legacy.migrated;
            const migratedFrames = await createFramesFromLoose(chatDir);
            stats.gzipped += migratedFrames.converted;
            stats.framesCreated += migratedFrames.created;
            await validateFramesInDirectory(chatDir, 'reconcile-frame-validation');
            const retention = await enforceChatVersionLimit(chatDir);
            stats.versionsTrimmed += retention.versionsRemoved;
            stats.bundlesRotated += retention.bundlesRemoved;
            stats.uncompressedVersionsTrimmed += retention.uncompressedVersionsRemoved;
            stats.totalUncompressedBytes += retention.uncompressedBytes;
            stats.maxUncompressedBytes = retention.maxUncompressedBytes;
        }
        const budget = await enforceGlobalBudget(root, chatDirs);
        stats.budgetItemsRemoved = budget.removed;
        stats.totalBytes = budget.totalBytes;
        stats.maxBytes = budget.maxBytes;
        pruneEmptyDirectories(root);
        return stats;
    }

    async function normalizeFederatedHistoryOnDisk() {
        const stats = {
            rootsVisited: 0,
            staleTempsRemoved: 0,
            looseVersionsConverted: 0,
            framesCreated: 0,
            conflictsPreserved: 0,
            legacyBundlesMigrated: 0,
            framesVerified: 0,
            framesInvalid: 0,
        };
        // Resolve the read federation once. Conflict namespaces created during
        // this pass already contain payload-verified frames.
        for (const rootRecord of backupsReadRootRecords()) {
            const root = rootRecord.root;
            let rootStat;
            try { rootStat = fs.statSync(root); }
            catch { continue; }
            if (!rootStat.isDirectory()) continue;
            stats.rootsVisited++;
            const policy = { retainSource: !rootRecord.active };
            if (rootRecord.active) {
                stats.staleTempsRemoved += cleanupStaleTemps(root, {
                    skipRootHistory: true,
                });
            }
            for (const { chatDir } of collectChatDirectories(root)) {
                const initialFrames = await createFramesFromLoose(chatDir, root, policy);
                stats.looseVersionsConverted += initialFrames.converted;
                stats.framesCreated += initialFrames.created;
                stats.conflictsPreserved += initialFrames.conflicted;
                const legacy = await migrateLegacyBundles(chatDir, root, policy);
                stats.legacyBundlesMigrated += legacy.migrated;
                const migratedFrames = await createFramesFromLoose(chatDir, root, policy);
                stats.looseVersionsConverted += migratedFrames.converted;
                stats.framesCreated += migratedFrames.created;
                stats.conflictsPreserved += migratedFrames.conflicted;
                if (policy.retainSource && legacy.sourcesChanged > 0) {
                    const retriedLegacy = await migrateLegacyBundles(chatDir, root, policy);
                    stats.legacyBundlesMigrated += retriedLegacy.migrated;
                    const retriedFrames = await createFramesFromLoose(chatDir, root, policy);
                    stats.looseVersionsConverted += retriedFrames.converted;
                    stats.framesCreated += retriedFrames.created;
                    stats.conflictsPreserved += retriedFrames.conflicted;
                }
                const validation = await validateFramesInDirectory(chatDir);
                stats.framesVerified += validation.verified;
                stats.framesInvalid += validation.failed;
            }
        }
        return stats;
    }

    function reconcileChatBackups() {
        const operation = () => reconcileOnDisk();
        if (typeof runStorageOperation === 'function') {
            return Promise.resolve().then(() => (
                runStorageOperation(operation, 'chat-backup-reconcile')
            ));
        }
        const run = localReconcileQueue.then(operation, operation);
        localReconcileQueue = run.catch(() => {});
        return run;
    }

    function normalizeChatBackups() {
        const operation = () => normalizeFederatedHistoryOnDisk();
        if (typeof runStorageOperation === 'function') {
            return Promise.resolve().then(() => (
                runStorageOperation(operation, 'chat-backup-normalize-history')
            ));
        }
        const run = localReconcileQueue.then(operation, operation);
        localReconcileQueue = run.catch(() => {});
        return run;
    }

    function versionsFromChatDirectoryScan(chatDir, scan, { strict = false } = {}) {
        const versions = [];

        for (const bundle of scan.bundles) {
            for (const entry of bundle.entries) {
                const sourceFiles = [bundle.bundleFile, bundle.metaFile];
                versions.push({
                    versionId: entry.versionId,
                    ts: entry.ts,
                    reason: entry.reason,
                    size: entry.size,
                    storage: 'bundle',
                    bundleFile: bundle.bundleFile,
                    sourceStorage: 'legacy-bundle',
                    sourceFiles,
                    seq: entry.seq,
                    semanticIdentity: knownVerifiedSourceSemantic(
                        sourceFiles.map(filename => path.join(chatDir, filename)),
                        entry.versionId,
                    ),
                });
            }
        }
        for (const entry of scan.frames) {
            const filename = path.join(chatDir, entry.filename);
            versions.push({
                versionId: entry.versionId,
                ts: entry.ts,
                reason: entry.reason,
                size: entry.size,
                storage: 'bundle',
                bundleFile: entry.filename,
                sourceStorage: 'frame',
                sourceFiles: [entry.filename],
                seq: entry.seq,
                semanticIdentity: knownVerifiedFrameSemantic(filename, entry),
            });
        }
        for (const entry of scan.loose) {
            const filename = path.join(chatDir, entry.filename);
            let semanticIdentity = null;
            if (!entry.compressed) {
                try {
                    semanticIdentity = `${entry.size}:${hashFileBytes(filename)}`;
                } catch (error) {
                    if (strict) {
                        throw new Error(
                            `Cannot verify retained loose chat backup ${filename}: `
                            + `${error?.message || error}`,
                            { cause: error },
                        );
                    }
                }
            } else {
                semanticIdentity = knownVerifiedSourceSemantic([filename], entry.versionId);
            }
            versions.push({
                versionId: entry.versionId,
                ts: entry.ts,
                reason: entry.reason,
                size: entry.size,
                storage: 'loose',
                sourceStorage: entry.compressed ? 'loose-gzip' : 'loose',
                sourceFiles: [entry.filename],
                seq: entry.seq,
                semanticIdentity,
            });
        }

        return versions;
    }

    function versionsInChatDirectory(chatDir) {
        return versionsFromChatDirectoryScan(chatDir, scanChatDirectory(chatDir));
    }

    function hashFileBytes(filename) {
        const hash = crypto.createHash('sha256');
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let fd;
        try {
            fd = fs.openSync(filename, 'r');
            let offset = 0;
            while (true) {
                const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
                if (read === 0) break;
                hash.update(chunk.subarray(0, read));
                offset += read;
            }
            return hash.digest('hex');
        } finally {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch {}
            }
        }
    }

    function physicalCandidateIdentity(candidate) {
        const hash = crypto.createHash('sha256');
        for (const filename of candidate.sourceFiles) {
            hash.update(filename);
            hash.update('\0');
            try { hash.update(hashFileBytes(path.join(candidate.chatDir, filename))); }
            catch { hash.update('unreadable'); }
            hash.update('\0');
        }
        return hash.digest('hex');
    }

    function versionFilesMatch(first, second) {
        if (first.semanticIdentity && first.semanticIdentity === second.semanticIdentity) {
            return true;
        }
        if (first.sourceStorage !== second.sourceStorage
            || first.sourceFiles.length !== second.sourceFiles.length) return false;
        return first.sourceFiles.every((filename, index) => (
            filesHaveIdenticalBytes(
                path.join(first.chatDir, filename),
                path.join(second.chatDir, second.sourceFiles[index]),
            )
        ));
    }

    function resolveChatBackupVersions(chaId, chatId) {
        const candidates = backupsReadRootRecords().flatMap((rootRecord) => {
            const chatDir = chatDirectoryAt(rootRecord.root, chaId, chatId);
            return versionsInChatDirectory(chatDir).map(entry => ({
                ...entry,
                chatDir,
                rootIdentity: rootRecord.identity,
                activeRoot: rootRecord.active,
                originalEligible: rootRecord.originalEligible,
                sourceVersionId: entry.versionId,
            }));
        });
        const reservedIds = new Set(candidates.map(entry => entry.sourceVersionId));
        const acceptedBySourceId = new Map();
        const resolved = [];

        for (const candidate of candidates) {
            candidate.candidateIdentity = crypto.createHash('sha256')
                .update(candidate.sourceVersionId)
                .update('\0')
                .update(candidate.semanticIdentity ?? physicalCandidateIdentity(candidate))
                .digest('hex');
        }

        for (const candidate of candidates.sort((a, b) => (
            Number(b.activeRoot) - Number(a.activeRoot)
            || Number(b.originalEligible) - Number(a.originalEligible)
            || a.candidateIdentity.localeCompare(b.candidateIdentity)
        ))) {
            const siblings = acceptedBySourceId.get(candidate.sourceVersionId) ?? [];
            if (siblings.some(existing => versionFilesMatch(existing, candidate))) continue;

            let publicVersionId = candidate.sourceVersionId;
            if (!candidate.originalEligible || siblings.length > 0) {
                let salt = 0;
                do {
                    const digest = crypto.createHash('sha256')
                        .update(candidate.candidateIdentity)
                        .update(`:${salt++}`)
                        .digest('hex');
                    const sequence = Number.parseInt(digest.slice(0, 13), 16);
                    publicVersionId = `v-${candidate.ts}-${sequence}-${candidate.reason}`;
                } while (reservedIds.has(publicVersionId));
                if (!parseVersionId(publicVersionId)) {
                    throw new Error('Could not derive a safe chat-backup conflict alias');
                }
                reservedIds.add(publicVersionId);
            }
            const accepted = { ...candidate, publicVersionId };
            siblings.push(accepted);
            acceptedBySourceId.set(candidate.sourceVersionId, siblings);
            resolved.push(accepted);
        }

        return resolved.sort((a, b) => compareVersionsOldest(
            { ...b, versionId: b.publicVersionId },
            { ...a, versionId: a.publicVersionId },
        ));
    }

    function listChatBackups(chaId, chatId) {
        return resolveChatBackupVersions(chaId, chatId)
            .map(({
                publicVersionId,
                ts,
                reason,
                size,
                storage,
                bundleFile,
            }) => ({
                versionId: publicVersionId,
                ts,
                reason,
                size,
                storage,
                ...(bundleFile ? { bundleFile } : {}),
            }));
    }

    function listChatBackupChats() {
        const chatIdentities = new Map();
        for (const root of backupsReadRoots()) {
            for (const item of collectChatDirectories(root)) {
                if (item.chaId === null || item.chatId === null) continue;
                const key = JSON.stringify([item.chaId, item.chatId]);
                const current = chatIdentities.get(key) ?? {
                    chaId: item.chaId,
                    chatId: item.chatId,
                    chatDirs: [],
                };
                current.chatDirs.push(item.chatDir);
                chatIdentities.set(key, current);
            }
        }
        const summaries = [];
        for (const item of chatIdentities.values()) {
            const versions = listChatBackups(item.chaId, item.chatId);
            if (versions.length === 0) continue;
            summaries.push({
                chaId: item.chaId,
                chatId: item.chatId,
                versionCount: versions.length,
                newestTs: versions[0].ts,
                oldestTs: versions[versions.length - 1].ts,
                totalBytes: item.chatDirs.reduce(
                    (total, chatDir) => total + treeBytes(chatDir),
                    0,
                ),
            });
        }
        return summaries.sort((a, b) => b.newestTs - a.newestTs
            || a.chaId.localeCompare(b.chaId)
            || a.chatId.localeCompare(b.chatId));
    }

    /**
     * Visit every independently restorable version across the active and
     * federated historical roots. Callers use this for reachability proofs
     * that must cover recovery history as well as the live chat-row store.
     *
     * A listed version becoming unreadable is an error here rather than a
     * missing result: treating unreadable retained history as empty would let
     * a destructive cleanup sever references that become visible again after
     * the underlying path or file recovers.
     */
    async function scanChatBackupVersions(visitor) {
        if (typeof visitor !== 'function') {
            throw new TypeError('chat-backup version visitor must be a function');
        }

        const candidates = [];
        const rootRecords = backupsReadRootRecords({ strictReachability: true });
        observe('reachability-roots-discovered', {
            roots: rootRecords.map(record => ({
                root: record.root,
                identity: record.identity,
                required: record.required,
            })),
        });
        for (const rootRecord of rootRecords) {
            for (const item of collectChatDirectoriesForReachability(rootRecord)) {
                if (item.chaId === null || item.chatId === null) continue;
                const scan = scanChatDirectoryForReachability(item.chatDir);
                for (const entry of versionsFromChatDirectoryScan(
                    item.chatDir,
                    scan,
                    { strict: true },
                )) {
                    candidates.push({
                        ...entry,
                        chaId: item.chaId,
                        chatId: item.chatId,
                        chatDir: item.chatDir,
                        rootIdentity: rootRecord.identity,
                        sourceVersionId: entry.versionId,
                    });
                }
            }
        }

        candidates.sort((left, right) => (
            left.chaId.localeCompare(right.chaId)
            || left.chatId.localeCompare(right.chatId)
            || compareVersionsOldest(left, right)
            || left.rootIdentity.localeCompare(right.rootIdentity)
        ));
        observe('reachability-inventory-complete', {
            totalCandidates: candidates.length,
            totalDirectories: new Set(candidates.map(candidate => candidate.chatDir)).size,
        });
        let totalVersions = 0;
        for (const candidate of candidates) {
            const raw = await readChatBackupCandidate(candidate);
            if (raw === null) {
                throw new Error(
                    `Cannot verify retained chat backup ${candidate.chaId}/${candidate.chatId}`
                    + `/${candidate.sourceVersionId}`,
                );
            }
            await visitor(raw, {
                chaId: candidate.chaId,
                chatId: candidate.chatId,
                versionId: candidate.sourceVersionId,
                sourceVersionId: candidate.sourceVersionId,
                storage: candidate.sourceStorage,
                rootIdentity: candidate.rootIdentity,
            });
            totalVersions++;
        }
        return { totalVersions };
    }

    async function readDecodedToBuffer(readable, expectedSize, context, expectedSha256 = null) {
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
            throw new Error('Chat backup frame has an invalid raw size');
        }
        const output = Buffer.allocUnsafe(expectedSize);
        const hash = expectedSha256 ? crypto.createHash('sha256') : null;
        let offset = 0;
        observe('decompress-start', context);
        observe('uncompressed-state', {
            ...context,
            bufferedFrames: 1,
            bufferedBytes: expectedSize,
        });
        try {
            for await (const chunk of readable) {
                if (offset + chunk.length > output.length) {
                    throw new Error('Chat backup decompressed beyond its declared size');
                }
                chunk.copy(output, offset);
                offset += chunk.length;
                hash?.update(chunk);
                observe('uncompressed-chunk', {
                    ...context,
                    chunkBytes: chunk.length,
                    bufferedFrames: 1,
                });
            }
            if (offset !== output.length) {
                throw new Error('Chat backup ended before its declared size');
            }
            if (expectedSha256 && hash.digest('hex') !== expectedSha256) {
                throw new Error('Chat backup frame checksum mismatch');
            }
            return output;
        } finally {
            observe('uncompressed-state', {
                ...context,
                bufferedFrames: 0,
                bufferedBytes: 0,
            });
            observe('decompress-end', context);
        }
    }

    async function readGzipVersion(filename, expectedSize, context, expectedSha256 = null) {
        const gunzip = createGunzipReadStream(filename);
        return readDecodedToBuffer(gunzip, expectedSize, context, expectedSha256);
    }

    async function readLegacyBundleEntry(chatDir, bundle, entry) {
        const output = Buffer.allocUnsafe(entry.size);
        let copied = 0;
        let absoluteOffset = 0;
        const entryEnd = entry.offset + entry.size;
        const context = {
            operation: 'read',
            versionId: entry.versionId,
            storage: 'legacy-bundle',
            bundleFile: bundle.bundleFile,
        };
        const gunzip = createGunzipReadStream(path.join(chatDir, bundle.bundleFile));
        observe('decompress-start', context);
        observe('uncompressed-state', {
            ...context,
            bufferedFrames: 1,
            bufferedBytes: entry.size,
        });
        try {
            for await (const chunk of gunzip) {
                const chunkStart = absoluteOffset;
                const chunkEnd = chunkStart + chunk.length;
                const overlapStart = Math.max(entry.offset, chunkStart);
                const overlapEnd = Math.min(entryEnd, chunkEnd);
                if (overlapStart < overlapEnd) {
                    const slice = chunk.subarray(
                        overlapStart - chunkStart,
                        overlapEnd - chunkStart,
                    );
                    slice.copy(output, copied);
                    copied += slice.length;
                }
                absoluteOffset = chunkEnd;
                observe('uncompressed-chunk', {
                    ...context,
                    chunkBytes: chunk.length,
                    bufferedFrames: 1,
                });
            }
            if (copied !== entry.size) {
                throw new Error(`Legacy bundle ${bundle.bundleFile} has an invalid entry range`);
            }
            return output;
        } finally {
            observe('uncompressed-state', {
                ...context,
                bufferedFrames: 0,
                bufferedBytes: 0,
            });
            observe('decompress-end', context);
        }
    }

    async function readChatBackupCandidate(candidate) {
        const {
            chatDir,
            sourceVersionId: versionId,
            sourceStorage,
            sourceFiles,
        } = candidate;
        try {
            if (sourceStorage === 'loose') {
                return await fs.promises.readFile(path.join(chatDir, sourceFiles[0]));
            }
            if (sourceStorage === 'loose-gzip') {
                const gzipPath = path.join(chatDir, sourceFiles[0]);
                return await readGzipVersion(gzipPath, candidate.size, {
                    operation: 'read',
                    versionId,
                    storage: 'legacy-loose-gzip',
                });
            }
        } catch (error) {
            log('warn', `[ChatBackups] Failed to read loose version ${versionId}:`, error);
            return null;
        }

        if (sourceStorage === 'frame') {
            const framePath = path.join(chatDir, sourceFiles[0]);
            let lastError = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                const frame = readFrameHeader(framePath);
                if (!frame || frame.versionId !== versionId) {
                    lastError = new Error(`Frame header changed while reading ${versionId}`);
                    continue;
                }
                try {
                    const verification = await readWithStableFrameIdentity(
                        framePath,
                        async () => {
                            const end = frame.payloadOffset + frame.compressedBytes - 1;
                            const gunzip = createGunzipReadStream(framePath, {
                                start: frame.payloadOffset,
                                end,
                            });
                            return readDecodedToBuffer(gunzip, frame.size, {
                                operation: 'read',
                                versionId,
                                storage: 'frame',
                                frameFile: frame.filename,
                            }, frame.sha256);
                        },
                    );
                    if (!verification.stable) {
                        lastError = new Error(`Frame changed while reading ${versionId}`);
                        continue;
                    }
                    rememberVerifiedFrame(
                        framePath,
                        frame,
                        frame,
                        verification.fingerprint,
                    );
                    return verification.value;
                } catch (error) {
                    lastError = error;
                }
            }
            log('warn', `[ChatBackups] Failed to read framed version ${versionId}:`, lastError);
            return null;
        }

        if (sourceStorage === 'legacy-bundle') {
            const bundle = readBundleMeta(chatDir, candidate.bundleFile);
            const entry = bundle?.entries.find(item => item.versionId === versionId);
            if (!bundle || !entry) return null;
            try {
                return await readLegacyBundleEntry(chatDir, bundle, entry);
            } catch (error) {
                log('warn', `[ChatBackups] Failed to read bundled version ${versionId}:`, error);
                return null;
            }
        }
        return null;
    }

    async function readChatBackup(chaId, chatId, versionId) {
        if (!parseVersionId(versionId)) return null;
        const selected = resolveChatBackupVersions(chaId, chatId)
            .find(candidate => candidate.publicVersionId === versionId);
        if (!selected) return null;
        return readChatBackupCandidate(selected);
    }

    function close() {
        if (reconcileTimer !== null) {
            clearTimeout(reconcileTimer);
            reconcileTimer = null;
        }
    }

    return {
        captureChatPreImage,
        normalizeChatBackups,
        reconcileChatBackups,
        listChatBackupChats,
        listChatBackups,
        readChatBackup,
        scanChatBackupVersions,
        close,
    };
}

module.exports = {
    createChatBackupStore,
    migrateLegacyChatBackups,
    resolveChatBackupDir,
    resolveChatBackupMaxBytes,
    resolveChatBackupMaxUncompressedBytes,
    sanitizeBackupReason,
    isDestructiveBackupReason,
    CHAT_BACKUP_DIRNAME,
    CHAT_BACKUP_DIR_ENV,
    CHAT_BACKUP_MAX_BYTES_KEY,
    CHAT_BACKUP_MAX_BYTES_ENV,
    CHAT_BACKUP_DEFAULT_MAX_BYTES,
    CHAT_BACKUP_MIN_MAX_BYTES,
    CHAT_BACKUP_MAX_MAX_BYTES,
    CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES_KEY,
    CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES_ENV,
    CHAT_BACKUP_DEFAULT_MAX_UNCOMPRESSED_BYTES,
    CHAT_BACKUP_MIN_MAX_UNCOMPRESSED_BYTES,
    CHAT_BACKUP_MAX_MAX_UNCOMPRESSED_BYTES,
    FRAME_FORMAT,
    COLD_STORAGE_HEADER,
};
