'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isSafeAssetName } = require('./assetStore.cjs');
const {
    acquireAssetMaintenanceLockSync,
    assetMaintenanceLockPath,
    isAssetMaintenanceLockedError,
    releaseAssetMaintenanceLockHandle,
} = require('./assetMaintenanceLock.cjs');

const ASSET_DEDUP_TEMP_PREFIX = '.pocketrisu-dedup-tmp-v1-';
const ASSET_DEDUP_TEMP_RE = /^\.pocketrisu-dedup-tmp-v1-[0-9]+-[0-9a-f-]{36}$/;
const HASH_PAGE_BYTES = 256 * 1024;
// Compare every permission and special bit, but not the file-type bits. The
// latter are validated explicitly, and directories and regular files must be
// allowed to have their naturally different types and permission policies.
const STAT_PERMISSION_MODE_MASK = 0o7777;

function comparePathBytes(left, right) {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function invalidAssetDirectoryError(candidate, detail = '') {
    const suffix = detail ? ` (${detail})` : '';
    const error = new Error(
        `Dedup target must be a PocketRisu assets directory: ${path.resolve(candidate)}${suffix}`,
    );
    error.code = 'INVALID_ASSET_DIRECTORY';
    return error;
}

function wait(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function fsyncDirectorySync(directory, fsOps = fs) {
    let descriptor;
    try {
        descriptor = fsOps.openSync(directory, 'r');
        fsOps.fsyncSync(descriptor);
    } catch (error) {
        if (!['EINVAL', 'ENOTSUP'].includes(error?.code)
            && !(process.platform === 'win32'
                && ['EACCES', 'EISDIR', 'EPERM'].includes(error?.code))) {
            throw error;
        }
    } finally {
        if (descriptor !== undefined) {
            try { fsOps.closeSync(descriptor); } catch {}
        }
    }
}

function dedupMetadataFromStat(stat, label = 'Filesystem entry') {
    const metadata = {
        uid: stat?.uid,
        gid: stat?.gid,
        mode: Number.isInteger(stat?.mode) ? stat.mode & STAT_PERMISSION_MODE_MASK : NaN,
    };
    if (!Number.isInteger(metadata.uid) || metadata.uid < 0
        || !Number.isInteger(metadata.gid) || metadata.gid < 0
        || !Number.isInteger(metadata.mode)) {
        const error = new Error(`${label} has unavailable ownership or mode metadata`);
        error.code = 'ASSET_DEDUP_METADATA_MISMATCH';
        throw error;
    }
    return metadata;
}

function sameDedupMetadata(left, right) {
    const leftMetadata = dedupMetadataFromStat(left);
    const rightMetadata = dedupMetadataFromStat(right);
    return leftMetadata.uid === rightMetadata.uid
        && leftMetadata.gid === rightMetadata.gid
        && leftMetadata.mode === rightMetadata.mode;
}

function formatDedupMetadata(metadata) {
    return `uid=${metadata.uid}, gid=${metadata.gid}, mode=0${metadata.mode.toString(8)}`;
}

function assertDedupMetadata(stat, expected, label) {
    const actual = dedupMetadataFromStat(stat, label);
    if (actual.uid === expected.uid
        && actual.gid === expected.gid
        && actual.mode === expected.mode) {
        return actual;
    }
    const error = new Error(
        `Asset dedup metadata mismatch for ${label}: expected ${formatDedupMetadata(expected)}; `
        + `received ${formatDedupMetadata(actual)}`,
    );
    error.code = 'ASSET_DEDUP_METADATA_MISMATCH';
    throw error;
}

function samePinnedIdentity(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && sameDedupMetadata(left, right);
}

function assertRegularFileStat(stat, label) {
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${label} is no longer a regular file`);
    }
}

function hashPinnedFile(filePath, expectedStat = null, fsOps = fs) {
    const descriptor = fsOps.openSync(filePath, 'r');
    const hash = crypto.createHash('sha256');
    const page = Buffer.allocUnsafe(HASH_PAGE_BYTES);
    try {
        const before = fsOps.fstatSync(descriptor);
        assertRegularFileStat(before, filePath);
        if (expectedStat && !samePinnedIdentity(before, expectedStat)) {
            throw new Error(`Asset changed before revalidation: ${filePath}`);
        }
        let position = 0;
        while (position < before.size) {
            const length = Math.min(page.length, before.size - position);
            const bytesRead = fsOps.readSync(descriptor, page, 0, length, position);
            if (bytesRead !== length) throw new Error(`Asset changed while reading: ${filePath}`);
            hash.update(page.subarray(0, bytesRead));
            position += bytesRead;
        }
        const after = fsOps.fstatSync(descriptor);
        if (!samePinnedIdentity(before, after)) {
            throw new Error(`Asset changed while hashing: ${filePath}`);
        }
        return { hash: hash.digest('hex'), stat: after };
    } finally {
        fsOps.closeSync(descriptor);
    }
}

function filesEqualPinned(leftPath, rightPath, leftStat, rightStat, fsOps = fs) {
    if (leftStat.size !== rightStat.size) return false;
    const left = fsOps.openSync(leftPath, 'r');
    const right = fsOps.openSync(rightPath, 'r');
    const leftPage = Buffer.allocUnsafe(HASH_PAGE_BYTES);
    const rightPage = Buffer.allocUnsafe(HASH_PAGE_BYTES);
    try {
        const leftBefore = fsOps.fstatSync(left);
        const rightBefore = fsOps.fstatSync(right);
        if (!samePinnedIdentity(leftBefore, leftStat)
            || !samePinnedIdentity(rightBefore, rightStat)) {
            throw new Error('Asset identity changed before byte comparison');
        }
        let position = 0;
        while (position < leftBefore.size) {
            const length = Math.min(leftPage.length, leftBefore.size - position);
            const leftRead = fsOps.readSync(left, leftPage, 0, length, position);
            const rightRead = fsOps.readSync(right, rightPage, 0, length, position);
            if (leftRead !== length || rightRead !== length
                || !leftPage.subarray(0, length).equals(rightPage.subarray(0, length))) {
                return false;
            }
            position += length;
        }
        const leftAfter = fsOps.fstatSync(left);
        const rightAfter = fsOps.fstatSync(right);
        if (!samePinnedIdentity(leftBefore, leftAfter)
            || !samePinnedIdentity(rightBefore, rightAfter)) {
            throw new Error('Asset identity changed during byte comparison');
        }
        return true;
    } finally {
        fsOps.closeSync(left);
        fsOps.closeSync(right);
    }
}

function recoverInterruptedDedupNames(assetDir, fsOps = fs) {
    let recovered = 0;
    for (const entry of fsOps.readdirSync(assetDir, { withFileTypes: true })) {
        if (!ASSET_DEDUP_TEMP_RE.test(entry.name)) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) {
            throw new Error(`Interrupted dedup path is not a file: ${path.join(assetDir, entry.name)}`);
        }
        try {
            fsOps.unlinkSync(path.join(assetDir, entry.name));
            recovered++;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    if (recovered > 0) fsyncDirectorySync(assetDir, fsOps);
    return recovered;
}

function listDedupCandidates(assetDirs, fsOps = fs) {
    const candidates = [];
    for (const assetDir of assetDirs) {
        for (const entry of fsOps.readdirSync(assetDir, { withFileTypes: true })) {
            // This deliberately excludes every PocketRisu and tool temporary:
            // both families are hidden, while runtime names must pass the
            // asset store's complete bounded filename predicate.
            if (entry.name.startsWith('.') || !isSafeAssetName(entry.name) || !entry.isFile()) {
                continue;
            }
            const filePath = path.join(assetDir, entry.name);
            const stat = fsOps.lstatSync(filePath);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            candidates.push({ assetDir, name: entry.name, filePath, stat });
        }
    }
    return candidates.sort((left, right) => comparePathBytes(left.filePath, right.filePath));
}

function preflightDedupEligibility(assetDirs, candidates, fsOps = fs) {
    const directoryStats = new Map();
    let directoryMetadata = null;
    let device = null;
    for (const assetDir of assetDirs) {
        const stat = fsOps.lstatSync(assetDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw invalidAssetDirectoryError(assetDir, 'operand is no longer a directory');
        }
        if (device === null) device = stat.dev;
        if (stat.dev !== device) {
            throw new Error('All asset directories must be on the same filesystem');
        }
        if (directoryMetadata === null) {
            directoryMetadata = dedupMetadataFromStat(stat, `asset directory ${assetDir}`);
        } else {
            assertDedupMetadata(stat, directoryMetadata, `asset directory ${assetDir}`);
        }
        directoryStats.set(assetDir, stat);
    }

    let candidateMetadata = null;
    for (const candidate of candidates) {
        const containingDirectory = directoryStats.get(candidate.assetDir);
        const containingMetadata = dedupMetadataFromStat(
            containingDirectory,
            `asset directory ${candidate.assetDir}`,
        );
        const actual = dedupMetadataFromStat(candidate.stat, `asset candidate ${candidate.filePath}`);
        if (actual.uid !== containingMetadata.uid || actual.gid !== containingMetadata.gid) {
            const expected = {
                uid: containingMetadata.uid,
                gid: containingMetadata.gid,
                mode: actual.mode,
            };
            assertDedupMetadata(candidate.stat, expected, `asset candidate ${candidate.filePath}`);
        }
        if (candidateMetadata === null) {
            candidateMetadata = actual;
        } else {
            assertDedupMetadata(candidate.stat, candidateMetadata, `asset candidate ${candidate.filePath}`);
        }
    }
    return { directoryMetadata, candidateMetadata };
}

function assertPublicationEligibility(source, destination, sourceStat, destinationStat, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const expected = options.eligibility ?? {};
    const sourceDirectoryStat = fsOps.lstatSync(source.assetDir);
    const destinationDirectoryStat = fsOps.lstatSync(destination.assetDir);
    if (!sourceDirectoryStat.isDirectory() || sourceDirectoryStat.isSymbolicLink()
        || !destinationDirectoryStat.isDirectory() || destinationDirectoryStat.isSymbolicLink()) {
        throw new Error('Asset directory changed before hardlink publication');
    }
    if (sourceDirectoryStat.dev !== destinationDirectoryStat.dev) {
        throw new Error('Asset directories changed filesystem before hardlink publication');
    }
    const directoryMetadata = expected.directoryMetadata
        ?? dedupMetadataFromStat(sourceDirectoryStat, `asset directory ${source.assetDir}`);
    assertDedupMetadata(
        sourceDirectoryStat,
        directoryMetadata,
        `asset directory ${source.assetDir}`,
    );
    assertDedupMetadata(
        destinationDirectoryStat,
        directoryMetadata,
        `asset directory ${destination.assetDir}`,
    );

    const candidateMetadata = expected.candidateMetadata
        ?? dedupMetadataFromStat(sourceStat, `asset candidate ${source.filePath}`);
    assertDedupMetadata(sourceStat, candidateMetadata, `asset candidate ${source.filePath}`);
    assertDedupMetadata(
        destinationStat,
        candidateMetadata,
        `asset candidate ${destination.filePath}`,
    );
    if (candidateMetadata.uid !== directoryMetadata.uid
        || candidateMetadata.gid !== directoryMetadata.gid) {
        const error = new Error(
            `Asset candidates must share their target directories' ownership: `
            + `${formatDedupMetadata(candidateMetadata)} versus `
            + `${formatDedupMetadata(directoryMetadata)}`,
        );
        error.code = 'ASSET_DEDUP_METADATA_MISMATCH';
        throw error;
    }
    return { directoryMetadata, candidateMetadata };
}

