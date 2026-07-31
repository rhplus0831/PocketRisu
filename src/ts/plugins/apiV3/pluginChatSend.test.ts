import { afterEach, describe, expect, test, vi } from 'vitest'
import {
    beginChatSendTransaction,
    doingChat,
    finishChatSendTransaction,
    getActiveChatSendTransaction,
} from '../../process/chatSendState'
import {
    applyChatInputToTarget,
    captureChatSendTarget,
    resolveChatSendTarget,
} from '../../process/chatSendTarget'
import { createPluginChatSendController } from './pluginChatSend'

function makeDatabase() {
    return {
        useSayNothing: false,
        characters: [{
            chaId: 'character-a',
            type: 'character',
            chatPage: 0,
            chats: [
                { id: 'chat-a', message: [{ role: 'char', data: 'history A' }] },
                { id: 'chat-b', message: [{ role: 'char', data: 'history B' }] },
            ],
        }],
    } as any
}

afterEach(() => {
    const activeTransaction = getActiveChatSendTransaction()
    if (activeTransaction) finishChatSendTransaction(activeTransaction)
    doingChat.set(false)
})

describe('V3 plugin child chat sends', () => {
    test('an awaited input hook completes a child turn before the outer message', async () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        const transaction = beginChatSendTransaction(target)!
        let generationActive = false

        const controller = createPluginChatSendController({
            getPermission: async () => true,
            isGenerationActive: () => generationActive,
            getActiveTransaction: getActiveChatSendTransaction,
            getDefaultTarget: () => captureChatSendTarget(db, 0)!,
            resolveTarget: candidate => resolveChatSendTarget(db, candidate),
            isPluginModelActive: () => false,
            runGeneration: async (candidate, activeTransaction) => {
                expect(activeTransaction).toBe(transaction)
                generationActive = true
                resolveChatSendTarget(db, candidate)!.chat.message.push({
                    role: 'char',
                    data: 'child response',
                })
            },
            releaseGeneration: () => { generationActive = false },
            now: () => 100,
        })

        const inputHook = controller.wrapInputHook(async (content) => {
            // Even if an asynchronous side effect changes the selected page,
            // the child turn remains bound to the outer transaction target.
            db.characters[0].chatPage = 1
            await controller.sendChat('child prompt')
            return content.toUpperCase()
        })

        await applyChatInputToTarget({
            getDatabase: () => db,
            target,
            input: 'outer prompt',
            now: () => 200,
            runInputTrigger: async (_character, chat) => ({
                chat: structuredClone(chat),
            }),
            processInput: (_character, content) => inputHook(content),
        })

        expect(db.characters[0].chats[0].message).toEqual([
            { role: 'char', data: 'history A' },
            { role: 'user', data: 'child prompt', time: 100 },
            { role: 'char', data: 'child response' },
            { role: 'user', data: 'OUTER PROMPT', time: 200, name: null },
        ])
        expect(db.characters[0].chats[1].message).toEqual([
            { role: 'char', data: 'history B' },
        ])
    })

    test('an unrelated API call cannot borrow an active send transaction', async () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        beginChatSendTransaction(target)
        const runGeneration = vi.fn()
        const controller = createPluginChatSendController({
            getPermission: async () => true,
            isGenerationActive: () => false,
            getActiveTransaction: getActiveChatSendTransaction,
            getDefaultTarget: () => target,
            resolveTarget: candidate => resolveChatSendTarget(db, candidate),
            isPluginModelActive: () => false,
            runGeneration,
            releaseGeneration: vi.fn(),
        })

        await expect(controller.sendChat('unrelated')).rejects.toThrow('already in progress')
        expect(runGeneration).not.toHaveBeenCalled()
        expect(db.characters[0].chats[0].message).toHaveLength(1)
    })

    test('input-hook authority does not permit recursion during model generation', async () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        beginChatSendTransaction(target)
        const controller = createPluginChatSendController({
            getPermission: async () => true,
            isGenerationActive: () => true,
            getActiveTransaction: getActiveChatSendTransaction,
            getDefaultTarget: () => target,
            resolveTarget: candidate => resolveChatSendTarget(db, candidate),
            isPluginModelActive: () => false,
            runGeneration: vi.fn(),
            releaseGeneration: vi.fn(),
        })
        const inputHook = controller.wrapInputHook(async (content) => {
            await controller.sendChat('recursive')
            return content
        })

        await expect(inputHook('outer')).rejects.toThrow('already in progress')
        expect(db.characters[0].chats[0].message).toHaveLength(1)
    })

    test('forwards bridge cancellation through permission and generation cleanup', async () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        const requestController = new AbortController()
        let permissionSignal: AbortSignal | undefined
        let generationSignal: AbortSignal | undefined
        const releaseGeneration = vi.fn()
        const cancellation = new DOMException('Plugin sandbox terminated', 'AbortError')
        const controller = createPluginChatSendController({
            getPermission: async signal => {
                permissionSignal = signal
                return true
            },
            isGenerationActive: () => false,
            getActiveTransaction: () => null,
            getDefaultTarget: () => target,
            resolveTarget: candidate => resolveChatSendTarget(db, candidate),
            isPluginModelActive: () => false,
            runGeneration: async (_candidate, _transaction, signal) => {
                generationSignal = signal
                return new Promise<never>((_resolve, reject) => {
                    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
                })
            },
            releaseGeneration,
        })

        const sending = controller.sendChat('pending', requestController.signal)
        await vi.waitFor(() => expect(generationSignal).toBe(requestController.signal))
        requestController.abort(cancellation)

        await expect(sending).rejects.toBe(cancellation)
        expect(permissionSignal).toBe(requestController.signal)
        expect(releaseGeneration).toHaveBeenCalledOnce()
    })
})
