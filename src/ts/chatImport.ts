import type { Chat } from './storage/database.svelte'
import { prepareChatForImport } from './storage/chatStorage'

export function encodeChatHtmlPayload(chat: Chat): string {
    return JSON.stringify(chat)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function isCompleteChatPayload(value: unknown): value is Partial<Chat> {
    if (!value || typeof value !== 'object') return false
    const chat = value as Partial<Chat>
    return Array.isArray(chat.message)
        && typeof chat.note === 'string'
        && typeof chat.name === 'string'
        && Array.isArray(chat.localLore)
}

/** Parse the hidden lossless payload from a PocketRisu HTML chat export. */
export function parseChatHtmlExport(
    html: string,
    makeId?: () => string,
): Chat | null {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const payload = doc.querySelector('.idat')?.textContent
    if (!payload) return null

    const parsed: unknown = JSON.parse(payload)
    if (!isCompleteChatPayload(parsed)) return null
    return prepareChatForImport(parsed, makeId)
}