function publishDedupHardlink(source, destination, expectedHash, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const onStage = options.onStage ?? (() => {});
    const sourceBefore = fsOps.lstatSync(source.filePath);
    const destinationBefore = fsOps.lstatSync(destination.filePath);
    assertRegularFileStat(sourceBefore, source.filePath);
    assertRegularFileStat(destinationBefore, destination.filePath);
    if (sourceBefore.dev === destinationBefore.dev
        && sourceBefore.ino === destinationBefore.ino) return false;
    if (sourceBefore.dev !== destinationBefore.dev) {
        throw new Error(`Cannot hardlink assets across filesystems: ${source.filePath} -> ${destination.filePath}`);
    }
    const eligibility = assertPublicationEligibility(
        source,
        destination,
        sourceBefore,
        destinationBefore,
        { fsOps, eligibility: options.eligibility },
    );

    const sourceHash = hashPinnedFile(source.filePath, sourceBefore, fsOps);
    const destinationHash = hashPinnedFile(destination.filePath, destinationBefore, fsOps);
    if (sourceHash.hash !== expectedHash || destinationHash.hash !== expectedHash
        || !filesEqualPinned(
            source.filePath,
            destination.filePath,
            sourceHash.stat,
            destinationHash.stat,
            fsOps,
        )) {
        throw new Error('Dedup candidate content changed before publication');
    }

    const tempPath = path.join(
        destination.assetDir,
        `${ASSET_DEDUP_TEMP_PREFIX}${process.pid}-${crypto.randomUUID()}`,
    );
    let tempExists = false;
    let published = false;
    try {
        onStage('before-link', { source, destination, tempPath });
        fsOps.linkSync(source.filePath, tempPath);
        tempExists = true;
        onStage('after-link', { source, destination, tempPath });

        const sourceNow = fsOps.lstatSync(source.filePath);
        const destinationNow = fsOps.lstatSync(destination.filePath);
        const tempNow = fsOps.lstatSync(tempPath);
        if (!samePinnedIdentity(sourceBefore, sourceNow)
            || !samePinnedIdentity(destinationBefore, destinationNow)
            || sourceNow.dev !== tempNow.dev
            || sourceNow.ino !== tempNow.ino
            || sourceNow.size !== tempNow.size
            || !sameDedupMetadata(sourceNow, tempNow)) {
            throw new Error('Dedup candidate inode changed before atomic publication');
        }
        onStage('before-revalidate', { source, destination, tempPath });
        const sourceRevalidated = hashPinnedFile(source.filePath, sourceNow, fsOps);
        const destinationRevalidated = hashPinnedFile(
            destination.filePath,
            destinationNow,
            fsOps,
        );
        const tempRevalidated = hashPinnedFile(tempPath, tempNow, fsOps);
        if (sourceRevalidated.hash !== expectedHash
            || destinationRevalidated.hash !== expectedHash
            || tempRevalidated.hash !== expectedHash
            || !filesEqualPinned(
                source.filePath,
                destination.filePath,
                sourceRevalidated.stat,
                destinationRevalidated.stat,
                fsOps,
            )) {
            throw new Error('Dedup candidate content changed during immediate revalidation');
        }
        onStage('after-revalidate', { source, destination, tempPath });

        // Crash injection above is deliberately followed by one final complete
        // revalidation. No callback or asynchronous boundary is permitted
        // between this validation and the atomic replacement.
        const finalSource = hashPinnedFile(source.filePath, sourceRevalidated.stat, fsOps);
        const finalDestination = hashPinnedFile(
            destination.filePath,
            destinationRevalidated.stat,
            fsOps,
        );
        const finalTemp = hashPinnedFile(tempPath, tempRevalidated.stat, fsOps);
        if (finalSource.hash !== expectedHash
            || finalDestination.hash !== expectedHash
            || finalTemp.hash !== expectedHash
            || !filesEqualPinned(
                source.filePath,
                destination.filePath,
                finalSource.stat,
                finalDestination.stat,
                fsOps,
            )) {
            throw new Error('Dedup candidate changed immediately before atomic publication');
        }

        // This is the metadata publication boundary. Re-read all path metadata
        // after the final descriptor-pinned content checks, then permit no
        // callback or asynchronous boundary before rename.
        const boundarySource = fsOps.lstatSync(source.filePath);
        const boundaryDestination = fsOps.lstatSync(destination.filePath);
        const boundaryTemp = fsOps.lstatSync(tempPath);
        if (!samePinnedIdentity(finalSource.stat, boundarySource)
            || !samePinnedIdentity(finalDestination.stat, boundaryDestination)
            || !samePinnedIdentity(finalTemp.stat, boundaryTemp)
            || boundarySource.dev !== boundaryTemp.dev
            || boundarySource.ino !== boundaryTemp.ino) {
            throw new Error('Dedup candidate metadata changed at the publication boundary');
        }
        assertPublicationEligibility(
            source,
            destination,
            boundarySource,
            boundaryDestination,
            { fsOps, eligibility },
        );
        assertDedupMetadata(
            boundaryTemp,
            eligibility.candidateMetadata,
            `dedup publication temp ${tempPath}`,
        );
        fsOps.renameSync(tempPath, destination.filePath);
        tempExists = false;
        published = true;
        onStage('after-rename', { source, destination, tempPath });
        fsyncDirectorySync(destination.assetDir, fsOps);
        onStage('after-directory-fsync', { source, destination, tempPath });

        const publishedStat = fsOps.lstatSync(destination.filePath);
        if (publishedStat.dev !== sourceRevalidated.stat.dev
            || publishedStat.ino !== sourceRevalidated.stat.ino
            || !sameDedupMetadata(publishedStat, eligibility.candidateMetadata)
            || hashPinnedFile(destination.filePath, publishedStat, fsOps).hash !== expectedHash) {
            throw new Error('Published dedup hardlink failed post-publication validation');
        }
        return true;
    } catch (error) {
        if (error && typeof error === 'object') error.dedupPublished = published;
        throw error;
    } finally {
        if (tempExists) {
            try { fsOps.unlinkSync(tempPath); } catch {}
        }
    }
}

