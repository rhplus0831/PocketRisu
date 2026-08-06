import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbModulePath = path.resolve(process.cwd(), 'server/node/db/db.cjs')

describe('db list-delta wrappers', () => {
    it('tracks logical deletes, escapes prefixes, clears tombstones on every write, and rotates epochs', () => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-list-delta-'))
        try {
            const script = String.raw`
                const store = require(process.argv[1]);
                const b = (value) => Buffer.from(value);

                store.kvSet('literal%/one', b('1'));
                store.kvSet('literalX/one', b('2'));
                store.kvSet('literal_/two', b('3'));
                store.kvSet('literalY/two', b('4'));
                const percentModified = store.kvListModifiedSince(0, 'literal%/').sort();
                const underscoreModified = store.kvListModifiedSince(0, 'literal_/').sort();

                store.kvSet('bulk%/delete', b('5'));
                store.kvSet('bulkX/keep', b('6'));
                store.kvDelPrefix('bulk%/');
                const bulkDeleted = store.kvGetDeletedSince(0, 'bulk%/').sort();
                const bulkRemaining = store.kvList('bulk').sort();

                store.kvDel('filesystem-only');
                const filesystemDeleteRecorded = store.kvGetDeletedSince(0, 'filesystem-only');

                store.kvSet('assets/live', b('legacy'));
                store.kvDel('assets/live');
                store.kvClearDeletion('assets/live');
                const liveFileTombstones = store.kvGetDeletedSince(0, 'assets/live');

                store.kvDel('chats/chunked');
                store.kvSet('chats/chunked', b('chunked bytes'));
                const chunkTombstones = store.kvGetDeletedSince(0, 'chats/chunked');
                const chunkValue = store.kvGet('chats/chunked').toString('utf8');

                const firstEpoch = store.kvGetListEpoch();
                const secondEpoch = store.kvBumpListEpoch();
                const persistedEpoch = store.kvGetListEpoch();
                const kvIndexes = store.db.prepare("PRAGMA index_list('kv')")
                    .all().map((row) => row.name);
                const modifiedPlan = store.db.prepare(
                    "EXPLAIN QUERY PLAN SELECT key FROM kv INDEXED BY idx_kv_updated_at_key "
                    + "WHERE updated_at >= ? AND key LIKE ? ESCAPE '\\\\'"
                ).all(0, 'literal%');

                console.log(JSON.stringify({
                    percentModified,
                    underscoreModified,
                    bulkDeleted,
                    bulkRemaining,
                    filesystemDeleteRecorded,
                    liveFileTombstones,
                    chunkTombstones,
                    chunkValue,
                    firstEpoch,
                    secondEpoch,
                    persistedEpoch,
                    kvIndexes,
                    modifiedPlan,
                }));
                store.db.close();
            `
            const stdout = execFileSync(process.execPath, ['-e', script, dbModulePath], {
                cwd: workDir,
                encoding: 'utf8',
                env: { ...process.env, POCKETRISU_CHUNK_THRESHOLD: '1' },
            })
            const result = JSON.parse(stdout.trim().split('\n').at(-1) as string)

            expect(result.percentModified).toEqual(['literal%/one'])
            expect(result.underscoreModified).toEqual(['literal_/two'])
            expect(result.bulkDeleted).toEqual(['bulk%/delete'])
            expect(result.bulkRemaining).toEqual(['bulkX/keep'])
            expect(result.filesystemDeleteRecorded).toEqual(['filesystem-only'])
            expect(result.liveFileTombstones).toEqual([])
            expect(result.chunkTombstones).toEqual([])
            expect(result.chunkValue).toBe('chunked bytes')
            expect(result.firstEpoch).toMatch(/^[0-9a-f-]{36}$/)
            expect(result.secondEpoch).not.toBe(result.firstEpoch)
            expect(result.persistedEpoch).toBe(result.secondEpoch)
            expect(result.kvIndexes).toContain('idx_kv_updated_at_key')
            expect(result.modifiedPlan).toHaveLength(1)
            expect(result.modifiedPlan[0].detail).toContain('idx_kv_updated_at_key')
            expect(result.modifiedPlan[0].detail).not.toMatch(/^SCAN kv\b/)
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true })
        }
    })
})
