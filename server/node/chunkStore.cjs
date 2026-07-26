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
    const selKv = db.prepare('SELECT value FROM kv WHERE key = ?');
    const selKvList = db.prepare('SELECT key FROM kv');
    const selKvPrefix = db.prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'`);
    const selKvPrefixSizes = db.prepare(
        `SELECT key, LENGTH(value) AS size, value = @chunkMarker AS is_chunked
         FROM kv WHERE key LIKE @pattern ESCAPE '\\'`,
    );
    const selManifest = db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq');
    const selChunk = db.prepare('SELECT data FROM chunks WHERE hash = ?');
    const selSize = db.prepare(
        'SELECT SUM(LENGTH(c.data)) AS n FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash WHERE m.manifest_key = ?',
    );
    function kvGet(key) {
        const row = selKv.get(key);
        if (!row) return null;
        if (isChunked(row.value)) {
            const rows = selManifest.all(key);
            if (rows.length === 0) return row.value;
            return Buffer.concat(rows.map((entry) => selChunk.get(entry.hash).data));
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
        }).map((row) => ({
            key: row.key,
            size: row.is_chunked ? (selSize.get(row.key).n ?? row.size) : row.size,
        }));
    }

    return { kvGet, kvList, kvListWithSizes };
}

// Bind chunk-aware get/put to a specific better-sqlite3 instance. db.cjs wires
// the real DB; tests wire a :memory: DB. The kv table must already exist (it is
// db.cjs's schema); this creates only the chunk/manifest tables.
function createChunkStore(db, opts = {}) {
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

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
    `);

    const insChunk = db.prepare('INSERT OR IGNORE INTO chunks (hash, data) VALUES (?, ?)');
    const delManifest = db.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ?');
    const insManifest = db.prepare('INSERT INTO manifest_chunks (manifest_key, seq, hash) VALUES (?, ?, ?)');
    const selManifest = db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq');
    const selManifestExists = db.prepare('SELECT 1 FROM manifest_chunks WHERE manifest_key = ? LIMIT 1');
    const selChunk = db.prepare('SELECT data FROM chunks WHERE hash = ?');
    const selSize = db.prepare(
        'SELECT SUM(LENGTH(c.data)) AS n FROM manifest_chunks m JOIN chunks c ON c.hash = m.hash WHERE m.manifest_key = ?',
    );
    const selKvPrefixSizes = db.prepare(
        `SELECT key, LENGTH(value) AS size, value = @chunkMarker AS is_chunked
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
        if (value.length <= threshold) {
            kvSet.run(key, value, Date.now());
            return;
        }
        const chunks = cdcSplit(value);
        for (const c of chunks) insChunk.run(c.hash, c.data);
        for (let i = 0; i < chunks.length; i++) insManifest.run(key, i, chunks[i].hash);
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
            if (size <= threshold) {
                kvSet.run(key, readFileRange(fd, size, 0), Date.now());
                return;
            }

            let position = 0;
            let sequence = 0;
            while (position < size) {
                const window = readFileRange(fd, Math.min(MAX_SIZE, size - position), position);
                const chunk = cdcSplit(window)[0];
                insChunk.run(chunk.hash, chunk.data);
                insManifest.run(key, sequence++, chunk.hash);
                position += chunk.data.length;
            }
            kvSet.run(key, CHUNK_MARKER, Date.now());
        } finally {
            fs.closeSync(fd);
        }
    });

    function getValue(key) {
        const row = kvGet.get(key);
        if (!row) return null;
        if (isChunked(row.value)) {
            const rows = selManifest.all(key);
            // A real chunked key always has manifest rows. If a non-chunked value
            // happens to equal the marker byte-for-byte (astronomically unlikely),
            // there are none — return it raw instead of an empty buffer. No extra
            // cost for real chunked keys: they need this manifest lookup anyway.
            if (rows.length === 0) return row.value;
            return Buffer.concat(rows.map((r) => selChunk.get(r.hash).data));
        }
        return row.value;
    }

    function sizeValue(key) {
        const row = kvGet.get(key);
        if (!row) return null;
        if (isChunked(row.value)) return selSize.get(key).n ?? row.value.length;
        return row.value.length;
    }

    // Enumerate logical payload sizes without reassembling chunk bodies. This
    // mirrors createSnapshotReader.kvListWithSizes for the live connection.
    function listValuesWithSizes(prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        return selKvPrefixSizes.all({
            chunkMarker: CHUNK_MARKER,
            pattern: `${escaped}%`,
        }).map((row) => ({
            key: row.key,
            size: row.is_chunked ? (selSize.get(row.key).n ?? row.size) : row.size,
        }));
    }

    // Bytes deleting this key would free after chunk GC. Raw values own their row;
    // chunked values own only chunks referenced by no other manifest.
    function snapshotCostExclusive(key) {
        const row = kvGet.get(key);
        if (!row) return 0;
        if (!isChunked(row.value) || !selManifestExists.get(key)) return row.value.length;
        return selExclusive.get(key, key).n;
    }

    // Copy src's value to dst. For a chunked src, only the manifest (list of
    // chunk hashes) is copied — chunks stay shared, so a snapshot costs ~nothing
    // and never duplicates bytes. Mirrors kvCopyValue: missing src is a no-op.
    const snapshotValue = db.transaction((srcKey, dstKey) => {
        const row = kvGet.get(srcKey);
        if (!row) return;
        delManifest.run(dstKey);
        if (isChunked(row.value)) {
            copyManifest.run(dstKey, srcKey);
            kvSet.run(dstKey, CHUNK_MARKER, Date.now());
        } else {
            kvSet.run(dstKey, row.value, Date.now());
        }
    });

    // Remove a key entirely (its manifest + kv row). Chunks it referenced
    // become orphans, reclaimed by the next gc(). Used for snapshot rotation.
    const dropValue = db.transaction((key) => {
        delManifest.run(key);
        kvDel.run(key);
    });

    // Reclaim unreferenced chunks. Returns the number deleted. Run opportunistically
    // (e.g. Optimize / periodic) — never on the hot save path.
    function gc() {
        gcStaleManifests.run(CHUNK_MARKER);
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
        return !!row && isChunked(row.value);
    }

    return {
        putValue,
        putValueFromFile,
        getValue,
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
};
