'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ASSET_MAINTENANCE_LOCK_NAME = '__asset_maintenance.lock';
const ASSET_MAINTENANCE_LOCK_OWNER = 'owner.json';
const ASSET_MAINTENANCE_LOCK_VERSION = 1;
const ASSET_MAINTENANCE_RECOVERY_PREFIX = '.recover-';
const ASSET_MAINTENANCE_OWNER_STAGE_PREFIX = '.owner-stage-';
const ASSET_MAINTENANCE_RECOVERY_STAGE_PREFIX = '.recover-stage-';
const OWNER_STAGE_RE = /^\.owner-stage-([0-9a-f]{16})-([1-9][0-9]{0,15})-([0-9a-f]{64})$/;
const RECOVERY_STAGE_RE = /^\.recover-stage-([0-9a-f]{16})-([1-9][0-9]{0,15})-([0-9a-f]{64})$/;
const RECOVERY_INTENT_RE = /^\.recover-([0-9a-f]{64})$/;
const activeOwnerStages = new Set();

function directoryFsyncErrorIsUnsupported(error, platform = process.platform) {
    if (error?.code === 'EINVAL' || error?.code === 'ENOTSUP') return true;
    return platform === 'win32' && ['EACCES', 'EISDIR', 'EPERM'].includes(error?.code);
}

function fsyncDirectorySync(directoryPath, fsOps = fs, platform = process.platform) {
    let descriptor;
    let pendingError = null;
    try {
        descriptor = fsOps.openSync(directoryPath, 'r');
        fsOps.fsyncSync(descriptor);
    } catch (error) {
        if (!directoryFsyncErrorIsUnsupported(error, platform)) pendingError = error;
    } finally {
        if (descriptor !== undefined) {
            try {
                fsOps.closeSync(descriptor);
            } catch (error) {
                if (!directoryFsyncErrorIsUnsupported(error, platform) && !pendingError) {
                    pendingError = error;
                }
            }
        }
    }
    if (pendingError) throw pendingError;
}

function assetDirectorySymlinkError(assetDir) {
    const error = new Error(
        `Asset directory itself must not be a symbolic link: ${path.resolve(assetDir)}`,
    );
    error.code = 'ASSET_DIRECTORY_SYMLINK';
    return error;
}

function canonicalAssetDirectoryIdentitySync(assetDir, fsOps = fs) {
    if (typeof assetDir !== 'string' || assetDir.trim().length === 0) {
        throw new TypeError('Asset directory must be a non-empty filesystem path');
    }
    const absoluteAssetDir = path.resolve(assetDir);
    const missingSegments = [];
    let existingPrefix = absoluteAssetDir;
    while (true) {
        try {
            const stat = fsOps.lstatSync(existingPrefix);
            if (existingPrefix === absoluteAssetDir && stat.isSymbolicLink()) {
                throw assetDirectorySymlinkError(absoluteAssetDir);
            }
            return path.join(fsOps.realpathSync(existingPrefix), ...missingSegments);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            const parent = path.dirname(existingPrefix);
            if (parent === existingPrefix) throw error;
            missingSegments.unshift(path.basename(existingPrefix));
            existingPrefix = parent;
        }
    }
}

function sameAssetDirectoryIdentitySync(left, right, fsOps = fs) {
    const leftIdentity = canonicalAssetDirectoryIdentitySync(left, fsOps);
    const rightIdentity = canonicalAssetDirectoryIdentitySync(right, fsOps);
    return process.platform === 'win32'
        ? leftIdentity.toLowerCase() === rightIdentity.toLowerCase()
        : leftIdentity === rightIdentity;
}

function assetMaintenanceLockPath(assetDir, fsOps = fs) {
    const canonicalAssetDir = canonicalAssetDirectoryIdentitySync(assetDir, fsOps);
    return path.join(path.dirname(canonicalAssetDir), ASSET_MAINTENANCE_LOCK_NAME);
}

