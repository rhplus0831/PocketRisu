import { describe, expect, it } from 'vitest'
import pkg from './dbCachePersistence.cjs'

const {
    persistDbCacheGenerationSync,
    runEmergencyDbFlush,
} = pkg as {
    persistDbCacheGenerationSync: (options: Record<string, unknown>) => {
        data: Buffer
        committedRevision: number | null
    }
    runEmergencyDbFlush: (options: Record<string, unknown>) => {
        status: 'persisted' | 'skipped' | 'failed'
        reason?: string
    }
}

const DB_KEY = 'database/database.bin'

function createHarness() {
    const cachedDb = {
        characters: [],
        personas: [],
        botPresets: [],
        modules: [],
    }
    const pendingBytes = Buffer.from('pending-database-bytes')
    const writes = new Map<string, Buffer>()
    const logs: string[] = []
    const state = {
        importInProgress: false,
        inTransaction: false,
        pending: true,
        cache: cachedDb as Record<string, unknown> | null,
        cacheRevision: 7,
        databaseRevision: 7,
        normalizeCopy: false,
        duplicateChatIds: [] as Array<Record<string, unknown>>,
        transactionCount: 0,
    }
    const sqliteDb = {
        transaction(operation: () => void) {
            return () => {
                state.transactionCount += 1
                const prior = state.inTransaction
                state.inTransaction = true
                try { operation() } finally { state.inTransaction = prior }
            }
        },
    }

    const emergencyOptions = {
        log: (message: string) => logs.push(message),
        isImportInProgress: () => state.importInProgress,
        isInTransaction: () => state.inTransaction,
        hasPendingWork: () => state.pending,
        peekCachedDb: () => state.cache,
        getCacheMetadata: () => ({ revision: state.cacheRevision, dirty: true }),
        kvGetDatabaseRevision: () => state.databaseRevision,
        persist: ({ cachedDb: current }: { cachedDb: Record<string, unknown> }) => (
            persistDbCacheGenerationSync({
                cachedDb: current,
                decodedKey: DB_KEY,
                assertCurrent: () => {
                    if (state.cache !== current
                        || state.cacheRevision !== state.databaseRevision) {
                        throw new Error('cache changed')
                    }
                },
                findDuplicateChatIds: () => state.duplicateChatIds,
                preparePluginStorageExternalization: () => ({
                    strippedDb: state.normalizeCopy ? { ...current } : current,
                    rows: [],
                    manifest: null,
                }),
                retainCanonicalEncoding: () => ({ bytes: pendingBytes }),
                encodeRisuSaveLegacy: () => pendingBytes,
                sqliteDb,
                writePluginStorageRows: () => {},
                writePluginStorageManifest: () => {},
                kvSet: (key: string, value: Buffer) => writes.set(key, Buffer.from(value)),
                kvDel: (key: string) => writes.delete(key),
                kvGetDatabaseRevision: () => state.databaseRevision,
                chatRowsToDelete: [],
            })
        ),
    }
    return { emergencyOptions, logs, pendingBytes, state, writes }
}

describe('fatal database cache persistence', () => {
    it('writes pending canonical database bytes in one synchronous transaction', () => {
        const harness = createHarness()
        harness.writes.set('chats/retained/row', Buffer.from('retained chat row'))

        expect(runEmergencyDbFlush(harness.emergencyOptions)).toEqual({ status: 'persisted' })
        expect(harness.writes.get(DB_KEY)).toEqual(harness.pendingBytes)
        expect(harness.writes.get('chats/retained/row')).toEqual(Buffer.from('retained chat row'))
        expect(harness.state.transactionCount).toBe(1)
        expect(harness.logs).toEqual(['[FatalFlush] persisted pending database state'])
    })

    it.each([
        ['import-in-progress', (state: ReturnType<typeof createHarness>['state']) => {
            state.importInProgress = true
        }],
        ['sqlite-transaction-active', (state: ReturnType<typeof createHarness>['state']) => {
            state.inTransaction = true
        }],
        ['no-pending-work', (state: ReturnType<typeof createHarness>['state']) => {
            state.pending = false
        }],
    ] as const)('skips %s without writing', (reason, arrange) => {
        const harness = createHarness()
        arrange(harness.state)

        expect(runEmergencyDbFlush(harness.emergencyOptions)).toMatchObject({
            status: 'skipped',
            reason,
        })
        expect(harness.writes.size).toBe(0)
        expect(harness.state.transactionCount).toBe(0)
    })

    it('checks import, transaction ownership, and pending work in that order', () => {
        const harness = createHarness()
        harness.state.importInProgress = true
        harness.state.inTransaction = true
        harness.state.pending = false

        expect(runEmergencyDbFlush(harness.emergencyOptions)).toMatchObject({
            status: 'skipped',
            reason: 'import-in-progress',
        })
    })

    it.each([
        ['empty-cache', (state: ReturnType<typeof createHarness>['state']) => {
            state.cache = null
        }],
        ['cache-revision-mismatch', (state: ReturnType<typeof createHarness>['state']) => {
            state.databaseRevision += 1
        }],
        ['cache-not-normalized', (state: ReturnType<typeof createHarness>['state']) => {
            state.normalizeCopy = true
        }],
    ] as const)('skips %s without writing', (reason, arrange) => {
        const harness = createHarness()
        arrange(harness.state)

        expect(runEmergencyDbFlush(harness.emergencyOptions)).toMatchObject({
            status: 'skipped',
            reason,
        })
        expect(harness.writes.size).toBe(0)
    })

    it.each([
        ['stub-flag-loss', (state: ReturnType<typeof createHarness>['state']) => {
            state.cache = {
                characters: [{
                    chaId: 'guard-character',
                    chats: [{ id: 'metadata-only-chat', name: 'Missing stub flag' }],
                }],
            }
        }],
        ['duplicate-chat-ids', (state: ReturnType<typeof createHarness>['state']) => {
            state.duplicateChatIds = [{ chaId: 'guard-character', chatId: 'duplicate' }]
        }],
    ] as const)('skips the %s graph guard without writing', (reason, arrange) => {
        const harness = createHarness()
        arrange(harness.state)

        expect(runEmergencyDbFlush(harness.emergencyOptions)).toMatchObject({
            status: 'skipped',
            reason,
        })
        expect(harness.writes.size).toBe(0)
        expect(harness.state.transactionCount).toBe(0)
    })
})
