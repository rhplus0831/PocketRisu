import { DBState } from '../stores.svelte'

export function backupChatAfterProcessing(charIndex: number, chatIndex: number) {
    try {
        const char = DBState.db.characters[charIndex]
        if (!char) return

        const chat = char.chats[chatIndex]
        if (!chat || !chat.message || chat.message.length === 0) return

        const charName = char.name || char.chaId || `char_${charIndex}`
        const chatName = chat.name || chat.id || `chat_${chatIndex}`
        const messages = chat.message

        // Fire and forget – don't block the UI
        fetch('/api/backup/save-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ charName, chatName, messages })
        }).catch(() => {
            // Silently ignore backup failures
        })
    } catch {
        // Never let backup errors affect chat processing
    }
}
