const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RECOVERY_PATH_MARKER_MAX_BYTES = 32 * 1024;
const RECOVERY_PATH_MARKER_STATE_VERSION = 1;
const RECOVERY_PATH_MARKER_MAX_TARGETS = 128;
const RECOVERY_PATH_STARTUP_QUARANTINE_MAX_BYTES = 128 * 1024;
const RECOVERY_PATH_STARTUP_QUARANTINE_NAME = '__recovery_path_startup_quarantine';
const RECOVERY_PATH_STARTUP_QUARANTINE_VERSION = 1;
const RECOVERY_PATH_STATE_LOCK_NAME = '__recovery_path_state.lock';
const RECOVERY_PATH_STATE_LOCK_OWNER = 'owner.json';
const RECOVERY_PATH_STATE_HANDOFF_VERSION = 1;
const RECOVERY_PATH_STATE_HANDOFF_NAME = 'recovery-path-lock-handoff.json';
const MANAGED_RECOVERY_PATH_ROOTS = new Set([
    'server',
    'dist',
    'scripts',
    'bin',
    'node_modules',
    '.update-tmp',
]);
const RECOVERY_PATH_MARKERS = [
    { name: '__backup_path', label: 'Server-backup directory' },
    { name: '__chat_backup_path', label: 'Chat-backup directory' },
];

function caseFoldPath(value, platform = process.platform) {
    return platform === 'win32' ? value.toLowerCase() : value;
}

function recoveryPathKeepSetHas(keep, entry, platform = process.platform) {
    if (platform !== 'win32') return keep.has(entry);
    const foldedEntry = caseFoldPath(entry, platform);
    for (const candidate of keep) {
        if (caseFoldPath(candidate, platform) === foldedEntry) return true;
    }
    return false;
}

function directoryFsyncErrorIsUnsupported(error, platform = process.platform) {
    if (error?.code === 'EINVAL' || error?.code === 'ENOTSUP') return true;
    return platform === 'win32'
        && ['EACCES', 'EISDIR', 'EPERM'].includes(error?.code);
}

function decodeMarkerBytes(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error('marker is not valid UTF-8');
    }
}

function normalizeRecoveryPathMarkerValue(value) {
    if (typeof value !== 'string') throw new Error('marker must contain text paths');
    const trimmed = value.trim();
    if (!trimmed) throw new Error('marker path is empty');
    if (trimmed.includes('\0') || trimmed.includes('\n') || trimmed.includes('\r')) {
        throw new Error('marker path must contain exactly one filesystem path');
    }
    if (!path.isAbsolute(trimmed)) throw new Error('marker path is not absolute');
    const normalized = path.resolve(trimmed);
    if (normalized !== trimmed) throw new Error('marker path is not normalized');
    return normalized;
}

function normalizeRecoveryPathMarkerTargets(values, platform = process.platform) {
    if (!Array.isArray(values)
        || values.length === 0
        || values.length > RECOVERY_PATH_MARKER_MAX_TARGETS * 4) {
        throw new Error('marker must contain a bounded non-empty path list');
    }
    const targets = [];
    const seen = new Set();
    for (const value of values) {
        const normalized = normalizeRecoveryPathMarkerValue(value);
        const identity = caseFoldPath(normalized, platform);
        if (seen.has(identity)) continue;
        if (targets.length >= RECOVERY_PATH_MARKER_MAX_TARGETS) {
            throw new Error('marker contains too many distinct paths');
        }
        seen.add(identity);
        targets.push(normalized);
    }
    if (targets.length === 0) throw new Error('marker path list is empty');
    return targets;
}

function parseRecoveryPathMarkerTargets(value, platform = process.platform) {
    const trimmed = String(value).trim();
    if (!trimmed) throw new Error('marker is empty');
    if (!trimmed.startsWith('{')) {
        return normalizeRecoveryPathMarkerTargets([trimmed], platform);
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new Error('marker transition record is malformed JSON');
    }
    if (!parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || parsed.version !== RECOVERY_PATH_MARKER_STATE_VERSION
        || !Array.isArray(parsed.paths)
        || Object.keys(parsed).some(key => !['version', 'paths'].includes(key))) {
        throw new Error('marker transition record has an unsupported schema');
    }
    return normalizeRecoveryPathMarkerTargets(parsed.paths, platform);
}

