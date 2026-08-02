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
const { decodeRisuSave } = require('./utils.cjs');

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

function migrateLegacyChatBackups(options = {}) {
    const logger = options.logger ?? console;
    const stats = {
        moved: 0,
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

    if (legacyRoot === destinationRoot || !fs.existsSync(legacyRoot)) return stats;

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

    function pruneIfEmpty(directory) {
        try {
            if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
        } catch (error) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
                stats.failed++;
                migrationLog(logger, 'warn', `[ChatBackups] Could not prune legacy directory ${directory}:`, error);
            }
        }
    }

    function copyAcrossDevices(source, destination) {
        let destinationCreated = false;
        try {
            fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
            destinationCreated = true;
            let destinationFd;
            try {
                destinationFd = fs.openSync(destination, 'r');
                fs.fsyncSync(destinationFd);
            } catch {
                // Byte verification below is authoritative; fsync is best-effort.
            } finally {
                if (destinationFd !== undefined) {
                    try { fs.closeSync(destinationFd); } catch {}
                }
            }
            if (!filesHaveIdenticalBytes(source, destination)) {
                throw new Error('copied bytes did not match the legacy source');
            }
            fs.unlinkSync(source);
            stats.moved++;
        } catch (error) {
            stats.failed++;
            migrationLog(logger, 'error', `[ChatBackups] Could not copy legacy file ${source} to ${destination}:`, error);
            if (destinationCreated && fs.existsSync(source)) {
                try { fs.unlinkSync(destination); } catch {}
            }
        }
    }

    function moveDirectory(sourceDirectory, destinationDirectory) {
        let entries;
        try {
            entries = fs.readdirSync(sourceDirectory, { withFileTypes: true });
            fs.mkdirSync(destinationDirectory, { recursive: true });
        } catch (error) {
            stats.failed++;
            migrationLog(logger, 'error', `[ChatBackups] Could not prepare legacy directory ${sourceDirectory}:`, error);
            return;
        }

        for (const entry of entries) {
            const source = path.join(sourceDirectory, entry.name);
            const destination = path.join(destinationDirectory, entry.name);
            if (entry.isDirectory()) {
                moveDirectory(source, destination);
                pruneIfEmpty(source);
                continue;
            }
            if (!entry.isFile()) {
                stats.failed++;
                migrationLog(logger, 'warn', `[ChatBackups] Leaving unsupported legacy entry in place: ${source}`);
                continue;
            }

            if (fs.existsSync(destination)) {
                if (filesHaveIdenticalBytes(source, destination)) {
                    try {
                        fs.unlinkSync(source);
                        stats.deduplicated++;
                    } catch (error) {
                        stats.failed++;
                        migrationLog(logger, 'warn', `[ChatBackups] Could not remove duplicate legacy file ${source}:`, error);
                    }
                } else {
                    stats.conflicts++;
                    migrationLog(
                        logger,
                        'warn',
                        `[ChatBackups] Legacy file conflicts with the destination and was left in place: ${source}`,
                    );
                }
                continue;
            }

            try {
                fs.renameSync(source, destination);
                stats.moved++;
            } catch (error) {
                if (error?.code === 'EXDEV') copyAcrossDevices(source, destination);
                else {
                    stats.failed++;
                    migrationLog(logger, 'error', `[ChatBackups] Could not move legacy file ${source} to ${destination}:`, error);
                }
            }
        }
        pruneIfEmpty(sourceDirectory);
    }

    try {
        moveDirectory(legacyRoot, destinationRoot);
        pruneIfEmpty(legacyRoot);
    } catch (error) {
        stats.failed++;
        migrationLog(logger, 'error', '[ChatBackups] Unexpected legacy migration failure:', error);
    }

    if (stats.moved || stats.deduplicated || stats.conflicts || stats.failed) {
        migrationLog(
            logger,
            stats.conflicts || stats.failed ? 'warn' : 'info',
            `[ChatBackups] Legacy migration complete: ${stats.moved} moved, `
            + `${stats.deduplicated} duplicate(s) removed, ${stats.conflicts} conflict(s), `
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

    function chatDirectory(chaId, chatId) {
        return path.join(
            backupsTreeRoot(),
            encodePathComponent(chaId),
            encodePathComponent(chatId),
        );
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
        fs.renameSync(temp, destination);
        syncDirectory(path.dirname(destination));
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
                            repairChatRowMetadata(selected, coldStorage);
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
            if (!force && newest !== null && currentTime - newest < Math.max(0, cooldownMs)) {
                return 'skipped-cooldown';
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

    function cleanupStaleTemps(directory) {
        let entries = [];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return 0; }
        let removed = 0;
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                removed += cleanupStaleTemps(fullPath);
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
            if (!charEntry.isDirectory()) continue;
            const charDir = path.join(root, charEntry.name);
            let chatEntries = [];
            try { chatEntries = fs.readdirSync(charDir, { withFileTypes: true }); } catch { continue; }
            for (const chatEntry of chatEntries) {
                if (!chatEntry.isDirectory()) continue;
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
            const decoded = await inspectFramePayload(filename, frame, operation);
            return decoded.size === rawInfo.size && decoded.sha256 === rawInfo.sha256;
        } catch {
            return false;
        }
    }

    async function createFrameFromLoose(chatDir, entry) {
        const source = path.join(chatDir, entry.filename);
        const destination = path.join(chatDir, `${entry.versionId}.frame`);
        const rawInfo = entry.compressed
            ? await inspectGzipFile(source, {
                operation: 'reconcile-source',
                versionId: entry.versionId,
                storage: 'legacy-loose-gzip',
            })
            : await inspectRawFile(source);

        if (await verifiedFrameMatches(
            destination,
            entry,
            rawInfo,
            'reconcile-existing-frame',
        )) {
            unlinkAndSync(source);
            return { created: false, sourceRemoved: true };
        }

        const header = encodeFrameHeader(entry, rawInfo);
        const prefix = framePrefix(header.length);
        const temp = `${destination}.${process.pid}-${tempCounter++}.tmp`;
        try {
            fs.writeFileSync(temp, Buffer.concat([prefix, header]), { flag: 'wx' });
            const output = fs.createWriteStream(temp, { flags: 'a' });
            if (entry.compressed) {
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
            unlinkAndSync(source);
            return { created: true, sourceRemoved: true };
        } catch (error) {
            try { fs.unlinkSync(temp); } catch {}
            throw error;
        }
    }

    async function createFramesFromLoose(chatDir) {
        let converted = 0;
        let created = 0;
        let filenames = [];
        try { filenames = fs.readdirSync(chatDir); } catch { return { converted, created }; }
        const entries = filenames
            .map(parseVersionFile)
            .filter(Boolean)
            .sort(compareVersionsOldest);
        for (const entry of entries) {
            try {
                const result = await createFrameFromLoose(chatDir, entry);
                if (result.sourceRemoved) converted++;
                if (result.created) created++;
            } catch (error) {
                log('warn', `[ChatBackups] Failed to frame ${entry.filename}:`, error);
            }
        }
        return { converted, created };
    }

    async function publishExtractedTemp(temp, destination) {
        if (fs.existsSync(destination)) {
            if (!filesHaveIdenticalBytes(temp, destination)) {
                throw new Error(`Extracted legacy version conflicts with ${path.basename(destination)}`);
            }
            fs.unlinkSync(temp);
            return;
        }
        durablePublishTemp(temp, destination);
    }

    async function migrateLegacyBundleToLoose(chatDir, bundle) {
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
            await publishExtractedTemp(completed.temp, completed.destination);
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

        // Every raw entry is durable before the legacy index is withdrawn. A
        // crash before this point leaves the bundle readable; a crash after it
        // leaves the exact loose entries readable and ready for framing.
        unlinkAndSync(path.join(chatDir, bundle.metaFile));
        try { unlinkAndSync(bundlePath); } catch {}
    }

    async function migrateLegacyBundles(chatDir) {
        let migrated = 0;
        const bundles = scanChatDirectory(chatDir).bundles;
        for (const bundle of bundles) {
            try {
                await migrateLegacyBundleToLoose(chatDir, bundle);
                migrated++;
            } catch (error) {
                log('warn', `[ChatBackups] Failed to migrate ${bundle.bundleFile}:`, error);
            }
        }
        return migrated;
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
            staleTempsRemoved: cleanupStaleTemps(root),
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
            const legacyMigrated = await migrateLegacyBundles(chatDir);
            stats.legacyBundlesMigrated += legacyMigrated;
            stats.bundlesRotated += legacyMigrated;
            const migratedFrames = await createFramesFromLoose(chatDir);
            stats.gzipped += migratedFrames.converted;
            stats.framesCreated += migratedFrames.created;
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

    function reconcileChatBackups() {
        const operation = () => reconcileOnDisk();
        if (typeof runStorageOperation === 'function') {
            return Promise.resolve().then(() => runStorageOperation(operation));
        }
        const run = localReconcileQueue.then(operation, operation);
        localReconcileQueue = run.catch(() => {});
        return run;
    }

    function listChatBackups(chaId, chatId) {
        const chatDir = chatDirectory(chaId, chatId);
        const scan = scanChatDirectory(chatDir);
        const byId = new Map();

        for (const bundle of scan.bundles) {
            for (const entry of bundle.entries) {
                byId.set(entry.versionId, {
                    versionId: entry.versionId,
                    ts: entry.ts,
                    reason: entry.reason,
                    size: entry.size,
                    storage: 'bundle',
                    bundleFile: bundle.bundleFile,
                    seq: entry.seq,
                });
            }
        }
        for (const entry of scan.frames) {
            byId.set(entry.versionId, {
                versionId: entry.versionId,
                ts: entry.ts,
                reason: entry.reason,
                size: entry.size,
                storage: 'bundle',
                bundleFile: entry.filename,
                seq: entry.seq,
            });
        }
        for (const entry of scan.loose) {
            byId.set(entry.versionId, {
                versionId: entry.versionId,
                ts: entry.ts,
                reason: entry.reason,
                size: entry.size,
                storage: 'loose',
                seq: entry.seq,
            });
        }

        return [...byId.values()]
            .sort((a, b) => compareVersionsOldest(b, a))
            .map(({ seq, ...entry }) => entry);
    }

    function listChatBackupChats() {
        const root = backupsTreeRoot();
        const summaries = [];
        for (const item of collectChatDirectories(root)) {
            if (item.chaId === null || item.chatId === null) continue;
            const versions = listChatBackups(item.chaId, item.chatId);
            if (versions.length === 0) continue;
            summaries.push({
                chaId: item.chaId,
                chatId: item.chatId,
                versionCount: versions.length,
                newestTs: versions[0].ts,
                oldestTs: versions[versions.length - 1].ts,
                totalBytes: treeBytes(item.chatDir),
            });
        }
        return summaries.sort((a, b) => b.newestTs - a.newestTs
            || a.chaId.localeCompare(b.chaId)
            || a.chatId.localeCompare(b.chatId));
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

    async function readChatBackup(chaId, chatId, versionId) {
        if (!parseVersionId(versionId)) return null;
        const chatDir = chatDirectory(chaId, chatId);
        const rawPath = path.join(chatDir, `${versionId}.bin`);
        const gzipPath = `${rawPath}.gz`;
        try {
            if (fs.existsSync(rawPath)) return await fs.promises.readFile(rawPath);
            if (fs.existsSync(gzipPath)) {
                return await readGzipVersion(gzipPath, gzipRawSize(gzipPath), {
                    operation: 'read',
                    versionId,
                    storage: 'legacy-loose-gzip',
                });
            }
        } catch (error) {
            log('warn', `[ChatBackups] Failed to read loose version ${versionId}:`, error);
            return null;
        }

        const scan = scanChatDirectory(chatDir);
        const frame = scan.frames.find(candidate => candidate.versionId === versionId);
        if (frame) {
            try {
                const end = frame.payloadOffset + frame.compressedBytes - 1;
                const gunzip = createGunzipReadStream(path.join(chatDir, frame.filename), {
                    start: frame.payloadOffset,
                    end,
                });
                return await readDecodedToBuffer(gunzip, frame.size, {
                    operation: 'read',
                    versionId,
                    storage: 'frame',
                    frameFile: frame.filename,
                }, frame.sha256);
            } catch (error) {
                log('warn', `[ChatBackups] Failed to read framed version ${versionId}:`, error);
                return null;
            }
        }
        for (const bundle of scan.bundles) {
            const entry = bundle.entries.find(candidate => candidate.versionId === versionId);
            if (!entry) continue;
            try {
                return await readLegacyBundleEntry(chatDir, bundle, entry);
            } catch (error) {
                log('warn', `[ChatBackups] Failed to read bundled version ${versionId}:`, error);
                return null;
            }
        }
        return null;
    }

    function close() {
        if (reconcileTimer !== null) {
            clearTimeout(reconcileTimer);
            reconcileTimer = null;
        }
    }

    return {
        captureChatPreImage,
        reconcileChatBackups,
        listChatBackupChats,
        listChatBackups,
        readChatBackup,
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
