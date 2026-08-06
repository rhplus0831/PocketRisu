import { afterEach, describe, expect, test, vi } from 'vitest'
import { appendFailedGenerationToMessage, LiveModelJobSendOwner, type LiveModelJobSendDependencies } from './liveModelJobSend'
import { isModelJobOwnedByLiveSend, resetLiveModelJobOwnershipForTest } from './liveModelJobOwnership'
import { chatPersistKey, runChatPersistStage } from '../../storage/chatPersistStage'
import type { Chat, Database } from '../../storage/database.svelte'

function terminal(jobId: string, events: string[], claimError?: Error) {
    return {
        jobId,
        status: 'done' as const,
        claim: vi.fn(async () => {
            events.push(`claim:${jobId}`)
            if (claimError) throw claimError
        }),
    }
}

function dependencies(events: string[], clear = true): LiveModelJobSendDependencies {
    return {
        markChatDirty: vi.fn((chaId, chatId) => { events.push(`dirty:${chaId}/${chatId}`) }),
        save: vi.fn(async (options) => {
            expect(options).toEqual({ forceChatPersist: true })
            events.push('save')
            return { status: 'committed' as const }
        }),
        clearPendingSendFireAndForget: vi.fn((chatId, generationId) => {
            events.push(`fire-delete:${chatId}/${generationId}`)
        }),
        clearPendingSend: vi.fn(async (chatId, generationId) => {
            events.push(`delete:${chatId}/${generationId}`)
            return clear
        }),
    }
}

afterEach(() => {
    resetLiveModelJobOwnershipForTest()
    vi.restoreAllMocks()
})