async function normalizeAssetDirectories(assetDirs, fsOps = fs.promises) {
    if (!Array.isArray(assetDirs)) throw new TypeError('Asset directories must be an array');
    const unique = new Map();
    for (const candidate of assetDirs) {
        if (typeof candidate !== 'string' || candidate.trim().length === 0) {
            const error = new Error('Asset directory operands must be non-empty paths');
            error.code = 'INVALID_ASSET_DIRECTORY';
            throw error;
        }
        const resolved = path.resolve(candidate);
        let real;
        try {
            const lexicalStat = await fsOps.lstat(resolved);
            if (lexicalStat.isSymbolicLink()) {
                const error = new Error(`Asset directory itself must not be a symbolic link: ${resolved}`);
                error.code = 'ASSET_DIRECTORY_SYMLINK';
                throw error;
            }
            if (!lexicalStat.isDirectory()) {
                throw invalidAssetDirectoryError(candidate, 'operand is not a directory');
            }
            real = await fsOps.realpath(resolved);
        } catch (error) {
            if (error?.code === 'ENOENT' && path.basename(resolved) === 'assets') continue;
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
                throw invalidAssetDirectoryError(candidate, 'operand does not resolve to a directory');
            }
            throw error;
        }
        const stat = await fsOps.lstat(real);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw invalidAssetDirectoryError(candidate, 'operand is not a directory');
        }
        if (path.basename(real) !== 'assets') {
            throw invalidAssetDirectoryError(candidate);
        }
        unique.set(real, real);
    }
    return [...unique.values()].sort(comparePathBytes);
}

