const { Packr, Unpackr } = require('msgpackr');
const nodeCrypto = require('crypto');
const { encodeRisuSaveLegacy, sha256Hex } = require('./utils.cjs');

const DB_CACHE_VERSION = 1;
const DB_CACHE_MAX_HASHES = 8192;
const DB_CACHE_GROUPS = ['root', 'characters', 'botPresets', 'modules', 'personas'];
const DB_CACHE_ARRAY_GROUPS = DB_CACHE_GROUPS.slice(1);
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
    if (!isRecord(strippedDatabase)) {
        throw new Error('Database must be an object');
    }
    for (const group of DB_CACHE_ARRAY_GROUPS) {
        if (!Array.isArray(strippedDatabase[group])) {
            throw new Error(`Database field ${group} must be an array`);
        }
    }

    const root = {};
    for (const key of Object.keys(strippedDatabase)) {
        if (!DB_CACHE_ARRAY_GROUPS.includes(key)) root[key] = strippedDatabase[key];
    }

    const encoded = {
        root: encodeDatabaseSegment(root),
    };
    for (const group of DB_CACHE_ARRAY_GROUPS) {
        encoded[group] = strippedDatabase[group].map(encodeDatabaseSegment);
    }
    return encoded;
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
    computeBufferEtag,
    encodeRawMsgpack,
    decodeRawMsgpack,
    parseDbCacheInventory,
    prepareDatabaseReadPayload,
    encodeDatabaseSegments,
    buildCachedDbReadEnvelope,
    encodeCachedDbReadEnvelope,
};
