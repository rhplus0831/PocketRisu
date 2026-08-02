'use strict';

function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Small LRU map for per-browser-session protocol state. A hit refreshes the
 * entry because a session actively reading its pinned publication is exactly
 * the session that should survive churn from older boot IDs.
 */
function createBoundedSessionState(options = {}) {
    const maxEntries = positiveInteger(options.maxEntries, 50);
    const onEvict = typeof options.onEvict === 'function' ? options.onEvict : () => {};
    const entries = new Map();
    let evictions = 0;

    function set(id, value) {
        if (typeof id !== 'string' || id.length === 0) return null;
        entries.delete(id);
        entries.set(id, value);
        let evicted = null;
        if (entries.size > maxEntries) {
            const oldest = entries.keys().next().value;
            const oldestValue = entries.get(oldest);
            entries.delete(oldest);
            evictions++;
            evicted = oldest;
            onEvict(oldest, oldestValue);
        }
        return evicted;
    }

    function get(id) {
        if (typeof id !== 'string' || !entries.has(id)) return null;
        const value = entries.get(id);
        entries.delete(id);
        entries.set(id, value);
        return value;
    }

    function deleteEntry(id) {
        return entries.delete(id);
    }

    function clear() {
        entries.clear();
    }

    function stats() {
        return {
            maxEntries,
            size: entries.size,
            evictions,
            keys: [...entries.keys()],
        };
    }

    return {
        set,
        get,
        delete: deleteEntry,
        clear,
        stats,
    };
}

module.exports = { createBoundedSessionState };
