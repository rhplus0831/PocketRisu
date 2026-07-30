import { afterEach, describe, expect, test } from 'vitest'
import { get } from 'svelte/store'
import {
    beginChatSendTransaction,
    chatOperationActive,
    doingChat,
    finishChatSendTransaction,
    getActiveChatSendTransaction,
} from './chatSendState'

afterEach(() => {
    const transaction = getActiveChatSendTransaction()
    if (transaction) finishChatSendTransaction(transaction)
    doingChat.set(false)
})

describe('chat send transaction state', () => {
    test('keeps the overall operation busy without claiming generation', () => {
        const transaction = beginChatSendTransaction({ chaId: 'character', chatId: 'chat' })

        expect(transaction).not.toBeNull()
        expect(get(doingChat)).toBe(false)
        expect(get(chatOperationActive)).toBe(true)
        expect(beginChatSendTransaction({ chaId: 'other', chatId: 'other-chat' })).toBeNull()

        expect(finishChatSendTransaction(transaction!)).toBe(true)
        expect(get(chatOperationActive)).toBe(false)
    })

    test('cannot begin an outer transaction during an existing generation', () => {
        doingChat.set(true)
        expect(beginChatSendTransaction({ chaId: 'character', chatId: 'chat' })).toBeNull()
        expect(get(chatOperationActive)).toBe(true)
    })
})
