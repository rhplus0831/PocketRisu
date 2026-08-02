'use strict';

function nonNegativeInteger(value, fallback) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Small decoded-object cache with revision validation and clean-only eviction.
 * Dirty entries represent acknowledged, not-yet-persisted state and are pinned
 * regardless of configured limits or memory pressure.
 */
function createRevisionBoundCache(options = {}) {
    const maxEntries = nonNegativeInteger(options.maxEntries, 8);
    const maxEstimatedBytes = nonNegativeInteger(
        options.maxEstimatedBytes,
        1024 * 1024 * 1024,
    );
    const maxEntryEstimatedBytes = nonNegativeInteger(
        options.maxEntryEstimatedBytes,
        512 * 1024 * 1024,
    );
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const isUnderMemoryPressure = typeof options.isUnderMemoryPressure === 'function'
        ? options.isUnderMemoryPressure
        : () => false;
    const onMutation = typeof options.onMutation === 'function'
        ? options.onMutation
        : () => {};
    const entries = new Map();
    let estimatedBytes = 0;

    function entrySize(entry) {
        return nonNegativeInteger(entry?.estimatedBytes, 0);
    }

    function remove(key, reason = 'explicit') {
        const entry = entries.get(key);
        if (!entry) return false;
        entries.delete(key);
        estimatedBytes -= entrySize(entry);
        onMutation(key, reason);
        return true;
    }

    function set(key, value, metadata = {}) {
        const previous = entries.get(key);
        const next = {
            value,
            revision: Object.hasOwn(metadata, 'revision')
                ? metadata.revision
                : previous?.revision ?? null,
            dirty: Object.hasOwn(metadata, 'dirty')
                ? metadata.dirty === true
                : previous?.dirty === true,
            estimatedBytes: Object.hasOwn(metadata, 'estimatedBytes')
                ? nonNegativeInteger(metadata.estimatedBytes, 0)
                : entrySize(previous),
            lastAccessed: now(),
        };
        if (previous) estimatedBytes -= entrySize(previous);
        entries.set(key, next);
        estimatedBytes += entrySize(next);
        if (!previous || previous.value !== value) onMutation(key, 'replace');
        return value;
    }

    function peek(key) {
        return entries.get(key)?.value;
    }

    function get(key) {
        const entry = entries.get(key);
        if (!entry) return undefined;
        entry.lastAccessed = now();
        return entry.value;
    }

    function getForRevision(key, revision, { allowDirty = false } = {}) {
        const entry = entries.get(key);
        if (!entry || (entry.dirty && !allowDirty)) return undefined;
        if (entry.revision !== revision) {
            // Dirty entries are acknowledged, not-yet-persisted state. Never
            // discard them merely because an external writer advanced the row.
            if (entry.dirty) return undefined;
            remove(key, 'stale-revision');
            return undefined;
        }
        entry.lastAccessed = now();
        return entry.value;
    }

    function markDirty(key) {
        const entry = entries.get(key);
        if (!entry) return false;
        entry.dirty = true;
        entry.lastAccessed = now();
        return true;
    }

    function markClean(key, metadata = {}) {
        const entry = entries.get(key);
        if (!entry) return false;
        estimatedBytes -= entrySize(entry);
        entry.dirty = false;
        if (Object.hasOwn(metadata, 'revision')) entry.revision = metadata.revision;
        if (Object.hasOwn(metadata, 'estimatedBytes')) {
            entry.estimatedBytes = nonNegativeInteger(metadata.estimatedBytes, 0);
        }
        entry.lastAccessed = now();
        estimatedBytes += entrySize(entry);
        return true;
    }

    function metadata(key) {
        const entry = entries.get(key);
        if (!entry) return null;
        return {
            revision: entry.revision,
            dirty: entry.dirty,
            estimatedBytes: entry.estimatedBytes,
            lastAccessed: entry.lastAccessed,
        };
    }

    function prune() {
        const removed = [];
        const pressure = isUnderMemoryPressure();
        const candidates = [...entries.entries()]
            .filter(([, entry]) => !entry.dirty)
            .sort((left, right) => left[1].lastAccessed - right[1].lastAccessed);

        for (const [key, entry] of candidates) {
            const oversized = entrySize(entry) > maxEntryEstimatedBytes;
            const overEntries = entries.size > maxEntries;
            const overBytes = estimatedBytes > maxEstimatedBytes;
            if (!pressure && !oversized && !overEntries && !overBytes) break;
            if (remove(key, pressure ? 'memory-pressure' : 'limit')) removed.push(key);
        }
        return removed;
    }

    function clear(reason = 'clear') {
        for (const key of [...entries.keys()]) remove(key, reason);
    }

    return {
        set,
        get,
        peek,
        getForRevision,
        markDirty,
        markClean,
        metadata,
        prune,
        delete: remove,
        clear,
        has: (key) => entries.has(key),
        keys: () => [...entries.keys()],
        size: () => entries.size,
        estimatedBytes: () => estimatedBytes,
    };
}

module.exports = { createRevisionBoundCache };
