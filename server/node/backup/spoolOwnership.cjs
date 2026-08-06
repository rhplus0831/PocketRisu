'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SPOOL_OWNER_ID_FILENAME = '__spool_owner_id';
const OWNED_SPOOL_DIR_PREFIX = '.instance-';
const OWNED_SPOOL_CLAIM_SUFFIX = '.claim';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_PATTERN = /^v1:([0-9a-f]{64})$/;
const DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set([
    'EACCES',
    'EINVAL',
    'EISDIR',
    'ENOTSUP',
    'EPERM',
]);

function canonicalUuid(value) {
    const candidate = String(value ?? '').trim();
    return UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

function lstatOrNull(filePath, fsOps = fs) {
    try {
        return fsOps.lstatSync(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function sameFileIdentity(left, right) {
    if (!left || !right) return false;
    return left.dev === right.dev && left.ino === right.ino;
}

function closeDescriptor(descriptor, fsOps = fs) {
    if (descriptor === null || descriptor === undefined) return;
    fsOps.closeSync(descriptor);
}

function openRegularFileNoFollow(filePath, fsOps = fs, { harden = false } = {}) {
    const before = lstatOrNull(filePath, fsOps);
    if (!before || !before.isFile()) return null;
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let descriptor = null;
    try {
        descriptor = fsOps.openSync(filePath, fs.constants.O_RDONLY | noFollow);
        const after = fsOps.fstatSync(descriptor);
        if (!after.isFile() || !sameFileIdentity(before, after)) {
            closeDescriptor(descriptor, fsOps);
            return null;
        }
        if (harden && (after.mode & 0o777) !== 0o600) {
            fsOps.fchmodSync(descriptor, 0o600);
            fsOps.fsyncSync(descriptor);
        }
        return { descriptor, stat: after };
    } catch (error) {
        if (descriptor !== null) {
            try { closeDescriptor(descriptor, fsOps); } catch {}
        }
        if (['ELOOP', 'EMLINK', 'ENOTDIR'].includes(error?.code)) return null;
        throw error;
    }
}

function readRegularFileNoFollow(filePath, fsOps = fs, { harden = false } = {}) {
    const opened = openRegularFileNoFollow(filePath, fsOps, { harden });
    if (!opened) return null;
    try {
        return {
            value: fsOps.readFileSync(opened.descriptor, 'utf8'),
            stat: opened.stat,
        };
    } finally {
        closeDescriptor(opened.descriptor, fsOps);
    }
}

function readUuid(filePath, fsOps = fs) {
    const read = readRegularFileNoFollow(filePath, fsOps, { harden: true });
    return read ? canonicalUuid(read.value) : null;
}

function fsyncDirectory(directoryPath, fsOps = fs) {
    let descriptor;
    let pendingError = null;
    try {
        descriptor = fsOps.openSync(directoryPath, 'r');
        fsOps.fsyncSync(descriptor);
    } catch (error) {
        if (!DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(error?.code)) pendingError = error;
    } finally {
        if (descriptor !== undefined) {
            try {
                fsOps.closeSync(descriptor);
            } catch (error) {
                if (!DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(error?.code) && !pendingError) {
                    pendingError = error;
                }
            }
        }
    }
    if (pendingError) throw pendingError;
}

function canonicalPath(filePath, fsOps = fs) {
    const realParent = fsOps.realpathSync(path.dirname(filePath));
    const canonical = path.join(realParent, path.basename(filePath));
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function deterministicUuid(filePath, salt = '', fsOps = fs) {
    const digest = crypto.createHash('sha256')
        .update(canonicalPath(filePath, fsOps), 'utf8')
        .update('\0', 'utf8')
        .update(salt, 'utf8')
        .digest();
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function writePrivateTempFile(temporaryPath, value, fsOps = fs) {
    let descriptor = null;
    try {
        descriptor = fsOps.openSync(temporaryPath, 'wx', 0o600);
        fsOps.writeFileSync(descriptor, value, 'utf8');
        fsOps.fchmodSync(descriptor, 0o600);
        fsOps.fsyncSync(descriptor);
        closeDescriptor(descriptor, fsOps);
        descriptor = null;
    } finally {
        if (descriptor !== null) {
            try { closeDescriptor(descriptor, fsOps); } catch {}
        }
    }
}

function publishUuid(filePath, value, { force = false, fs: fsOps = fs } = {}) {
    const temporaryPath = `${filePath}.${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
        writePrivateTempFile(temporaryPath, value, fsOps);
        if (!force) {
            try {
                fsOps.linkSync(temporaryPath, filePath);
                fsyncDirectory(path.dirname(filePath), fsOps);
                return value;
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                const winner = readUuid(filePath, fsOps);
                if (winner) return winner;
            }
        }
        // Every PocketRisu contender for this save path computes the same
        // replacement UUID. Atomic rename therefore repairs invalid files and
        // symlinks without a reclaimable singleton lock or winner divergence.
        fsOps.renameSync(temporaryPath, filePath);
        fsyncDirectory(path.dirname(filePath), fsOps);
        return readUuid(filePath, fsOps) ?? value;
    } finally {
        try { fsOps.unlinkSync(temporaryPath); } catch {}
    }
}

function readOrCreatePersistentUuid(filePath, options = {}) {
    const fsOps = options.fs ?? fs;
    const current = readUuid(filePath, fsOps);
    if (current) return current;
    return publishUuid(filePath, deterministicUuid(filePath, 'persistent-uuid', fsOps), {
        fs: fsOps,
    });
}

function resolveOwnedSpoolDir(spoolRoot, ownerId) {
    const canonicalOwner = canonicalUuid(ownerId);
    if (!canonicalOwner) throw new TypeError('Spool owner id must be a valid UUID');
    const ownerHash = crypto.createHash('sha256').update(canonicalOwner, 'utf8').digest('hex');
    return path.join(spoolRoot, `${OWNED_SPOOL_DIR_PREFIX}${ownerHash}`);
}

function resolveOwnedSpoolDirFromSave(savePath, spoolRoot = path.join(savePath, '.spool')) {
    const ownerId = readUuid(path.join(savePath, SPOOL_OWNER_ID_FILENAME));
    if (!ownerId) throw new Error(`Missing or invalid ${SPOOL_OWNER_ID_FILENAME}`);
    return resolveOwnedSpoolDir(spoolRoot, ownerId);
}

function canonicalInstallationBinding(savePath, fsOps = fs) {
    const realSavePath = fsOps.realpathSync(savePath);
    const portablePath = process.platform === 'win32'
        ? realSavePath.toLowerCase()
        : realSavePath;
    return crypto.createHash('sha256').update(portablePath, 'utf8').digest('hex');
}

function readNamespaceClaim(claimPath, fsOps = fs) {
    const read = readRegularFileNoFollow(claimPath, fsOps, { harden: true });
    if (!read) return null;
    const match = CLAIM_PATTERN.exec(String(read.value).trim());
    return match?.[1] ?? null;
}

function publishNamespaceClaim(claimPath, binding, fsOps = fs) {
    const temporaryPath = `${claimPath}.${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
        writePrivateTempFile(temporaryPath, `v1:${binding}\n`, fsOps);
        try {
            fsOps.linkSync(temporaryPath, claimPath);
        } catch (error) {
            if (error?.code === 'EEXIST') return false;
            throw error;
        }
        fsyncDirectory(path.dirname(claimPath), fsOps);
        return true;
    } finally {
        try { fsOps.unlinkSync(temporaryPath); } catch {}
    }
}

function claimOwnedSpoolNamespaceSync(savePath, spoolRoot, options = {}) {
    const fsOps = options.fs ?? fs;
    fsOps.mkdirSync(spoolRoot, { recursive: true });
    if (!fsOps.statSync(spoolRoot).isDirectory()) {
        const error = new Error('Configured spool root must be a directory');
        error.code = 'ENOTDIR';
        throw error;
    }
    const ownerPath = path.join(savePath, SPOOL_OWNER_ID_FILENAME);
    const binding = canonicalInstallationBinding(savePath, fsOps);
    let ownerId = readOrCreatePersistentUuid(ownerPath, { fs: fsOps });
    for (let attempt = 0; attempt < 32; attempt += 1) {
        const spoolDir = resolveOwnedSpoolDir(spoolRoot, ownerId);
        const claimPath = `${spoolDir}${OWNED_SPOOL_CLAIM_SUFFIX}`;
        const existing = lstatOrNull(claimPath, fsOps);
        if (!existing) {
            if (publishNamespaceClaim(claimPath, binding, fsOps)) {
                return { ownerId, spoolDir, claimPath };
            }
            continue;
        }
        if (readNamespaceClaim(claimPath, fsOps) === binding) {
            return { ownerId, spoolDir, claimPath };
        }
        ownerId = deterministicUuid(ownerPath, `spool-claim:${binding}:${attempt}`, fsOps);
        publishUuid(ownerPath, ownerId, { force: true, fs: fsOps });
    }
    throw new Error('Could not claim a collision-free spool namespace');
}

function openOwnedDirectoryNoFollow(directoryPath, fsOps = fs) {
    const before = lstatOrNull(directoryPath, fsOps);
    if (!before || !before.isDirectory()) return null;
    const flags = fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY ?? 0)
        | (fs.constants.O_NOFOLLOW ?? 0);
    let descriptor = null;
    try {
        descriptor = fsOps.openSync(directoryPath, flags);
        const after = fsOps.fstatSync(descriptor);
        if (!after.isDirectory() || !sameFileIdentity(before, after)) {
            closeDescriptor(descriptor, fsOps);
            return null;
        }
        if ((after.mode & 0o777) !== 0o700) fsOps.fchmodSync(descriptor, 0o700);
        return { descriptor, stat: after };
    } catch (error) {
        if (descriptor !== null) {
            try { closeDescriptor(descriptor, fsOps); } catch {}
        }
        if (['ELOOP', 'EMLINK', 'ENOTDIR'].includes(error?.code)) return null;
        throw error;
    }
}

function ensureOwnedSpoolDirSync(spoolRoot, ownedSpoolDir, options = {}) {
    const fsOps = options.fs ?? fs;
    fsOps.mkdirSync(spoolRoot, { recursive: true });
    if (!fsOps.statSync(spoolRoot).isDirectory()) {
        const error = new Error('Configured spool root must be a directory');
        error.code = 'ENOTDIR';
        throw error;
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const existing = lstatOrNull(ownedSpoolDir, fsOps);
        if (existing && !existing.isDirectory()) {
            const retainedPath = path.join(
                spoolRoot,
                `.rejected-owned-${process.pid}-${crypto.randomUUID()}`,
            );
            try {
                // Atomic parking clears the reusable pathname without ever
                // conditionally unlinking whatever object occupies it.
                fsOps.renameSync(ownedSpoolDir, retainedPath);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            continue;
        }
        if (!lstatOrNull(ownedSpoolDir, fsOps)) {
            try {
                fsOps.mkdirSync(ownedSpoolDir, { mode: 0o700 });
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
            }
        }
        const opened = openOwnedDirectoryNoFollow(ownedSpoolDir, fsOps);
        if (!opened) continue;
        closeDescriptor(opened.descriptor, fsOps);
        return ownedSpoolDir;
    }
    const error = new Error('Owned spool namespace must be a real directory');
    error.code = 'ENOTDIR';
    throw error;
}

function resolvePinnedDirectoryPath(descriptor, expectedStat, fsOps = fs) {
    for (const prefix of ['/proc/self/fd', '/dev/fd']) {
        const candidate = path.join(prefix, String(descriptor));
        try {
            const candidateStat = fsOps.statSync(candidate);
            if (candidateStat.isDirectory() && sameFileIdentity(candidateStat, expectedStat)) {
                return candidate;
            }
        } catch {}
    }
    return null;
}

function openPinnedOwnedSpoolDirSync(ownedSpoolDir, options = {}) {
    const fsOps = options.fs ?? fs;
    const opened = openOwnedDirectoryNoFollow(ownedSpoolDir, fsOps);
    if (!opened) return null;
    const pinnedPath = resolvePinnedDirectoryPath(opened.descriptor, opened.stat, fsOps);
    if (!pinnedPath) {
        closeDescriptor(opened.descriptor, fsOps);
        return null;
    }
    return {
        descriptor: opened.descriptor,
        pinnedPath,
        stat: opened.stat,
    };
}

function withQuarantinedOwnedSpoolDirSync(
    spoolRoot,
    ownedSpoolDir,
    sweep,
    options = {},
) {
    const fsOps = options.fs ?? fs;
    const hooks = options.hooks ?? {};
    fsOps.mkdirSync(spoolRoot, { recursive: true });
    if (!fsOps.statSync(spoolRoot).isDirectory()) {
        const error = new Error('Configured spool root must be a directory');
        error.code = 'ENOTDIR';
        throw error;
    }
    const existing = lstatOrNull(ownedSpoolDir, fsOps);
    if (!existing) {
        ensureOwnedSpoolDirSync(spoolRoot, ownedSpoolDir, { fs: fsOps });
        return { quarantined: false, swept: false };
    }
    const quarantinePath = path.join(
        spoolRoot,
        `.boot-sweep-${process.pid}-${crypto.randomUUID()}`,
    );
    options.hooks?.beforeQuarantineRename?.({
        ownedSpoolDir,
        quarantinePath,
        sourceStat: existing,
    });
    fsOps.renameSync(ownedSpoolDir, quarantinePath);
    ensureOwnedSpoolDirSync(spoolRoot, ownedSpoolDir, { fs: fsOps });

    const quarantined = lstatOrNull(quarantinePath, fsOps);
    if (!quarantined?.isDirectory()) return { quarantined: true, swept: false };
    const opened = openOwnedDirectoryNoFollow(quarantinePath, fsOps);
    if (!opened) return { quarantined: true, swept: false };
    if (!sameFileIdentity(existing, opened.stat)) {
        closeDescriptor(opened.descriptor, fsOps);
        return { quarantined: true, swept: false };
    }
    const freshOpened = openOwnedDirectoryNoFollow(ownedSpoolDir, fsOps);
    if (!freshOpened) {
        closeDescriptor(opened.descriptor, fsOps);
        return { quarantined: true, swept: false };
    }
    let swept = false;
    try {
        const pinnedPath = resolvePinnedDirectoryPath(opened.descriptor, opened.stat, fsOps);
        const freshPinnedPath = resolvePinnedDirectoryPath(
            freshOpened.descriptor,
            freshOpened.stat,
            fsOps,
        );
        if (!pinnedPath || !freshPinnedPath) return { quarantined: true, swept: false };
        hooks.afterDirectoryPinned?.({
            descriptor: opened.descriptor,
            freshDescriptor: freshOpened.descriptor,
            freshPinnedPath,
            pinnedPath,
            quarantinePath,
        });
        sweep(pinnedPath);
        // The historical sweep preserves unrelated entries. Publish ordinary
        // file survivors create-only into the fresh pinned directory and keep
        // the original hard link in quarantine. Conflicts and unsupported
        // entry types retain both sides without an overwriting rename.
        for (const entry of fsOps.readdirSync(pinnedPath, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const sourcePath = path.join(pinnedPath, entry.name);
            const destinationPath = path.join(freshPinnedPath, entry.name);
            try {
                fsOps.linkSync(sourcePath, destinationPath);
            } catch (error) {
                if (!['EEXIST', 'EPERM', 'EXDEV', 'ENOTSUP'].includes(error?.code)) {
                    throw error;
                }
                if (error?.code !== 'EEXIST') {
                    try {
                        fsOps.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
                    } catch (copyError) {
                        if (copyError?.code !== 'EEXIST') continue;
                    }
                }
            }
        }
        swept = true;
    } finally {
        closeDescriptor(opened.descriptor, fsOps);
        closeDescriptor(freshOpened.descriptor, fsOps);
        hooks.afterDescriptorsClosed?.({ quarantinePath });
    }
    return { quarantined: true, swept };
}

module.exports = {
    SPOOL_OWNER_ID_FILENAME,
    OWNED_SPOOL_DIR_PREFIX,
    OWNED_SPOOL_CLAIM_SUFFIX,
    UUID_PATTERN,
    canonicalUuid,
    readOrCreatePersistentUuid,
    resolveOwnedSpoolDir,
    resolveOwnedSpoolDirFromSave,
    claimOwnedSpoolNamespaceSync,
    ensureOwnedSpoolDirSync,
    openPinnedOwnedSpoolDirSync,
    withQuarantinedOwnedSpoolDirSync,
};
