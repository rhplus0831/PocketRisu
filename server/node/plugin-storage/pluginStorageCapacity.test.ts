import { describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbModulePath = path.resolve(process.cwd(), 'server/node/db/db.cjs')

describe('optimized plugin storage capacity', () => {
    test('chunks rows, accounts logical bytes atomically, and clears manifests', () => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-plugin-capacity-'))
        try {
            const script = String.raw`
                const store = require(process.argv[1]);
                const marker = Buffer.from('\x00RISUCHUNKED\x00', 'binary');
                const a = 'pluginsave/YQ.json';
                const b = 'pluginsave/Yg.json';
                const c = 'pluginsave/Yw.json';
                const first = Buffer.alloc(5000, 0x61);
                const second = Buffer.alloc(2500, 0x62);
                store.kvSet(a, first);
                store.kvSet(b, second);
                const rawMarker = store.db.prepare('SELECT value FROM kv WHERE key = ?').get(a).value.equals(marker);
                const manifestCount = store.db.prepare('SELECT COUNT(*) n FROM manifest_chunks WHERE manifest_key = ?').get(a).n;
                const byKey = (x, y) => x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
                const liveSizes = store.kvListWithSizes('pluginsave/').sort(byKey);
                const snapshot = store.createKvSnapshot();
                const snapshotSizes = snapshot.kvListWithSizes('pluginsave/').sort(byKey);
                snapshot.close();

                let aggregateError;
                try { store.kvSet(a, Buffer.alloc(6000, 0x78)); }
                catch (error) { aggregateError = { code: error.code, limit: error.limit, actual: error.actual }; }
                let valueError;
                try { store.kvSet(c, Buffer.alloc(6001, 0x79)); }
                catch (error) { valueError = { code: error.code, limit: error.limit, actual: error.actual }; }
                const preservedA = store.kvGet(a).equals(first);

                let rollbackUsage;
                try {
                    store.db.transaction(() => {
                        store.kvSet(c, Buffer.alloc(400, 0x63));
                        throw new Error('rollback');
                    })();
                } catch {}
                rollbackUsage = store.getPluginStorageUsage();
                const rollbackKey = store.kvGet(c);

                store.kvDelPrefix('pluginsave/');
                const remainingManifest = store.db.prepare(
                    "SELECT COUNT(*) n FROM manifest_chunks WHERE manifest_key LIKE 'pluginsave/%'"
                ).get().n;
                const finalUsage = store.getPluginStorageUsage();
                console.log(JSON.stringify({
                    rawMarker,
                    manifestCount,
                    liveSizes,
                    snapshotSizes,
                    aggregateError,
                    valueError,
                    preservedA,
                    rollbackUsage,
                    rollbackKey,
                    remainingManifest,
                    finalUsage,
                }));
                store.db.close();
            `
            const stdout = execFileSync(process.execPath, ['-e', script, dbModulePath], {
                cwd: workDir,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    POCKETRISU_CHUNK_THRESHOLD: '1024',
                    POCKETRISU_PLUGIN_VALUE_MAX_BYTES: '6000',
                    POCKETRISU_PLUGIN_STORAGE_MAX_BYTES: '8000',
                },
            })
            const result = JSON.parse(stdout.trim().split('\n').at(-1) as string)

            expect(result.rawMarker).toBe(true)
            expect(result.manifestCount).toBeGreaterThan(0)
            expect(result.liveSizes).toEqual([
                { key: 'pluginsave/YQ.json', size: 5000 },
                { key: 'pluginsave/Yg.json', size: 2500 },
            ])
            expect(result.snapshotSizes).toEqual(result.liveSizes)
            expect(result.aggregateError).toEqual({
                code: 'PLUGIN_STORAGE_TOTAL_TOO_LARGE',
                limit: 8000,
                actual: 8500,
            })
            expect(result.valueError).toEqual({
                code: 'PLUGIN_VALUE_TOO_LARGE',
                limit: 6000,
                actual: 6001,
            })
            expect(result.preservedA).toBe(true)
            expect(result.rollbackUsage).toBe(7500)
            expect(result.rollbackKey).toBeNull()
            expect(result.remainingManifest).toBe(0)
            expect(result.finalUsage).toBe(0)
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true })
        }
    })
})
