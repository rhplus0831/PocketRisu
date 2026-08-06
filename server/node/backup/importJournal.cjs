'use strict';

const defaultFs = require('fs');
const path = require('path');

const JOURNAL_PHASES = new Set(['swapped', 'committed']);

function isMissing(error) {
    return error?.code === 'ENOENT';
}

function fsyncPath(filePath, fsOps) {
    let fd;
    try {
        fd = fsOps.openSync(filePath, 'r');
        fsOps.fsyncSync(fd);
    } catch (error) {
        if (!isMissing(error)) throw error;
    } finally {
        if (fd !== undefined) {
            try {
                fsOps.closeSync(fd);
            } catch (error) {
                if (!isMissing(error)) throw error;
            }
        }
    }
}

function fsyncParentDirectory(filePath, fsOps) {
    fsyncPath(path.dirname(filePath), fsOps);
}

function isValidImportJournal(state) {
    return Boolean(
        state
        && typeof state === 'object'
        && typeof state.id === 'string'
        && state.id.length > 0
        && JOURNAL_PHASES.has(state.phase)
        && Array.isArray(state.dirs)
        && state.dirs.length > 0
        && state.dirs.every((dir) => (
            dir
            && typeof dir === 'object'
            && typeof dir.liveDir === 'string'
            && dir.liveDir.length > 0
            && typeof dir.backupDir === 'string'
            && dir.backupDir.length > 0
            && typeof dir.stagingDir === 'string'
            && dir.stagingDir.length > 0
            && typeof dir.liveExisted === 'boolean'
        ))
    );
}

function writeImportJournal(journalPath, state, fsOps = defaultFs) {
    if (!isValidImportJournal(state)) {
        throw new TypeError('Invalid import journal state');
    }
    const tmpPath = `${journalPath}.tmp`;
    fsOps.writeFileSync(tmpPath, JSON.stringify(state), 'utf-8');
    fsyncPath(tmpPath, fsOps);
    fsOps.renameSync(tmpPath, journalPath);
    fsyncParentDirectory(journalPath, fsOps);
}

function readImportJournal(journalPath, fsOps = defaultFs) {
    const tmpPath = `${journalPath}.tmp`;
    try {
        if (fsOps.existsSync(tmpPath)) {
            fsOps.rmSync(tmpPath, { force: true });
            fsyncParentDirectory(journalPath, fsOps);
        }
    } catch (error) {
        if (!isMissing(error)) throw error;
    }

    try {
        const parsed = JSON.parse(fsOps.readFileSync(journalPath, 'utf-8'));
        return isValidImportJournal(parsed) ? parsed : null;
    } catch (error) {
        if (isMissing(error) || error instanceof SyntaxError) return null;
        throw error;
    }
}

function clearImportJournal(journalPath, fsOps = defaultFs) {
    for (const target of [journalPath, `${journalPath}.tmp`]) {
        try {
            fsOps.rmSync(target, { force: true });
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
    }
    fsyncParentDirectory(journalPath, fsOps);
}

function fsyncDirectoryTree(dir, fsOps = defaultFs) {
    let entries;
    try {
        entries = fsOps.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        if (isMissing(error)) return;
        throw error;
    }

    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        let stat;
        try {
            stat = fsOps.lstatSync(entryPath);
        } catch (error) {
            if (isMissing(error)) continue;
            throw error;
        }
        if (stat.isDirectory()) {
            fsyncDirectoryTree(entryPath, fsOps);
        } else if (stat.isFile()) {
            fsyncPath(entryPath, fsOps);
        }
    }
    fsyncPath(dir, fsOps);
}

function recoverImportSwap({ journal, markerPresent, fs: fsOps = defaultFs }) {
    if (!isValidImportJournal(journal)) {
        throw new TypeError('Invalid import journal state');
    }
    const finalize = journal.phase === 'committed'
        || (journal.phase === 'swapped' && markerPresent === true);

    for (const dir of journal.dirs) {
        if (finalize) {
            fsOps.rmSync(dir.backupDir, { recursive: true, force: true });
            fsOps.rmSync(dir.stagingDir, { recursive: true, force: true });
            continue;
        }

        const backupExists = fsOps.existsSync(dir.backupDir);
        const liveExists = fsOps.existsSync(dir.liveDir);
        if (backupExists) {
            if (liveExists) {
                fsOps.rmSync(dir.liveDir, { recursive: true, force: true });
            }
            fsOps.renameSync(dir.backupDir, dir.liveDir);
        } else if (liveExists && dir.liveExisted === false) {
            fsOps.rmSync(dir.liveDir, { recursive: true, force: true });
        }
        fsOps.rmSync(dir.stagingDir, { recursive: true, force: true });
    }

    return {
        action: finalize ? 'finalized' : 'restored',
        id: journal.id,
        phase: journal.phase,
        markerPresent: markerPresent === true,
        directories: journal.dirs.length,
    };
}

module.exports = {
    writeImportJournal,
    readImportJournal,
    clearImportJournal,
    fsyncDirectoryTree,
    recoverImportSwap,
};
