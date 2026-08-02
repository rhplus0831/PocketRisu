import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import chunkStorePkg from './chunkStore.cjs'
import streamBackupPkg from './streamBackupRisuSave.cjs'
import streamSavePkg from './streamRisuSave.cjs'
import utilsPkg from './utils.cjs'

const execFileAsync = promisify(execFile)
const { createChunkStore, createSnapshotReader } = chunkStorePkg as {
    createChunkStore: (db: Database.Database, opts?: { threshold?: number }) => {
        putValue: (key: string, value: Buffer) => void
        dropValue: (key: string) => void
    }
    createSnapshotReader: (db: Database.Database) => {
        kvGet: (key: string) => Buffer | null
        kvList: (prefix?: string) => string[]
        kvListWithSizes: (prefix: string) => Array<{ key: string; size: number }>
    }
}
const { streamRisuSaveToFile } = streamSavePkg as {
    streamRisuSaveToFile: (options: {
        dbObj: Record<string, unknown>
        filePath: string
        readChatRow: (chaId: string, chatId: string) => Promise<unknown> | unknown
        onMissingChatRow?: (chaId: string, chatId: string) => Promise<void> | void
    }) => Promise<{ filePath: string; size: number }>
}
const { streamBackupRisuSaveToFile } = streamBackupPkg as {
    streamBackupRisuSaveToFile: (options: Record<string, unknown>) => Promise<{
        filePath: string
        size: number
    }>
}
const { decodeRisuSave, encodeRisuSaveLegacy } = utilsPkg as {
    decodeRisuSave: (value: Buffer) => Promise<any>
    encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}

const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempPath(name: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'risu-backup-snapshot-'))
    tempDirs.push(dir)
    return path.join(dir, name)
}

function createKvSchema(db: Database.Database): void {
    db.exec(
        'CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)',
    )
}