describe('LiveModelJobSendOwner', () => {
    test('failed resend preserves message identity and stamps the current generation', () => {
        const message = {
            role: 'char' as const,
            data: 'first response',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
        }

        expect(appendFailedGenerationToMessage(
            message,
            'retry failed',
            { generationId: 'gen-2' },
        )).toBe(true)
        expect(message.chatId).toBe('gen-1')
        expect(message.generationInfo.generationId).toBe('gen-2')
        expect(message.data).toContain('retry failed')
    })

    test('marks the exact row dirty and finalizes only after successful publication', async () => {
        const events: string[] = []
        const owner = new LiveModelJobSendOwner()
        const deps = dependencies(events)
        owner.enter()
        owner.registerPending('cha-1', 'chat-1', 'gen-1')
        owner.registerTerminal(terminal('job-1', events))
        owner.markPublished()

        await expect(owner.leave({ preserveArtifacts: false }, deps)).resolves.toBe(true)
        expect(events).toEqual([
            'dirty:cha-1/chat-1',
            'save',
            'claim:job-1',
            'delete:chat-1/gen-1',
        ])
    })

    test('a recent checkpoint cannot satisfy the exact final-row barrier before claim/delete', async () => {
        const events: string[] = []
        const chat = {
            id: 'chat-1',
            name: 'chat',
            note: '',
            localLore: [],
            message: [{ role: 'char', data: 'current final response' }],
        } as Chat
        const db = { characters: [{ chaId: 'cha-1', chats: [chat] }] } as Database
        const checkpointTime = 50_000
        const generationCheckpoints = new Map([
            [chatPersistKey('cha-1', 'chat-1'), checkpointTime],
        ])
        let persisted = ''
        const owner = new LiveModelJobSendOwner()
        const job = terminal('job-1', events)
        owner.enter()
        owner.registerPending('cha-1', 'chat-1', 'gen-1')
        owner.registerTerminal(job)
        owner.markPublished()

        const result = owner.leave({ preserveArtifacts: false }, {
            markChatDirty: (chaId, chatId) => events.push(`dirty:${chaId}/${chatId}`),
            save: async ({ forceChatPersist }) => {
                await runChatPersistStage({
                    db,
                    toSave: {
                        character: [], chat: [['cha-1', 'chat-1']], root: false,
                        botPreset: false, modules: false, plugins: false,
                        pluginCustomStorage: false,
                    },
                    doingChat: true,
                    forceChatPersist,
                    knownChatIdsByCharacter: new Map([['cha-1', new Set(['chat-1'])]]),
                    generationCheckpoints,
                    requeueChats: () => {},
                    now: () => checkpointTime + 1,
                    saveChat: async (_chaId, _index, _chatId, row) => {
                        persisted = row.message[0].data
                        events.push('row:current-final')
                    },
                    commitStubDatabase: async () => {
                        events.push('stub:commit')
                        return { committed: true, result: undefined }
                    },
                })
                return { status: 'committed' }
            },
            clearPendingSendFireAndForget: () => events.push('unexpected:fire-delete'),
            clearPendingSend: async () => { events.push('tombstone:delete'); return true },
        })

        await expect(result).resolves.toBe(true)
        expect(persisted).toBe('current final response')
        expect(events).toEqual([
            'dirty:cha-1/chat-1',
            'row:current-final',
            'stub:commit',
            'claim:job-1',
            'tombstone:delete',
        ])
    })

    test.each([
        'non-streaming processScriptFull failure',
        'streaming post-EOF trigger/inlay failure',
    ])('%s preserves job and tombstone without dirtying or saving', async () => {
        const events: string[] = []
        const owner = new LiveModelJobSendOwner()
        const deps = dependencies(events)
        owner.enter()
        owner.registerPending('cha-1', 'chat-1', 'gen-1')
        const job = terminal('job-1', events)
        owner.registerTerminal(job)

        await expect(owner.leave({ preserveArtifacts: true }, deps)).resolves.toBe(false)
        expect(events).toEqual([])
        expect(job.claim).not.toHaveBeenCalled()
        expect(deps.clearPendingSend).not.toHaveBeenCalled()
        expect(isModelJobOwnedByLiveSend({ id: 'job-1', chatId: 'other', generationId: 'other' })).toBe(false)
    })

    test.each(['abort', 'connection loss'])('%s without terminal handoff preserves the tombstone', async () => {
        const events: string[] = []
        const owner = new LiveModelJobSendOwner()
        const deps = dependencies(events)
        owner.enter()
        owner.registerPending('cha-1', 'chat-1', 'gen-1')

        await expect(owner.leave({ preserveArtifacts: true }, deps)).resolves.toBe(false)
        expect(deps.clearPendingSend).not.toHaveBeenCalled()
        expect(deps.clearPendingSendFireAndForget).not.toHaveBeenCalled()
    })

    test('default sends are a no-op and proxy fallback cleanup stays fire-and-forget', async () => {
        const defaultEvents: string[] = []
        const defaultOwner = new LiveModelJobSendOwner()
        const defaultDeps = dependencies(defaultEvents)
        defaultOwner.enter()
        await expect(defaultOwner.leave({ preserveArtifacts: false }, defaultDeps)).resolves.toBe(false)
        expect(defaultEvents).toEqual([])

        const proxyEvents: string[] = []
        const proxyOwner = new LiveModelJobSendOwner()
        const proxyDeps = dependencies(proxyEvents)
        proxyOwner.enter()
        proxyOwner.registerPending('cha-1', 'chat-1', 'gen-proxy')
        await expect(proxyOwner.leave({ preserveArtifacts: false }, proxyDeps)).resolves.toBe(false)
        expect(proxyEvents).toEqual(['fire-delete:chat-1/gen-proxy'])
        expect(proxyDeps.save).not.toHaveBeenCalled()
        expect(proxyDeps.clearPendingSend).not.toHaveBeenCalled()
    })

    test('an abort after terminal handoff preserves artifacts even if chat publication completed', async () => {
        const events: string[] = []
        const owner = new LiveModelJobSendOwner()
        const deps = dependencies(events)
        owner.enter()
        owner.registerPending('cha-1', 'chat-1', 'gen-1')
        const job = terminal('job-1', events)
        owner.registerTerminal(job)
        owner.markPublished()

        await expect(owner.leave({ preserveArtifacts: true }, deps)).resolves.toBe(false)
        expect(events).toEqual([])
        expect(job.claim).not.toHaveBeenCalled()
        expect(deps.clearPendingSend).not.toHaveBeenCalled()
    })

    test('auto-continue/resend recursion finalizes once using the latest owned generation', async () => {
        const events: string[] = []
        const owner = new LiveModelJobSendOwner()
        const deps = dependencies(events)
        owner.enter()
        owner.registerPending('cha-1', 'chat-1', 'gen-1')
        const first = terminal('job-1', events)
        owner.registerTerminal(first)

        owner.enter()
        owner.registerPending('cha-1', 'chat-1', 'gen-2')
        const second = terminal('job-2', events)
        owner.registerTerminal(second)
        owner.markPublished()

        await expect(owner.leave({ preserveArtifacts: false }, deps)).resolves.toBe(false)
        expect(events).toEqual([])
        await expect(owner.leave({ preserveArtifacts: false }, deps)).resolves.toBe(true)
        expect(events).toEqual([
            'dirty:cha-1/chat-1',
            'save',
            'claim:job-1',
            'claim:job-2',
            'delete:chat-1/gen-2',
        ])
        expect(first.claim).toHaveBeenCalledTimes(1)
        expect(second.claim).toHaveBeenCalledTimes(1)
    })

    test('claim and DELETE cleanup failures retain a recovery artifact', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})

        const claimEvents: string[] = []
        const claimOwner = new LiveModelJobSendOwner()
        const claimDeps = dependencies(claimEvents)
        claimOwner.enter()
        claimOwner.registerPending('cha-1', 'chat-1', 'gen-1')
        claimOwner.registerTerminal(terminal('job-1', claimEvents, new Error('claim down')))
        claimOwner.markPublished()
        await expect(claimOwner.leave({ preserveArtifacts: false }, claimDeps)).resolves.toBe(false)
        expect(claimDeps.clearPendingSend).not.toHaveBeenCalled()

        const deleteEvents: string[] = []
        const deleteOwner = new LiveModelJobSendOwner()
        const deleteDeps = dependencies(deleteEvents, false)
        deleteOwner.enter()
        deleteOwner.registerPending('cha-1', 'chat-1', 'gen-2')
        const deleteJob = terminal('job-2', deleteEvents)
        deleteOwner.registerTerminal(deleteJob)
        deleteOwner.markPublished()
        await expect(deleteOwner.leave({ preserveArtifacts: false }, deleteDeps)).resolves.toBe(false)
        expect(deleteJob.claim).toHaveBeenCalledTimes(1)
        expect(deleteDeps.clearPendingSend).toHaveBeenCalledWith('chat-1', 'gen-2')
    })
})