function appendReleaseErrors(primaryError, releaseErrors) {
    if (!primaryError || typeof primaryError !== 'object') return;
    if (!Array.isArray(primaryError.cleanupErrors)) primaryError.cleanupErrors = [];
    primaryError.cleanupErrors.push(...releaseErrors);
}

function releaseAllAssetMaintenanceLocks(locks, options = {}, primaryError = null) {
    const releaseErrors = [];
    const releaseLock = options.releaseLock
        ?? ((lock) => releaseAssetMaintenanceLockHandle(lock));
    for (const lock of [...locks].reverse()) {
        try {
            releaseLock(lock);
        } catch (error) {
            releaseErrors.push(error);
        }
    }
    if (releaseErrors.length === 0) return true;
    if (primaryError) {
        appendReleaseErrors(primaryError, releaseErrors);
        return false;
    }
    const error = releaseErrors[0];
    appendReleaseErrors(error, releaseErrors.slice(1));
    throw error;
}

async function acquireAllAssetMaintenanceLocks(assetDirs, options = {}) {
    const timeoutMs = options.lockTimeoutMs ?? 30_000;
    const retryMs = options.lockRetryMs ?? 100;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const lockTargets = [...new Map(assetDirs.map((assetDir) => (
        [assetMaintenanceLockPath(assetDir), assetDir]
    ))).values()].sort((left, right) => (
        comparePathBytes(assetMaintenanceLockPath(left), assetMaintenanceLockPath(right))
    ));

    while (true) {
        const locks = [];
        try {
            for (const assetDir of lockTargets) {
                locks.push(acquireAssetMaintenanceLockSync(assetDir, {
                    purpose: 'cross-instance asset deduplication',
                }));
            }
            return locks;
        } catch (error) {
            releaseAllAssetMaintenanceLocks(locks, options, error);
            if (error?.cleanupErrors?.length > 0) throw error;
            if (!isAssetMaintenanceLockedError(error) || Date.now() >= deadline) throw error;
            await wait(Math.min(retryMs, Math.max(1, deadline - Date.now())));
        }
    }
}

