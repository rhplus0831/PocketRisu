'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const ASSET_MIGRATION_MARKER = '.migrated_to_fs';
const ASSET_TEMP_PREFIX = '.tmp-';
const LEGACY_HASH_IDENTITY_MARKER = '.legacy_hash_identity_v1';
const LEGACY_HASH_MARKER_DIR = '.legacy-hash-assets';
const LEGACY_HASH_MARKER_VALUE = 'legacy-hash-asset-v1\n';
const SAFE_ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const HASH_NAME_RE = /^assets\/([0-9a-f]{64})\.[A-Za-z0-9]{1,10}$/;
const WINDOWS_RESERVED_ASSET_BASENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

function isSafeAssetName(name) {
    return typeof name === 'string'
        && SAFE_ASSET_NAME_RE.test(name)
        && name !== ASSET_MIGRATION_MARKER
        && !name.startsWith(ASSET_TEMP_PREFIX);
}

function portableAssetNameKey(name) {
    return name.toLowerCase().replace(/\.+$/, '');
}

function isPortableAssetName(name) {
    if (!isSafeAssetName(name) || name.endsWith('.')) return false;
    const basename = name.split('.', 1)[0].toLowerCase();
    return !WINDOWS_RESERVED_ASSET_BASENAME_RE.test(basename);
}

function verifyAssetHash(key, buffer) {
    const match = typeof key === 'string' ? key.match(HASH_NAME_RE) : null;
    if (!match) {
        return { claimed: null, actual: null, ok: true };
    }
    const actual = createHash('sha256').update(Buffer.from(buffer)).digest('hex');
    return {
        claimed: match[1],
        actual,
        ok: match[1] === actual,
    };
}

function swapDirectoryFromStaging(options) {
    const {
        liveDir,
        stagingDir,
        backupDir,
        fs: fsOps = fs,
    } = options;
    if (!fsOps.existsSync(stagingDir)) {
        throw new Error(`Staging directory does not exist: ${stagingDir}`);
    }

    fsOps.rmSync(backupDir, { recursive: true, force: true });
    let movedLive = false;
    let installedStaging = false;
    let settled = false;

    function restorePreviousDirectory() {
        if (settled) return;
        if (installedStaging) {
            fsOps.rmSync(liveDir, { recursive: true, force: true });
        }
        if (movedLive && fsOps.existsSync(backupDir)) {
            fsOps.renameSync(backupDir, liveDir);
        }
        fsOps.rmSync(stagingDir, { recursive: true, force: true });
        settled = true;
    }

    try {
        if (fsOps.existsSync(liveDir)) {
            fsOps.renameSync(liveDir, backupDir);
            movedLive = true;
        }
        fsOps.renameSync(stagingDir, liveDir);
        installedStaging = true;
    } catch (error) {
        try {
            restorePreviousDirectory();
        } catch (restoreError) {
            error.restoreError = restoreError;
        }
        throw error;
    }

    return {
        rollback: restorePreviousDirectory,
        finalize() {
            if (settled) return;
            fsOps.rmSync(backupDir, { recursive: true, force: true });
            settled = true;
        },
    };
}