function readAssetMaintenanceLockOwnerSync(lockPath, fsOps = fs) {
    const ownerPath = path.join(lockPath, ASSET_MAINTENANCE_LOCK_OWNER);
    try {
        const stat = fsOps.lstatSync(ownerPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4096) {
            return null;
        }
        const owner = JSON.parse(fsOps.readFileSync(ownerPath, 'utf8'));
        if (!owner
            || typeof owner !== 'object'
            || Array.isArray(owner)
            || owner.version !== ASSET_MAINTENANCE_LOCK_VERSION
            || typeof owner.token !== 'string'
            || !/^[0-9a-f]{64}$/.test(owner.token)
            || !Number.isSafeInteger(owner.pid)
            || owner.pid <= 0
            || typeof owner.hostname !== 'string'
            || owner.hostname.length === 0
            || owner.hostname.length > 255
            || typeof owner.purpose !== 'string'
            || typeof owner.acquiredAt !== 'string') {
            return null;
        }
        return owner;
    } catch {
        return null;
    }
}

function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        // EPERM and unfamiliar platform errors are ambiguous and therefore live.
        return true;
    }
}

function assetMaintenanceLockedError(lockPath, owner) {
    const detail = owner
        ? `owner pid ${owner.pid} on ${owner.hostname} (${owner.purpose || 'unknown operation'})`
        : 'owner metadata is incomplete or unreadable';
    const recovery = owner
        ? 'Valid dead same-host ownership is recovered automatically by the next operation.'
        : `This malformed ownership cannot be recovered automatically. Verify that no asset operation is active, then remove only ${path.join(lockPath, ASSET_MAINTENANCE_LOCK_OWNER)}.`;
    const error = new Error(
        `Asset storage is locked by ${detail}. Retry after maintenance completes. ${recovery}`,
    );
    error.code = 'ASSET_MAINTENANCE_LOCKED';
    error.assetMaintenanceLocked = true;
    error.lockPath = lockPath;
    error.owner = owner;
    error.statusCode = 503;
    error.retryable = true;
    error.commitOutcome = 'not-committed';
    error.commitOutcomeUnknown = false;
    return error;
}

function isAssetMaintenanceLockedError(error) {
    return Boolean(error && error.assetMaintenanceLocked === true);
}

function staleOwnerCanBeRecovered(owner, options = {}) {
    if (!owner) return false;
    const hostname = options.hostname ?? os.hostname();
    if (owner.hostname !== hostname) return false;
    const pidIsAlive = options.pidIsAlive ?? processIsAlive;
    return pidIsAlive(owner.pid) === false;
}

function recoverStaleAssetMaintenanceLockSync(lockPath, owner, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    if (!staleOwnerCanBeRecovered(owner, options)) return false;
    const observedBefore = observeAssetMaintenanceOwnerSync(lockPath, fsOps);
    if (!observedBefore
        || observedBefore.owner?.token !== owner.token
        || !staleOwnerCanBeRecovered(observedBefore.owner, options)) return true;
    const recoveryIntent = publishAssetMaintenanceRecoveryIntentSync(
        lockPath,
        owner.token,
        { fsOps, platform },
    );
    // A complete fixed-name intent elects exactly one remover for stale A.
    // Contenders preserve it and cannot race pathname removal against owner B.
    if (!recoveryIntent) return false;

    let primaryError = null;
    try {
        const observedNow = observeAssetMaintenanceOwnerSync(lockPath, fsOps);
        if (!observedNow) return true;
        if (observedNow.owner?.token !== owner.token
            || !sameFileIdentity(observedNow.stat, observedBefore.stat)) return true;
        if (!staleOwnerCanBeRecovered(observedNow.owner, options)) return false;
        unlinkObservedPathSync(
            path.join(lockPath, ASSET_MAINTENANCE_LOCK_OWNER),
            observedBefore.stat,
            fsOps,
        );
        fsyncDirectorySync(lockPath, fsOps, platform);
        return true;
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        try {
            cleanupAssetMaintenanceRecoveryIntentSync(recoveryIntent, { fsOps, platform });
        } catch (cleanupError) {
            if (primaryError) attachCleanupError(primaryError, cleanupError);
            else throw cleanupError;
        }
    }
}

