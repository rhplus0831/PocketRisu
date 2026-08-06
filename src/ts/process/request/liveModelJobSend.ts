import type { DatabaseSaveOutcome } from '../../storage/databaseSave'
import type { Message, MessageGenerationInfo } from '../../storage/database.svelte'
import type { TerminalModelJob } from './jobFetch'
import { LiveModelJobFinalization } from './liveModelJobFinalization'

export interface LiveModelJobSendDependencies {
    markChatDirty: (chaId: string, chatId: string) => void
    save: (options: { forceChatPersist: true }) => Promise<DatabaseSaveOutcome>
    clearPendingSendFireAndForget: (chatId: string, generationId: string) => void
    clearPendingSend: (chatId: string, generationId: string) => Promise<boolean>
}

export function appendFailedGenerationToMessage(
    message: Message | undefined,
    error: string,
    generationInfo: MessageGenerationInfo | undefined,
): boolean {
    if (message?.role !== 'char') return false
    message.data += `\n\`\`\`risuerror\n${error}\n\`\`\``
    if (generationInfo) message.generationInfo = generationInfo
    return true
}

/** Owns recovery artifacts across one send and its recursive continuation
 * chain. Transport terminality and successful chat publication are separate:
 * only the latter unlocks the durability barrier and cleanup. */
export class LiveModelJobSendOwner {
    private depth = 0
    private pending: { chaId?: string, chatId: string, generationId: string } | null = null
    private published = false
    private readonly terminal = new LiveModelJobFinalization()

    enter(): void {
        this.depth += 1
    }

    registerPending(chaId: string | undefined, chatId: string, generationId: string): void {
        this.pending = { chaId, chatId, generationId }
    }

    registerTerminal(job: TerminalModelJob): void {
        this.terminal.register(job)
    }

    markPublished(): void {
        this.published = true
    }

    async leave(
        options: { preserveArtifacts: boolean },
        dependencies: LiveModelJobSendDependencies,
    ): Promise<boolean> {
        this.depth -= 1
        if (this.depth > 0 || !this.pending) return false

        const pending = this.pending
        if (!this.terminal.hasTerminalJobs()) {
            if (options.preserveArtifacts) return false
            dependencies.clearPendingSendFireAndForget(pending.chatId, pending.generationId)
            return false
        }

        try {
            if (options.preserveArtifacts) return false
            if (!this.published) return false
            if (!pending.chaId) return false
            dependencies.markChatDirty(pending.chaId, pending.chatId)
            return await this.terminal.finalizeAfterCommittedSave(
                () => dependencies.save({ forceChatPersist: true }),
                () => dependencies.clearPendingSend(pending.chatId, pending.generationId),
            )
        } finally {
            // Once the live pipeline has concluded, any retained unclaimed job
            // belongs to normal recovery. A concurrent discovery pass skips it
            // while this ownership is present.
            this.terminal.releaseOwnership()
        }
    }
}
