export interface DirtyTargetSink {
    character: (chaId: string) => void
    chat: (chaId: string, chatId: string) => void
}
/**
 * Buffers explicit dirty targets until the save loop is ready, then forwards
 * every later target synchronously. This keeps startup/plugin mutations from
 * disappearing into the no-op bridge that existed before saveDb initialized.
 */
export class DirtyTargetBridge {
    private sink: DirtyTargetSink | null = null
    private readonly pendingCharacters = new Set<string>()
    private readonly pendingChats = new Map<string, [string, string]>()

    markCharacter(chaId: string): void {
        if (!chaId) return
        if (this.sink) {
            this.sink.character(chaId)
            return
        }
        this.pendingCharacters.add(chaId)
    }

    markChat(chaId: string, chatId: string): void {
        if (!chaId || !chatId) return
        if (this.sink) {
            this.sink.chat(chaId, chatId)
            return
        }
        this.pendingChats.set(`${chaId}\0${chatId}`, [chaId, chatId])
    }

    activate(sink: DirtyTargetSink): void {
        this.sink = sink
        for (const chaId of this.pendingCharacters) sink.character(chaId)
        for (const [chaId, chatId] of this.pendingChats.values()) sink.chat(chaId, chatId)
        this.pendingCharacters.clear()
        this.pendingChats.clear()
    }
}