describe('backup snapshot assembly', () => {
    test('automatic snapshot existence is probed through verified metadata, not database kvGet', async () => {
        const source = await readFile(path.resolve(import.meta.dirname, 'server.cjs'), 'utf8')
        const captureStart = source.indexOf('async function captureAutomaticSnapshotSource')
        const assemblyStart = source.indexOf('async function assembleAutomaticSnapshotSource')
        expect(captureStart).toBeGreaterThanOrEqual(0)
        expect(assemblyStart).toBeGreaterThan(captureStart)
        const captureSource = source.slice(captureStart, assemblyStart)
        expect(captureSource).toContain('snapshot.kvGetSnapshotSourceToken()')
        expect(captureSource).toContain('sourceToken.databaseSize')
        expect(captureSource).not.toMatch(/kvGet\([^)]*database\/database\.bin/)
    })

    test('pinned source-to-source assembly preserves the legacy snapshot bytes', async () => {
        const chaId = 'byte-character'
        const chatId = 'byte-chat'
        const callId = 'remembered-call'
        const mcpSuffix = `${Buffer.from(callId, 'utf8').toString('base64url')}.json`
        const graph = {
            characters: [{
                chaId,
                name: 'Character',
                chats: [{ id: chatId, name: 'Stub name', _stub: true, folderId: 'folder' }],
            }],
            optimizePluginMemory: true,
            pluginStorageGeneration: 'generation-byte-test',
            pluginCustomStorage: {},
            pluginStorageMeta: {},
        }
        const fullChat = {
            id: chatId,
            name: 'Full name',
            message: [{
                role: 'assistant',
                data: `<tool_call>${callId}\uf100payload</tool_call>`,
            }],
            scriptstate: { exact: true },
        }
        const rowValues: Record<string, unknown> = {
            'plugin-value': { nested: ['same', 42, true] },
            'plugin-meta': { plugin: 'owner' },
            'mcp-row': {
                call: { id: callId, name: 'lookup' },
                response: [{ type: 'text', text: 'remembered' }],
            },
        }
        const pluginStorage = {
            valueRows: [{ key: 'alpha', source: 'plugin-value' }],
            metaRows: [{ key: 'alpha', source: 'plugin-meta' }],
            readRow: (source: string) => rowValues[source],
        }
        const mcpToolCalls = {
            rows: [{ key: mcpSuffix, source: 'mcp-row' }],
            readRow: (source: string) => rowValues[source],
        }
        const legacyPath = await tempPath('legacy.risudat')
        await streamRisuSaveToFile({
            dbObj: graph,
            filePath: legacyPath,
            readChatRow: () => fullChat,
            pluginStorage,
            mcpToolCalls,
            markPluginStorageFolded: true,
        } as any)

        const sourcePath = await tempPath('database.risudat')
        const chatPath = await tempPath('chat.risudat')
        const valuePaths = new Map<string, { filePath: string; size: number }>()
        await writeFile(sourcePath, Buffer.from(encodeRisuSaveLegacy(graph)))
        await writeFile(chatPath, Buffer.from(encodeRisuSaveLegacy(fullChat)))
        for (const [source, value] of Object.entries(rowValues)) {
            const filePath = await tempPath(`${source}.json`)
            const bytes = Buffer.from(JSON.stringify(value), 'utf8')
            await writeFile(filePath, bytes)
            valuePaths.set(source, { filePath, size: bytes.length })
        }
        const streamedPath = await tempPath('streamed.risudat')
        await streamBackupRisuSaveToFile({
            databaseSource: {
                filePath: sourcePath,
                size: (await readFile(sourcePath)).length,
            },
            filePath: streamedPath,
            tempDir: path.dirname(streamedPath),
            readChatRowSource: () => ({
                filePath: chatPath,
                size: Buffer.from(encodeRisuSaveLegacy(fullChat)).length,
            }),
            pluginStorage: {
                valueRows: pluginStorage.valueRows,
                metaRows: pluginStorage.metaRows,
                readRowSource: (source: string) => valuePaths.get(source),
            },
            mcpToolCalls: {
                rows: mcpToolCalls.rows,
                readRowSource: (source: string) => valuePaths.get(source),
            },
            markPluginStorageFolded: true,
            canonicalJsonEncoding: true,
        })

        expect(await readFile(streamedPath)).toEqual(await readFile(legacyPath))
    })

    test('createKvSnapshot reads raw and chunked values from its pinned WAL snapshot', async () => {
        const cwd = await mkdtemp(path.join(tmpdir(), 'risu-kv-snapshot-'))
        tempDirs.push(cwd)
        const dbModule = path.resolve(import.meta.dirname, 'db.cjs')
        const script = String.raw`
            const { db, kvGet, kvSet, kvDel, kvList, createKvSnapshot, checkpointWal } = require(process.argv[1]);
            const oldChunk = Buffer.alloc(200000, 0x41);
            const newChunk = Buffer.alloc(200000, 0x42);
            kvSet('raw/value', Buffer.from('before'));
            kvSet('database/database.bin', oldChunk);
            kvSet('deleted/value', Buffer.from('present'));
            kvSet('literal%_\\/one', Buffer.from('escaped'));
            const snapshot = createKvSnapshot();
            kvSet('raw/value', Buffer.from('after'));
            kvSet('database/database.bin', newChunk);
            kvDel('deleted/value');
            kvSet('new/value', Buffer.from('later'));
            kvSet('literalXX/other', Buffer.from('not-a-prefix-match'));
            const result = {
                raw: snapshot.kvGet('raw/value').toString(),
                chunk: snapshot.kvGet('database/database.bin').equals(oldChunk),
                deleted: snapshot.kvGet('deleted/value').toString(),
                added: snapshot.kvGet('new/value'),
                escapedList: snapshot.kvList('literal%_\\/'),
                escapedSizes: snapshot.kvListWithSizes('literal%_\\/'),
                chunkSizes: snapshot.kvListWithSizes('database/'),
            };
            snapshot.close();
            snapshot.close();
            result.checkpoint = checkpointWal('TRUNCATE');
            result.liveRaw = kvGet('raw/value').toString();
            result.liveChunk = kvGet('database/database.bin').equals(newChunk);
            result.liveKeys = kvList('new/');
            db.close();
            console.log(JSON.stringify(result));
        `
        const { stdout } = await execFileAsync(process.execPath, ['-e', script, dbModule], {
            cwd,
            env: { ...process.env, POCKETRISU_CHUNK_THRESHOLD: '1024' },
        })
        const result = JSON.parse(stdout.trim().split('\n').at(-1)!)

        expect(result).toMatchObject({
            raw: 'before',
            chunk: true,
            deleted: 'present',
            added: null,
            escapedList: ['literal%_\\/one'],
            escapedSizes: [{ key: 'literal%_\\/one', size: 7 }],
            chunkSizes: [{ key: 'database/database.bin', size: 200000 }],
            liveRaw: 'after',
            liveChunk: true,
            liveKeys: ['new/value'],
        })
        expect(result.checkpoint).toEqual([
            expect.objectContaining({ busy: 0 }),
        ])
    })

    test('a row deleted after graph capture is still complete in the produced archive', async () => {
        const dbPath = await tempPath('race.db')
        const outputPath = await tempPath('race.risudat')
        const writer = new Database(dbPath)
        writer.pragma('journal_mode = WAL')
        createKvSchema(writer)
        const store = createChunkStore(writer, { threshold: 1024 })
        const chaId = 'character-race'
        const chatId = 'chat-race'
        const chatKey = `chats/${encodeURIComponent(chaId)}/${encodeURIComponent(chatId)}`
        const stub = { id: chatId, name: 'Before', _stub: true }
        const fullChat = {
            id: chatId,
            name: 'Payload name',
            message: [{ role: 'user', data: 'pre-delete payload' }],
            scriptstate: { retained: true },
        }
        const oldGraph = { characters: [{ chaId, name: 'Character', chats: [stub] }] }
        const newGraph = { characters: [{ chaId, name: 'Character', chats: [] }] }
        store.putValue('database/database.bin', Buffer.from(encodeRisuSaveLegacy(oldGraph)))
        store.putValue(chatKey, Buffer.from(encodeRisuSaveLegacy(fullChat)))

        const snapshotDb = new Database(dbPath, { readonly: true })
        snapshotDb.pragma('busy_timeout = 5000')
        snapshotDb.exec('BEGIN')
        snapshotDb.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()
        const reader = createSnapshotReader(snapshotDb)
        const capturedGraph = await decodeRisuSave(reader.kvGet('database/database.bin')!)

        let resumeRowRead!: () => void
        let rowReadReached!: () => void
        const rowReadGate = new Promise<void>((resolve) => { resumeRowRead = resolve })
        const rowReadStarted = new Promise<void>((resolve) => { rowReadReached = resolve })
        const spool = streamRisuSaveToFile({
            dbObj: capturedGraph,
            filePath: outputPath,
            readChatRow: async (readChaId, readChatId) => {
                rowReadReached()
                await rowReadGate
                const value = reader.kvGet(
                    `chats/${encodeURIComponent(readChaId)}/${encodeURIComponent(readChatId)}`,
                )
                return value === null ? null : decodeRisuSave(value)
            },
        })

        await rowReadStarted
        writer.transaction(() => {
            store.dropValue(chatKey)
            store.putValue('database/database.bin', Buffer.from(encodeRisuSaveLegacy(newGraph)))
        })()
        resumeRowRead()

        await spool
        const archiveDatabase = await decodeRisuSave(await readFile(outputPath))
        const archivedChat = archiveDatabase.characters[0].chats[0]
        expect(archivedChat).toMatchObject({
            id: chatId,
            name: 'Before',
            message: [{ role: 'user', data: 'pre-delete payload' }],
            scriptstate: { retained: true },
        })
        expect(archivedChat._stub).toBeUndefined()
        expect(archiveDatabase.characters[0].chats).not.toContainEqual(
            expect.objectContaining({ _stub: true }),
        )

        snapshotDb.exec('ROLLBACK')
        snapshotDb.close()
        writer.close()
    })

    test('missing rows fail safe by default while snapshot rotation mode preserves the stub', async () => {
        const chaId = 'damaged-character'
        const chatId = 'missing-chat'
        const graph = {
            characters: [{
                chaId,
                chats: [{ id: chatId, name: 'Damaged', _stub: true }],
            }],
        }
        const failedPath = await tempPath('missing-failed.risudat')
        await expect(streamRisuSaveToFile({
            dbObj: graph,
            filePath: failedPath,
            readChatRow: () => null,
        })).rejects.toMatchObject({
            code: 'BACKUP_MISSING_CHAT_ROW',
            message: expect.stringContaining(`${chaId}/${chatId}`),
        })

        const warnings: string[] = []
        const rotationPath = await tempPath('missing-rotation.risudat')
        await streamRisuSaveToFile({
            dbObj: graph,
            filePath: rotationPath,
            readChatRow: () => null,
            onMissingChatRow: (missingChaId, missingChatId) => {
                warnings.push(`${missingChaId}/${missingChatId}`)
            },
        })
        const rotated = await decodeRisuSave(await readFile(rotationPath))
        expect(warnings).toEqual([`${chaId}/${chatId}`])
        expect(rotated.characters[0].chats[0]).toEqual(
            expect.objectContaining({ id: chatId, _stub: true }),
        )
    })
})