async function deduplicateAssetDirectories(assetDirs, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const onStage = options.onStage ?? (() => {});
    const normalizedDirs = await normalizeAssetDirectories(assetDirs, fsOps.promises);
    if (normalizedDirs.length === 0) {
        return { directories: normalizedDirs.length, scanned: 0, linked: 0, recovered: 0 };
    }

    const locks = await acquireAllAssetMaintenanceLocks(normalizedDirs, options);
    let primaryError = null;
    try {
        options.onLocksAcquired?.(locks);
        onStage('after-locks-acquired', { assetDirs: normalizedDirs });
        const candidates = listDedupCandidates(normalizedDirs, fsOps);
        const eligibility = preflightDedupEligibility(normalizedDirs, candidates, fsOps);
        let recovered = 0;
        for (const assetDir of normalizedDirs) {
            recovered += recoverInterruptedDedupNames(assetDir, fsOps);
        }
        onStage('after-temp-recovery', { assetDirs: normalizedDirs, recovered });
        if (normalizedDirs.length < 2) {
            return { directories: normalizedDirs.length, scanned: 0, linked: 0, recovered };
        }

        const sizeGroups = new Map();
        for (const candidate of candidates) {
            const group = sizeGroups.get(candidate.stat.size) ?? [];
            group.push(candidate);
            sizeGroups.set(candidate.stat.size, group);
        }

        const hashGroups = new Map();
        for (const group of sizeGroups.values()) {
            if (group.length < 2) continue;
            for (const candidate of group) {
                const current = hashPinnedFile(candidate.filePath, candidate.stat, fsOps);
                const hashGroup = hashGroups.get(current.hash) ?? [];
                hashGroup.push({ ...candidate, stat: current.stat });
                hashGroups.set(current.hash, hashGroup);
            }
        }

        let linked = 0;
        for (const [hash, group] of hashGroups) {
            if (group.length < 2) continue;
            const source = group[0];
            for (const destination of group.slice(1)) {
                if (publishDedupHardlink(source, destination, hash, {
                    fsOps,
                    onStage,
                    eligibility,
                })) {
                    linked++;
                }
            }
        }
        return {
            directories: normalizedDirs.length,
            scanned: candidates.length,
            linked,
            recovered,
        };
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        releaseAllAssetMaintenanceLocks(locks, options, primaryError);
    }
}

module.exports = {
    ASSET_DEDUP_TEMP_PREFIX,
    ASSET_DEDUP_TEMP_RE,
    comparePathBytes,
    deduplicateAssetDirectories,
    dedupMetadataFromStat,
    filesEqualPinned,
    hashPinnedFile,
    listDedupCandidates,
    normalizeAssetDirectories,
    preflightDedupEligibility,
    publishDedupHardlink,
    recoverInterruptedDedupNames,
    releaseAllAssetMaintenanceLocks,
    samePinnedIdentity,
};
