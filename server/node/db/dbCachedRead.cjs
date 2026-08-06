const { Packr, Unpackr } = require('msgpackr');
const nodeCrypto = require('crypto');
const { encodeRisuSaveLegacy, sha256Hex } = require('../utils.cjs');

const DB_CACHE_VERSION = 1;
const DB_CACHE_MAX_HASHES = 8192;
const DB_CACHE_GROUPS = ['root', 'characters', 'botPresets', 'modules', 'personas'];
const DB_CACHE_ARRAY_GROUPS = DB_CACHE_GROUPS.slice(1);
const DB_SEGMENT_MEMO_MAX_BYTES = 64 * 1024 * 1024;
const DB_SEGMENT_MEMO_MAX_VALUE_BYTES = 32 * 1024 * 1024;
const DB_SEGMENT_MEMO_MAX_ENTRIES = DB_CACHE_MAX_HASHES;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const packr = new Packr({
    useRecords: false,
    variableMapSize: true,
});

const unpackr = new Unpackr({
    copyBuffers: true,
    int64AsType: 'number',
    useRecords: false,
});

function computeBufferEtag(buffer) {
    return nodeCrypto.createHash('md5').update(buffer).digest('hex');
}

function encodeRawMsgpack(value) {
    return Buffer.from(packr.encode(value));
}

function decodeRawMsgpack(value) {
    return unpackr.decode(value);
}

function parseDbCacheInventory(body) {
    if (!isRecord(body) || !hasExactKeys(body, ['cache'])) {
        throw new Error('Malformed database cache request');
    }
    const cache = body.cache;
    if (!isRecord(cache) || cache.version !== DB_CACHE_VERSION || !hasExactKeys(cache, ['version', 'hashes'])) {
        throw new Error('Malformed database cache request');
    }
    const hashes = cache.hashes;
    if (!isRecord(hashes) || !hasExactKeys(hashes, DB_CACHE_GROUPS)) {
        throw new Error('Malformed database cache request');
    }

    let totalHashes = 0;
    const inventory = {};
    for (const group of DB_CACHE_GROUPS) {
        const values = hashes[group];
        if (!Array.isArray(values)) throw new Error('Malformed database cache request');
        totalHashes += values.length;
        if (totalHashes > DB_CACHE_MAX_HASHES) {
            throw new Error('Database cache inventory exceeds 8192 hashes');
        }
        const unique = new Set();
        for (const value of values) {
            if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
                throw new Error('Malformed database cache request');
            }
            unique.add(value);
        }
        inventory[group] = unique;
    }
    return inventory;
}

function prepareDatabaseReadPayload(strippedDatabase) {
    const fullBlob = Buffer.from(encodeRisuSaveLegacy(strippedDatabase));
    return {
        strippedDatabase,
        fullBlob,
        etag: computeBufferEtag(fullBlob),
    };
}

function encodeDatabaseSegments(strippedDatabase) {
    validateSegmentedDatabase(strippedDatabase);

    const root = selectDatabaseRoot(strippedDatabase);

    const encoded = {
        root: encodeDatabaseSegment(root),
    };
    for (const group of DB_CACHE_ARRAY_GROUPS) {
        encoded[group] = strippedDatabase[group].map(encodeDatabaseSegment);
    }
    return encoded;
}

/**
 * Retain only one bounded publication of encoded database segments. The
 * authoritative SQLite row revision names the publication; callers must clear
 * the memo on a replacement that cannot preserve object identity. Atomic JSON
 * patches are copy-on-write, so unchanged array members and shallow root fields
 * can safely carry their encoded bytes into the next revision.
 */
