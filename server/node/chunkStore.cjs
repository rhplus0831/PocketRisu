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
function cdcSplit(buf) {
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
        chunks.push({ hash, data });
        start = cut;
    }
    return chunks;
}

// Sentinel stored in kv.value for a chunked key. kv.value is NOT NULL, so a
// chunked row holds this marker instead of an empty value; the real bytes live
// in the chunks table, ordered by manifest_chunks. A legacy raw value never
// equals this 13-byte sentinel, so reads stay backward-compatible.
const CHUNK_MARKER = Buffer.from('\x00RISUCHUNKED\x00', 'binary');
const DEFAULT_THRESHOLD = 16 * 1024 * 1024; // values larger than this get chunked

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
    return typeof key === 'string'
        && (key === 'database/database.bin'
            || key.startsWith('database/dbbackup-')
            || key.startsWith('chats/')
            || key.startsWith('pluginsave/'));
}

function isChunked(value) {
    return Buffer.isBuffer(value) && value.equals(CHUNK_MARKER);
}

// Read-only chunk-aware bindings for a pinned SQLite snapshot. Keep this
// separate from createChunkStore so readonly connections prepare no writes.
function createSnapshotReader(db) {
    const selKv = db.prepare(
        `SELECT value, EXISTS (
             SELECT 1 FROM chunk_manifest_publications p WHERE p.manifest_key = kv.key
         ) AS is_protected FROM kv WHERE key = ?`,
    );
    const selKvList = db.prepare('SELECT key FROM kv');
    const selKvPrefix = db.prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'`);
    const selKvPrefixSizes = db.prepare(
        `SELECT key, LENGTH(value) AS size, value = @chunkMarker AS has_marker, EXISTS (
             SELECT 1 FROM chunk_manifest_publications p WHERE p.manifest_key = kv.key
         ) AS is_protected
         FROM kv WHERE key LIKE @pattern ESCAPE '\\'`,
    );
    const selManifest = db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq');
    const selChunk = db.prepare('SELECT data FROM chunks WHERE hash = ?');
    const selManifestExists = db.prepare('SELECT 1 FROM manifest_chunks WHERE manifest_key = ? LIMIT 1');
    const selManifestMeta = db.prepare(
        'SELECT chunk_count, logical_size, logical_sha256 FROM chunk_manifest_meta WHERE manifest_key = ?',
    );
    const selManifestInventory = db.prepare(
        'SELECT COUNT(*) AS chunk_count, MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM manifest_chunks WHERE manifest_key = ?',
    );
    const selManifestPublication = db.prepare(
        'SELECT 1 FROM chunk_manifest_publications WHERE manifest_key = ?',
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
            const rows = selManifest.all(key);
            const logicalHash = crypto.createHash('sha256');
            let size = 0;
            const parts = rows.map((entry, index) => {
                const chunk = selChunk.get(entry.hash)?.data;
                if (!/^[0-9a-f]{64}$/.test(entry.hash) || !Buffer.isBuffer(chunk)
                    || chunk.length <= 0 || chunk.length > MAX_SIZE
                    || crypto.createHash('sha256').update(chunk).digest('hex') !== entry.hash) {
                    throw chunkCorruption(`Protected chunk manifest ${key} has an invalid row at ${index}`);
                }
                size += chunk.length;
                logicalHash.update(chunk);
                return chunk;
            });
            if (size !== metadata.logical_size
                || logicalHash.digest('hex') !== metadata.logical_sha256) {
                throw chunkCorruption(`Protected chunk manifest ${key} failed logical verification`);
            }
            return Buffer.concat(parts);
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
        return selKvPrefixSizes.all({
            chunkMarker: CHUNK_MARKER,
            pattern: `${escaped}%`,
        }).map((row) => {
            if (!row.has_marker) return { key: row.key, size: row.size };
            if (!row.is_protected) {
                if (selManifestExists.get(row.key) || selManifestMeta.get(row.key)) {
                    throw chunkCorruption(`Chunk manifest ${row.key} has inconsistent protection state`);
                }
                return { key: row.key, size: row.size };
            }
            const metadata = selManifestMeta.get(row.key);
            const inventory = selManifestInventory.get(row.key);
            const size = selSize.get(row.key).n;
            if (!metadata || inventory.chunk_count !== metadata.chunk_count
                || inventory.min_seq !== 0 || inventory.max_seq !== inventory.chunk_count - 1
                || size !== metadata.logical_size) {
                throw chunkCorruption(`Protected chunk manifest ${row.key} is incomplete`);
            }
            return { key: row.key, size };
        });
    }

    return { kvGet, kvList, kvListWithSizes };
}

