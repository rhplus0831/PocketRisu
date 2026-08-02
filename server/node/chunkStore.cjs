'use strict';

// Content-defined chunking for large kv values. Splits an opaque byte buffer
// into content-addressed chunks so a small logical change rewrites only the
// chunks that actually changed (dedup), and so no single SQLite value exceeds
// the BLOB bind limit. Operates purely on bytes — knows nothing about the DB
// schema. See .agent/notes/db-storage-chunking-plan.md.

const crypto = require('crypto');
const fs = require('fs');

// Gear table for the rolling hash (FastCDC-style). Deterministic so chunk
// boundaries depend only on content — identical content always cuts the same
// way, which is what makes dedup work across versions.
const GEAR = new Uint32Array(256);
for (let i = 0; i < 256; i++) GEAR[i] = Math.imul(i + 1, 2654435761) >>> 0;

const MIN_SIZE = 4096;        // no boundary checked before this — bounds chunk count
const MAX_SIZE = 65536;       // forced cut here — bounds worst-case chunk size
const MASK = 0x3fff;          // ~16KB average chunk (14 one-bits)

// Split a buffer into ordered content-addressed chunks. Reassembling
// chunks[].data in order reproduces the input exactly.
function splitBuffer(buf, logicalHash = null) {
    const chunks = [];
    const len = buf.length;
    let start = 0;
    while (start < len) {
        const end = Math.min(start + MAX_SIZE, len);
        let cut = end;
        let h = 0;
        for (let i = Math.min(start + MIN_SIZE, len); i < end; i++) {
            h = ((h << 1) + GEAR[buf[i]]) >>> 0;
            if ((h & MASK) === 0) { cut = i + 1; break; }
        }
        const data = buf.subarray(start, cut);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        logicalHash?.update(data);
        chunks.push({ hash, data });
        start = cut;
    }
    return chunks;
}

function cdcSplit(buf) {
    return splitBuffer(buf);
}

// Sentinel stored in kv.value for a chunked key. kv.value is NOT NULL, so a
// chunked row holds this marker instead of an empty value; the real bytes live
// in the chunks table, ordered by manifest_chunks. A legacy raw value never
// equals this 13-byte sentinel, so reads stay backward-compatible.
const CHUNK_MARKER = Buffer.from('\x00RISUCHUNKED\x00', 'binary');
const DEFAULT_THRESHOLD = 16 * 1024 * 1024; // values larger than this get chunked
const CONTENT_VERIFICATION_MEMO_LIMIT = 4096;

function createContentVerificationMemo(limit = CONTENT_VERIFICATION_MEMO_LIMIT) {
    const revisions = new Map();
    return {
        has(key, revision) {
            return Number.isSafeInteger(revision) && revisions.get(key) === revision;
        },
        remember(key, revision) {
            if (!Number.isSafeInteger(revision) || revision < 0) return;
            revisions.delete(key);
            revisions.set(key, revision);
            while (revisions.size > limit) {
                revisions.delete(revisions.keys().next().value);
            }
        },
        forget(key) {
            revisions.delete(key);
        },
    };
}

function chunkCorruption(message) {
    const error = new Error(message);
    error.code = 'KV_CHUNK_CORRUPT';
    return error;
}

// The environment knob is intentionally lower-only.  A very large, negative,
// NaN, or infinite threshold would allow new monolithic SQLite rows even though
// every reader is designed around bounded parts.  Existing rows written by an
// older high-threshold process remain readable through SQLite substr() paging.
function normalizeThreshold(value) {
    if (value === undefined || value === null) return DEFAULT_THRESHOLD;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_THRESHOLD;
    return Math.min(DEFAULT_THRESHOLD, Math.max(1, Math.floor(numeric)));
}

function isChunkableKey(key) {
    // Chunking is a physical representation detail, not a namespace contract.
    // Every logical KV reader/delete/size/copy path is chunk-aware, and legacy
    // save folders may contain valid application or plugin-defined namespaces
    // that this server cannot predict. Keeping an allowlist here would make a
    // value writable through the generic API but unrestorable from disk.
    return typeof key === 'string';
}

function isChunked(value) {
    return Buffer.isBuffer(value) && value.equals(CHUNK_MARKER);
}

function isValidManifestMetadata(row) {
    return Number.isSafeInteger(row?.metadata_chunk_count) && row.metadata_chunk_count > 0
        && Number.isSafeInteger(row?.logical_size) && row.logical_size > 0
        && /^[0-9a-f]{64}$/.test(row?.logical_sha256 ?? '');
}

function hasCurrentVerifiedInventory(row) {
    return !!row?.is_protected
        && isValidManifestMetadata(row)
        && Number.isSafeInteger(row?.source_revision)
        && row.source_revision >= 0
        && row.verified_revision === row.source_revision;
}

function sizeFromAggregateRow(row) {
    if (!row?.has_marker) return row?.raw_size ?? null;
    const manifestCount = Number(row.manifest_count ?? 0);
    const presentChunkCount = Number(row.present_chunk_count ?? 0);
    const storedSize = Number(row.stored_size ?? 0);
    if (!row.is_protected) {
        if (manifestCount > 0 || row.metadata_chunk_count !== null) {
            throw chunkCorruption(`Chunk manifest ${row.key} has inconsistent protection state`);
        }
        return row.raw_size;
    }
    if (!isValidManifestMetadata(row)
        || manifestCount !== row.metadata_chunk_count
        || presentChunkCount !== row.metadata_chunk_count
        || row.min_seq !== 0 || row.max_seq !== manifestCount - 1
        || storedSize !== row.logical_size) {
        throw chunkCorruption(`Protected chunk manifest ${row.key} is incomplete`);
    }
    return row.logical_size;
}

