'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const ASSET_MIGRATION_MARKER = '.migrated_to_fs';
const ASSET_TEMP_PREFIX = '.tmp-';
const SAFE_ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const HASH_NAME_RE = /^assets\/([0-9a-f]{64})\.[A-Za-z0-9]{1,10}$/;

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

    function ensureAssetDir() {
        fsOps.mkdirSync(assetDir, { recursive: true });
    }

    function isSafeAssetName(name) {
        return typeof name === 'string'
            && SAFE_ASSET_NAME_RE.test(name)
            && name !== ASSET_MIGRATION_MARKER
            && !name.startsWith(ASSET_TEMP_PREFIX);
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
            try {
                const dirFd = fsOps.openSync(assetDir, 'r');
                try { fsOps.fsyncSync(dirFd); } finally { fsOps.closeSync(dirFd); }
            } catch {
                // Directory fsync is unavailable on some platforms.
            }
        } finally {
            if (fd !== undefined) {
                try { fsOps.closeSync(fd); } catch {}
            }
            if (tempPath) {
                try { fsOps.unlinkSync(tempPath); } catch {}
            }
        }
    }

    function writeAssetFileIfSizeDiffers(name, buffer) {
        const data = Buffer.from(buffer);
        if (assetFileSize(name) === data.length) return false;
        writeAssetFile(name, data);
        return true;
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
        try {
            fsOps.unlinkSync(assetPathFor(name));
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
        }
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
            if (entry.name === ASSET_MIGRATION_MARKER) continue;
            if (!entry.isFile() && !entry.isSymbolicLink()) continue;
            try {
                fsOps.unlinkSync(path.join(assetDir, entry.name));
                removed++;
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
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
        ensureAssetDir,
        isSafeAssetName,
        assetPathFor,
        writeAssetFile,
        writeAssetFileIfSizeDiffers,
        readAssetFile,
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
        onProgress = null,
    } = options;
    let migrated = 0;
    let skippedUnsafe = 0;

    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        const name = key.startsWith('assets/') ? key.slice('assets/'.length) : '';
        if (!store.isSafeAssetName(name)) {
            skippedUnsafe++;
            continue;
        }
        const value = getValue(key);
        if (value === null) continue;
        store.writeAssetFileIfSizeDiffers(name, value);
        deleteValue(key);
        migrated++;
        if (onProgress) onProgress({ index, total: keys.length, key, migrated });
    }

    return { migrated, skippedUnsafe };
}

const defaultStore = createAssetStore();

module.exports = {
    ASSET_MIGRATION_MARKER,
    ASSET_TEMP_PREFIX,
    SAFE_ASSET_NAME_RE,
    HASH_NAME_RE,
    createAssetStore,
    verifyAssetHash,
    swapDirectoryFromStaging,
    migrateAssetRowsToFilesystem,
    ...defaultStore,
};
