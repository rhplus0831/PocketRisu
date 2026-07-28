'use strict';

const ASSET_REFERENCE_RE = /assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}/g;
const SAFE_ASSET_KEY_RE = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DEFAULT_MAX_SCAN_NODES = 2_000_000;
const DEFAULT_MAX_SCAN_DEPTH = 256;
const unsafeAssetMatcherCache = new WeakMap();

class AssetReferenceScanLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AssetReferenceScanLimitError';
        this.code = 'ASSET_REFERENCE_SCAN_LIMIT';
    }
}

function unsafeAssetMatcher(knownAssetKeys) {
    const cached = unsafeAssetMatcherCache.get(knownAssetKeys);
    if (cached) return cached;
    const root = new Map();
    for (const key of knownAssetKeys) {
        if (SAFE_ASSET_KEY_RE.test(key)) continue;
        let node = root;
        for (const char of key) {
            if (!node.has(char)) node.set(char, new Map());
            node = node.get(char);
        }
        node.assetKey = key;
    }
    unsafeAssetMatcherCache.set(knownAssetKeys, root);
    return root;
}

function collectReferencedAssetKeys(
    root,
    knownAssetKeys,
    referenced = new Set(),
    options = {},
) {
    const maxNodes = options.maxNodes ?? DEFAULT_MAX_SCAN_NODES;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_SCAN_DEPTH;
    const unsafeMatcher = unsafeAssetMatcher(knownAssetKeys);
    const stack = [{ value: root, depth: 0 }];
    const seen = new WeakSet();
    let visitedNodes = 0;

    const scanString = (value) => {
        if (!value.includes('assets/')) return;
        if (knownAssetKeys.has(value)) referenced.add(value);
        ASSET_REFERENCE_RE.lastIndex = 0;
        for (const match of value.matchAll(ASSET_REFERENCE_RE)) {
            let candidate = match[0];
            // Punctuation such as a sentence-ending period is filename-safe and
            // therefore consumed by the regex. Walk back to the longest exact
            // stored key; false positives only retain bytes and are preferable
            // to deleting a live plugin asset.
            while (candidate.startsWith('assets/')) {
                if (knownAssetKeys.has(candidate)) {
                    referenced.add(candidate);
                    break;
                }
                candidate = candidate.slice(0, -1);
            }
        }
        let start = value.indexOf('assets/');
        while (start !== -1 && unsafeMatcher.size > 0) {
            let node = unsafeMatcher;
            for (let index = start; index < value.length; index++) {
                node = node.get(value[index]);
                if (!node) break;
                if (node.assetKey) referenced.add(node.assetKey);
            }
            start = value.indexOf('assets/', start + 1);
        }
    };

    while (stack.length > 0) {
        const { value, depth } = stack.pop();
        if (++visitedNodes > maxNodes) {
            throw new AssetReferenceScanLimitError(
                `Asset reference scan exceeded ${maxNodes} values`,
            );
        }
        if (typeof value === 'string') {
            scanString(value);
            continue;
        }
        if (value === null || typeof value !== 'object') continue;
        if (seen.has(value)) continue;
        if (depth >= maxDepth) {
            throw new AssetReferenceScanLimitError(
                `Asset reference scan exceeded depth ${maxDepth}`,
            );
        }
        seen.add(value);
        for (const key of Object.keys(value)) {
            scanString(key);
            stack.push({ value: value[key], depth: depth + 1 });
        }
    }

    return referenced;
}

function assetEntryIdentity(entry) {
    const changedAt = Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : null;
    return JSON.stringify([entry.source, entry.size, changedAt]);
}

function planAssetGc({
    assets,
    referencedKeys,
    candidates,
    now,
    graceMs,
}) {
    const existingKeys = new Set(assets.map((entry) => entry.key));
    const clear = [];
    const mark = [];
    const remove = [];
    let retainedByGrace = 0;

    for (const candidateKey of candidates.keys()) {
        if (!existingKeys.has(candidateKey) || referencedKeys.has(candidateKey)) {
            clear.push(candidateKey);
        }
    }

    for (const asset of assets) {
        if (referencedKeys.has(asset.key)) continue;
        const identity = assetEntryIdentity(asset);
        const candidate = candidates.get(asset.key);
        if (!candidate || candidate.identity !== identity) {
            mark.push({ key: asset.key, identity, firstUnreferencedAt: now });
            retainedByGrace++;
            continue;
        }
        const elapsed = Math.max(0, now - candidate.firstUnreferencedAt);
        if (elapsed >= graceMs) {
            remove.push(asset.key);
        } else {
            retainedByGrace++;
        }
    }

    return { clear, mark, remove, retainedByGrace };
}

function createAssetGcCandidateStore(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS asset_gc_candidates (
        asset_key            TEXT    PRIMARY KEY,
        first_unreferenced_at INTEGER NOT NULL,
        identity             TEXT    NOT NULL
      )
    `);
    const list = db.prepare(
        'SELECT asset_key, first_unreferenced_at, identity FROM asset_gc_candidates',
    );
    const upsert = db.prepare(`
      INSERT INTO asset_gc_candidates (asset_key, first_unreferenced_at, identity)
      VALUES (?, ?, ?)
      ON CONFLICT(asset_key) DO UPDATE SET
        first_unreferenced_at = excluded.first_unreferenced_at,
        identity = excluded.identity
    `);
    const remove = db.prepare('DELETE FROM asset_gc_candidates WHERE asset_key = ?');
    const clear = db.prepare('DELETE FROM asset_gc_candidates');

    return {
        list() {
            return new Map(list.all().map((row) => [row.asset_key, {
                firstUnreferencedAt: row.first_unreferenced_at,
                identity: row.identity,
            }]));
        },
        mark(key, firstUnreferencedAt, identity) {
            upsert.run(key, firstUnreferencedAt, identity);
        },
        remove(key) {
            return remove.run(key).changes > 0;
        },
        clear() {
            return clear.run().changes;
        },
    };
}

module.exports = {
    AssetReferenceScanLimitError,
    assetEntryIdentity,
    collectReferencedAssetKeys,
    createAssetGcCandidateStore,
    planAssetGc,
};