// Bind chunk-aware get/put to a specific better-sqlite3 instance. db.cjs wires
// the real DB; tests wire a :memory: DB. The kv table must already exist (it is
// db.cjs's schema); this creates only the chunk/manifest tables.
function createChunkStore(db, opts = {}) {
    const threshold = normalizeThreshold(opts.threshold);

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
    `);

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
    const selManifest = db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq');
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
        `SELECT COUNT(*) AS chunk_count, MIN(seq) AS min_seq, MAX(seq) AS max_seq
         FROM manifest_chunks WHERE manifest_key = ?`,
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
    const selKvPrefixSizes = db.prepare(
        `SELECT key, LENGTH(value) AS size, value = @chunkMarker AS has_marker, EXISTS (
             SELECT 1 FROM chunk_manifest_publications p WHERE p.manifest_key = kv.key
         ) AS is_protected
         FROM kv WHERE key LIKE @pattern ESCAPE '\\'`,
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

    // Atomic: clearing the old manifest, inserting new chunks, and writing the
    // marker all commit together. Orphaned chunks from a prior version are left
    // for GC (a later layer) — never deleted here.
    const putValue = db.transaction((key, value) => {
        delManifest.run(key);
        delManifestMeta.run(key);
        delManifestPublication.run(key);
        if (value.length <= threshold) {
            kvSet.run(key, value, Date.now());
            return;
        }
        const chunks = cdcSplit(value);
        for (const c of chunks) insChunk.run(c.hash, c.data);
        for (let i = 0; i < chunks.length; i++) insManifest.run(key, i, chunks[i].hash);
        insManifestMeta.run(
            key,
            chunks.length,
            value.length,
            crypto.createHash('sha256').update(value).digest('hex'),
        );
        insManifestPublication.run(key);
        kvSet.run(key, CHUNK_MARKER, Date.now());
    });

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
    const putValueFromFile = db.transaction((key, filePath) => {
        const fd = fs.openSync(filePath, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            delManifest.run(key);
            delManifestMeta.run(key);
            delManifestPublication.run(key);
            if (size <= threshold) {
                kvSet.run(key, readFileRange(fd, size, 0), Date.now());
                return;
            }

            let position = 0;
            let sequence = 0;
            const logicalHash = crypto.createHash('sha256');
            while (position < size) {
                const window = readFileRange(fd, Math.min(MAX_SIZE, size - position), position);
                const chunk = cdcSplit(window)[0];
                insChunk.run(chunk.hash, chunk.data);
                insManifest.run(key, sequence++, chunk.hash);
                logicalHash.update(chunk.data);
                position += chunk.data.length;
            }
            insManifestMeta.run(key, sequence, size, logicalHash.digest('hex'));
            insManifestPublication.run(key);
            kvSet.run(key, CHUNK_MARKER, Date.now());
        } finally {
            fs.closeSync(fd);
        }
    });

    function getValue(key) {
        const row = kvGet.get(key);
        if (!row) return null;
        const state = publicationState(key, isChunked(row.value));
        if (!state.chunked) return row.value;
        const logicalHash = crypto.createHash('sha256');
        let size = 0;
        const parts = selManifest.all(key).map((entry, index) => {
            const chunk = selChunk.get(entry.hash)?.data;
            if (!/^[0-9a-f]{64}$/.test(entry.hash) || !Buffer.isBuffer(chunk)
                || chunk.length <= 0 || chunk.length > MAX_SIZE
                || crypto.createHash('sha256').update(chunk).digest('hex') !== entry.hash) {
                throw chunkCorruption(`Protected chunk manifest ${key} has an invalid row at ${index}`);
            }
            size += chunk.length;
            logicalHash.update(chunk);
            return chunk;
        });
        if (size !== state.metadata.logical_size
            || logicalHash.digest('hex') !== state.metadata.logical_sha256) {
            throw chunkCorruption(`Protected chunk manifest ${key} failed logical verification`);
        }
        return Buffer.concat(parts);
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
        return { chunked: true, metadata, inventory };
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

    /**
     * Spool one logical value without reassembling its chunk manifest. At most
     * one stored chunk is handed to JavaScript at a time; incomplete files are
     * removed on cancellation, read errors, and write errors.
     */
    async function writeValueToFile(key, filePath, options = {}) {
        // Metadata is fetched without selecting the BLOB.  In particular, a
        // legacy raw 100 MiB row must not be copied into V8 merely to discover
        // whether it is chunked.
        const row = selValueStreamMetadata.get({ key, chunk_marker: CHUNK_MARKER });
        if (!row) return null;
        const shouldAbort = () => options.signal?.aborted || options.shouldAbort?.() || false;
        const throwIfAborted = () => {
            if (shouldAbort()) throw streamError('KV value stream cancelled', 'KV_STREAM_ABORTED');
        };
        const fileHandle = await fs.promises.open(filePath, 'wx');
        let size = 0;
        let chunks = 0;
        let maxChunkBytes = 0;
        const logicalHash = crypto.createHash('sha256');
        const writePart = async (data) => {
            // A macrotask yield on both sides is deliberate: socket close and
            // AbortController events must be observable while a large snapshot
            // is copied, rather than only after a synchronous SQLite iterator
            // has exhausted every row.
            await yieldToEventLoop();
            throwIfAborted();
            await writeAll(fileHandle, data);
            size += data.length;
            chunks++;
            maxChunkBytes = Math.max(maxChunkBytes, data.length);
            logicalHash.update(data);
            options.onChunk?.({ index: chunks - 1, size: data.length });
            await yieldToEventLoop();
            throwIfAborted();
        };
        try {
            throwIfAborted();
            const state = publicationState(key, !!row.has_chunk_marker);
            if (state.chunked) {
                const inventory = state.inventory;
                const expected = state.metadata;
                for (let index = 0; index < inventory.chunk_count; index++) {
                    throwIfAborted();
                    // One completed statement per part: unlike .iterate(), no
                    // better-sqlite cursor remains open while file I/O yields.
                    const part = selManifestPart.get({
                        key,
                        seq: index,
                    });
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
                    if (crypto.createHash('sha256').update(chunkRow.data).digest('hex') !== part.hash) {
                        throw streamError(`Chunk manifest row ${index} failed canonical hash verification`);
                    }
                    await writePart(chunkRow.data);
                }
                const actualHash = logicalHash.digest('hex');
                if (expected && (
                    chunks !== expected.chunk_count
                    || size !== expected.logical_size
                    || actualHash !== expected.logical_sha256
                )) {
                    throw streamError('Chunk manifest logical length or hash does not match its publication');
                }
            } else {
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
                    await writePart(data);
                    offset += data.length;
                }
                // Empty values still create an exact empty spool, without an
                // artificial zero-length callback/part.
                if (row.raw_size === 0) logicalHash.digest('hex');
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
        const row = kvGet.get(key);
        if (!row) return null;
        const state = publicationState(key, isChunked(row.value));
        if (state.chunked) {
            const size = selSize.get(key).n;
            if (size !== state.metadata.logical_size) {
                throw chunkCorruption(`Protected chunk manifest ${key} has missing chunk bytes`);
            }
            return size;
        }
        return row.value.length;
    }

    // Enumerate logical payload sizes without reassembling chunk bodies. This
    // mirrors createSnapshotReader.kvListWithSizes for the live connection.
    function listValuesWithSizes(prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        return selKvPrefixSizes.all({
            chunkMarker: CHUNK_MARKER,
            pattern: `${escaped}%`,
        }).map((row) => {
            const state = publicationState(row.key, !!row.has_marker);
            if (!state.chunked) return { key: row.key, size: row.size };
            const size = selSize.get(row.key).n;
            if (size !== state.metadata.logical_size) {
                throw chunkCorruption(`Protected chunk manifest ${row.key} has missing chunk bytes`);
            }
            return { key: row.key, size };
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
    const snapshotValue = db.transaction((srcKey, dstKey) => {
        const row = kvGet.get(srcKey);
        if (!row) return;
        const state = publicationState(srcKey, isChunked(row.value));
        if (state.chunked && selSize.get(srcKey).n !== state.metadata.logical_size) {
            throw chunkCorruption(`Protected chunk manifest ${srcKey} has missing chunk bytes`);
        }
        delManifest.run(dstKey);
        delManifestMeta.run(dstKey);
        delManifestPublication.run(dstKey);
        if (state.chunked) {
            copyManifest.run(dstKey, srcKey);
            copyManifestMeta.run(dstKey, srcKey);
            copyManifestPublication.run(dstKey, srcKey);
            kvSet.run(dstKey, CHUNK_MARKER, Date.now());
        } else {
            kvSet.run(dstKey, row.value, Date.now());
        }
    });

    // Remove a key entirely (its manifest + kv row). Chunks it referenced
    // become orphans, reclaimed by the next gc(). Used for snapshot rotation.
    const dropValue = db.transaction((key) => {
        delManifest.run(key);
        delManifestMeta.run(key);
        delManifestPublication.run(key);
        kvDel.run(key);
    });

    // Reclaim unreferenced chunks. Returns the number deleted. Run opportunistically
    // (e.g. Optimize / periodic) — never on the hot save path.
    function gc() {
        gcStaleManifests.run(CHUNK_MARKER);
        gcStaleManifestMeta.run(CHUNK_MARKER);
        gcStaleManifestPublications.run(CHUNK_MARKER);
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
        writeValueToFile,
        sizeValue,
        listValuesWithSizes,
        snapshotCostExclusive,
        snapshotValue,
        dropValue,
        gc,
        reclaimableBytes,
        isChunkedKey,
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
