import { get } from 'svelte/store'
import { chatGenKey, generationStates } from '../generationState'

interface RecoverableJobIdentity {
    id: string
    chatId: string
    generationId?: string | null
}

// Terminal ownership outlives the generation-state id across recursive
// auto-continue/resend handoffs, so keep exact job ids until the outer send
// either publishes+finalizes or abandons them for recovery.
const terminalOwners = new Set<string>()

export function ownLiveTerminalModelJob(jobId: string): void {
    terminalOwners.add(jobId)
}

export function releaseLiveTerminalModelJob(jobId: string): void {
    terminalOwners.delete(jobId)
}

export function isModelJobOwnedByLiveSend(job: RecoverableJobIdentity): boolean {
    if (terminalOwners.has(job.id)) return true

    // Close the server-terminal → transport-EOF handoff race: before jobFetch
    // has seen EOF and registered the exact job id, the live generation entry
    // still proves ownership of this chat/generation pair.
    const live = get(generationStates).get(chatGenKey(job.chatId))
    return live?.kind === 'live'
        && typeof job.generationId === 'string'
        && live.generationId === job.generationId
}

/** Test-only reset for module-isolated recovery suites. */
export function resetLiveModelJobOwnershipForTest(): void {
    terminalOwners.clear()
}