function encodeRecoveryPathMarkerTargets(targets, platform = process.platform) {
    const normalized = normalizeRecoveryPathMarkerTargets(targets, platform);
    const value = normalized.length === 1
        ? normalized[0]
        : JSON.stringify({ version: RECOVERY_PATH_MARKER_STATE_VERSION, paths: normalized });
    const bytes = Buffer.from(value, 'utf-8');
    if (bytes.length > RECOVERY_PATH_MARKER_MAX_BYTES) {
        throw new Error('Recovery-path marker value is too large');
    }
    return { bytes, targets: normalized };
}

function readRecoveryPathMarkerTargetsSync(markerPath, options = {}) {
    const fsOps = options.fsOps ?? fs;
    let stat;
    try {
        stat = fsOps.lstatSync(markerPath);
    } catch (error) {
        if (error?.code === 'ENOENT') throw new Error('marker is missing', { cause: error });
        throw new Error(`marker metadata is unreadable: ${error?.message || error}`, { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('marker is not a regular file');
    }
    if (stat.size <= 0 || stat.size > RECOVERY_PATH_MARKER_MAX_BYTES) {
        throw new Error('marker has an invalid size');
    }
    let bytes;
    try {
        bytes = fsOps.readFileSync(markerPath);
    } catch (error) {
        throw new Error(`marker is unreadable: ${error?.message || error}`, { cause: error });
    }
    if (bytes.length !== stat.size) throw new Error('marker changed while it was being read');
    return parseRecoveryPathMarkerTargets(
        decodeMarkerBytes(bytes),
        options.platform ?? process.platform,
    );
}

function readRecoveryPathMarkerSync(markerPath, options = {}) {
    const targets = readRecoveryPathMarkerTargetsSync(markerPath, options);
    if (targets.length !== 1) throw new Error('marker contains an active path transition');
    return targets[0];
}

function recoveryPathStartupQuarantinePath(markerDirectory) {
    return path.join(
        path.resolve(markerDirectory),
        RECOVERY_PATH_STARTUP_QUARANTINE_NAME,
    );
}

function encodeRecoveryPathStartupQuarantine(markerTargets, platform = process.platform) {
    if (!markerTargets || typeof markerTargets !== 'object' || Array.isArray(markerTargets)) {
        throw new TypeError('Recovery-path startup quarantine targets must be an object');
    }
    const markers = {};
    for (const marker of RECOVERY_PATH_MARKERS) {
        markers[marker.name] = normalizeRecoveryPathMarkerTargets(
            markerTargets[marker.name],
            platform,
        );
    }
    if (Object.keys(markerTargets).some(
        key => !RECOVERY_PATH_MARKERS.some(marker => marker.name === key),
    )) {
        throw new Error('Recovery-path startup quarantine contains an unknown marker');
    }
    const bytes = Buffer.from(JSON.stringify({
        version: RECOVERY_PATH_STARTUP_QUARANTINE_VERSION,
        state: 'startup-publication-fail-closed',
        markers,
    }), 'utf8');
    if (bytes.length > RECOVERY_PATH_STARTUP_QUARANTINE_MAX_BYTES) {
        throw new Error('Recovery-path startup quarantine is too large');
    }
    return { bytes, markers };
}

function parseRecoveryPathStartupQuarantine(value, platform = process.platform) {
    let parsed;
    try {
        parsed = JSON.parse(String(value));
    } catch {
        throw new Error('Recovery-path startup quarantine is malformed JSON');
    }
    const markerNames = RECOVERY_PATH_MARKERS.map(marker => marker.name);
    if (!parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || parsed.version !== RECOVERY_PATH_STARTUP_QUARANTINE_VERSION
        || parsed.state !== 'startup-publication-fail-closed'
        || !parsed.markers
        || typeof parsed.markers !== 'object'
        || Array.isArray(parsed.markers)
        || Object.keys(parsed).some(key => !['version', 'state', 'markers'].includes(key))
        || Object.keys(parsed.markers).length !== markerNames.length
        || Object.keys(parsed.markers).some(key => !markerNames.includes(key))) {
        throw new Error('Recovery-path startup quarantine has an unsupported schema');
    }
    const markers = {};
    for (const markerName of markerNames) {
        markers[markerName] = normalizeRecoveryPathMarkerTargets(
            parsed.markers[markerName],
            platform,
        );
    }
    return { version: parsed.version, state: parsed.state, markers };
}

function readRecoveryPathStartupQuarantineSync(markerDirectory, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const quarantinePath = recoveryPathStartupQuarantinePath(markerDirectory);
    let stat;
    try {
        stat = fsOps.lstatSync(quarantinePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw new Error(
            `Recovery-path startup quarantine metadata is unreadable: ${error?.message || error}`,
            { cause: error },
        );
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Recovery-path startup quarantine is not a regular file');
    }
    if (stat.size <= 0 || stat.size > RECOVERY_PATH_STARTUP_QUARANTINE_MAX_BYTES) {
        throw new Error('Recovery-path startup quarantine has an invalid size');
    }
    let bytes;
    try {
        bytes = fsOps.readFileSync(quarantinePath);
    } catch (error) {
        throw new Error(
            `Recovery-path startup quarantine is unreadable: ${error?.message || error}`,
            { cause: error },
        );
    }
    if (bytes.length !== stat.size) {
        throw new Error('Recovery-path startup quarantine changed while it was being read');
    }
    return parseRecoveryPathStartupQuarantine(
        decodeMarkerBytes(bytes),
        options.platform ?? process.platform,
    );
}

function assertRecoveryPathStartupQuarantineAbsentSync(markerDirectory, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const quarantinePath = recoveryPathStartupQuarantinePath(markerDirectory);
    try {
        fsOps.lstatSync(quarantinePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw new Error(
            `Cannot safely update: recovery-path startup quarantine metadata is unreadable: ${error?.message || error}`,
            { cause: error },
        );
    }
    throw new Error(
        `Cannot safely update: recovery-path startup quarantine exists at ${quarantinePath}. `
        + 'Start PocketRisu successfully to recover and republish the complete recovery-path history, then retry the update.',
    );
}

function fsyncDirectorySync(directoryPath, fsOps = fs, options = {}) {
    const platform = options.platform ?? process.platform;
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

function recoveryPathStateLockPath(markerDirectory) {
    return path.join(path.resolve(markerDirectory), RECOVERY_PATH_STATE_LOCK_NAME);
}

function readRecoveryPathStateLockOwnerSync(lockPath, fsOps = fs) {
    const ownerPath = path.join(lockPath, RECOVERY_PATH_STATE_LOCK_OWNER);
    try {
        const stat = fsOps.lstatSync(ownerPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4096) {
            return null;
        }
        const parsed = JSON.parse(fsOps.readFileSync(ownerPath, 'utf8'));
        if (!parsed
            || parsed.version !== 1
            || typeof parsed.token !== 'string'
            || !/^[0-9a-f]{64}$/.test(parsed.token)
            || !Number.isSafeInteger(parsed.pid)
            || parsed.pid <= 0
            || typeof parsed.purpose !== 'string') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function recoveryPathStateLockError(lockPath, owner) {
    const detail = owner
        ? `owner pid ${owner.pid} (${owner.purpose || 'unknown operation'})`
        : 'owner metadata is incomplete or unreadable';
    const error = new Error(
        `Recovery-path state is locked by ${detail}. `
        + `The lock at ${lockPath} is never removed automatically because an ambiguous stale-lock decision could permit recovery-data deletion. `
        + 'If the owning server/updater crashed, verify that no update or backup-path change is still active, then remove that exact lock directory and retry.',
    );
    error.code = 'RECOVERY_PATH_STATE_LOCKED';
    return error;
}

function releaseRecoveryPathStateLockSync(markerDirectory, token, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const lockPath = recoveryPathStateLockPath(markerDirectory);
    const owner = readRecoveryPathStateLockOwnerSync(lockPath, fsOps);
    if (!owner || owner.token !== token) {
        throw new Error(
            `Refusing to release recovery-path state lock ${lockPath}: ownership token does not match`,
        );
    }
    fsOps.unlinkSync(path.join(lockPath, RECOVERY_PATH_STATE_LOCK_OWNER));
    fsOps.rmdirSync(lockPath);
    fsyncDirectorySync(path.dirname(lockPath), fsOps, { platform });
}

function acquireRecoveryPathStateLockSync(markerDirectory, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const lockPath = recoveryPathStateLockPath(markerDirectory);
    const token = crypto.randomBytes(32).toString('hex');
    const purpose = String(options.purpose ?? 'recovery-path operation').slice(0, 256);
    try {
        fsOps.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
        if (error?.code === 'EEXIST') {
            throw recoveryPathStateLockError(
                lockPath,
                readRecoveryPathStateLockOwnerSync(lockPath, fsOps),
            );
        }
        throw error;
    }

    const ownerPath = path.join(lockPath, RECOVERY_PATH_STATE_LOCK_OWNER);
    let published = false;
    try {
        const ownerBytes = Buffer.from(JSON.stringify({
            version: 1,
            token,
            pid: options.pid ?? process.pid,
            purpose,
            acquiredAt: new Date().toISOString(),
        }), 'utf8');
        const descriptor = fsOps.openSync(ownerPath, 'wx', 0o600);
        try {
            let offset = 0;
            while (offset < ownerBytes.length) {
                const written = fsOps.writeSync(
                    descriptor,
                    ownerBytes,
                    offset,
                    ownerBytes.length - offset,
                );
                if (written <= 0) throw new Error('lock owner write made no progress');
                offset += written;
            }
            fsOps.fsyncSync(descriptor);
        } finally {
            fsOps.closeSync(descriptor);
        }
        fsyncDirectorySync(lockPath, fsOps, { platform });
        fsyncDirectorySync(path.dirname(lockPath), fsOps, { platform });
        published = true;
    } finally {
        // Once mkdir succeeds, any incomplete owner state intentionally stays
        // fail-closed. Automatically removing it here would make a publication
        // durability failure indistinguishable from a lock that another
        // process must continue to respect after this process crashes.
        if (!published) {
            try { fsyncDirectorySync(path.dirname(lockPath), fsOps, { platform }); } catch {}
        }
    }

    let released = false;
    return {
        lockPath,
        token,
        release() {
            if (released) return;
            releaseRecoveryPathStateLockSync(markerDirectory, token, { fsOps, platform });
            released = true;
        },
    };
}

function publishRecoveryPathStateLockHandoffSync(
    handoffPath,
    markerDirectory,
    token,
    options = {},
) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const absoluteMarkerDirectory = path.resolve(markerDirectory);
    const lockPath = recoveryPathStateLockPath(absoluteMarkerDirectory);
    const owner = readRecoveryPathStateLockOwnerSync(lockPath, fsOps);
    if (!owner || owner.token !== token) {
        throw new Error('Cannot hand off recovery-path state lock: ownership token does not match');
    }
    const bytes = Buffer.from(JSON.stringify({
        version: RECOVERY_PATH_STATE_HANDOFF_VERSION,
        markerDirectory: absoluteMarkerDirectory,
        token,
    }), 'utf8');
    durableReplaceMarkerSync(path.resolve(handoffPath), bytes, { fsOps, platform });
    return path.resolve(handoffPath);
}

function readRecoveryPathStateLockHandoffSync(handoffPath, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const absoluteHandoffPath = path.resolve(handoffPath);
    const stat = fsOps.lstatSync(absoluteHandoffPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4096) {
        throw new Error('Recovery-path lock handoff is not a bounded regular file');
    }
    const bytes = fsOps.readFileSync(absoluteHandoffPath);
    if (bytes.length !== stat.size) throw new Error('Recovery-path lock handoff changed while reading');
    const parsed = JSON.parse(decodeMarkerBytes(bytes));
    if (!parsed
        || parsed.version !== RECOVERY_PATH_STATE_HANDOFF_VERSION
        || typeof parsed.markerDirectory !== 'string'
        || !path.isAbsolute(parsed.markerDirectory)
        || path.resolve(parsed.markerDirectory) !== parsed.markerDirectory
        || typeof parsed.token !== 'string'
        || !/^[0-9a-f]{64}$/.test(parsed.token)
        || Object.keys(parsed).some(key => !['version', 'markerDirectory', 'token'].includes(key))) {
        throw new Error('Recovery-path lock handoff has an unsupported schema');
    }
    return {
        handoffPath: absoluteHandoffPath,
        markerDirectory: parsed.markerDirectory,
        token: parsed.token,
    };
}

function finalizeRecoveryPathStateLockHandoffSync(handoffPath, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const handoff = readRecoveryPathStateLockHandoffSync(handoffPath, { fsOps });
    releaseRecoveryPathStateLockSync(handoff.markerDirectory, handoff.token, {
        fsOps,
        platform,
    });
    fsOps.unlinkSync(handoff.handoffPath);
    fsyncDirectorySync(path.dirname(handoff.handoffPath), fsOps, { platform });
    return handoff.markerDirectory;
}

function readExistingRegularMarkerBytes(markerPath, fsOps) {
    try {
        const stat = fsOps.lstatSync(markerPath);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        if (stat.size <= 0 || stat.size > RECOVERY_PATH_MARKER_MAX_BYTES) return null;
        const bytes = fsOps.readFileSync(markerPath);
        if (bytes.length !== stat.size) return null;
        return bytes;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function durableReplaceMarkerSync(markerPath, bytes, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const directory = path.dirname(markerPath);
    const temporaryPath = path.join(
        directory,
        `.${path.basename(markerPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let descriptor;
    let renamed = false;
    try {
        options.onStage?.('before-write');
        descriptor = fsOps.openSync(temporaryPath, 'wx', 0o600);
        let offset = 0;
        while (offset < bytes.length) {
            const written = fsOps.writeSync(descriptor, bytes, offset, bytes.length - offset);
            if (written <= 0) throw new Error('marker write made no progress');
            offset += written;
        }
        fsOps.fsyncSync(descriptor);
        fsOps.closeSync(descriptor);
        descriptor = undefined;
        options.onStage?.('before-rename');
        fsOps.renameSync(temporaryPath, markerPath);
        renamed = true;
        options.onStage?.('before-directory-fsync');
        fsyncDirectorySync(directory, fsOps, { platform: options.platform });
        options.onStage?.('published');
        return { renamed };
    } catch (error) {
        if (error && typeof error === 'object') error.markerRenamed = renamed;
        throw error;
    } finally {
        if (descriptor !== undefined) {
            try { fsOps.closeSync(descriptor); } catch {}
        }
        try { fsOps.unlinkSync(temporaryPath); } catch {}
    }
}

function publishRecoveryPathStartupQuarantineSync(
    markerDirectory,
    markerTargets,
    options = {},
) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const publication = encodeRecoveryPathStartupQuarantine(markerTargets, platform);
    durableReplaceMarkerSync(
        recoveryPathStartupQuarantinePath(markerDirectory),
        publication.bytes,
        { fsOps, platform, onStage: options.onStage },
    );
    return publication.markers;
}

function clearRecoveryPathStartupQuarantineSync(markerDirectory, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const quarantinePath = recoveryPathStartupQuarantinePath(markerDirectory);
    fsOps.unlinkSync(quarantinePath);
    fsyncDirectorySync(path.dirname(quarantinePath), fsOps, { platform });
}

function invalidateRecoveryPathMarkerSync(
    markerPath,
    fsOps = fs,
    platform = process.platform,
) {
    try { fsOps.unlinkSync(markerPath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    fsyncDirectorySync(path.dirname(markerPath), fsOps, { platform });
}

function publishRecoveryPathMarkerSetSync(markerPath, targetPaths, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const publication = encodeRecoveryPathMarkerTargets(targetPaths, platform);
    const previousBytes = readExistingRegularMarkerBytes(markerPath, fsOps);
    try {
        durableReplaceMarkerSync(markerPath, publication.bytes, {
            fsOps,
            platform,
            onStage: options.onStage,
        });
    } catch (publicationError) {
        if (!publicationError?.markerRenamed) throw publicationError;
        try {
            if (previousBytes) {
                durableReplaceMarkerSync(markerPath, previousBytes, { fsOps, platform });
            } else {
                invalidateRecoveryPathMarkerSync(markerPath, fsOps, platform);
            }
        } catch (rollbackError) {
            try {
                // A missing marker is fail-closed for every updater. If the old
                // bytes cannot be restored durably, invalidate the replacement
                // rather than leaving a potentially narrower path set trusted.
                invalidateRecoveryPathMarkerSync(markerPath, fsOps, platform);
            } catch (invalidationError) {
                throw new AggregateError(
                    [publicationError, rollbackError, invalidationError],
                    'Recovery-path marker publication failed and its state is uncertain',
                );
            }
            throw new AggregateError(
                [publicationError, rollbackError],
                'Recovery-path marker publication failed; the marker was invalidated to keep updaters fail-closed',
            );
        }
        throw publicationError;
    }
    return publication.targets;
}

function publishRecoveryPathMarkerSync(markerPath, targetPath, options = {}) {
    return publishRecoveryPathMarkerSetSync(markerPath, [targetPath], options)[0];
}

function canonicalizePathWithExistingPrefixSync(value, fsOps = fs) {
    const absolute = path.resolve(value);
    const missing = [];
    let cursor = absolute;
    while (true) {
        try {
            const canonicalPrefix = fsOps.realpathSync(cursor);
            return path.resolve(canonicalPrefix, ...missing);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            const parent = path.dirname(cursor);
            if (parent === cursor) throw error;
            missing.unshift(path.basename(cursor));
            cursor = parent;
        }
    }
}

function classifyPathIdentity(rootPath, targetPath, label, options = {}) {
    const platform = options.platform ?? process.platform;
    const foldedRoot = caseFoldPath(rootPath, platform);
    const foldedTarget = caseFoldPath(targetPath, platform);
    const relative = path.relative(foldedRoot, foldedTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return null;
    }
    if (!relative) {
        throw new Error(`${label} points at the PocketRisu app root. Move it to a separate folder before updating.`);
    }
    const relativeParts = relative.split(path.sep);
    const targetParts = path.resolve(targetPath).split(path.sep);
    // Containment is checked against folded identities, but the keep entry
    // must retain the spelling/casing returned by the real filesystem. Updater
    // enumeration compares this name against actual directory entries.
    const top = targetParts[targetParts.length - relativeParts.length];
    const managedTop = caseFoldPath(top, platform);
    if (MANAGED_RECOVERY_PATH_ROOTS.has(managedTop)) {
        throw new Error(
            `${label} is inside PocketRisu app files (${relative}). `
            + 'Move it to a separate folder such as data/backups before updating.',
        );
    }
    return top || null;
}

function recoveryPathKeepEntries(rootPath, targetPath, label, options = {}) {
    const fsOps = options.fsOps ?? fs;
    const platform = options.platform ?? process.platform;
    const lexicalRoot = path.resolve(rootPath);
    const lexicalTarget = normalizeRecoveryPathMarkerValue(targetPath);
    const canonicalRoot = canonicalizePathWithExistingPrefixSync(lexicalRoot, fsOps);
    const canonicalTarget = canonicalizePathWithExistingPrefixSync(lexicalTarget, fsOps);
    const entries = new Set();
    const identities = [
        [lexicalRoot, lexicalTarget],
        [canonicalRoot, canonicalTarget],
    ];
    const seen = new Set();
    for (const [root, target] of identities) {
        const identity = `${caseFoldPath(root, platform)}\0${caseFoldPath(target, platform)}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const entry = classifyPathIdentity(root, target, label, { platform });
        if (entry) entries.add(entry);
    }
    return [...entries];
}

function recoveryPathKeepEntry(rootPath, targetPath, label, options = {}) {
    return recoveryPathKeepEntries(rootPath, targetPath, label, options)[0] ?? null;
}

function addRecoveryPathMarkerKeepEntriesSync(options) {
    const root = path.resolve(options.root);
    const markerDirectory = path.resolve(options.markerDirectory ?? path.join(root, 'save'));
    const keep = options.keep;
    if (!(keep instanceof Set)) throw new TypeError('keep must be a Set');
    assertRecoveryPathStartupQuarantineAbsentSync(markerDirectory, {
        fsOps: options.fsOps,
    });

    for (const marker of options.markers ?? RECOVERY_PATH_MARKERS) {
        const markerPath = path.join(markerDirectory, marker.name);
        let targetPaths;
        try {
            targetPaths = readRecoveryPathMarkerTargetsSync(markerPath, {
                fsOps: options.fsOps,
                platform: options.platform,
            });
        } catch (error) {
            throw new Error(
                `Cannot safely update: ${marker.label} preservation marker ${error.message}. `
                + 'Start PocketRisu once to republish recovery metadata, then retry the update.',
                { cause: error },
            );
        }
        for (const targetPath of targetPaths) {
            let entries;
            try {
                entries = recoveryPathKeepEntries(root, targetPath, marker.label, {
                    fsOps: options.fsOps,
                    platform: options.platform,
                });
            } catch (error) {
                throw new Error(`Cannot safely update: ${error.message}`, { cause: error });
            }
            for (const entry of entries) {
                if (recoveryPathKeepSetHas(keep, entry, options.platform)) continue;
                keep.add(entry);
                options.onKeep?.(entry, marker.label);
            }
        }
    }
    return keep;
}

module.exports = {
    MANAGED_RECOVERY_PATH_ROOTS,
    RECOVERY_PATH_MARKERS,
    RECOVERY_PATH_MARKER_MAX_BYTES,
    RECOVERY_PATH_MARKER_STATE_VERSION,
    RECOVERY_PATH_STARTUP_QUARANTINE_MAX_BYTES,
    RECOVERY_PATH_STARTUP_QUARANTINE_NAME,
    RECOVERY_PATH_STARTUP_QUARANTINE_VERSION,
    RECOVERY_PATH_STATE_HANDOFF_NAME,
    RECOVERY_PATH_STATE_HANDOFF_VERSION,
    RECOVERY_PATH_STATE_LOCK_NAME,
    acquireRecoveryPathStateLockSync,
    addRecoveryPathMarkerKeepEntriesSync,
    assertRecoveryPathStartupQuarantineAbsentSync,
    canonicalizePathWithExistingPrefixSync,
    caseFoldPath,
    clearRecoveryPathStartupQuarantineSync,
    directoryFsyncErrorIsUnsupported,
    encodeRecoveryPathMarkerTargets,
    encodeRecoveryPathStartupQuarantine,
    fsyncDirectorySync,
    finalizeRecoveryPathStateLockHandoffSync,
    invalidateRecoveryPathMarkerSync,
    normalizeRecoveryPathMarkerTargets,
    normalizeRecoveryPathMarkerValue,
    parseRecoveryPathMarkerTargets,
    parseRecoveryPathStartupQuarantine,
    publishRecoveryPathStateLockHandoffSync,
    publishRecoveryPathMarkerSetSync,
    publishRecoveryPathMarkerSync,
    publishRecoveryPathStartupQuarantineSync,
    readRecoveryPathMarkerSync,
    readRecoveryPathMarkerTargetsSync,
    readRecoveryPathStartupQuarantineSync,
    readRecoveryPathStateLockHandoffSync,
    readRecoveryPathStateLockOwnerSync,
    recoveryPathKeepSetHas,
    recoveryPathKeepEntries,
    recoveryPathKeepEntry,
    recoveryPathStartupQuarantinePath,
    recoveryPathStateLockPath,
    releaseRecoveryPathStateLockSync,
};
