import { derived, get, writable } from 'svelte/store'
import type { ChatSendTarget } from './chatSendTarget'

export interface ChatSendTransaction {
    readonly id: number
    readonly target: ChatSendTarget
}

export const doingChat = writable(false)

const activeChatSendTransaction = writable<ChatSendTransaction | null>(null)
let nextChatSendTransactionId = 1

export const chatSendTransactionActive = derived(
    activeChatSendTransaction,
    transaction => transaction !== null,
)

export const chatOperationActive = derived(
    [doingChat, activeChatSendTransaction],
    ([generationActive, transaction]) => generationActive || transaction !== null,
)

export function beginChatSendTransaction(target: ChatSendTarget): ChatSendTransaction | null {
    if (get(doingChat) || get(activeChatSendTransaction)) return null

    const transaction = Object.freeze({
        id: nextChatSendTransactionId++,
        target: Object.freeze({ ...target }),
    })
    activeChatSendTransaction.set(transaction)
    return transaction
}

export function finishChatSendTransaction(transaction: ChatSendTransaction): boolean {
    if (get(activeChatSendTransaction) !== transaction) return false
    activeChatSendTransaction.set(null)
    return true
}

export function getActiveChatSendTransaction(): ChatSendTransaction | null {
    return get(activeChatSendTransaction)
}