function createDatabaseSegmentMemo(options = {}) {
    const maxBytes = nonNegativeInteger(
        options.maxBytes,
        DB_SEGMENT_MEMO_MAX_BYTES,
    );
    const maxValueBytes = nonNegativeInteger(
        options.maxValueBytes,
        DB_SEGMENT_MEMO_MAX_VALUE_BYTES,
    );
    const maxEntries = nonNegativeInteger(
        options.maxEntries,
        DB_SEGMENT_MEMO_MAX_ENTRIES,
    );
    const encodeSegment = typeof options.encodeSegment === 'function'
        ? options.encodeSegment
        : encodeDatabaseSegment;
    let state = null;

    function clear() {
        state = null;
    }

    function preserveForNextRevision() {
        if (state) state.mayReuseAcrossRevision = true;
    }

    function build(strippedDatabase, inventory, etag, revision) {
        validateSegmentedDatabase(strippedDatabase);
        validateParsedInventory(inventory);

        const prior = state && (
            state.revision === revision || state.mayReuseAcrossRevision === true
        ) ? state : null;
        const rootFields = selectDatabaseRoot(strippedDatabase);
        let encodedSegments = 0;
        let reusedSegments = 0;
        let retainedBytes = 0;
        let retainedEntries = 0;

        let rootSegment = null;
        let rootOversized = false;
        if (
            prior?.root
            && (prior.root.segment || prior.root.oversized)
            && shallowRecordEqual(prior.root.fields, rootFields)
        ) {
            rootSegment = prior.root.segment;
            rootOversized = prior.root.oversized;
            reusedSegments += 1;
        } else {
            rootSegment = normalizeEncodedSegment(encodeSegment(rootFields));
            encodedSegments += 1;
            rootOversized = rootSegment.bytes.length > maxValueBytes;
        }

        if (rootOversized) {
            state = {
                revision,
                mayReuseAcrossRevision: false,
                root: { fields: rootFields, segment: null, oversized: true },
                groups: emptySegmentMaps(),
            };
            return {
                kind: 'raw-boot',
                reason: 'oversized-root',
                stats: {
                    encodedSegments,
                    reusedSegments,
                    retainedBytes: 0,
                    retainedEntries: 0,
                    revision,
                },
            };
        }

        const retainRoot = maxEntries > 0 && rootSegment.bytes.length <= maxBytes;
        const next = {
            revision,
            mayReuseAcrossRevision: false,
            root: {
                fields: rootFields,
                segment: retainRoot ? rootSegment : null,
                oversized: false,
            },
            groups: emptySegmentMaps(),
        };
        if (retainRoot) {
            retainedBytes += rootSegment.bytes.length;
            retainedEntries += 1;
        }

        const envelope = {
            version: DB_CACHE_VERSION,
            etag,
            root: projectSegment(rootSegment, inventory.root),
        };

        for (const group of DB_CACHE_ARRAY_GROUPS) {
            const priorSegments = prior?.groups?.[group];
            const nextSegments = next.groups[group];
            envelope[group] = [];
            for (const source of strippedDatabase[group]) {
                let segment = priorSegments?.get(source) ?? null;
                if (segment) {
                    reusedSegments += 1;
                } else {
                    segment = normalizeEncodedSegment(encodeSegment(source));
                    encodedSegments += 1;
                }

                envelope[group].push(projectSegment(segment, inventory[group]));
                if (
                    !nextSegments.has(source)
                    && segment.bytes.length <= maxValueBytes
                    && retainedEntries < maxEntries
                    && segment.bytes.length <= maxBytes - retainedBytes
                ) {
                    nextSegments.set(source, segment);
                    retainedBytes += segment.bytes.length;
                    retainedEntries += 1;
                }
            }
        }

        state = next;
        return {
            kind: 'envelope',
            envelope,
            stats: {
                encodedSegments,
                reusedSegments,
                retainedBytes,
                retainedEntries,
                revision,
            },
        };
    }

    return { build, clear, preserveForNextRevision };
}

function buildCachedDbReadEnvelope(encodedSegments, inventory, etag) {
    const envelope = {
        version: DB_CACHE_VERSION,
        etag,
        root: projectSegment(encodedSegments.root, inventory.root),
    };
    for (const group of DB_CACHE_ARRAY_GROUPS) {
        envelope[group] = encodedSegments[group].map((segment) => projectSegment(segment, inventory[group]));
    }
    return envelope;
}

function encodeCachedDbReadEnvelope(envelope) {
    return encodeRawMsgpack(envelope);
}

function encodeDatabaseSegment(value) {
    const bytes = encodeRawMsgpack(value);
    return {
        hash: sha256Hex(bytes),
        bytes,
    };
}

function validateSegmentedDatabase(strippedDatabase) {
    if (!isRecord(strippedDatabase)) {
        throw new Error('Database must be an object');
    }
    for (const group of DB_CACHE_ARRAY_GROUPS) {
        if (!Array.isArray(strippedDatabase[group])) {
            throw new Error(`Database field ${group} must be an array`);
        }
    }
}

function validateParsedInventory(inventory) {
    if (!isRecord(inventory)) throw new Error('Malformed parsed database cache inventory');
    for (const group of DB_CACHE_GROUPS) {
        if (!(inventory[group] instanceof Set)) {
            throw new Error('Malformed parsed database cache inventory');
        }
    }
}

function selectDatabaseRoot(strippedDatabase) {
    const root = {};
    for (const key of Object.keys(strippedDatabase)) {
        if (!DB_CACHE_ARRAY_GROUPS.includes(key)) root[key] = strippedDatabase[key];
    }
    return root;
}

function emptySegmentMaps() {
    return Object.fromEntries(DB_CACHE_ARRAY_GROUPS.map((group) => [group, new Map()]));
}

function shallowRecordEqual(left, right) {
    if (!left || !right) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => (
        key === rightKeys[index] && Object.is(left[key], right[key])
    ));
}

function normalizeEncodedSegment(segment) {
    if (!segment || typeof segment.hash !== 'string' || !Buffer.isBuffer(segment.bytes)) {
        throw new TypeError('Segment encoder must return a hash and Buffer bytes');
    }
    return segment;
}

function nonNegativeInteger(value, fallback) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function projectSegment(segment, inventory) {
    return inventory.has(segment.hash)
        ? { hash: segment.hash }
        : { bytes: segment.bytes };
}

function hasExactKeys(value, expected) {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

module.exports = {
    DB_CACHE_VERSION,
    DB_CACHE_MAX_HASHES,
    DB_CACHE_GROUPS,
    DB_CACHE_ARRAY_GROUPS,
    DB_SEGMENT_MEMO_MAX_BYTES,
    DB_SEGMENT_MEMO_MAX_VALUE_BYTES,
    DB_SEGMENT_MEMO_MAX_ENTRIES,
    computeBufferEtag,
    encodeRawMsgpack,
    decodeRawMsgpack,
    parseDbCacheInventory,
    prepareDatabaseReadPayload,
    encodeDatabaseSegments,
    buildCachedDbReadEnvelope,
    encodeCachedDbReadEnvelope,
    createDatabaseSegmentMemo,
};