function releaseAssetMaintenanceLockSync(assetDir, token, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const lockPath = assetMaintenanceLockPath(assetDir, fsOps);
    const ownerPath = path.join(lockPath, ASSET_MAINTENANCE_LOCK_OWNER);
    const owner = readAssetMaintenanceLockOwnerSync(lockPath, fsOps);
    if (!owner) {
        try {
            fsOps.lstatSync(ownerPath);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                // Retrying a release after unlink-but-before-fsync must still
                // make the prior owner removal durable.
                fsyncDirectorySync(lockPath, fsOps, platform);
                return false;
            }
            throw error;
        }
    }
    if (!owner || owner.token !== token) {
        throw new Error(
            `Refusing to release asset-maintenance lock ${lockPath}: ownership token does not match`,
        );
    }
    fsOps.unlinkSync(ownerPath);
    fsyncDirectorySync(lockPath, fsOps, platform);
    return true;
}

function sameFileIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}

function maintenanceHostnameIdentity(hostname = os.hostname()) {
    return crypto.createHash('sha256').update(String(hostname)).digest('hex').slice(0, 16);
}

function observeAssetMaintenanceOwnerSync(lockPath, fsOps = fs) {
    const ownerPath = path.join(lockPath, ASSET_MAINTENANCE_LOCK_OWNER);
    let before;
    try {
        before = fsOps.lstatSync(ownerPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    const owner = readAssetMaintenanceLockOwnerSync(lockPath, fsOps);
    const after = fsOps.lstatSync(ownerPath);
    if (!sameFileIdentity(before, after)) {
        throw new Error(`Asset-maintenance owner changed while observing ${ownerPath}`);
    }
    return { owner, stat: after };
}

function unlinkObservedPathSync(targetPath, expectedStat, fsOps = fs) {
    const current = fsOps.lstatSync(targetPath);
    if (!sameFileIdentity(current, expectedStat)) {
        throw new Error(`Refusing to unlink replaced path ${targetPath}`);
    }
    fsOps.unlinkSync(targetPath);
}

function cleanupCreatedAssetMaintenanceOwnerSync(
    lockPath,
    token,
    createdOwnerStat,
    options = {},
) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const ownerPath = path.join(lockPath, ASSET_MAINTENANCE_LOCK_OWNER);
    if (!createdOwnerStat) {
        throw new Error(
            `Refusing to clean asset-maintenance owner ${ownerPath}: exact created identity is unavailable`,
        );
    }
    let currentStat;
    try {
        currentStat = fsOps.lstatSync(ownerPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
    if (!sameFileIdentity(currentStat, createdOwnerStat)) {
        throw new Error(
            `Refusing to clean asset-maintenance owner ${ownerPath}: ownership changed`,
        );
    }
    const owner = readAssetMaintenanceLockOwnerSync(lockPath, fsOps);
    if (!owner || owner.token !== token) {
        throw new Error(
            `Refusing to clean asset-maintenance owner ${ownerPath}: exact token is unavailable or changed`,
        );
    }
    // Recheck after parsing so a same-token replacement cannot exploit token
    // equality to delete a different inode.
    if (!sameFileIdentity(fsOps.lstatSync(ownerPath), createdOwnerStat)) {
        throw new Error(
            `Refusing to clean asset-maintenance owner ${ownerPath}: ownership changed`,
        );
    }
    try { fsOps.unlinkSync(ownerPath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    fsyncDirectorySync(lockPath, fsOps, platform);
    return true;
}

function cleanupCreatedAssetMaintenanceStageSync(stagePath, createdStat, fsOps, platform) {
    if (!createdStat) return false;
    let currentStat;
    try {
        currentStat = fsOps.lstatSync(stagePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
    if (!sameFileIdentity(currentStat, createdStat)) {
        throw new Error(`Refusing to clean replaced asset-maintenance stage ${stagePath}`);
    }
    fsOps.unlinkSync(stagePath);
    fsyncDirectorySync(path.dirname(stagePath), fsOps, platform);
    return true;
}

function readAssetMaintenanceRecoveryIntentSync(intentPath, fsOps = fs) {
    try {
        const before = fsOps.lstatSync(intentPath);
        if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > 4096) {
            return null;
        }
        const intent = JSON.parse(fsOps.readFileSync(intentPath, 'utf8'));
        const after = fsOps.lstatSync(intentPath);
        if (!sameFileIdentity(before, after)
            || !intent
            || typeof intent !== 'object'
            || intent.version !== ASSET_MAINTENANCE_LOCK_VERSION
            || typeof intent.ownerToken !== 'string'
            || !/^[0-9a-f]{64}$/.test(intent.ownerToken)
            || typeof intent.recoveryToken !== 'string'
            || !/^[0-9a-f]{64}$/.test(intent.recoveryToken)
            || !Number.isSafeInteger(intent.pid)
            || intent.pid <= 0
            || typeof intent.hostname !== 'string'
            || intent.hostname.length === 0
            || typeof intent.startedAt !== 'string') {
            return null;
        }
        return { intent, stat: after };
    } catch {
        return null;
    }
}

function publishAssetMaintenanceRecoveryIntentSync(lockPath, ownerToken, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const recoveryToken = crypto.randomBytes(32).toString('hex');
    const intentPath = path.join(lockPath, `${ASSET_MAINTENANCE_RECOVERY_PREFIX}${ownerToken}`);
    const stagePath = path.join(
        lockPath,
        `${ASSET_MAINTENANCE_RECOVERY_STAGE_PREFIX}`
        + `${maintenanceHostnameIdentity()}-${process.pid}-${recoveryToken}`,
    );
    const bytes = Buffer.from(JSON.stringify({
        version: ASSET_MAINTENANCE_LOCK_VERSION,
        ownerToken,
        recoveryToken,
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
    }), 'utf8');
    let descriptor;
    let stageStat = null;
    let intentPublished = false;
    activeOwnerStages.add(stagePath);
    try {
        descriptor = fsOps.openSync(stagePath, 'wx', 0o600);
        stageStat = fsOps.fstatSync(descriptor);
        let offset = 0;
        while (offset < bytes.length) {
            const written = fsOps.writeSync(descriptor, bytes, offset, bytes.length - offset);
            if (written <= 0) throw new Error('asset-maintenance recovery intent write made no progress');
            offset += written;
        }
        fsOps.fsyncSync(descriptor);
        fsOps.closeSync(descriptor);
        descriptor = undefined;
        fsyncDirectorySync(lockPath, fsOps, platform);
        try {
            fsOps.linkSync(stagePath, intentPath);
            intentPublished = true;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
        if (intentPublished) fsyncDirectorySync(lockPath, fsOps, platform);
        cleanupCreatedAssetMaintenanceStageSync(stagePath, stageStat, fsOps, platform);
        return intentPublished
            ? { intentPath, recoveryToken, stat: stageStat }
            : null;
    } catch (error) {
        if (descriptor !== undefined) {
            try { fsOps.closeSync(descriptor); } catch (closeError) {
                attachCleanupError(error, closeError);
            }
        }
        if (intentPublished && stageStat) {
            try {
                const observed = readAssetMaintenanceRecoveryIntentSync(intentPath, fsOps);
                if (!observed
                    || observed.intent.recoveryToken !== recoveryToken
                    || !sameFileIdentity(observed.stat, stageStat)) {
                    throw new Error(`Refusing to clean replaced recovery intent ${intentPath}`);
                }
                unlinkObservedPathSync(intentPath, stageStat, fsOps);
                fsyncDirectorySync(lockPath, fsOps, platform);
            } catch (cleanupError) {
                attachCleanupError(error, cleanupError);
            }
        }
        if (stageStat) {
            try {
                cleanupCreatedAssetMaintenanceStageSync(stagePath, stageStat, fsOps, platform);
            } catch (cleanupError) {
                attachCleanupError(error, cleanupError);
            }
        }
        throw error;
    } finally {
        activeOwnerStages.delete(stagePath);
    }
}

function cleanupAssetMaintenanceRecoveryIntentSync(handle, options = {}) {
    if (!handle) return false;
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    try {
        fsOps.lstatSync(handle.intentPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
    const observed = readAssetMaintenanceRecoveryIntentSync(handle.intentPath, fsOps);
    if (!observed) {
        throw new Error(`Refusing to clean unreadable recovery intent ${handle.intentPath}`);
    }
    if (observed.intent.recoveryToken !== handle.recoveryToken
        || !sameFileIdentity(observed.stat, handle.stat)) {
        throw new Error(`Refusing to clean replaced recovery intent ${handle.intentPath}`);
    }
    unlinkObservedPathSync(handle.intentPath, handle.stat, fsOps);
    fsyncDirectorySync(path.dirname(handle.intentPath), fsOps, platform);
    return true;
}

function attachCleanupError(primaryError, cleanupError) {
    if (primaryError && typeof primaryError === 'object') {
        if (!Array.isArray(primaryError.cleanupErrors)) primaryError.cleanupErrors = [];
        primaryError.cleanupErrors.push(cleanupError);
    }
}

function ensureAssetMaintenanceCoordinatorSync(lockPath, fsOps, platform) {
    fsOps.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
        fsOps.mkdirSync(lockPath, { mode: 0o700 });
        fsyncDirectorySync(path.dirname(lockPath), fsOps, platform);
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const stat = fsOps.lstatSync(lockPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error(`Asset-maintenance coordinator is not a directory: ${lockPath}`);
        }
    }
}

function listAssetMaintenanceRecoveryIntents(lockPath, fsOps) {
    return fsOps.readdirSync(lockPath).filter((name) => (
        name.startsWith(ASSET_MAINTENANCE_RECOVERY_PREFIX)
        && /^[0-9a-f]{64}$/.test(name.slice(ASSET_MAINTENANCE_RECOVERY_PREFIX.length))
    ));
}

function reconcileAbandonedAssetMaintenanceStagesSync(lockPath, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const localHostIdentity = maintenanceHostnameIdentity();
    const stagePidIsAlive = options.stagePidIsAlive ?? processIsAlive;
    let removed = 0;
    for (const name of fsOps.readdirSync(lockPath)) {
        const match = name.match(OWNER_STAGE_RE) ?? name.match(RECOVERY_STAGE_RE);
        if (!match) continue;
        const stagePath = path.join(lockPath, name);
        if (activeOwnerStages.has(stagePath) || match[1] !== localHostIdentity) continue;
        const pid = Number(match[2]);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        if (pid !== process.pid && stagePidIsAlive(pid)) continue;
        let stat;
        try {
            stat = fsOps.lstatSync(stagePath);
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) continue;
        try {
            unlinkObservedPathSync(stagePath, stat, fsOps);
            removed++;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    if (removed > 0) fsyncDirectorySync(lockPath, fsOps, platform);
    return removed;
}

function reconcileAssetMaintenanceRecoveryIntentsSync(lockPath, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    let owner = readAssetMaintenanceLockOwnerSync(lockPath, fsOps);
    const intents = listAssetMaintenanceRecoveryIntents(lockPath, fsOps);
    let pending = 0;
    let removed = 0;
    for (const name of intents) {
        const intentPath = path.join(lockPath, name);
        const observed = readAssetMaintenanceRecoveryIntentSync(intentPath, fsOps);
        if (!observed) {
            pending++;
            continue;
        }
        const intentOwnerStillPresent = owner?.token === observed.intent.ownerToken;
        const recoveryIsLive = observed.intent.hostname !== os.hostname()
            || processIsAlive(observed.intent.pid);
        if (intentOwnerStillPresent && recoveryIsLive) {
            pending++;
            continue;
        }
        try {
            unlinkObservedPathSync(intentPath, observed.stat, fsOps);
            removed++;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    if (removed > 0) fsyncDirectorySync(lockPath, fsOps, platform);
    owner = readAssetMaintenanceLockOwnerSync(lockPath, fsOps);
    return { owner, pending };
}

function acquireAssetMaintenanceLockSync(assetDir, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const absoluteAssetDir = canonicalAssetDirectoryIdentitySync(assetDir, fsOps);
    const lockPath = assetMaintenanceLockPath(absoluteAssetDir, fsOps);
    const token = crypto.randomBytes(32).toString('hex');
    const purpose = String(options.purpose ?? 'asset mutation').slice(0, 256);
    const hostname = String(options.hostname ?? os.hostname()).slice(0, 255);
    const onStage = options.onStage ?? (() => {});

    ensureAssetMaintenanceCoordinatorSync(lockPath, fsOps, platform);
    reconcileAbandonedAssetMaintenanceStagesSync(lockPath, {
        fsOps,
        platform,
        stagePidIsAlive: options.stagePidIsAlive,
    });
    while (true) {
        const recoveryOptions = {
            fsOps,
            platform,
            hostname,
            pidIsAlive: options.pidIsAlive,
        };
        const recoveryState = reconcileAssetMaintenanceRecoveryIntentsSync(
            lockPath,
            recoveryOptions,
        );
        const { owner } = recoveryState;
        if (recoveryState.pending > 0) {
            throw assetMaintenanceLockedError(lockPath, owner);
        }
        if (owner) {
            if (options.recoverStale !== false
                && recoverStaleAssetMaintenanceLockSync(lockPath, owner, recoveryOptions)) {
                continue;
            }
            throw assetMaintenanceLockedError(lockPath, owner);
        }
        try {
            fsOps.lstatSync(path.join(lockPath, ASSET_MAINTENANCE_LOCK_OWNER));
            throw assetMaintenanceLockedError(lockPath, null);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }

        const ownerBytes = Buffer.from(JSON.stringify({
            version: ASSET_MAINTENANCE_LOCK_VERSION,
            token,
            pid: options.pid ?? process.pid,
            hostname,
            purpose,
            acquiredAt: new Date().toISOString(),
        }), 'utf8');
        const ownerPath = path.join(lockPath, ASSET_MAINTENANCE_LOCK_OWNER);
        const ownerStagePath = path.join(
            lockPath,
            `${ASSET_MAINTENANCE_OWNER_STAGE_PREFIX}`
            + `${maintenanceHostnameIdentity()}-${process.pid}-${token}`,
        );
        let descriptor;
        let createdOwnerStat = null;
        let ownerPublished = false;
        let publicationContended = false;
        activeOwnerStages.add(ownerStagePath);
        try {
            // Never expose an empty live owner. Build and fsync complete
            // metadata in a unique private inode, capture identity from its
            // open descriptor, then atomically hard-link that inode to the live
            // owner name. A pre-identity fault can strand only an ignored stage,
            // never malformed ownership.
            onStage('before-owner-open', { assetDir: absoluteAssetDir, lockPath, token });
            descriptor = fsOps.openSync(ownerStagePath, 'wx', 0o600);
            onStage('owner-created-before-fstat', {
                assetDir: absoluteAssetDir,
                lockPath,
                token,
            });
            createdOwnerStat = fsOps.fstatSync(descriptor);
            let offset = 0;
            while (offset < ownerBytes.length) {
                const written = fsOps.writeSync(
                    descriptor,
                    ownerBytes,
                    offset,
                    ownerBytes.length - offset,
                );
                if (written <= 0) throw new Error('asset-maintenance owner write made no progress');
                offset += written;
            }
            onStage('before-owner-fsync', { assetDir: absoluteAssetDir, lockPath, token });
            fsOps.fsyncSync(descriptor);
            onStage('after-owner-fsync', { assetDir: absoluteAssetDir, lockPath, token });
            fsOps.closeSync(descriptor);
            descriptor = undefined;
            // Make the completed stage durable before publishing its inode at
            // owner.json. linkSync is the exclusive atomic admission boundary.
            fsyncDirectorySync(lockPath, fsOps, platform);
            onStage('before-owner-publication', {
                assetDir: absoluteAssetDir,
                lockPath,
                token,
            });
            try {
                fsOps.linkSync(ownerStagePath, ownerPath);
                ownerPublished = true;
            } catch (error) {
                if (error?.code === 'EEXIST') publicationContended = true;
                throw error;
            }
            onStage('after-owner-open', { assetDir: absoluteAssetDir, lockPath, token });
            onStage('before-coordinator-fsync', {
                assetDir: absoluteAssetDir,
                lockPath,
                token,
            });
            fsyncDirectorySync(lockPath, fsOps, platform);
            onStage('after-coordinator-fsync', {
                assetDir: absoluteAssetDir,
                lockPath,
                token,
            });

            // If a recovery intent appeared between the last scan and atomic
            // owner publication, its token names an older owner.
            // Reconciliation re-reads this new
            // token and removes only the obsolete intent, never this owner.
            if (listAssetMaintenanceRecoveryIntents(lockPath, fsOps).length > 0) {
                reconcileAssetMaintenanceRecoveryIntentsSync(lockPath, recoveryOptions);
            }
            onStage('before-owner-postcheck', {
                assetDir: absoluteAssetDir,
                lockPath,
                token,
            });
            const publishedOwner = readAssetMaintenanceLockOwnerSync(lockPath, fsOps);
            if (publishedOwner?.token !== token) {
                throw new Error('Asset-maintenance lock ownership changed during publication');
            }
            onStage('owner-published', { assetDir: absoluteAssetDir, lockPath, token });
            cleanupCreatedAssetMaintenanceStageSync(
                ownerStagePath,
                createdOwnerStat,
                fsOps,
                platform,
            );
        } catch (error) {
            if (descriptor !== undefined) {
                try { fsOps.closeSync(descriptor); } catch (closeError) {
                    attachCleanupError(error, closeError);
                }
            }
            if (ownerPublished) {
                try {
                    cleanupCreatedAssetMaintenanceOwnerSync(
                        lockPath,
                        token,
                        createdOwnerStat,
                        { fsOps, platform },
                    );
                } catch (cleanupError) {
                    attachCleanupError(error, cleanupError);
                }
            }
            if (createdOwnerStat) {
                try {
                    cleanupCreatedAssetMaintenanceStageSync(
                        ownerStagePath,
                        createdOwnerStat,
                        fsOps,
                        platform,
                    );
                } catch (cleanupError) {
                    attachCleanupError(error, cleanupError);
                }
            }
            activeOwnerStages.delete(ownerStagePath);
            if (publicationContended && !error?.cleanupErrors?.length) continue;
            throw error;
        }
        activeOwnerStages.delete(ownerStagePath);
        break;
    }

    let released = false;
    return {
        assetDir: absoluteAssetDir,
        lockPath,
        token,
        release() {
            if (released) return;
            releaseAssetMaintenanceLockSync(absoluteAssetDir, token, { fsOps, platform });
            released = true;
        },
    };
}

function releaseAssetMaintenanceLockHandle(lock, primaryError = null) {
    if (!lock) return true;
    const releaseErrors = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            lock.release();
            return true;
        } catch (error) {
            releaseErrors.push(error);
        }
    }
    if (primaryError) {
        for (const error of releaseErrors) attachCleanupError(primaryError, error);
        return false;
    }
    const error = releaseErrors[0];
    for (const cleanupError of releaseErrors.slice(1)) attachCleanupError(error, cleanupError);
    throw error;
}

function withAssetMaintenanceLockSync(assetDir, operation, options = {}) {
    const lock = acquireAssetMaintenanceLockSync(assetDir, options);
    let primaryError = null;
    try {
        return operation();
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        releaseAssetMaintenanceLockHandle(lock, primaryError);
    }
}

module.exports = {
    ASSET_MAINTENANCE_LOCK_NAME,
    ASSET_MAINTENANCE_LOCK_OWNER,
    ASSET_MAINTENANCE_LOCK_VERSION,
    acquireAssetMaintenanceLockSync,
    assetMaintenanceLockPath,
    canonicalAssetDirectoryIdentitySync,
    cleanupCreatedAssetMaintenanceOwnerSync,
    isAssetMaintenanceLockedError,
    readAssetMaintenanceLockOwnerSync,
    recoverStaleAssetMaintenanceLockSync,
    releaseAssetMaintenanceLockHandle,
    releaseAssetMaintenanceLockSync,
    sameAssetDirectoryIdentitySync,
    staleOwnerCanBeRecovered,
    withAssetMaintenanceLockSync,
};
