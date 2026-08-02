'use strict';

const { createRevisionBoundCache } = require('./revisionBoundCache.cjs');
const {
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_STORAGE_MANIFEST_VERSION,
    encodePluginSaveStorageKey,
    pluginSaveStorageKeyMappingComponent,
} = require('./pluginSaveKeys.cjs');

const CACHE_KEY = 'live-plugin-storage-manifest';

function addCount(map, key, delta) {
    const next = (map.get(key) ?? 0) + delta;
    if (next === 0) map.delete(key);
    else map.set(key, next);
}

function mappingComponent(storageKey, prefix) {
    return pluginSaveStorageKeyMappingComponent(storageKey, prefix);
}

function createEntry(state) {
    const manifest = state.manifest;
    const valueKeys = new Set(manifest?.valueKeys ?? []);
    const metaKeys = new Set(manifest?.metaKeys ?? []);
    const mappingByComponent = new Map(
        manifest?.version === PLUGIN_STORAGE_MANIFEST_VERSION
            ? manifest.keyMappings
            : [],
    );
    const mappingReferences = new Map();
    for (const [keys, prefix] of [
        [valueKeys, PLUGIN_SAVE_PREFIX],
        [metaKeys, PLUGIN_SAVE_META_PREFIX],
    ]) {
        for (const storageKey of keys) {
            const component = mappingComponent(storageKey, prefix);
            if (component !== null) addCount(mappingReferences, component, 1);
        }
    }
    return {
        state,
        valueKeys,
        metaKeys,
        mappingByComponent,
        mappingReferences,
    };
}

function uniqueStrings(values, fieldName) {
    const result = [];
    const seen = new Set();
    for (const value of values ?? []) {
        if (typeof value !== 'string') throw new TypeError(`${fieldName} must contain strings`);
        if (!seen.has(value)) {
            seen.add(value);
            result.push(value);
        }
    }
    return result;
}

function reviseOrderedKeys(current, membership, adds, deletes) {
    const requestedAdds = uniqueStrings(adds, 'manifest additions');
    const requestedDeletes = new Set(uniqueStrings(deletes, 'manifest deletions'));
    const effectiveDeletes = new Set(
        [...requestedDeletes].filter(key => membership.has(key)),
    );
    const effectiveAdds = requestedAdds.filter(key => (
        !membership.has(key) || effectiveDeletes.has(key)
    ));
    if (effectiveDeletes.size === 0 && effectiveAdds.length === 0) {
        return { keys: current, effectiveAdds, effectiveDeletes };
    }
    return {
        keys: [
            ...current.filter(key => !effectiveDeletes.has(key)),
            ...effectiveAdds,
        ],
        effectiveAdds,
        effectiveDeletes,
    };
}