// Read-only chunk-aware bindings for a pinned SQLite snapshot. Keep this
// separate from createChunkStore so readonly connections prepare no writes.
function createSnapshotReader(db, opts = {}) {
    const trustedContentMemo = opts.contentVerificationMemo ?? null;
    const localContentMemo = createContentVerificationMemo();
    const contentReadMetrics = {
        fullVerificationAttempts: 0,
        fullVerifications: 0,
        warmReads: 0,
        chunkDigestComputations: 0,
        preallocatedReads: 0,
    };
    const selKv = db.prepare(
        `SELECT value, EXISTS (
             SELECT 1 FROM chunk_manifest_publications p WHERE p.manifest_key = kv.key
         ) AS is_protected FROM kv WHERE key = ?`,
    );
    const selKvList = db.prepare('SELECT key FROM kv');
    const selKvPrefix = db.prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'`);
    const selVerifiedSize = db.prepare(
        `SELECT kv.key AS key,
                LENGTH(kv.value) AS raw_size,
                kv.value = @chunk_marker AS has_marker,
                EXISTS (
                    SELECT 1 FROM chunk_manifest_publications p
                    WHERE p.manifest_key = kv.key
                ) AS is_protected,
                meta.chunk_count AS metadata_chunk_count,
                meta.logical_size AS logical_size,
                meta.logical_sha256 AS logical_sha256,
                revision.source_revision AS source_revision,
                revision.verified_revision AS verified_revision
           FROM kv
           LEFT JOIN chunk_manifest_meta meta ON meta.manifest_key = kv.key
           LEFT JOIN chunk_manifest_inventory_revision revision
                  ON revision.manifest_key = kv.key
          WHERE kv.key = @key`,
    );
    const selKvPrefixVerifiedSizes = db.prepare(
        `SELECT kv.key AS key,
                LENGTH(kv.value) AS raw_size,
                kv.value = @chunk_marker AS has_marker,
                EXISTS (
                    SELECT 1 FROM chunk_manifest_publications p
                    WHERE p.manifest_key = kv.key
                ) AS is_protected,
                meta.chunk_count AS metadata_chunk_count,
                meta.logical_size AS logical_size,
                meta.logical_sha256 AS logical_sha256,
                revision.source_revision AS source_revision,
                revision.verified_revision AS verified_revision
           FROM kv
           LEFT JOIN chunk_manifest_meta meta ON meta.manifest_key = kv.key
           LEFT JOIN chunk_manifest_inventory_revision revision
                  ON revision.manifest_key = kv.key
          WHERE kv.key LIKE @pattern ESCAPE '\\'`,
    );
    const selKvPrefixAggregateSizes = db.prepare(
        `SELECT kv.key AS key,
                LENGTH(kv.value) AS raw_size,
                kv.value = @chunk_marker AS has_marker,
                EXISTS (
                    SELECT 1 FROM chunk_manifest_publications p
                    WHERE p.manifest_key = kv.key
                ) AS is_protected,
                meta.chunk_count AS metadata_chunk_count,
                meta.logical_size AS logical_size,
                meta.logical_sha256 AS logical_sha256,
                revision.source_revision AS source_revision,
                revision.verified_revision AS verified_revision,
                COUNT(manifest.seq) AS manifest_count,
                COUNT(chunk.hash) AS present_chunk_count,
                MIN(manifest.seq) AS min_seq,
                MAX(manifest.seq) AS max_seq,
                COALESCE(SUM(LENGTH(chunk.data)), 0) AS stored_size
           FROM kv
           LEFT JOIN chunk_manifest_meta meta ON meta.manifest_key = kv.key
           LEFT JOIN chunk_manifest_inventory_revision revision
                  ON revision.manifest_key = kv.key
           LEFT JOIN manifest_chunks manifest ON manifest.manifest_key = kv.key
           LEFT JOIN chunks chunk ON chunk.hash = manifest.hash
          WHERE kv.key LIKE @pattern ESCAPE '\\'
          GROUP BY kv.key`,
    );
    const selManifest = db.prepare(
        'SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq',
    );
    const selChunk = db.prepare('SELECT data FROM chunks WHERE hash = ?');
    const selManifestExists = db.prepare('SELECT 1 FROM manifest_chunks WHERE manifest_key = ? LIMIT 1');
    const selManifestMeta = db.prepare(
        'SELECT chunk_count, logical_size, logical_sha256 FROM chunk_manifest_meta WHERE manifest_key = ?',
    );
    const selManifestInventory = db.prepare(
        `SELECT COUNT(manifest.seq) AS chunk_count,
                COUNT(chunk.hash) AS present_chunk_count,
                MIN(manifest.seq) AS min_seq,
                MAX(manifest.seq) AS max_seq,
                COALESCE(SUM(LENGTH(chunk.data)), 0) AS stored_size,
                MIN(LENGTH(chunk.data)) AS min_chunk_size,
                MAX(LENGTH(chunk.data)) AS max_chunk_size,
                COALESCE(SUM(CASE
                    WHEN length(manifest.hash) = 64
                     AND manifest.hash NOT GLOB '*[^0-9a-f]*' THEN 0
                    ELSE 1
                END), 0) AS invalid_hash_count
           FROM manifest_chunks manifest
           LEFT JOIN chunks chunk ON chunk.hash = manifest.hash
          WHERE manifest.manifest_key = ?`,
    );
    const selContentRevision = db.prepare(
        `SELECT source_revision, content_verified_revision
           FROM chunk_manifest_inventory_revision WHERE manifest_key = ?`,
    );
    const selManifestPublication = db.prepare(
        'SELECT 1 FROM chunk_manifest_publications WHERE manifest_key = ?',
    );
    const selValueStreamMetadata = db.prepare(
        `SELECT LENGTH(value) AS raw_size, value = @chunk_marker AS has_chunk_marker
         FROM kv WHERE key = @key`,
    );
    const selRawValuePart = db.prepare(
        'SELECT substr(value, @offset, @length) AS data FROM kv WHERE key = @key',
    );
    const selManifestPart = db.prepare(
        `SELECT m.seq AS seq, m.hash AS hash, LENGTH(c.data) AS stored_size
         FROM manifest_chunks m
         LEFT JOIN chunks c ON c.hash = m.hash
         WHERE m.manifest_key = @key AND m.seq = @seq`,
    );
    const selChunkDataPart = db.prepare(
        'SELECT substr(data, 1, @read_length) AS data FROM chunks WHERE hash = @hash',
    );
    const selSize = db.prepare(
        'SELECT SUM(LENGTH(c.data)) AS n FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash WHERE m.manifest_key = ?',
    );
    function kvGet(key) {
        const row = selKv.get(key);
        if (!row) return null;
        const hasMarker = isChunked(row.value);
        const isProtected = !!selManifestPublication.get(key);
        const hasManifest = !!selManifestExists.get(key);
        const metadata = selManifestMeta.get(key) ?? null;
        if (hasMarker && isProtected) {
            const inventory = selManifestInventory.get(key);
            if (!hasManifest || !metadata
                || inventory.chunk_count !== metadata.chunk_count
                || inventory.min_seq !== 0 || inventory.max_seq !== inventory.chunk_count - 1) {
                throw chunkCorruption(`Protected chunk manifest ${key} is incomplete`);
            }
            const revision = selContentRevision.get(key) ?? null;
            let warm = Number.isSafeInteger(revision?.source_revision)
                && revision.source_revision >= 0
                && (
                    localContentMemo.has(key, revision.source_revision)
                    || (
                        revision.content_verified_revision === revision.source_revision
                        && trustedContentMemo?.has(key, revision.source_revision)
                    )
                );
            if (warm && (
                inventory.present_chunk_count !== metadata.chunk_count
                || inventory.stored_size !== metadata.logical_size
                || !Number.isSafeInteger(inventory.min_chunk_size)
                || inventory.min_chunk_size <= 0
                || !Number.isSafeInteger(inventory.max_chunk_size)
                || inventory.max_chunk_size > MAX_SIZE
                || inventory.invalid_hash_count !== 0
            )) {
                // A warm proof never blesses structure. Fall through to the
                // ordinary full verifier so its established corruption error
                // remains the one surfaced to callers.
                warm = false;
            }
            if (!warm) contentReadMetrics.fullVerificationAttempts += 1;
            const logicalHash = warm ? null : crypto.createHash('sha256');
            let size = 0;
            const output = Buffer.allocUnsafe(metadata.logical_size);
            contentReadMetrics.preallocatedReads += 1;
            const entries = selManifest.all(key);
            for (let index = 0; index < inventory.chunk_count; index++) {
                const entry = entries[index];
                const chunk = entry ? selChunk.get(entry.hash)?.data : null;
                let hashMatches = true;
                if (!warm && Buffer.isBuffer(chunk)) {
                    contentReadMetrics.chunkDigestComputations += 1;
                    hashMatches = crypto.createHash('sha256').update(chunk).digest('hex')
                        === entry?.hash;
                }
                if (!entry || entry.seq !== index
                    || !/^[0-9a-f]{64}$/.test(entry.hash) || !Buffer.isBuffer(chunk)
                    || chunk.length <= 0 || chunk.length > MAX_SIZE
                    || !hashMatches) {
                    throw chunkCorruption(`Protected chunk manifest ${key} has an invalid row at ${index}`);
                }
                if (size + chunk.length > output.length) {
                    throw chunkCorruption(`Protected chunk manifest ${key} failed logical verification`);
                }
                chunk.copy(output, size);
                size += chunk.length;
                logicalHash?.update(chunk);
            }
            if (size !== metadata.logical_size
                || (!warm && logicalHash.digest('hex') !== metadata.logical_sha256)) {
                throw chunkCorruption(`Protected chunk manifest ${key} failed logical verification`);
            }
            if (warm) {
                contentReadMetrics.warmReads += 1;
            } else {
                contentReadMetrics.fullVerifications += 1;
                if (Number.isSafeInteger(revision?.source_revision)
                    && revision.source_revision >= 0) {
                    localContentMemo.remember(key, revision.source_revision);
                }
            }
            return output;
        }
        if (hasMarker && (isProtected || hasManifest || metadata)) {
            throw chunkCorruption(`Chunk manifest ${key} has inconsistent protection state`);
        }
        return row.value;
    }

    function kvList(prefix) {
        if (prefix) {
            const escaped = prefix.replace(/[\\%_]/g, '\\$&');
            return selKvPrefix.all(`${escaped}%`).map((row) => row.key);
        }
        return selKvList.all().map((row) => row.key);
    }

    function kvListWithSizes(prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        const parameters = { chunk_marker: CHUNK_MARKER, pattern: `${escaped}%` };
        const fastRows = selKvPrefixVerifiedSizes.all(parameters);
        if (fastRows.every((row) => !row.has_marker || hasCurrentVerifiedInventory(row))) {
            return fastRows.map((row) => ({
                key: row.key,
                size: row.has_marker ? row.logical_size : row.raw_size,
            }));
        }
        // A pinned reader cannot publish verification state. One grouped query
        // remains the authoritative fallback and replaces the former per-value
        // COUNT/SUM loop.
        return selKvPrefixAggregateSizes.all(parameters).map((row) => ({
            key: row.key,
            size: sizeFromAggregateRow(row),
        }));
    }

    function snapshotPublicationState(key, row) {
        if (!row?.has_chunk_marker) {
            return { chunked: false, size: row?.raw_size ?? null, metadata: null, inventory: null };
        }
        const published = !!selManifestPublication.get(key);
        const hasManifest = !!selManifestExists.get(key);
        const metadata = selManifestMeta.get(key) ?? null;
        if (!published) {
            if (hasManifest || metadata) {
                throw chunkCorruption(`Chunk manifest ${key} has inconsistent protection state`);
            }
            return { chunked: false, size: row.raw_size, metadata: null, inventory: null };
        }
        const inventory = selManifestInventory.get(key);
        const storedSize = selSize.get(key).n;
        if (!hasManifest || !metadata
            || !Number.isSafeInteger(metadata.chunk_count) || metadata.chunk_count <= 0
            || !Number.isSafeInteger(metadata.logical_size) || metadata.logical_size <= 0
            || !/^[0-9a-f]{64}$/.test(metadata.logical_sha256)
            || inventory.chunk_count !== metadata.chunk_count
            || inventory.min_seq !== 0 || inventory.max_seq !== inventory.chunk_count - 1
            || storedSize !== metadata.logical_size) {
            throw chunkCorruption(`Protected chunk manifest ${key} is incomplete`);
        }
        return {
            chunked: true,
            size: metadata.logical_size,
            metadata,
            inventory,
            revision: selContentRevision.get(key) ?? null,
        };
    }

    function snapshotPart(key, index) {
        const part = selManifestPart.get({ key, seq: index });
        if (!part || part.seq !== index
            || !Number.isSafeInteger(part.stored_size)
            || part.stored_size <= 0 || part.stored_size > MAX_SIZE
            || !/^[0-9a-f]{64}$/.test(part.hash)) {
            throw chunkCorruption(`Chunk manifest row ${index} is missing or invalid`);
        }
        return part;
    }

    function snapshotChunk(part, index, verifyContent = true) {
        const row = selChunkDataPart.get({ hash: part.hash, read_length: MAX_SIZE });
        let hashMatches = true;
        if (verifyContent && Buffer.isBuffer(row?.data)) {
            contentReadMetrics.chunkDigestComputations += 1;
            hashMatches = crypto.createHash('sha256').update(row.data).digest('hex') === part.hash;
        }
        if (!Buffer.isBuffer(row?.data) || row.data.length !== part.stored_size
            || !hashMatches) {
            throw chunkCorruption(`Chunk manifest row ${index} failed verification`);
        }
        return row.data;
    }

    function snapshotStreamAbort(options) {
        if (!options.signal?.aborted && !options.shouldAbort?.()) return;
        const error = options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error('KV snapshot stream cancelled');
        if (!error.code) {
            try { error.code = 'KV_STREAM_ABORTED'; } catch {}
        }
        throw error;
    }

    async function writeSnapshotPart(fileHandle, data) {
        let written = 0;
        while (written < data.length) {
            const result = await fileHandle.write(data, written, data.length - written, null);
            if (result.bytesWritten <= 0) throw new Error('KV snapshot spool write made no progress');
            written += result.bytesWritten;
        }
    }

    const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

    // Snapshot-backed counterpart to createChunkStore.writeValueToFile(). One
    // completed SQLite statement produces each <=64 KiB page; no cursor remains
    // live while file I/O or abort delivery yields to the event loop.
    async function kvWriteToFile(key, filePath, options = {}) {
        const row = selValueStreamMetadata.get({ key, chunk_marker: CHUNK_MARKER });
        if (!row) return null;
        const state = snapshotPublicationState(key, row);
        const fileHandle = await fs.promises.open(filePath, 'wx', 0o600);
        let size = 0;
        let chunks = 0;
        let maxChunkBytes = 0;
        let logicalHash = null;
        const writePart = async (data) => {
            await yieldToEventLoop();
            snapshotStreamAbort(options);
            await writeSnapshotPart(fileHandle, data);
            size += data.length;
            chunks++;
            maxChunkBytes = Math.max(maxChunkBytes, data.length);
            logicalHash?.update(data);
            await options.onChunk?.({ index: chunks - 1, size: data.length });
            await yieldToEventLoop();
            snapshotStreamAbort(options);
        };
        try {
            snapshotStreamAbort(options);
            if (state.chunked) {
                let warm = Number.isSafeInteger(state.revision?.source_revision)
                    && state.revision.source_revision >= 0
                    && (
                        localContentMemo.has(key, state.revision.source_revision)
                        || (
                            state.revision.content_verified_revision
                                === state.revision.source_revision
                            && trustedContentMemo?.has(key, state.revision.source_revision)
                        )
                    );
                if (warm && (
                    state.inventory.present_chunk_count !== state.metadata.chunk_count
                    || state.inventory.stored_size !== state.metadata.logical_size
                    || !Number.isSafeInteger(state.inventory.min_chunk_size)
                    || state.inventory.min_chunk_size <= 0
                    || !Number.isSafeInteger(state.inventory.max_chunk_size)
                    || state.inventory.max_chunk_size > MAX_SIZE
                    || state.inventory.invalid_hash_count !== 0
                )) {
                    warm = false;
                }
                if (!warm) {
                    contentReadMetrics.fullVerificationAttempts += 1;
                    logicalHash = crypto.createHash('sha256');
                }
                for (let index = 0; index < state.inventory.chunk_count; index++) {
                    snapshotStreamAbort(options);
                    const part = snapshotPart(key, index);
                    await writePart(snapshotChunk(part, index, !warm));
                }
                if (chunks !== state.metadata.chunk_count
                    || size !== state.metadata.logical_size
                    || (!warm && logicalHash.digest('hex') !== state.metadata.logical_sha256)) {
                    throw chunkCorruption(`Chunk manifest ${key} failed logical verification`);
                }
                if (warm) {
                    contentReadMetrics.warmReads += 1;
                } else {
                    contentReadMetrics.fullVerifications += 1;
                    if (Number.isSafeInteger(state.revision?.source_revision)
                        && state.revision.source_revision >= 0) {
                        localContentMemo.remember(key, state.revision.source_revision);
                    }
                }
            } else {
                if (!Number.isSafeInteger(state.size) || state.size < 0) {
                    throw chunkCorruption(`Raw KV value ${key} has an invalid size`);
                }
                let offset = 0;
                while (offset < state.size) {
                    snapshotStreamAbort(options);
                    const part = selRawValuePart.get({
                        key,
                        offset: offset + 1,
                        length: Math.min(MAX_SIZE, state.size - offset),
                    });
                    if (!Buffer.isBuffer(part?.data)
                        || part.data.length <= 0 || part.data.length > MAX_SIZE) {
                        throw chunkCorruption(`Raw KV value ${key} is missing bytes at ${offset}`);
                    }
                    await writePart(part.data);
                    offset += part.data.length;
                }
            }
            await fileHandle.sync();
            await fileHandle.close();
            return { filePath, size, chunks, maxChunkBytes };
        } catch (error) {
            try { await fileHandle.close(); } catch {}
            try { await fs.promises.unlink(filePath); } catch {}
            throw error;
        }
    }

    // Bounded metadata probe used for gzip headers/footers. The returned body
    // is explicitly limited to one storage page and never assembles a value.
    function kvReadRange(key, offset, length) {
        if (!Number.isSafeInteger(offset) || offset < 0
            || !Number.isSafeInteger(length) || length < 0 || length > MAX_SIZE) {
            throw new RangeError(`Invalid KV snapshot range for ${key}`);
        }
        const row = selValueStreamMetadata.get({ key, chunk_marker: CHUNK_MARKER });
        if (!row) return null;
        const state = snapshotPublicationState(key, row);
        if (offset > state.size || offset + length > state.size) {
            throw new RangeError(`KV snapshot range exceeds ${key}`);
        }
        if (length === 0) return Buffer.alloc(0);
        if (!state.chunked) {
            const part = selRawValuePart.get({ key, offset: offset + 1, length });
            if (!Buffer.isBuffer(part?.data) || part.data.length !== length) {
                throw chunkCorruption(`Raw KV value ${key} is missing a requested range`);
            }
            return part.data;
        }
        const output = Buffer.allocUnsafe(length);
        let logicalOffset = 0;
        let copied = 0;
        for (let index = 0; index < state.inventory.chunk_count && copied < length; index++) {
            const part = snapshotPart(key, index);
            const partEnd = logicalOffset + part.stored_size;
            if (partEnd > offset && logicalOffset < offset + length) {
                const chunk = snapshotChunk(part, index);
                const from = Math.max(0, offset - logicalOffset);
                const to = Math.min(chunk.length, offset + length - logicalOffset);
                chunk.copy(output, copied, from, to);
                copied += to - from;
            }
            logicalOffset = partEnd;
        }
        if (copied !== length) {
            throw chunkCorruption(`Chunked KV value ${key} is missing a requested range`);
        }
        return output;
    }

    function kvSize(key) {
        const row = selVerifiedSize.get({ key, chunk_marker: CHUNK_MARKER });
        if (!row) return null;
        if (!row.has_marker) return row.raw_size;
        if (hasCurrentVerifiedInventory(row)) return row.logical_size;
        const authoritative = selKvPrefixAggregateSizes.all({
            chunk_marker: CHUNK_MARKER,
            pattern: `${key.replace(/[\\%_]/g, '\\$&')}`,
        }).find((entry) => entry.key === key);
        return authoritative ? sizeFromAggregateRow(authoritative) : null;
    }

    return {
        kvGet,
        kvList,
        kvListWithSizes,
        kvWriteToFile,
        kvReadRange,
        kvSize,
        contentReadMetrics: () => ({ ...contentReadMetrics }),
    };
}

