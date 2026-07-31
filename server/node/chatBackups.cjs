'use strict';

/*
 * Chat backup bundle format (v1)
 * --------------------------------
 * A .bundle is one gzip stream over the raw pre-image bytes concatenated
 * oldest-first, without per-entry headers. Its .meta.json sidecar records each
 * entry's versionId, timestamp, reason, and offset/size in that uncompressed
 * stream, plus the entry count and compressed bundle size. Reading one version
 * therefore gunzips the small solid bundle and slices the recorded byte range.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { decodeRisuSave } = require('./utils.cjs');

const CHAT_BACKUP_DIRNAME = 'chat-backups';
const CHAT_BACKUP_DIR_ENV = 'POCKETRISU_CHAT_BACKUP_DIR';
const CHAT_BACKUP_MAX_BYTES_KEY = 'config/chat-backup-max-bytes';
const CHAT_BACKUP_MAX_BYTES_ENV = 'POCKETRISU_CHAT_BACKUP_MAX_BYTES';
const CHAT_BACKUP_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const CHAT_BACKUP_MIN_MAX_BYTES = 1024 * 1024;
const CHAT_BACKUP_MAX_MAX_BYTES = 50 * 1024 * 1024 * 1024;
const DEFAULT_COOLDOWN_MS = 45_000;
const DEFAULT_VERSIONS_PER_BUNDLE = 25;
const DEFAULT_MAX_BUNDLES_PER_CHAT = 4;
const DEFAULT_RECONCILE_DEBOUNCE_MS = 7_500;
const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';

const VERSION_FILE_RE = /^v-(\d+)-(\d+)-([a-z0-9_-]{1,24})\.bin(\.gz)?$/;
const VERSION_ID_RE = /^v-(\d+)-(\d+)-([a-z0-9_-]{1,24})$/;
const BUNDLE_FILE_RE = /^archive-(\d+)-(\d+)\.bundle$/;

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
        readChatRowRaw,
        logger = console,
        now = Date.now,
        decodeChat = decodeRisuSave,
        cooldownMs = DEFAULT_COOLDOWN_MS,
        reconcileDebounceMs = DEFAULT_RECONCILE_DEBOUNCE_MS,
        byteBudgetMin = CHAT_BACKUP_MIN_MAX_BYTES,
        byteBudgetMax = CHAT_BACKUP_MAX_MAX_BYTES,
        runStorageOperation,
        autoReconcile = true,
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

    if (typeof getChatBackupsRoot !== 'function') {
        throw new TypeError('getChatBackupsRoot must be a function');
    }
    if (typeof readChatRowRaw !== 'function') {
        throw new TypeError('readChatRowRaw must be a function');
    }

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

    function writeFileAtomic(destination, data) {
        const temp = `${destination}.${process.pid}-${tempCounter++}.tmp`;
        try {
            fs.writeFileSync(temp, data);
            let fileFd;
            try {
                fileFd = fs.openSync(temp, 'r');
                fs.fsyncSync(fileFd);
            } finally {
                if (fileFd !== undefined) fs.closeSync(fileFd);
            }
            fs.renameSync(temp, destination);
        } catch (error) {
            try { fs.unlinkSync(temp); } catch {}
            throw error;
        }

        // Directory fsync is not supported on every platform, but makes the
        // rename durable where it is available.
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
        const bundles = [];
        let filenames = [];
        try {
            filenames = fs.readdirSync(chatDir);
        } catch {
            return { loose: [], bundles: [] };
        }

        for (const filename of filenames) {
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
            bundles,
        };
    }

    function newestTimestampOnDisk(chatDir) {
        const scan = scanChatDirectory(chatDir);
        let newest = null;
        for (const entry of scan.loose) {
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
            const existing = readChatRowRaw(chaId, chatId);
            if (existing === null || existing === undefined) return 'skipped-no-row';
            const raw = Buffer.from(existing);

            if (!force && raw.length < 4096) {
                try {
                    const decoded = await decodeChat(raw);
                    if (decoded?.message?.[0]?.data?.startsWith(COLD_STORAGE_HEADER)) {
                        return 'skipped-cold-storage';
                    }
                } catch (error) {
                    log('warn', '[ChatBackups] Could not inspect a small row for cold storage; preserving it:', error);
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
            writeFileAtomic(path.join(chatDir, filename), raw);
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

    function gzipLooseFiles(chatDir) {
        let count = 0;
        let filenames = [];
        try { filenames = fs.readdirSync(chatDir); } catch { return count; }
        for (const filename of filenames) {
            const parsed = parseVersionFile(filename);
            if (!parsed || parsed.compressed) continue;
            const source = path.join(chatDir, filename);
            const destination = `${source}.gz`;
            try {
                const raw = fs.readFileSync(source);
                let destinationMatches = false;
                if (fs.existsSync(destination)) {
                    try {
                        destinationMatches = zlib.gunzipSync(
                            fs.readFileSync(destination),
                        ).equals(raw);
                    } catch {}
                }
                if (!destinationMatches) {
                    const compressed = zlib.gzipSync(raw);
                    writeFileAtomic(destination, compressed);
                }
                fs.unlinkSync(source);
                count++;
            } catch (error) {
                log('warn', `[ChatBackups] Failed to gzip ${source}:`, error);
            }
        }
        return count;
    }

    function looseGzipEntries(chatDir) {
        let filenames = [];
        try { filenames = fs.readdirSync(chatDir); } catch { return []; }
        return filenames
            .map(parseVersionFile)
            .filter(entry => entry?.compressed)
            .sort(compareVersionsOldest);
    }

    function createBundle(chatDir, selected) {
        const rawEntries = [];
        const metaEntries = [];
        let offset = 0;
        for (const entry of selected) {
            const compressed = fs.readFileSync(path.join(chatDir, entry.filename));
            const raw = zlib.gunzipSync(compressed);
            rawEntries.push(raw);
            metaEntries.push({
                versionId: entry.versionId,
                ts: entry.ts,
                reason: entry.reason,
                offset,
                size: raw.length,
            });
            offset += raw.length;
        }

        const firstTs = selected[0].ts;
        const lastTs = selected[selected.length - 1].ts;
        const base = `archive-${firstTs}-${lastTs}`;
        const bundleFile = `${base}.bundle`;
        const metaFile = `${base}.meta.json`;
        const bundlePath = path.join(chatDir, bundleFile);
        const metaPath = path.join(chatDir, metaFile);

        let regenerate = true;
        if (fs.existsSync(bundlePath) && fs.existsSync(metaPath)) {
            const existing = readBundleMeta(chatDir, bundleFile);
            const sameEntries = existing
                && existing.entries.length === metaEntries.length
                && existing.entries.every((entry, index) => (
                    entry.versionId === metaEntries[index].versionId
                ));
            if (!sameEntries) {
                throw new Error(`Bundle name collision for ${bundleFile}`);
            }

            try {
                const uncompressed = zlib.gunzipSync(fs.readFileSync(bundlePath));
                regenerate = !existing.entries.every((entry, index) => {
                    const end = entry.offset + entry.size;
                    return Number.isSafeInteger(end)
                        && end <= uncompressed.length
                        && uncompressed.subarray(entry.offset, end).equals(rawEntries[index]);
                });
            } catch {
                regenerate = true;
            }
        }

        if (regenerate) {
            // An orphaned half of an atomic pair is regenerable while loose
            // inputs remain, so replace it rather than treating it as authority.
            const bundle = zlib.gzipSync(Buffer.concat(rawEntries));
            const meta = {
                format: 'pocketrisu-chat-backup-bundle-v1',
                entryCount: metaEntries.length,
                compressedSize: bundle.length,
                entries: metaEntries,
            };
            writeFileAtomic(bundlePath, bundle);
            try {
                writeFileAtomic(metaPath, Buffer.from(`${JSON.stringify(meta)}\n`, 'utf-8'));
            } catch (error) {
                try { fs.unlinkSync(bundlePath); } catch {}
                throw error;
            }
        }

        for (const entry of selected) {
            fs.unlinkSync(path.join(chatDir, entry.filename));
        }
    }

    function bundleLooseVersions(chatDir) {
        let count = 0;
        while (true) {
            if (scanChatDirectory(chatDir).bundles.length >= bundleLimit) break;
            const loose = looseGzipEntries(chatDir);
            if (loose.length < bundleSize) break;
            const selected = loose.slice(0, bundleSize);
            try {
                createBundle(chatDir, selected);
                count++;
            } catch (error) {
                log('warn', `[ChatBackups] Failed to bundle ${chatDir}:`, error);
                break;
            }
        }
        return count;
    }

    function materializeRetainedBundleEntries(chatDir, bundle, removedVersionIds) {
        const uncompressed = zlib.gunzipSync(
            fs.readFileSync(path.join(chatDir, bundle.bundleFile)),
        );
        const retainedIds = [];

        for (const entry of bundle.entries) {
            if (removedVersionIds.has(entry.versionId)) continue;
            const end = entry.offset + entry.size;
            if (!Number.isSafeInteger(end) || end > uncompressed.length) {
                throw new Error(`Bundle ${bundle.bundleFile} has an invalid entry range`);
            }
            const raw = Buffer.from(uncompressed.subarray(entry.offset, end));
            const rawPath = path.join(chatDir, `${entry.versionId}.bin`);
            const gzipPath = `${rawPath}.gz`;

            if (fs.existsSync(rawPath) && !fs.readFileSync(rawPath).equals(raw)) {
                throw new Error(`Loose version conflicts with ${bundle.bundleFile}: ${entry.versionId}`);
            }
            if (fs.existsSync(gzipPath)) {
                let looseRaw;
                try {
                    looseRaw = zlib.gunzipSync(fs.readFileSync(gzipPath));
                } catch {
                    throw new Error(`Loose version is corrupt for ${entry.versionId}`);
                }
                if (!looseRaw.equals(raw)) {
                    throw new Error(`Loose version conflicts with ${bundle.bundleFile}: ${entry.versionId}`);
                }
            } else if (!fs.existsSync(rawPath)) {
                writeFileAtomic(gzipPath, zlib.gzipSync(raw));
            }
            retainedIds.push(entry.versionId);
        }

        // Retained entries are durable as loose versions before the old solid
        // bundle is withdrawn. A crash before this point leaves the old bundle
        // authoritative; a crash after it leaves the loose copies authoritative.
        fs.unlinkSync(path.join(chatDir, bundle.metaFile));
        try { fs.unlinkSync(path.join(chatDir, bundle.bundleFile)); } catch {}

        if (retainedIds.length === 0) return { bundleRemoved: 1, bundleRewritten: 0 };

        const retainedSet = new Set(retainedIds);
        const retained = looseGzipEntries(chatDir)
            .filter(entry => retainedSet.has(entry.versionId));
        if (retained.length !== retainedIds.length) {
            // Raw loose files can exist after a previously interrupted gzip.
            // Leaving them loose is safe and the next reconciliation will gzip
            // and bundle them again.
            return { bundleRemoved: 1, bundleRewritten: 0 };
        }
        try {
            createBundle(chatDir, retained);
            return { bundleRemoved: 0, bundleRewritten: 1 };
        } catch (error) {
            log('warn', `[ChatBackups] Failed to rebuild trimmed bundle ${bundle.bundleFile}:`, error);
            return { bundleRemoved: 1, bundleRewritten: 0 };
        }
    }

    function removeVersionEverywhere(chatDir, versionId) {
        const scan = scanChatDirectory(chatDir);
        let bundleRemoved = 0;
        let bundleRewritten = 0;

        for (const bundle of scan.bundles) {
            if (!bundle.entries.some(entry => entry.versionId === versionId)) continue;
            const result = materializeRetainedBundleEntries(
                chatDir,
                bundle,
                new Set([versionId]),
            );
            bundleRemoved += result.bundleRemoved;
            bundleRewritten += result.bundleRewritten;
        }

        for (const suffix of ['.bin', '.bin.gz']) {
            try { fs.unlinkSync(path.join(chatDir, `${versionId}${suffix}`)); } catch {}
        }
        return { bundleRemoved, bundleRewritten };
    }

    function enforceChatVersionLimit(chatDir) {
        let versionsRemoved = 0;
        let bundlesRemoved = 0;
        let bundlesRewritten = 0;

        while (true) {
            const scan = scanChatDirectory(chatDir);
            const byId = new Map();
            for (const bundle of scan.bundles) {
                for (const entry of bundle.entries) byId.set(entry.versionId, entry);
            }
            for (const entry of scan.loose) byId.set(entry.versionId, entry);
            const versions = [...byId.values()].sort(compareVersionsOldest);
            if (versions.length <= versionLimit) break;

            const oldest = versions[0];
            try {
                const result = removeVersionEverywhere(chatDir, oldest.versionId);
                const remaining = scanChatDirectory(chatDir);
                const stillPresent = remaining.loose.some(entry => entry.versionId === oldest.versionId)
                    || remaining.bundles.some(bundle => (
                        bundle.entries.some(entry => entry.versionId === oldest.versionId)
                    ));
                if (stillPresent) throw new Error(`Could not remove ${oldest.versionId}`);
                versionsRemoved++;
                bundlesRemoved += result.bundleRemoved;
                bundlesRewritten += result.bundleRewritten;
            } catch (error) {
                log('warn', `[ChatBackups] Failed to enforce version limit in ${chatDir}:`, error);
                break;
            }
        }
        return { versionsRemoved, bundlesRemoved, bundlesRewritten };
    }

    function removeBundledLooseDuplicates(chatDir) {
        const scan = scanChatDirectory(chatDir);
        const claimsByVersion = new Map();
        const looseIds = new Set(scan.loose.map(entry => entry.versionId));
        for (const bundle of scan.bundles) {
            for (const entry of bundle.entries) {
                if (!looseIds.has(entry.versionId)) continue;
                const claims = claimsByVersion.get(entry.versionId) || [];
                claims.push({ bundle, entry });
                claimsByVersion.set(entry.versionId, claims);
            }
        }

        const uncompressedBundles = new Map();
        function loadBundle(bundle) {
            if (uncompressedBundles.has(bundle.bundleFile)) {
                return uncompressedBundles.get(bundle.bundleFile);
            }
            try {
                const raw = zlib.gunzipSync(
                    fs.readFileSync(path.join(chatDir, bundle.bundleFile)),
                );
                uncompressedBundles.set(bundle.bundleFile, raw);
                return raw;
            } catch (error) {
                uncompressedBundles.set(bundle.bundleFile, null);
                log('warn', `[ChatBackups] Failed to validate ${bundle.bundleFile}:`, error);
                return null;
            }
        }

        for (const entry of scan.loose) {
            const claims = claimsByVersion.get(entry.versionId);
            if (!claims) continue;

            const loosePath = path.join(chatDir, entry.filename);
            let looseRaw;
            try {
                const contents = fs.readFileSync(loosePath);
                looseRaw = entry.compressed ? zlib.gunzipSync(contents) : contents;
            } catch (error) {
                log('warn', `[ChatBackups] Failed to validate loose version ${entry.versionId}:`, error);
                continue;
            }

            const matchesBundle = claims.some(({ bundle, entry: bundledEntry }) => {
                const uncompressed = loadBundle(bundle);
                if (!uncompressed) return false;
                const end = bundledEntry.offset + bundledEntry.size;
                return Number.isSafeInteger(end)
                    && end <= uncompressed.length
                    && uncompressed.subarray(bundledEntry.offset, end).equals(looseRaw);
            });
            if (!matchesBundle) continue;
            try {
                fs.unlinkSync(loosePath);
            } catch (error) {
                log('warn', `[ChatBackups] Failed to remove bundled duplicate ${loosePath}:`, error);
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

    function enforceGlobalBudget(root, chatDirs) {
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
            const allVersions = [
                ...scan.loose,
                ...scan.bundles.flatMap(bundle => bundle.entries),
            ].sort(compareVersionsOldest);
            const newestId = allVersions.at(-1)?.versionId ?? null;

            for (const bundle of scan.bundles) {
                if (bundle.entries.some(entry => entry.versionId === newestId)) continue;
                const age = bundle.entries.reduce((newest, entry) => (
                    newest === null || compareVersionsOldest(newest, entry) < 0
                        ? entry
                        : newest
                ), null) ?? { ts: 0, seq: 0, versionId: '' };
                evictable.push({
                    type: 'bundle',
                    chatDir,
                    bundle,
                    age,
                    versionCount: bundle.entries.length,
                    name: bundle.bundleFile,
                });
            }
            for (const entry of scan.loose) {
                if (entry.versionId === newestId) continue;
                evictable.push({
                    type: 'loose',
                    chatDir,
                    entry,
                    age: entry,
                    versionCount: 1,
                    name: entry.filename,
                });
            }
        }

        // A solid bundle is one indivisible eviction unit. Treat its newest
        // member as the unit's age so a bundle containing newer recovery points
        // cannot jump ahead of an older loose version in another chat. If ages
        // tie, prefer the unit that discards fewer versions.
        evictable.sort((a, b) => compareVersionsOldest(a.age, b.age)
            || a.versionCount - b.versionCount
            || a.chatDir.localeCompare(b.chatDir)
            || a.name.localeCompare(b.name));

        let removed = 0;
        for (const item of evictable) {
            if (totalBytes <= maxBytes) break;
            let deleted = false;
            if (item.type === 'bundle') {
                try {
                    fs.unlinkSync(path.join(item.chatDir, item.bundle.bundleFile));
                    deleted = true;
                } catch {}
                try {
                    fs.unlinkSync(path.join(item.chatDir, item.bundle.metaFile));
                    deleted = true;
                } catch {}
            } else {
                try {
                    fs.unlinkSync(path.join(item.chatDir, item.entry.filename));
                    deleted = true;
                } catch {}
            }
            totalBytes = treeBytes(root);
            if (deleted) removed++;
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

    function reconcileOnDisk() {
        const root = backupsTreeRoot();
        fs.mkdirSync(root, { recursive: true });
        const stats = {
            staleTempsRemoved: cleanupStaleTemps(root),
            gzipped: 0,
            bundlesCreated: 0,
            bundlesRotated: 0,
            versionsTrimmed: 0,
            budgetItemsRemoved: 0,
            totalBytes: 0,
            maxBytes: 0,
        };

        const chatDirs = collectChatDirectories(root);
        for (const { chatDir } of chatDirs) {
            stats.gzipped += gzipLooseFiles(chatDir);
            // A crash after publishing both bundle files but part-way through
            // deleting inputs can leave fewer than 25 duplicates. Remove those
            // before threshold checks so the next pass always finishes the work.
            removeBundledLooseDuplicates(chatDir);
            stats.bundlesCreated += bundleLooseVersions(chatDir);
            const retention = enforceChatVersionLimit(chatDir);
            stats.versionsTrimmed += retention.versionsRemoved;
            stats.bundlesRotated += retention.bundlesRemoved;
            // Trimming can retire a one-entry bundle and free a bundle slot.
            stats.bundlesCreated += bundleLooseVersions(chatDir);
        }
        const budget = enforceGlobalBudget(root, chatDirs);
        stats.budgetItemsRemoved = budget.removed;
        stats.totalBytes = budget.totalBytes;
        stats.maxBytes = budget.maxBytes;
        pruneEmptyDirectories(root);
        return stats;
    }

    function reconcileChatBackups() {
        const operation = () => Promise.resolve().then(reconcileOnDisk);
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

    function readChatBackup(chaId, chatId, versionId) {
        if (!parseVersionId(versionId)) return null;
        const chatDir = chatDirectory(chaId, chatId);
        const rawPath = path.join(chatDir, `${versionId}.bin`);
        const gzipPath = `${rawPath}.gz`;
        try {
            if (fs.existsSync(rawPath)) return fs.readFileSync(rawPath);
            if (fs.existsSync(gzipPath)) return zlib.gunzipSync(fs.readFileSync(gzipPath));
        } catch (error) {
            log('warn', `[ChatBackups] Failed to read loose version ${versionId}:`, error);
            return null;
        }

        const scan = scanChatDirectory(chatDir);
        for (const bundle of scan.bundles) {
            const entry = bundle.entries.find(candidate => candidate.versionId === versionId);
            if (!entry) continue;
            try {
                const uncompressed = zlib.gunzipSync(
                    fs.readFileSync(path.join(chatDir, bundle.bundleFile)),
                );
                const end = entry.offset + entry.size;
                if (end > uncompressed.length) return null;
                return Buffer.from(uncompressed.subarray(entry.offset, end));
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
    sanitizeBackupReason,
    CHAT_BACKUP_DIRNAME,
    CHAT_BACKUP_DIR_ENV,
    CHAT_BACKUP_MAX_BYTES_KEY,
    CHAT_BACKUP_MAX_BYTES_ENV,
    CHAT_BACKUP_DEFAULT_MAX_BYTES,
    CHAT_BACKUP_MIN_MAX_BYTES,
    CHAT_BACKUP_MAX_MAX_BYTES,
    COLD_STORAGE_HEADER,
};