function createAssetStore(options = {}) {
    const assetDir = path.resolve(options.assetDir || path.join(process.cwd(), 'save', 'assets'));
    const fsOps = options.fs || fs;
    const resolvedAssetDir = assetDir + path.sep;
    const legacyHashMarkerDir = path.join(assetDir, LEGACY_HASH_MARKER_DIR);
    const legacyHashIdentityMarkerPath = path.join(assetDir, LEGACY_HASH_IDENTITY_MARKER);

    function ensureAssetDir() {
        fsOps.mkdirSync(assetDir, { recursive: true });
    }

    function assetPathFor(name) {
        if (!isSafeAssetName(name)) {
            throw new Error(`Invalid asset name: ${name}`);
        }
        const filePath = path.resolve(assetDir, name);
        if (!filePath.startsWith(resolvedAssetDir)) {
            throw new Error(`Path escapes asset directory: ${filePath}`);
        }
        return filePath;
    }

    function isHashShapedAssetName(name) {
        return typeof name === 'string' && HASH_NAME_RE.test(`assets/${name}`);
    }

    function legacyHashMarkerPathFor(name) {
        if (!isSafeAssetName(name) || !isHashShapedAssetName(name)) {
            throw new Error(`Invalid legacy hash asset name: ${name}`);
        }
        return path.join(legacyHashMarkerDir, name);
    }

    function fsyncDirectory(directory) {
        try {
            const dirFd = fsOps.openSync(directory, 'r');
            try { fsOps.fsyncSync(dirFd); } finally { fsOps.closeSync(dirFd); }
        } catch {
            // Directory fsync is unavailable on some platforms.
        }
    }

    function writeMarkerFile(filePath, value) {
        const directory = path.dirname(filePath);
        fsOps.mkdirSync(directory, { recursive: true });
        const tempPath = path.join(directory, `${ASSET_TEMP_PREFIX}${randomUUID()}`);
        let fd;
        try {
            fd = fsOps.openSync(tempPath, 'wx', 0o600);
            const data = Buffer.from(value, 'utf-8');
            let offset = 0;
            while (offset < data.length) {
                offset += fsOps.writeSync(fd, data, offset, data.length - offset);
            }
            fsOps.fsyncSync(fd);
            fsOps.closeSync(fd);
            fd = undefined;
            fsOps.renameSync(tempPath, filePath);
            fsyncDirectory(directory);
        } finally {
            if (fd !== undefined) {
                try { fsOps.closeSync(fd); } catch {}
            }
            try { fsOps.unlinkSync(tempPath); } catch {}
        }
    }

    function isLegacyHashAsset(name) {
        if (!isHashShapedAssetName(name)) return false;
        try {
            const markerPath = legacyHashMarkerPathFor(name);
            const stat = fsOps.lstatSync(markerPath);
            return stat.isFile()
                && stat.size === Buffer.byteLength(LEGACY_HASH_MARKER_VALUE, 'utf-8')
                && fsOps.readFileSync(markerPath, 'utf-8') === LEGACY_HASH_MARKER_VALUE;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
        }
    }

    function markLegacyHashAsset(name) {
        const markerPath = legacyHashMarkerPathFor(name);
        if (isLegacyHashAsset(name)) return false;
        writeMarkerFile(markerPath, LEGACY_HASH_MARKER_VALUE);
        return true;
    }

    function clearLegacyHashAsset(name) {
        if (!isHashShapedAssetName(name)) return false;
        try {
            fsOps.unlinkSync(legacyHashMarkerPathFor(name));
            fsyncDirectory(legacyHashMarkerDir);
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
        }
    }

    function fileStat(name) {
        if (!isSafeAssetName(name)) return null;
        try {
            const stat = fsOps.lstatSync(assetPathFor(name));
            return stat.isFile() ? stat : null;
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
    }

    function writeAssetFile(name, buffer) {
        const destination = assetPathFor(name);
        const data = Buffer.from(buffer);
        ensureAssetDir();

        let tempPath;
        let fd;
        try {
            for (let attempt = 0; attempt < 10; attempt++) {
                tempPath = path.join(assetDir, `${ASSET_TEMP_PREFIX}${randomUUID()}`);
                try {
                    fd = fsOps.openSync(tempPath, 'wx', 0o600);
                    break;
                } catch (error) {
                    if (error?.code !== 'EEXIST' || attempt === 9) throw error;
                }
            }

            let offset = 0;
            while (offset < data.length) {
                offset += fsOps.writeSync(fd, data, offset, data.length - offset);
            }
            fsOps.fsyncSync(fd);
            fsOps.closeSync(fd);
            fd = undefined;

            fsOps.renameSync(tempPath, destination);
            tempPath = undefined;

            // Persist the directory-entry swap where the platform supports it.
            fsyncDirectory(assetDir);
        } finally {
            if (fd !== undefined) {
                try { fsOps.closeSync(fd); } catch {}
            }
            if (tempPath) {
                try { fsOps.unlinkSync(tempPath); } catch {}
            }
        }
    }

    function writeAssetFileIfChanged(name, buffer) {
        const data = Buffer.from(buffer);
        if (assetFileSize(name) === data.length) {
            // Equal length is only a fast path: stale or corrupt files keep
            // their length, so equality must be proven on the actual bytes.
            const existing = readAssetFile(name);
            if (existing !== null && existing.equals(data)) return false;
        }
        writeAssetFile(name, data);
        return true;
    }

    function filesEqual(leftPath, rightPath, size) {
        const left = fsOps.openSync(leftPath, 'r');
        const right = fsOps.openSync(rightPath, 'r');
        const leftPage = Buffer.allocUnsafe(256 * 1024);
        const rightPage = Buffer.allocUnsafe(256 * 1024);
        try {
            let offset = 0;
            while (offset < size) {
                const length = Math.min(leftPage.length, size - offset);
                const leftRead = fsOps.readSync(left, leftPage, 0, length, offset);
                const rightRead = fsOps.readSync(right, rightPage, 0, length, offset);
                if (leftRead !== length || rightRead !== length
                    || !leftPage.subarray(0, length).equals(rightPage.subarray(0, length))) {
                    return false;
                }
                offset += length;
            }
            return true;
        } finally {
            fsOps.closeSync(left);
            fsOps.closeSync(right);
        }
    }

    function writeAssetFileFromFile(name, sourcePath, { skipIfUnchanged = false } = {}) {
        const destination = assetPathFor(name);
        const sourceStat = fsOps.statSync(sourcePath);
        if (!sourceStat.isFile()) throw new Error('Asset spool source must be a regular file');
        ensureAssetDir();
        if (skipIfUnchanged && assetFileSize(name) === sourceStat.size
            && filesEqual(sourcePath, destination, sourceStat.size)) return false;

        let tempPath;
        let destinationDescriptor;
        try {
            for (let attempt = 0; attempt < 10; attempt++) {
                tempPath = path.join(assetDir, `${ASSET_TEMP_PREFIX}${randomUUID()}`);
                try {
                    destinationDescriptor = fsOps.openSync(tempPath, 'wx', 0o600);
                    break;
                } catch (error) {
                    if (error?.code !== 'EEXIST' || attempt === 9) throw error;
                }
            }
            const sourceDescriptor = fsOps.openSync(sourcePath, 'r');
            const page = Buffer.allocUnsafe(256 * 1024);
            try {
                let position = 0;
                while (position < sourceStat.size) {
                    const length = Math.min(page.length, sourceStat.size - position);
                    const bytesRead = fsOps.readSync(
                        sourceDescriptor,
                        page,
                        0,
                        length,
                        position,
                    );
                    if (bytesRead !== length) throw new Error('Asset spool changed during publication');
                    let written = 0;
                    while (written < bytesRead) {
                        const count = fsOps.writeSync(
                            destinationDescriptor,
                            page,
                            written,
                            bytesRead - written,
                        );
                        if (count <= 0) throw new Error('Asset spool publication made no progress');
                        written += count;
                    }
                    position += bytesRead;
                }
            } finally {
                fsOps.closeSync(sourceDescriptor);
            }
            fsOps.fsyncSync(destinationDescriptor);
            fsOps.closeSync(destinationDescriptor);
            destinationDescriptor = undefined;
            fsOps.renameSync(tempPath, destination);
            tempPath = undefined;
            fsyncDirectory(assetDir);
            return true;
        } finally {
            if (destinationDescriptor !== undefined) {
                try { fsOps.closeSync(destinationDescriptor); } catch {}
            }
            if (tempPath) {
                try { fsOps.unlinkSync(tempPath); } catch {}
            }
        }
    }

    function readAssetFile(name) {
        if (!fileStat(name)) return null;
        try {
            return fsOps.readFileSync(assetPathFor(name));
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
    }

    function verifyStoredAssetHash(name) {
        const key = `assets/${name}`;
        const match = key.match(HASH_NAME_RE);
        if (!match) return { claimed: null, actual: null, ok: true };
        if (!fileStat(name)) return null;
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(256 * 1024);
        const fd = fsOps.openSync(assetPathFor(name), 'r');
        try {
            let offset = 0;
            while (true) {
                const bytesRead = fsOps.readSync(fd, buffer, 0, buffer.length, offset);
                if (bytesRead === 0) break;
                hash.update(buffer.subarray(0, bytesRead));
                offset += bytesRead;
            }
        } finally {
            fsOps.closeSync(fd);
        }
        const actual = hash.digest('hex');
        return { claimed: match[1], actual, ok: match[1] === actual };
    }

    function reconcileLegacyHashAssetIdentity({ discover = false } = {}) {
        ensureAssetDir();
        let marked = 0;
        let cleared = 0;
        const files = new Map(listAssetFiles().map((entry) => [entry.name, entry]));

        if (discover) {
            for (const name of files.keys()) {
                if (!isHashShapedAssetName(name)) continue;
                const verification = verifyStoredAssetHash(name);
                if (verification && !verification.ok) {
                    if (markLegacyHashAsset(name)) marked++;
                } else if (clearLegacyHashAsset(name)) {
                    cleared++;
                }
            }
        }

        try {
            for (const entry of fsOps.readdirSync(legacyHashMarkerDir, { withFileTypes: true })) {
                if (!entry.isFile() || entry.name.startsWith(ASSET_TEMP_PREFIX)) continue;
                const verification = files.has(entry.name)
                    ? verifyStoredAssetHash(entry.name)
                    : null;
                if (!verification || verification.ok || !isLegacyHashAsset(entry.name)) {
                    if (clearLegacyHashAsset(entry.name)) cleared++;
                }
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }

        if (discover) {
            writeMarkerFile(legacyHashIdentityMarkerPath, new Date().toISOString());
        }
        return { marked, cleared };
    }

    function assetFileExists(name) {
        return fileStat(name) !== null;
    }

    function assetFileSize(name) {
        return fileStat(name)?.size ?? null;
    }

    function assetFileMtimeMs(name) {
        return fileStat(name)?.mtimeMs ?? null;
    }

    function deleteAssetFile(name) {
        if (!isSafeAssetName(name)) return false;
        let removed = false;
        try {
            fsOps.unlinkSync(assetPathFor(name));
            removed = true;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        clearLegacyHashAsset(name);
        return removed;
    }

    function listAssetFiles() {
        ensureAssetDir();
        const files = [];
        for (const entry of fsOps.readdirSync(assetDir, { withFileTypes: true })) {
            if (!entry.isFile() || entry.name.startsWith('.') || !isSafeAssetName(entry.name)) {
                continue;
            }
            try {
                const stat = fsOps.lstatSync(assetPathFor(entry.name));
                if (!stat.isFile()) continue;
                files.push({
                    name: entry.name,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                });
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        return files;
    }

    function sumAssetFsBytes() {
        return listAssetFiles().reduce((sum, entry) => sum + entry.size, 0);
    }

    function clearAssetFiles() {
        ensureAssetDir();
        let removed = 0;
        for (const entry of fsOps.readdirSync(assetDir, { withFileTypes: true })) {
            if (entry.name === ASSET_MIGRATION_MARKER
                || entry.name === LEGACY_HASH_IDENTITY_MARKER
                || entry.name === LEGACY_HASH_MARKER_DIR) continue;
            if (!entry.isFile() && !entry.isSymbolicLink()) continue;
            try {
                fsOps.unlinkSync(path.join(assetDir, entry.name));
                removed++;
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        fsOps.rmSync(legacyHashMarkerDir, { recursive: true, force: true });
        return removed;
    }

    function swapAssetDirectoryFromStaging(stagingDir, backupDir) {
        return swapDirectoryFromStaging({
            liveDir: assetDir,
            stagingDir,
            backupDir,
            fs: fsOps,
        });
    }

    return {
        assetDir,
        migrationMarkerPath: path.join(assetDir, ASSET_MIGRATION_MARKER),
        legacyHashIdentityMarkerPath,
        legacyHashMarkerDir,
        ensureAssetDir,
        isSafeAssetName,
        portableAssetNameKey,
        isPortableAssetName,
        isHashShapedAssetName,
        assetPathFor,
        legacyHashMarkerPathFor,
        isLegacyHashAsset,
        markLegacyHashAsset,
        clearLegacyHashAsset,
        reconcileLegacyHashAssetIdentity,
        writeAssetFile,
        writeAssetFileIfChanged,
        writeAssetFileFromFile,
        readAssetFile,
        verifyStoredAssetHash,
        assetFileExists,
        assetFileSize,
        assetFileMtimeMs,
        deleteAssetFile,
        listAssetFiles,
        sumAssetFsBytes,
        clearAssetFiles,
        swapAssetDirectoryFromStaging,
    };
}

function migrateAssetRowsToFilesystem(options) {
    const {
        keys,
        getValue,
        deleteValue,
        store,
        existingAssetNames = [],
        onProgress = null,
        onSkipped = null,
    } = options;
    let migrated = 0;
    let skippedUnsafe = 0;
    let skippedNonPortable = 0;
    let skippedCollision = 0;
    const candidates = [];
    const candidateNamesByPortableKey = new Map();
    const existingNamesByPortableKey = new Map();

    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        const name = key.startsWith('assets/') ? key.slice('assets/'.length) : '';
        if (!store.isSafeAssetName(name)) {
            skippedUnsafe++;
            continue;
        }
        if (!store.isPortableAssetName(name)) {
            skippedNonPortable++;
            if (onSkipped) onSkipped({ key, name, reason: 'non-portable' });
            continue;
        }
        const portableKey = store.portableAssetNameKey(name);
        const candidateNames = candidateNamesByPortableKey.get(portableKey) || new Set();
        candidateNames.add(name);
        candidateNamesByPortableKey.set(portableKey, candidateNames);
        candidates.push({ index, key, name, portableKey });
    }

    for (const name of existingAssetNames) {
        const portableKey = store.portableAssetNameKey(name);
        const existingNames = existingNamesByPortableKey.get(portableKey) || new Set();
        existingNames.add(name);
        existingNamesByPortableKey.set(portableKey, existingNames);
    }

    for (const candidate of candidates) {
        const candidateNames = candidateNamesByPortableKey.get(candidate.portableKey);
        const existingNames = existingNamesByPortableKey.get(candidate.portableKey);
        const collidesWithCandidate = candidateNames.size > 1;
        const collidesWithExisting = existingNames
            && [...existingNames].some((name) => name !== candidate.name);
        if (collidesWithCandidate || collidesWithExisting) {
            candidate.blocked = true;
            skippedCollision++;
            if (onSkipped) {
                onSkipped({
                    key: candidate.key,
                    name: candidate.name,
                    reason: 'collision',
                });
            }
        }
    }

    for (const candidate of candidates) {
        if (candidate.blocked) continue;
        const { index, key, name } = candidate;
        const value = getValue(key);
        if (value === null) continue;
        // Safe to drop the row afterwards: writeAssetFileIfChanged either
        // proved the destination byte-identical or durably replaced it.
        store.writeAssetFileIfChanged(name, value);
        deleteValue(key);
        migrated++;
        if (onProgress) onProgress({ index, total: keys.length, key, migrated });
    }

    return { migrated, skippedUnsafe, skippedNonPortable, skippedCollision };
}

const defaultStore = createAssetStore();

module.exports = {
    ASSET_MIGRATION_MARKER,
    ASSET_TEMP_PREFIX,
    LEGACY_HASH_IDENTITY_MARKER,
    LEGACY_HASH_MARKER_DIR,
    LEGACY_HASH_MARKER_VALUE,
    SAFE_ASSET_NAME_RE,
    HASH_NAME_RE,
    isSafeAssetName,
    portableAssetNameKey,
    isPortableAssetName,
    createAssetStore,
    verifyAssetHash,
    swapDirectoryFromStaging,
    migrateAssetRowsToFilesystem,
    ...defaultStore,
};