// Bind chunk-aware get/put to a specific better-sqlite3 instance. db.cjs wires
// the real DB; tests wire a :memory: DB. The kv table must already exist (it is
// db.cjs's schema); this creates only the chunk/manifest tables.
function createChunkStore(db, opts = {}) {
    const threshold = normalizeThreshold(opts.threshold);
    const contentVerificationMemo = opts.contentVerificationMemo
        ?? createContentVerificationMemo();
    const inFlightReads = new Map();
    const contentMetrics = {
        fullVerificationAttempts: 0,
        fullVerifications: 0,
        warmReads: 0,
        chunkDigestComputations: 0,
        preallocatedReads: 0,
        singleFlightStarts: 0,
        singleFlightJoins: 0,
    };
    const writeMetrics = {
        cdcPasses: 0,
        logicalDigestPasses: 0,
        secondFullValueDigestPasses: 0,
        preparedFilePublications: 0,
        synchronousFileFallbacks: 0,
    };

    db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
            hash TEXT PRIMARY KEY,
            data BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS manifest_chunks (
            manifest_key TEXT NOT NULL,
            seq          INTEGER NOT NULL,
            hash         TEXT NOT NULL,
            PRIMARY KEY (manifest_key, seq)
        );
        CREATE INDEX IF NOT EXISTS idx_manifest_hash ON manifest_chunks(hash);
        CREATE TABLE IF NOT EXISTS chunk_manifest_meta (
            manifest_key   TEXT PRIMARY KEY,
            chunk_count    INTEGER NOT NULL,
            logical_size   INTEGER NOT NULL,
            logical_sha256 TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunk_manifest_protection (
            id      INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunk_manifest_publications (
            manifest_key TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS chunk_manifest_inventory_revision (
            manifest_key             TEXT PRIMARY KEY,
            source_revision          INTEGER NOT NULL CHECK (source_revision >= 0),
            verified_revision        INTEGER CHECK (verified_revision IS NULL OR verified_revision >= 0),
            content_verified_revision INTEGER CHECK (
                content_verified_revision IS NULL OR content_verified_revision >= 0
            )
        );

        INSERT OR IGNORE INTO chunk_manifest_inventory_revision
            (manifest_key, source_revision, verified_revision)
        SELECT manifest_key, 0, NULL FROM (
            SELECT manifest_key FROM manifest_chunks
            UNION SELECT manifest_key FROM chunk_manifest_meta
            UNION SELECT manifest_key FROM chunk_manifest_publications
        );

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_kv_insert
        AFTER INSERT ON kv
        WHEN NEW.value = X'00524953554348554E4B454400'
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (NEW.key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_kv_update
        AFTER UPDATE OF key, value ON kv
        WHEN OLD.value = X'00524953554348554E4B454400'
          OR NEW.value = X'00524953554348554E4B454400'
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (OLD.key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            SELECT NEW.key, 1, NULL WHERE NEW.key <> OLD.key
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_kv_delete
        AFTER DELETE ON kv
        WHEN OLD.value = X'00524953554348554E4B454400'
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (OLD.key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_manifest_insert
        AFTER INSERT ON manifest_chunks
        WHEN EXISTS (
            SELECT 1 FROM chunk_manifest_publications
             WHERE manifest_key = NEW.manifest_key
        )
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (NEW.manifest_key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_manifest_update
        AFTER UPDATE ON manifest_chunks
        WHEN EXISTS (
            SELECT 1 FROM chunk_manifest_publications
             WHERE manifest_key = OLD.manifest_key OR manifest_key = NEW.manifest_key
        )
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (OLD.manifest_key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            SELECT NEW.manifest_key, 1, NULL
             WHERE NEW.manifest_key <> OLD.manifest_key
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_manifest_delete
        AFTER DELETE ON manifest_chunks
        WHEN EXISTS (
            SELECT 1 FROM chunk_manifest_publications
             WHERE manifest_key = OLD.manifest_key
        )
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (OLD.manifest_key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_meta_insert
        AFTER INSERT ON chunk_manifest_meta
        WHEN EXISTS (
            SELECT 1 FROM chunk_manifest_publications
             WHERE manifest_key = NEW.manifest_key
        )
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (NEW.manifest_key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_meta_update
        AFTER UPDATE ON chunk_manifest_meta
        WHEN EXISTS (
            SELECT 1 FROM chunk_manifest_publications
             WHERE manifest_key = OLD.manifest_key OR manifest_key = NEW.manifest_key
        )
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (OLD.manifest_key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            SELECT NEW.manifest_key, 1, NULL
             WHERE NEW.manifest_key <> OLD.manifest_key
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_meta_delete
        AFTER DELETE ON chunk_manifest_meta
        WHEN EXISTS (
            SELECT 1 FROM chunk_manifest_publications
             WHERE manifest_key = OLD.manifest_key
        )
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (OLD.manifest_key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_publication_insert
        AFTER INSERT ON chunk_manifest_publications
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (NEW.manifest_key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_publication_update
        AFTER UPDATE ON chunk_manifest_publications
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (OLD.manifest_key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            SELECT NEW.manifest_key, 1, NULL
             WHERE NEW.manifest_key <> OLD.manifest_key
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_publication_delete
        AFTER DELETE ON chunk_manifest_publications
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            VALUES (OLD.manifest_key, 1, NULL)
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_chunk_insert
        AFTER INSERT ON chunks
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            SELECT DISTINCT manifest_key, 1, NULL
              FROM manifest_chunks
             WHERE hash = NEW.hash
               AND EXISTS (
                   SELECT 1 FROM chunk_manifest_publications publication
                    WHERE publication.manifest_key = manifest_chunks.manifest_key
               )
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_chunk_update
        AFTER UPDATE ON chunks
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            SELECT DISTINCT manifest_key, 1, NULL
              FROM manifest_chunks
             WHERE (hash = OLD.hash OR hash = NEW.hash)
               AND EXISTS (
                   SELECT 1 FROM chunk_manifest_publications publication
                    WHERE publication.manifest_key = manifest_chunks.manifest_key
               )
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_chunk_inventory_chunk_delete
        AFTER DELETE ON chunks
        BEGIN
            INSERT INTO chunk_manifest_inventory_revision
                (manifest_key, source_revision, verified_revision)
            SELECT DISTINCT manifest_key, 1, NULL
              FROM manifest_chunks
             WHERE hash = OLD.hash
               AND EXISTS (
                   SELECT 1 FROM chunk_manifest_publications publication
                    WHERE publication.manifest_key = manifest_chunks.manifest_key
               )
            ON CONFLICT(manifest_key) DO UPDATE SET
                source_revision = source_revision + 1,
                verified_revision = NULL;
        END;
    `);

    // CREATE TABLE IF NOT EXISTS does not evolve Track 3.5 databases. Existing
    // rows deliberately start cold: inventory verification proves only counts
    // and lengths, never the stored content bytes.
    const inventoryRevisionColumns = db.prepare(
        'PRAGMA table_info(chunk_manifest_inventory_revision)',
    ).all();
    if (!inventoryRevisionColumns.some((column) => (
        column.name === 'content_verified_revision'
    ))) {
        db.exec(`
            ALTER TABLE chunk_manifest_inventory_revision
            ADD COLUMN content_verified_revision INTEGER CHECK (
                content_verified_revision IS NULL OR content_verified_revision >= 0
            )
        `);
    }

    const insChunk = db.prepare('INSERT OR IGNORE INTO chunks (hash, data) VALUES (?, ?)');
    const delManifest = db.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ?');
    const delManifestMeta = db.prepare('DELETE FROM chunk_manifest_meta WHERE manifest_key = ?');
    const delManifestPublication = db.prepare(
        'DELETE FROM chunk_manifest_publications WHERE manifest_key = ?',
    );
    const insManifestPublication = db.prepare(
        'INSERT OR IGNORE INTO chunk_manifest_publications (manifest_key) VALUES (?)',
    );
    const selManifestPublication = db.prepare(
        'SELECT 1 FROM chunk_manifest_publications WHERE manifest_key = ?',
    );
    const insManifest = db.prepare('INSERT INTO manifest_chunks (manifest_key, seq, hash) VALUES (?, ?, ?)');
    const insManifestMeta = db.prepare(
        `INSERT OR REPLACE INTO chunk_manifest_meta
         (manifest_key, chunk_count, logical_size, logical_sha256) VALUES (?, ?, ?, ?)`,
    );
    const selManifestProtection = db.prepare(
        'SELECT version FROM chunk_manifest_protection WHERE id = 1',
    );
    const insManifestProtection = db.prepare(
        `INSERT INTO chunk_manifest_protection (id, version) VALUES (1, 2)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
    );
    const selManifestKeys = db.prepare(
        'SELECT DISTINCT manifest_key FROM manifest_chunks ORDER BY manifest_key',
    );
    const selManifest = db.prepare(
        'SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq',
    );
    const selManifestExists = db.prepare('SELECT 1 FROM manifest_chunks WHERE manifest_key = ? LIMIT 1');
    const selChunk = db.prepare('SELECT data FROM chunks WHERE hash = ?');
    const selValueStreamMetadata = db.prepare(
        `SELECT LENGTH(value) AS raw_size, value = @chunk_marker AS has_chunk_marker
         FROM kv WHERE key = @key`,
    );
    const selRawValuePart = db.prepare(
        'SELECT substr(value, @offset, @length) AS data FROM kv WHERE key = @key',
    );
    const selManifestStreamMetadata = db.prepare(
        `SELECT COUNT(manifest.seq) AS chunk_count,
                COUNT(chunk.hash) AS present_chunk_count,
                MIN(manifest.seq) AS min_seq,
                MAX(manifest.seq) AS max_seq,
                COALESCE(SUM(LENGTH(chunk.data)), 0) AS stored_size,
                MIN(LENGTH(chunk.data)) AS min_chunk_size,
                MAX(LENGTH(chunk.data)) AS max_chunk_size,
                COALESCE(SUM(CASE
                    WHEN length(manifest.hash) = 64
                     AND manifest.hash NOT GLOB '*[^0-9a-f]*' THEN 0
                    ELSE 1
                END), 0) AS invalid_hash_count
           FROM manifest_chunks manifest
           LEFT JOIN chunks chunk ON chunk.hash = manifest.hash
          WHERE manifest.manifest_key = ?`,
    );
    const selContentRevision = db.prepare(
        `SELECT source_revision, content_verified_revision
           FROM chunk_manifest_inventory_revision WHERE manifest_key = ?`,
    );
    const selManifestMeta = db.prepare(
        `SELECT chunk_count, logical_size, logical_sha256
         FROM chunk_manifest_meta WHERE manifest_key = ?`,
    );
    const selManifestPart = db.prepare(
        `SELECT m.seq AS seq, m.hash AS hash, LENGTH(c.data) AS stored_size
         FROM manifest_chunks m
         LEFT JOIN chunks c ON c.hash = m.hash
         WHERE m.manifest_key = @key AND m.seq = @seq`,
    );
    const selChunkDataPart = db.prepare(
        'SELECT substr(data, 1, @read_length) AS data FROM chunks WHERE hash = @hash',
    );
    const selSize = db.prepare(
        'SELECT SUM(LENGTH(c.data)) AS n FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash WHERE m.manifest_key = ?',
    );
    const selVerifiedSize = db.prepare(
        `SELECT kv.key AS key,
                LENGTH(kv.value) AS raw_size,
                kv.value = @chunk_marker AS has_marker,
                EXISTS (
                    SELECT 1 FROM chunk_manifest_publications p
                    WHERE p.manifest_key = kv.key
                ) AS is_protected,
                meta.chunk_count AS metadata_chunk_count,
                meta.logical_size AS logical_size,
                meta.logical_sha256 AS logical_sha256,
                revision.source_revision AS source_revision,
                revision.verified_revision AS verified_revision
           FROM kv
           LEFT JOIN chunk_manifest_meta meta ON meta.manifest_key = kv.key
           LEFT JOIN chunk_manifest_inventory_revision revision
                  ON revision.manifest_key = kv.key
          WHERE kv.key = @key`,
    );
    const selKvPrefixVerifiedSizes = db.prepare(
        `SELECT kv.key AS key,
                LENGTH(kv.value) AS raw_size,
                kv.value = @chunk_marker AS has_marker,
                EXISTS (
                    SELECT 1 FROM chunk_manifest_publications p
                    WHERE p.manifest_key = kv.key
                ) AS is_protected,
                meta.chunk_count AS metadata_chunk_count,
                meta.logical_size AS logical_size,
                meta.logical_sha256 AS logical_sha256,
                revision.source_revision AS source_revision,
                revision.verified_revision AS verified_revision
           FROM kv
           LEFT JOIN chunk_manifest_meta meta ON meta.manifest_key = kv.key
           LEFT JOIN chunk_manifest_inventory_revision revision
                  ON revision.manifest_key = kv.key
          WHERE kv.key LIKE @pattern ESCAPE '\\'`,
    );
    const selKvPrefixAggregateSizes = db.prepare(
        `SELECT kv.key AS key,
                LENGTH(kv.value) AS raw_size,
                kv.value = @chunk_marker AS has_marker,
                EXISTS (
                    SELECT 1 FROM chunk_manifest_publications p
                    WHERE p.manifest_key = kv.key
                ) AS is_protected,
                meta.chunk_count AS metadata_chunk_count,
                meta.logical_size AS logical_size,
                meta.logical_sha256 AS logical_sha256,
                revision.source_revision AS source_revision,
                revision.verified_revision AS verified_revision,
                COUNT(manifest.seq) AS manifest_count,
                COUNT(chunk.hash) AS present_chunk_count,
                MIN(manifest.seq) AS min_seq,
                MAX(manifest.seq) AS max_seq,
                COALESCE(SUM(LENGTH(chunk.data)), 0) AS stored_size
           FROM kv
           LEFT JOIN chunk_manifest_meta meta ON meta.manifest_key = kv.key
           LEFT JOIN chunk_manifest_inventory_revision revision
                  ON revision.manifest_key = kv.key
           LEFT JOIN manifest_chunks manifest ON manifest.manifest_key = kv.key
           LEFT JOIN chunks chunk ON chunk.hash = manifest.hash
          WHERE kv.key LIKE @pattern ESCAPE '\\'
          GROUP BY kv.key`,
    );
    const selSelectedVerifiedSizes = db.prepare(
        `WITH requested(key) AS (
             SELECT DISTINCT value FROM json_each(@keys)
         )
         SELECT kv.key AS key,
                LENGTH(kv.value) AS raw_size,
                kv.value = @chunk_marker AS has_marker,
                EXISTS (
                    SELECT 1 FROM chunk_manifest_publications p
                    WHERE p.manifest_key = kv.key
                ) AS is_protected,
                meta.chunk_count AS metadata_chunk_count,
                meta.logical_size AS logical_size,
                meta.logical_sha256 AS logical_sha256,
                revision.source_revision AS source_revision,
                revision.verified_revision AS verified_revision
           FROM requested
           JOIN kv ON kv.key = requested.key
           LEFT JOIN chunk_manifest_meta meta ON meta.manifest_key = kv.key
           LEFT JOIN chunk_manifest_inventory_revision revision
                  ON revision.manifest_key = kv.key`,
    );
    const selSelectedAggregateSizes = db.prepare(
        `WITH requested(key) AS (
             SELECT DISTINCT value FROM json_each(@keys)
         )
         SELECT kv.key AS key,
                LENGTH(kv.value) AS raw_size,
                kv.value = @chunk_marker AS has_marker,
                EXISTS (
                    SELECT 1 FROM chunk_manifest_publications p
                    WHERE p.manifest_key = kv.key
                ) AS is_protected,
                meta.chunk_count AS metadata_chunk_count,
                meta.logical_size AS logical_size,
                meta.logical_sha256 AS logical_sha256,
                revision.source_revision AS source_revision,
                revision.verified_revision AS verified_revision,
                COUNT(manifest.seq) AS manifest_count,
                COUNT(chunk.hash) AS present_chunk_count,
                MIN(manifest.seq) AS min_seq,
                MAX(manifest.seq) AS max_seq,
                COALESCE(SUM(LENGTH(chunk.data)), 0) AS stored_size
           FROM requested
           JOIN kv ON kv.key = requested.key
           LEFT JOIN chunk_manifest_meta meta ON meta.manifest_key = kv.key
           LEFT JOIN chunk_manifest_inventory_revision revision
                  ON revision.manifest_key = kv.key
           LEFT JOIN manifest_chunks manifest ON manifest.manifest_key = kv.key
           LEFT JOIN chunks chunk ON chunk.hash = manifest.hash
          GROUP BY kv.key`,
    );
    const markVerifiedInventory = db.prepare(
        `UPDATE chunk_manifest_inventory_revision
            SET verified_revision = source_revision
          WHERE manifest_key = ? AND source_revision = ?`,
    );
    const markVerifiedContent = db.prepare(
        `UPDATE chunk_manifest_inventory_revision
            SET content_verified_revision = source_revision
          WHERE manifest_key = ? AND source_revision = ?`,
    );
    const insertVerifiedInventory = db.prepare(
        `INSERT OR IGNORE INTO chunk_manifest_inventory_revision
            (manifest_key, source_revision, verified_revision)
         VALUES (?, 0, 0)`,
    );
    const insertVerifiedContent = db.prepare(
        `INSERT OR IGNORE INTO chunk_manifest_inventory_revision
            (manifest_key, source_revision, verified_revision, content_verified_revision)
         VALUES (?, 0, NULL, 0)`,
    );
    const deleteInventoryRevision = db.prepare(
        'DELETE FROM chunk_manifest_inventory_revision WHERE manifest_key = ?',
    );
    const selSnapshotCosts = db.prepare(
        `WITH reference_counts AS (
             SELECT hash, COUNT(DISTINCT manifest_key) AS owner_count
               FROM manifest_chunks
              GROUP BY hash
         ), requested_hashes AS (
             SELECT DISTINCT manifest_key, hash
               FROM manifest_chunks
              WHERE manifest_key LIKE @pattern ESCAPE '\\'
         ), exclusive_costs AS (
             SELECT requested.manifest_key AS manifest_key,
                    COALESCE(SUM(LENGTH(chunk.data)), 0) AS exclusive_size
               FROM requested_hashes requested
               JOIN reference_counts refs ON refs.hash = requested.hash
                                         AND refs.owner_count = 1
               JOIN chunks chunk ON chunk.hash = requested.hash
              GROUP BY requested.manifest_key
         )
         SELECT kv.key AS key,
                LENGTH(kv.value) AS raw_size,
                kv.value = @chunk_marker AS has_marker,
                EXISTS (
                    SELECT 1 FROM chunk_manifest_publications publication
                    WHERE publication.manifest_key = kv.key
                ) AS is_protected,
                COALESCE(exclusive.exclusive_size, 0) AS exclusive_size,
                meta.chunk_count AS metadata_chunk_count,
                meta.logical_size AS logical_size,
                meta.logical_sha256 AS logical_sha256,
                revision.source_revision AS source_revision,
                revision.verified_revision AS verified_revision
           FROM kv
           LEFT JOIN exclusive_costs exclusive ON exclusive.manifest_key = kv.key
           LEFT JOIN chunk_manifest_meta meta ON meta.manifest_key = kv.key
           LEFT JOIN chunk_manifest_inventory_revision revision
                  ON revision.manifest_key = kv.key
          WHERE kv.key LIKE @pattern ESCAPE '\\'`,
    );
    // Physical bytes that deleting one manifest would make unreachable. Count
    // each chunk hash once even if repeated within the logical value.
    const selExclusive = db.prepare(
        `SELECT COALESCE(SUM(LENGTH(c.data)), 0) AS n FROM chunks c
         WHERE EXISTS (
             SELECT 1 FROM manifest_chunks own
             WHERE own.manifest_key = ? AND own.hash = c.hash
         )
           AND NOT EXISTS (
             SELECT 1 FROM manifest_chunks other
             WHERE other.manifest_key <> ? AND other.hash = c.hash
         )`,
    );
    const copyManifest = db.prepare(
        'INSERT INTO manifest_chunks (manifest_key, seq, hash) SELECT ?, seq, hash FROM manifest_chunks WHERE manifest_key = ?',
    );
    const copyManifestMeta = db.prepare(
        `INSERT INTO chunk_manifest_meta (manifest_key, chunk_count, logical_size, logical_sha256)
         SELECT ?, chunk_count, logical_size, logical_sha256
         FROM chunk_manifest_meta WHERE manifest_key = ?`,
    );
    const copyManifestPublication = db.prepare(
        `INSERT INTO chunk_manifest_publications (manifest_key)
         SELECT ? WHERE EXISTS (
             SELECT 1 FROM chunk_manifest_publications WHERE manifest_key = ?
         )`,
    );
    const kvSet = db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    const kvGet = db.prepare('SELECT value FROM kv WHERE key = ?');
    const kvDel = db.prepare('DELETE FROM kv WHERE key = ?');
    // Defensive self-heal: drop any manifest that is not backed by a live chunked
    // kv row — i.e. the key is gone OR its value is no longer the marker (some
    // path wrote a raw value over it). Either way the manifest is stale and would
    // pin its chunks forever; sweeping these first lets the damage be reclaimed.
    const gcStaleManifests = db.prepare(
        `DELETE FROM manifest_chunks WHERE NOT EXISTS (
             SELECT 1 FROM kv WHERE kv.key = manifest_chunks.manifest_key AND kv.value = ?)`,
    );
    const gcStaleManifestMeta = db.prepare(
        `DELETE FROM chunk_manifest_meta WHERE NOT EXISTS (
             SELECT 1 FROM kv WHERE kv.key = chunk_manifest_meta.manifest_key AND kv.value = ?
         ) OR NOT EXISTS (
             SELECT 1 FROM manifest_chunks
             WHERE manifest_chunks.manifest_key = chunk_manifest_meta.manifest_key
         )`,
    );
    const gcStaleManifestPublications = db.prepare(
        `DELETE FROM chunk_manifest_publications WHERE NOT EXISTS (
             SELECT 1 FROM kv
             WHERE kv.key = chunk_manifest_publications.manifest_key AND kv.value = ?
         )`,
    );
    // Mark-sweep: the set of all hashes referenced by ANY manifest (live + every
    // snapshot/backup) is the live set; anything else is unreachable. Recomputed
    // from manifest_chunks each run — stateless, self-healing, can't over-delete.
    const gcSweep = db.prepare('DELETE FROM chunks WHERE hash NOT IN (SELECT hash FROM manifest_chunks)');
    // Bytes gc would reclaim right now: chunks referenced by no marker-backed
    // (live) manifest. Counts true orphans + chunks held only by stale manifests.
    // The kv check is correlated on key (PK lookup per manifest key, ~6 keys), NOT
    // `value IN (SELECT … WHERE value = ?)` which full-scans every kv blob (seconds
    // on a DB with thousands of assets, blocking the synchronous event loop).
    const selReclaimable = db.prepare(
        `SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM chunks WHERE hash NOT IN
         (SELECT hash FROM manifest_chunks mc
          WHERE EXISTS (SELECT 1 FROM kv WHERE kv.key = mc.manifest_key AND kv.value = ?))`,
    );

    function markCurrentContentVerified(key) {
        const revision = selContentRevision.get(key) ?? null;
        if (Number.isSafeInteger(revision?.source_revision)
            && revision.source_revision >= 0) {
            markVerifiedContent.run(key, revision.source_revision);
            return revision.source_revision;
        }
        insertVerifiedContent.run(key);
        return selContentRevision.get(key)?.source_revision ?? null;
    }

    function storedChunkForPublication(chunk) {
        const inserted = insChunk.run(chunk.hash, chunk.data);
        if (inserted.changes === 1) return chunk.data;
        const stored = selChunk.get(chunk.hash)?.data;
        if (!Buffer.isBuffer(stored)
            || stored.length <= 0 || stored.length > MAX_SIZE
            || crypto.createHash('sha256').update(stored).digest('hex') !== chunk.hash) {
            throw chunkCorruption(`Stored chunk ${chunk.hash} failed publish-time verification`);
        }
        return stored;
    }

    // Atomic: clearing the old manifest, inserting new chunks, and writing the
    // marker all commit together. Orphaned chunks from a prior version are left
    // for GC (a later layer) — never deleted here.
    const putValueTransaction = db.transaction((key, value) => {
        delManifestPublication.run(key);
        delManifest.run(key);
        delManifestMeta.run(key);
        if (value.length <= threshold) {
            kvSet.run(key, value, Date.now());
            deleteInventoryRevision.run(key);
            return { verifiedRevision: null, sha256: null, size: value.length, chunked: false };
        }
        const logicalHash = crypto.createHash('sha256');
        const chunks = splitBuffer(value, logicalHash);
        writeMetrics.cdcPasses++;
        writeMetrics.logicalDigestPasses++;
        let logicalSize = 0;
        for (let i = 0; i < chunks.length; i++) {
            const stored = storedChunkForPublication(chunks[i]);
            insManifest.run(key, i, chunks[i].hash);
            logicalSize += stored.length;
        }
        if (logicalSize !== value.length) {
            throw chunkCorruption(`Stored chunks for ${key} failed publish-time length verification`);
        }
        const sha256 = logicalHash.digest('hex');
        insManifestMeta.run(
            key,
            chunks.length,
            logicalSize,
            sha256,
        );
        insManifestPublication.run(key);
        kvSet.run(key, CHUNK_MARKER, Date.now());
        return {
            verifiedRevision: markCurrentContentVerified(key),
            sha256,
            size: logicalSize,
            chunked: true,
        };
    });

    function putValue(key, value) {
        const result = putValueTransaction(key, value);
        if (Number.isSafeInteger(result.verifiedRevision)) {
            contentVerificationMemo.remember(key, result.verifiedRevision);
        } else {
            contentVerificationMemo.forget(key);
        }
        return result;
    }

    function readFileRange(fd, length, position) {
        const buffer = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
            const bytesRead = fs.readSync(fd, buffer, offset, length - offset, position + offset);
            if (bytesRead === 0) {
                throw new Error(`Unexpected end of file at byte ${position + offset}`);
            }
            offset += bytesRead;
        }
        return buffer;
    }

    // Keep only one CDC window resident while producing the same chunks and
    // manifest as putValue. A raw value still needs one Buffer for SQLite's
    // direct-row bind, but values above the threshold never become monolithic.
    function fileIdentity(stat) {
        return {
            size: stat.size,
            dev: String(stat.dev),
            ino: String(stat.ino),
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
        };
    }

    function assertPreparedFilePlan(plan, stat) {
        if (!plan || plan.version !== 1
            || !Number.isSafeInteger(plan.size) || plan.size < 0
            || plan.size !== stat.size
            || !/^[0-9a-f]{64}$/.test(plan.sha256 ?? '')
            || !Array.isArray(plan.chunks)
            || JSON.stringify(plan.identity) !== JSON.stringify(fileIdentity(stat))) {
            throw new Error('Prepared chunk plan no longer matches its private spool');
        }
        let position = 0;
        for (const chunk of plan.chunks) {
            if (!Number.isSafeInteger(chunk?.offset) || chunk.offset !== position
                || !Number.isSafeInteger(chunk.length) || chunk.length <= 0
                || chunk.length > MAX_SIZE
                || !/^[0-9a-f]{64}$/.test(chunk.hash ?? '')) {
                throw new Error('Prepared chunk plan is structurally invalid');
            }
            position += chunk.length;
        }
        if (position !== plan.size || (plan.size > 0) !== (plan.chunks.length > 0)) {
            throw new Error('Prepared chunk plan has an invalid logical length');
        }
    }

    function storedPreparedChunkForPublication(chunk) {
        const inserted = insChunk.run(chunk.hash, chunk.data);
        if (inserted.changes === 1) return chunk.data;
        const stored = selChunk.get(chunk.hash)?.data;
        // The worker already performed SHA-256. Exact comparison preserves the
        // publish-time collision/corruption guard without repeating crypto on
        // the event loop.
        if (!Buffer.isBuffer(stored) || !stored.equals(chunk.data)) {
            throw chunkCorruption(`Stored chunk ${chunk.hash} failed prepared publication verification`);
        }
        return stored;
    }

    const putValueFromFileTransaction = db.transaction((key, filePath, preparedPlan = null) => {
        const fd = fs.openSync(filePath, 'r');
        try {
            const stat = fs.fstatSync(fd);
            const size = stat.size;
            if (preparedPlan) assertPreparedFilePlan(preparedPlan, stat);
            delManifestPublication.run(key);
            delManifest.run(key);
            delManifestMeta.run(key);
            if (size <= threshold) {
                const value = readFileRange(fd, size, 0);
                kvSet.run(key, value, Date.now());
                deleteInventoryRevision.run(key);
                return {
                    verifiedRevision: null,
                    sha256: preparedPlan?.sha256
                        ?? crypto.createHash('sha256').update(value).digest('hex'),
                    size,
                    chunked: false,
                };
            }

            let position = 0;
            let sequence = 0;
            let sha256;
            if (preparedPlan) {
                writeMetrics.preparedFilePublications++;
                for (const planned of preparedPlan.chunks) {
                    const data = readFileRange(fd, planned.length, planned.offset);
                    const stored = storedPreparedChunkForPublication({
                        hash: planned.hash,
                        data,
                    });
                    insManifest.run(key, sequence++, planned.hash);
                    if (stored.length !== planned.length) {
                        throw chunkCorruption(`Stored chunk ${planned.hash} changed logical length`);
                    }
                    position += planned.length;
                }
                sha256 = preparedPlan.sha256;
            } else {
                writeMetrics.synchronousFileFallbacks++;
                const logicalHash = crypto.createHash('sha256');
                writeMetrics.cdcPasses++;
                writeMetrics.logicalDigestPasses++;
                while (position < size) {
                    const window = readFileRange(fd, Math.min(MAX_SIZE, size - position), position);
                    const chunk = cdcSplit(window)[0];
                    logicalHash.update(chunk.data);
                    const stored = storedChunkForPublication(chunk);
                    insManifest.run(key, sequence++, chunk.hash);
                    if (stored.length !== chunk.data.length) {
                        throw chunkCorruption(`Stored chunk ${chunk.hash} changed logical length`);
                    }
                    position += chunk.data.length;
                }
                sha256 = logicalHash.digest('hex');
            }
            if (position !== size) {
                throw chunkCorruption(`Stored chunks for ${key} failed publish-time length verification`);
            }
            insManifestMeta.run(key, sequence, size, sha256);
            insManifestPublication.run(key);
            kvSet.run(key, CHUNK_MARKER, Date.now());
            return {
                verifiedRevision: markCurrentContentVerified(key),
                sha256,
                size,
                chunked: true,
            };
        } finally {
            fs.closeSync(fd);
        }
    });

    function putValueFromFile(key, filePath, options = {}) {
        const result = putValueFromFileTransaction(key, filePath, options.chunkPlan ?? null);
        if (Number.isSafeInteger(result.verifiedRevision)) {
            contentVerificationMemo.remember(key, result.verifiedRevision);
        } else {
            contentVerificationMemo.forget(key);
        }
        return result;
    }

    function getValue(key) {
        const row = kvGet.get(key);
        if (!row) return null;
        const state = publicationState(key, isChunked(row.value));
        if (!state.chunked) return row.value;
        let warm = state.revision?.content_verified_revision === state.revision?.source_revision
            && contentVerificationMemo.has(key, state.revision?.source_revision);
        if (warm && !hasCheapContentStructure(state)) warm = false;
        if (!warm) contentMetrics.fullVerificationAttempts += 1;
        const logicalHash = warm ? null : crypto.createHash('sha256');
        const output = Buffer.allocUnsafe(state.metadata.logical_size);
        contentMetrics.preallocatedReads += 1;
        let size = 0;
        const entries = selManifest.all(key);
        for (let index = 0; index < state.inventory.chunk_count; index++) {
            const entry = entries[index];
            const chunk = entry ? selChunk.get(entry.hash)?.data : null;
            let hashMatches = true;
            if (!warm && Buffer.isBuffer(chunk)) {
                contentMetrics.chunkDigestComputations += 1;
                hashMatches = crypto.createHash('sha256').update(chunk).digest('hex')
                    === entry?.hash;
            }
            if (!entry || entry.seq !== index
                || !/^[0-9a-f]{64}$/.test(entry.hash) || !Buffer.isBuffer(chunk)
                || chunk.length <= 0 || chunk.length > MAX_SIZE
                || !hashMatches) {
                throw chunkCorruption(`Protected chunk manifest ${key} has an invalid row at ${index}`);
            }
            if (size + chunk.length > output.length) {
                throw chunkCorruption(`Protected chunk manifest ${key} failed logical verification`);
            }
            chunk.copy(output, size);
            size += chunk.length;
            logicalHash?.update(chunk);
        }
        if (size !== state.metadata.logical_size
            || (!warm && logicalHash.digest('hex') !== state.metadata.logical_sha256)) {
            throw chunkCorruption(`Protected chunk manifest ${key} failed logical verification`);
        }
        if (warm) {
            contentMetrics.warmReads += 1;
        } else {
            contentMetrics.fullVerifications += 1;
            publishReadContentVerification(key, state.revision);
        }
        return output;
    }

    function getValueAsync(key) {
        const existing = inFlightReads.get(key);
        if (existing) {
            contentMetrics.singleFlightJoins += 1;
            return existing;
        }
        contentMetrics.singleFlightStarts += 1;
        const read = new Promise((resolve, reject) => {
            setImmediate(() => {
                try {
                    resolve(getValue(key));
                } catch (error) {
                    reject(error);
                }
            });
        });
        inFlightReads.set(key, read);
        read.finally(() => {
            if (inFlightReads.get(key) === read) inFlightReads.delete(key);
        }).catch(() => {});
        return read;
    }

    async function writeAll(fileHandle, data) {
        let offset = 0;
        while (offset < data.length) {
            const result = await fileHandle.write(data, offset, data.length - offset);
            if (result.bytesWritten <= 0) throw new Error('Snapshot spool write made no progress');
            offset += result.bytesWritten;
        }
    }

    const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

    function streamError(message, code = 'KV_CHUNK_CORRUPT') {
        if (code === 'KV_CHUNK_CORRUPT') return chunkCorruption(message);
        const error = new Error(message);
        error.code = code;
        return error;
    }

    function publicationState(key, hasMarker) {
        if (!hasMarker) return { chunked: false, metadata: null, inventory: null };
        const protectedPublication = !!selManifestPublication.get(key);
        const hasManifest = !!selManifestExists.get(key);
        const metadata = selManifestMeta.get(key) ?? null;
        if (!protectedPublication) {
            if (hasManifest || metadata) {
                throw chunkCorruption(`Chunk manifest ${key} has inconsistent protection state`);
            }
            // The marker bytes themselves remain a valid legacy raw value.
            return { chunked: false, metadata: null, inventory: null };
        }
        if (!hasManifest || !metadata) {
            throw chunkCorruption(`Protected chunk manifest ${key} is incomplete`);
        }
        const inventory = selManifestStreamMetadata.get(key);
        if (!Number.isSafeInteger(inventory.chunk_count) || inventory.chunk_count <= 0
            || inventory.min_seq !== 0 || inventory.max_seq !== inventory.chunk_count - 1
            || !Number.isSafeInteger(metadata.chunk_count) || metadata.chunk_count <= 0
            || !Number.isSafeInteger(metadata.logical_size) || metadata.logical_size <= 0
            || !/^[0-9a-f]{64}$/.test(metadata.logical_sha256)
            || metadata.chunk_count !== inventory.chunk_count) {
            throw chunkCorruption(`Protected chunk manifest ${key} metadata is invalid`);
        }
        return {
            chunked: true,
            metadata,
            inventory,
            revision: selContentRevision.get(key) ?? null,
        };
    }

    function hasCheapContentStructure(state) {
        return state.inventory.present_chunk_count === state.metadata.chunk_count
            && state.inventory.stored_size === state.metadata.logical_size
            && Number.isSafeInteger(state.inventory.min_chunk_size)
            && state.inventory.min_chunk_size > 0
            && Number.isSafeInteger(state.inventory.max_chunk_size)
            && state.inventory.max_chunk_size <= MAX_SIZE
            && state.inventory.invalid_hash_count === 0;
    }

    function publishReadContentVerification(key, selectedRevision) {
        if (Number.isSafeInteger(selectedRevision?.source_revision)
            && selectedRevision.source_revision >= 0) {
            markVerifiedContent.run(key, selectedRevision.source_revision);
        } else {
            insertVerifiedContent.run(key);
        }
        const current = selContentRevision.get(key) ?? null;
        if (Number.isSafeInteger(current?.source_revision)
            && current.source_revision >= 0
            && current.content_verified_revision === current.source_revision
            && (
                !Number.isSafeInteger(selectedRevision?.source_revision)
                || selectedRevision.source_revision === current.source_revision
            )) {
            contentVerificationMemo.remember(key, current.source_revision);
        }
    }

    /**
     * Older databases have manifests but no publication metadata. Upgrade
     * those rows exactly once, in one transaction, before declaring the store
     * protected. Every key is verified independently: valid publications get
     * canonical metadata, while a corrupt marker-backed publication gets only
     * the durable publication guard. The latter deliberately has no metadata,
     * so every logical API continues to reject it after restart without one bad
     * snapshot preventing the server from recovering through an older key.
     */
    const migrateLegacyManifestMetadata = db.transaction(() => {
        if ((selManifestProtection.get()?.version ?? 0) >= 2) return;
        for (const { manifest_key: key } of selManifestKeys.all()) {
            const row = selValueStreamMetadata.get({ key, chunk_marker: CHUNK_MARKER });
            // Ignore stale manifests and raw rows; GC owns those. A marker with
            // manifest rows is the only representation this migration protects.
            if (!row?.has_chunk_marker) continue;
            try {
                const inventory = selManifestStreamMetadata.get(key);
                if (!Number.isSafeInteger(inventory.chunk_count) || inventory.chunk_count <= 0
                    || inventory.min_seq !== 0 || inventory.max_seq !== inventory.chunk_count - 1) {
                    throw streamError(`Legacy chunk manifest ${key} has an incomplete sequence`);
                }
                const logicalHash = crypto.createHash('sha256');
                let logicalSize = 0;
                for (let index = 0; index < inventory.chunk_count; index++) {
                    const part = selManifestPart.get({ key, seq: index });
                    if (!part || part.seq !== index
                        || !Number.isSafeInteger(part.stored_size)
                        || part.stored_size <= 0 || part.stored_size > MAX_SIZE
                        || !/^[0-9a-f]{64}$/.test(part.hash)) {
                        throw streamError(`Legacy chunk manifest ${key} has an invalid row at ${index}`);
                    }
                    const chunkRow = selChunkDataPart.get({ hash: part.hash, read_length: MAX_SIZE });
                    if (!Buffer.isBuffer(chunkRow?.data)
                        || chunkRow.data.length !== part.stored_size
                        || crypto.createHash('sha256').update(chunkRow.data).digest('hex') !== part.hash) {
                        throw streamError(`Legacy chunk manifest ${key} failed chunk verification at ${index}`);
                    }
                    logicalSize += chunkRow.data.length;
                    if (!Number.isSafeInteger(logicalSize)) {
                        throw streamError(`Legacy chunk manifest ${key} exceeds the safe size range`);
                    }
                    logicalHash.update(chunkRow.data);
                }
                const digest = logicalHash.digest('hex');
                const prior = selManifestMeta.get(key);
                if (prior && (
                    prior.chunk_count !== inventory.chunk_count
                    || prior.logical_size !== logicalSize
                    || prior.logical_sha256 !== digest
                )) {
                    throw streamError(`Legacy chunk manifest ${key} metadata does not match its chunks`);
                }
                insManifestMeta.run(key, inventory.chunk_count, logicalSize, digest);
            } catch (error) {
                if (error?.code !== 'KV_CHUNK_CORRUPT') throw error;
                // Publication without metadata is the durable protected-corrupt
                // state. Never retain legacy metadata that could bless damage.
                delManifestMeta.run(key);
            }
            insManifestPublication.run(key);
        }
        insManifestProtection.run();
    });

    migrateLegacyManifestMetadata();

    const sizeInventoryMetrics = {
        fastSizeHits: 0,
        authoritativeSizeDerivations: 0,
        fastListingQueries: 0,
        aggregateListingQueries: 0,
        snapshotAggregateQueries: 0,
    };

    function publishVerifiedInventory(row) {
        if (Number.isSafeInteger(row?.source_revision) && row.source_revision >= 0) {
            markVerifiedInventory.run(row.key, row.source_revision);
        } else {
            // Upgrade or deliberately removed derivative row: the authoritative
            // aggregate just verified this exact publication. INSERT OR IGNORE
            // cannot bless a concurrent trigger-created newer revision.
            insertVerifiedInventory.run(row.key);
        }
    }

    function authoritativeSize(key) {
        sizeInventoryMetrics.authoritativeSizeDerivations += 1;
        const escaped = key.replace(/[\\%_]/g, '\\$&');
        const row = selKvPrefixAggregateSizes.all({
            chunk_marker: CHUNK_MARKER,
            pattern: escaped,
        }).find((entry) => entry.key === key);
        if (!row) return null;
        const size = sizeFromAggregateRow(row);
        if (row.has_marker && row.is_protected) publishVerifiedInventory(row);
        return size;
    }

    /**
     * Iterate one logical value in bounded storage pages. A rejected iterator
     * may already have yielded bytes, so consumers must publish only after the
     * iterator completes successfully (writeValueToFile does this by deleting
     * its private partial file on every failure).
     */
    async function* iterateValue(key, options = {}) {
        const row = selValueStreamMetadata.get({ key, chunk_marker: CHUNK_MARKER });
        if (!row) return;
        const shouldAbort = () => options.signal?.aborted || options.shouldAbort?.() || false;
        const throwIfAborted = () => {
            if (shouldAbort()) throw streamError('KV value stream cancelled', 'KV_STREAM_ABORTED');
        };
        let size = 0;
        let chunks = 0;
        const yieldPart = async function* (data) {
            await yieldToEventLoop();
            throwIfAborted();
            size += data.length;
            chunks++;
            yield data;
            await yieldToEventLoop();
            throwIfAborted();
        };
        throwIfAborted();
        const state = publicationState(key, !!row.has_chunk_marker);
        if (state.chunked) {
            let warm = state.revision?.content_verified_revision === state.revision?.source_revision
                && contentVerificationMemo.has(key, state.revision?.source_revision);
            if (warm && !hasCheapContentStructure(state)) warm = false;
            if (!warm) contentMetrics.fullVerificationAttempts += 1;
            const logicalHash = warm ? null : crypto.createHash('sha256');
            const inventory = state.inventory;
            const expected = state.metadata;
            for (let index = 0; index < inventory.chunk_count; index++) {
                throwIfAborted();
                // One completed statement per part: unlike .iterate(), no
                // better-sqlite cursor remains open while consumers yield.
                const part = selManifestPart.get({ key, seq: index });
                if (!part || part.seq !== index
                    || !Number.isSafeInteger(part.stored_size)
                    || part.stored_size <= 0 || part.stored_size > MAX_SIZE) {
                    throw streamError(`Chunk manifest row ${index} is missing or has an invalid size`);
                }
                if (!/^[0-9a-f]{64}$/.test(part.hash)) {
                    throw streamError(`Chunk manifest row ${index} has a non-canonical hash`);
                }
                const chunkRow = selChunkDataPart.get({ hash: part.hash, read_length: MAX_SIZE });
                if (!Buffer.isBuffer(chunkRow?.data)
                    || chunkRow.data.length !== part.stored_size) {
                    throw streamError(`Chunk manifest row ${index} is missing or truncated`);
                }
                if (!warm) {
                    contentMetrics.chunkDigestComputations += 1;
                    if (crypto.createHash('sha256').update(chunkRow.data).digest('hex') !== part.hash) {
                        throw streamError(`Chunk manifest row ${index} failed canonical hash verification`);
                    }
                    logicalHash.update(chunkRow.data);
                }
                yield* yieldPart(chunkRow.data);
            }
            const actualHash = logicalHash?.digest('hex') ?? null;
            if (chunks !== expected.chunk_count
                || size !== expected.logical_size
                || (!warm && actualHash !== expected.logical_sha256)) {
                throw streamError('Chunk manifest logical length or hash does not match its publication');
            }
            if (warm) {
                contentMetrics.warmReads += 1;
            } else {
                contentMetrics.fullVerifications += 1;
                publishReadContentVerification(key, state.revision);
            }
            return;
        }

        if (!Number.isSafeInteger(row.raw_size) || row.raw_size < 0) {
            throw streamError('Raw KV value has an invalid size');
        }
        let offset = 0;
        while (offset < row.raw_size) {
            throwIfAborted();
            const part = selRawValuePart.get({
                key,
                offset: offset + 1,
                length: Math.min(MAX_SIZE, row.raw_size - offset),
            });
            const data = part?.data;
            if (!Buffer.isBuffer(data) || data.length <= 0 || data.length > MAX_SIZE) {
                throw streamError(`Raw KV value is missing bytes at offset ${offset}`);
            }
            yield* yieldPart(data);
            offset += data.length;
        }
    }

    /**
     * Spool one logical value without reassembling its chunk manifest. At most
     * one stored chunk is handed to JavaScript at a time; incomplete files are
     * removed on cancellation, read errors, and write errors.
     */
    async function writeValueToFile(key, filePath, options = {}) {
        const row = selValueStreamMetadata.get({ key, chunk_marker: CHUNK_MARKER });
        if (!row) return null;
        const fileHandle = await fs.promises.open(filePath, 'wx');
        let size = 0;
        let chunks = 0;
        let maxChunkBytes = 0;
        try {
            for await (const data of iterateValue(key, options)) {
                await writeAll(fileHandle, data);
                size += data.length;
                chunks++;
                maxChunkBytes = Math.max(maxChunkBytes, data.length);
                options.onBytes?.(data);
                options.onChunk?.({ index: chunks - 1, size: data.length });
            }
            if (chunks === 0 && row.raw_size > 0) {
                throw streamError(`KV value ${key} changed before streaming began`);
            }
            await fileHandle.close();
            return { filePath, size, chunks, maxChunkBytes };
        } catch (error) {
            try { await fileHandle.close(); } catch {}
            try { await fs.promises.unlink(filePath); } catch {}
            throw error;
        }
    }

    function sizeValue(key) {
        const row = selVerifiedSize.get({ key, chunk_marker: CHUNK_MARKER });
        if (!row) return null;
        if (!row.has_marker) return row.raw_size;
        if (hasCurrentVerifiedInventory(row)) {
            sizeInventoryMetrics.fastSizeHits += 1;
            return row.logical_size;
        }
        return authoritativeSize(key);
    }

    // Enumerate logical payload sizes without reassembling chunk bodies. This
    // mirrors createSnapshotReader.kvListWithSizes for the live connection.
    function listValuesWithSizes(prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        const parameters = { chunk_marker: CHUNK_MARKER, pattern: `${escaped}%` };
        sizeInventoryMetrics.fastListingQueries += 1;
        const fastRows = selKvPrefixVerifiedSizes.all(parameters);
        if (fastRows.every((row) => !row.has_marker || hasCurrentVerifiedInventory(row))) {
            return fastRows.map((row) => ({
                key: row.key,
                size: row.has_marker ? row.logical_size : row.raw_size,
            }));
        }

        sizeInventoryMetrics.aggregateListingQueries += 1;
        const rows = selKvPrefixAggregateSizes.all(parameters);
        return rows.map((row) => {
            const size = sizeFromAggregateRow(row);
            if (row.has_marker && row.is_protected) publishVerifiedInventory(row);
            return { key: row.key, size };
        });
    }

    function listValuesWithSizesForKeys(keys) {
        if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
            throw new TypeError('KV size inventory keys must be strings');
        }
        if (keys.length === 0) return [];
        const parameters = {
            chunk_marker: CHUNK_MARKER,
            keys: JSON.stringify(keys),
        };
        sizeInventoryMetrics.fastListingQueries += 1;
        const fastRows = selSelectedVerifiedSizes.all(parameters);
        if (fastRows.every((row) => !row.has_marker || hasCurrentVerifiedInventory(row))) {
            return fastRows.map((row) => ({
                key: row.key,
                size: row.has_marker ? row.logical_size : row.raw_size,
            }));
        }
        sizeInventoryMetrics.aggregateListingQueries += 1;
        return selSelectedAggregateSizes.all(parameters).map((row) => {
            const size = sizeFromAggregateRow(row);
            if (row.has_marker && row.is_protected) publishVerifiedInventory(row);
            return { key: row.key, size };
        });
    }

    // Aggregate every requested snapshot in one reference-count pass. The old
    // caller executed one correlated NOT EXISTS anti-join per snapshot. Logical
    // sizes are obtained through the same revision-bound verified inventory used
    // by kvSize/listing, so corruption still falls back to the full derivation.
    function listSnapshotCostsExclusive(prefix) {
        const logicalSizes = new Map(
            listValuesWithSizes(prefix).map((entry) => [entry.key, entry.size]),
        );
        if (logicalSizes.size === 0) return [];
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        sizeInventoryMetrics.snapshotAggregateQueries += 1;
        const rows = selSnapshotCosts.all({
            chunk_marker: CHUNK_MARKER,
            pattern: `${escaped}%`,
        });
        for (const row of rows) {
            if (row.has_marker && row.is_protected && !hasCurrentVerifiedInventory(row)) {
                // The publication moved between the inventory and footprint
                // statements. Re-derive once; never serve a cost bound to stale
                // metadata.
                const logicalSize = authoritativeSize(row.key);
                if (logicalSize !== null) logicalSizes.set(row.key, logicalSize);
            }
        }
        const finalRows = rows.some((row) => (
            row.has_marker && row.is_protected && !hasCurrentVerifiedInventory(row)
        ))
            ? selSnapshotCosts.all({
                chunk_marker: CHUNK_MARKER,
                pattern: `${escaped}%`,
            })
            : rows;
        return finalRows.map((row) => {
            if (row.has_marker && row.is_protected && !hasCurrentVerifiedInventory(row)) {
                throw chunkCorruption(`Protected chunk manifest ${row.key} changed during accounting`);
            }
            const logicalSize = logicalSizes.get(row.key);
            if (!Number.isSafeInteger(logicalSize) || logicalSize < 0) {
                throw chunkCorruption(`Snapshot ${row.key} changed during accounting`);
            }
            return {
                key: row.key,
                size: row.has_marker && row.is_protected ? row.exclusive_size : row.raw_size,
                logicalSize,
            };
        });
    }

    // Bytes deleting this key would free after chunk GC. Raw values own their row;
    // chunked values own only chunks referenced by no other manifest.
    function snapshotCostExclusive(key) {
        const row = kvGet.get(key);
        if (!row) return 0;
        const state = publicationState(key, isChunked(row.value));
        if (!state.chunked) return row.value.length;
        if (selSize.get(key).n !== state.metadata.logical_size) {
            throw chunkCorruption(`Protected chunk manifest ${key} has missing chunk bytes`);
        }
        return selExclusive.get(key, key).n;
    }

    // Copy src's value to dst. For a chunked src, only the manifest (list of
    // chunk hashes) is copied — chunks stay shared, so a snapshot costs ~nothing
    // and never duplicates bytes. Mirrors kvCopyValue: missing src is a no-op.
    const snapshotValueTransaction = db.transaction((srcKey, dstKey) => {
        const row = kvGet.get(srcKey);
        if (!row) return;
        const state = publicationState(srcKey, isChunked(row.value));
        if (state.chunked && selSize.get(srcKey).n !== state.metadata.logical_size) {
            throw chunkCorruption(`Protected chunk manifest ${srcKey} has missing chunk bytes`);
        }
        delManifestPublication.run(dstKey);
        delManifest.run(dstKey);
        delManifestMeta.run(dstKey);
        if (state.chunked) {
            copyManifest.run(dstKey, srcKey);
            copyManifestMeta.run(dstKey, srcKey);
            copyManifestPublication.run(dstKey, srcKey);
            kvSet.run(dstKey, CHUNK_MARKER, Date.now());
        } else {
            kvSet.run(dstKey, row.value, Date.now());
            deleteInventoryRevision.run(dstKey);
        }
    });

    function snapshotValue(srcKey, dstKey) {
        snapshotValueTransaction(srcKey, dstKey);
        // Manifest copies do not hash their exact stored bytes. A destination
        // therefore stays cold even when its source happened to be warm.
        contentVerificationMemo.forget(dstKey);
    }

    // Remove a key entirely (its manifest + kv row). Chunks it referenced
    // become orphans, reclaimed by the next gc(). Used for snapshot rotation.
    const dropValueTransaction = db.transaction((key) => {
        delManifestPublication.run(key);
        delManifest.run(key);
        delManifestMeta.run(key);
        kvDel.run(key);
        deleteInventoryRevision.run(key);
    });

    function dropValue(key) {
        dropValueTransaction(key);
        contentVerificationMemo.forget(key);
    }

    // Reclaim unreferenced chunks. Returns the number deleted. Run opportunistically
    // (e.g. Optimize / periodic) — never on the hot save path.
    function gc() {
        gcStaleManifestPublications.run(CHUNK_MARKER);
        gcStaleManifests.run(CHUNK_MARKER);
        gcStaleManifestMeta.run(CHUNK_MARKER);
        return gcSweep.run().changes;
    }

    function reclaimableBytes() {
        return selReclaimable.get(CHUNK_MARKER).b;
    }

    // True only when the key is actually stored chunked right now (its kv value
    // is the marker) — not merely when a manifest exists. A raw value that
    // overwrote the marker (manifest not yet swept) reads as not-chunked.
    function isChunkedKey(key) {
        const row = kvGet.get(key);
        return !!row && publicationState(key, isChunked(row.value)).chunked;
    }

    return {
        putValue,
        putValueFromFile,
        getValue,
        getValueAsync,
        iterateValue,
        writeValueToFile,
        sizeValue,
        listValuesWithSizes,
        listValuesWithSizesForKeys,
        listSnapshotCostsExclusive,
        snapshotCostExclusive,
        snapshotValue,
        dropValue,
        gc,
        reclaimableBytes,
        isChunkedKey,
        contentVerificationMemo,
        contentReadMetrics: () => ({ ...contentMetrics }),
        sizeInventoryMetrics: () => ({ ...sizeInventoryMetrics }),
        writeMetrics: () => ({ ...writeMetrics }),
    };
}

module.exports = {
    cdcSplit,
    createChunkStore,
    createSnapshotReader,
    isChunkableKey,
    CHUNK_MARKER,
    normalizeThreshold,
};