function createPluginStorageManifestCache({ getRevision, readState }) {
    if (typeof getRevision !== 'function' || typeof readState !== 'function') {
        throw new TypeError('Plugin manifest cache requires revision and state readers');
    }
    const counters = {
        hits: 0,
        misses: 0,
        publications: 0,
        revisionChanges: 0,
        unverifiable: 0,
    };
    const cache = createRevisionBoundCache({
        maxEntries: 1,
        maxEstimatedBytes: 0,
        maxEntryEstimatedBytes: 0,
        onMutation: (_key, reason) => {
            if (reason === 'stale-revision') counters.revisionChanges += 1;
        },
    });

    function selectedRevision() {
        try {
            const revision = getRevision();
            return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
        } catch {
            return null;
        }
    }

    function read() {
        // Retry a revision that changes around the row read once. If external
        // writers keep moving it, return a fresh uncached parse rather than
        // attaching unverifiable state to any revision.
        for (let attempt = 0; attempt < 2; attempt++) {
            const revision = selectedRevision();
            if (revision === null) {
                counters.unverifiable += 1;
                cache.clear('unverifiable-revision');
                return createEntry(readState());
            }
            const cached = cache.getForRevision(CACHE_KEY, revision);
            if (cached !== undefined) {
                counters.hits += 1;
                return cached;
            }
            counters.misses += 1;
            const entry = createEntry(readState());
            if (selectedRevision() === revision) {
                cache.set(CACHE_KEY, entry, { revision });
                return entry;
            }
            cache.clear('revision-changed-during-read');
        }
        counters.unverifiable += 1;
        return createEntry(readState());
    }

    function prepareUpdate(entry, changes = {}) {
        const activeManifest = entry?.state?.manifest;
        if (!activeManifest || entry.state.valid !== true) {
            throw new TypeError('A valid cached plugin manifest is required');
        }
        const nextValues = reviseOrderedKeys(
            activeManifest.valueKeys,
            entry.valueKeys,
            changes.valueAdds,
            changes.valueDeletes,
        );
        const nextMeta = reviseOrderedKeys(
            activeManifest.metaKeys,
            entry.metaKeys,
            changes.metaAdds,
            changes.metaDeletes,
        );
        const mappingDeltas = new Map();
        for (const [keys, prefix, delta] of [
            [nextValues.effectiveDeletes, PLUGIN_SAVE_PREFIX, -1],
            [nextValues.effectiveAdds, PLUGIN_SAVE_PREFIX, 1],
            [nextMeta.effectiveDeletes, PLUGIN_SAVE_META_PREFIX, -1],
            [nextMeta.effectiveAdds, PLUGIN_SAVE_META_PREFIX, 1],
        ]) {
            for (const storageKey of keys) {
                const component = mappingComponent(storageKey, prefix);
                if (component !== null) addCount(mappingDeltas, component, delta);
            }
        }

        const rawMappings = new Map();
        for (const rawKey of uniqueStrings(changes.rawKeys, 'raw plugin keys')) {
            const storageKey = encodePluginSaveStorageKey(rawKey, PLUGIN_SAVE_PREFIX);
            const component = mappingComponent(storageKey, PLUGIN_SAVE_PREFIX);
            if (component === null) continue;
            const existing = entry.mappingByComponent.get(component);
            if (existing !== undefined && existing !== rawKey) {
                throw new TypeError('Plugin storage key hash collision');
            }
            const pending = rawMappings.get(component);
            if (pending !== undefined && pending !== rawKey) {
                throw new TypeError('Plugin storage key hash collision');
            }
            rawMappings.set(component, rawKey);
        }

        const finalReferenceCount = component => (
            (entry.mappingReferences.get(component) ?? 0)
            + (mappingDeltas.get(component) ?? 0)
        );
        const currentMappings = activeManifest.version === PLUGIN_STORAGE_MANIFEST_VERSION
            ? activeManifest.keyMappings
            : [];
        const removedMappingComponents = new Set(
            [...mappingDeltas.keys()].filter(component => finalReferenceCount(component) <= 0),
        );
        const appendedMappings = [];
        for (const [component, rawKey] of rawMappings) {
            if (finalReferenceCount(component) > 0
                && !entry.mappingByComponent.has(component)) {
                appendedMappings.push([component, rawKey]);
            }
        }
        for (const [component, delta] of mappingDeltas) {
            if (finalReferenceCount(component) > 0
                && !entry.mappingByComponent.has(component)
                && !rawMappings.has(component)) {
                throw new TypeError(`Missing plugin storage key mapping after delta ${delta}`);
            }
        }
        const nextMappings = removedMappingComponents.size === 0
            && appendedMappings.length === 0
            ? currentMappings
            : [
                ...currentMappings.filter(([component]) => (
                    !removedMappingComponents.has(component)
                )),
                ...appendedMappings,
            ];

        const manifest = {
            version: nextMappings.length > 0 ? PLUGIN_STORAGE_MANIFEST_VERSION : 2,
            generation: activeManifest.generation,
            valueKeys: nextValues.keys,
            metaKeys: nextMeta.keys,
            ...(nextMappings.length > 0 ? { keyMappings: nextMappings } : {}),
        };
        return {
            entry,
            manifest,
            nextValues,
            nextMeta,
            mappingDeltas,
            rawMappings,
        };
    }

    function publishPrepared(prepared, { revision, manifestRevision }) {
        if (!Number.isSafeInteger(revision) || revision < 0) {
            counters.unverifiable += 1;
            cache.clear('unverifiable-publication');
            return;
        }
        const entry = prepared.entry;
        for (const key of prepared.nextValues.effectiveDeletes) entry.valueKeys.delete(key);
        for (const key of prepared.nextValues.effectiveAdds) entry.valueKeys.add(key);
        for (const key of prepared.nextMeta.effectiveDeletes) entry.metaKeys.delete(key);
        for (const key of prepared.nextMeta.effectiveAdds) entry.metaKeys.add(key);
        for (const [component, delta] of prepared.mappingDeltas) {
            addCount(entry.mappingReferences, component, delta);
            if (!entry.mappingReferences.has(component)) entry.mappingByComponent.delete(component);
        }
        for (const [component, rawKey] of prepared.rawMappings) {
            if (entry.mappingReferences.has(component)) {
                entry.mappingByComponent.set(component, rawKey);
            }
        }
        entry.state = {
            manifest: prepared.manifest,
            present: true,
            valid: true,
            revision: manifestRevision,
        };
        cache.set(CACHE_KEY, entry, { revision });
        counters.publications += 1;
    }

    return {
        read,
        prepareUpdate,
        publishPrepared,
        clear: reason => cache.clear(reason),
        counters: () => ({ ...counters }),
    };
}

module.exports = { createPluginStorageManifestCache };
