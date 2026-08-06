import { derived, get, writable, type Readable } from "svelte/store"

// Per-chat generation state, keyed by the REAL chat id (chat.id) — not the
// per-request generationId that flows through request args as `chatId` (see
// .agent/notes/generation-state-keying.md §1-bis). Keyed-Map pattern modeled
// on status/requestStatus.ts.
//
// Compatibility layer: the historical global stores `doingChat` /
// `chatProcessStage` live here (re-exported from process/index.svelte for
// existing consumers) and are fed from the map, so with a single active
// generation behavior is unchanged. All lifecycle writes go through the
// helpers below so the stores and the map never diverge.
//
// Non-persistent, memory only: never touches db/localStorage/.bin.

export type GenerationKind = 'live' | 'background'

// Opaque by identity: generationId changes when auto-continue/resend starts a
// new request, while this token follows the complete owned send chain. Callers
// must obtain it through startGeneration/captureGenerationOwnership and may
// only use it for an atomic conditional release.
export interface GenerationOwnershipToken {
    readonly initialGenerationId: string
    readonly kind: GenerationKind
}

// A one-shot, explicitly scoped restart capability. It carries the generation
// chain's ownership and abort controller without placing either in ambient
// per-chat state between recursive sendChat calls.
export interface GenerationHandoff {
    readonly chatKey: string
    readonly kind: GenerationKind
    readonly ownership: GenerationOwnershipToken
    readonly abortController?: AbortController
}

export interface GenState {
    generationId: string
    // 'live' = a send running in this client (feeds the global doingChat
    // compat store). 'background' = a server-side job reattached by
    // jobRecovery: it holds the per-chat send guard but must NOT flip the
    // global doingChat (that would lock every send UI and character switching
    // for up to the job-poll deadline).
    kind: GenerationKind
    ownership: GenerationOwnershipToken
    abortController?: AbortController
}

export const generationStates = writable<Map<string, GenState>>(new Map())

// Compat stores. Kept writable: Suggestion.svelte pulses doingChat true→false
// to retrigger its subscriber (only while nothing is generating, so the pulse
// cannot diverge from the map).
export const doingChat = writable(false)
export const chatProcessStage = writable(0)

export const isAnyGenerating: Readable<boolean> = derived(generationStates, (m) => m.size > 0)

// Abort controllers registered by the UI before sendChat creates the map entry
// (the screen creates the controller, then sendChat registers the generation).
// An entry is moved into the generation on registration. Auto-continue/resend
// carries it explicitly in a GenerationHandoff, so a failed restart cannot
// leave an ambient controller for a later unrelated send to adopt.
const pendingAborts = new Map<string, AbortController>()
const availableHandoffs = new WeakSet<GenerationHandoff>()
const generationStartObservers = new Map<
    string,
    Set<(ownership: GenerationOwnershipToken) => void>
>()

// Legacy chats can lack chat.id; those share one fallback key so the guard and
// cleanup still pair up (same single-generation behavior as before).
export function chatGenKey(chatId: string | undefined): string {
    return chatId ?? 'nochat'
}

// Global compat store = "any LIVE generation running". Background entries hold
// only the per-chat guard. Exported so the Suggestion.svelte pulse can
// re-converge the store with the map after its true→false toggle.
export function syncDoingChat(): void {
    let anyLive = false
    for (const entry of get(generationStates).values()) {
        if (entry.kind === 'live') {
            anyLive = true
            break
        }
    }
    doingChat.set(anyLive)
}

// Counts BOTH kinds: a chat with a background job must still block a new send.
export function isChatGenerating(chatKey: string): boolean {
    return get(generationStates).has(chatKey)
}

export function captureGenerationOwnership(chatKey: string): GenerationOwnershipToken | undefined {
    return get(generationStates).get(chatKey)?.ownership
}

export function startGeneration(
    chatKey: string,
    generationId: string,
    kind?: GenerationKind,
): GenerationOwnershipToken
export function startGeneration(
    chatKey: string,
    generationId: string,
    kind: GenerationKind,
    handoff: GenerationHandoff,
): GenerationOwnershipToken | undefined
export function startGeneration(
    chatKey: string,
    generationId: string,
    kind: GenerationKind = 'live',
    handoff?: GenerationHandoff,
): GenerationOwnershipToken | undefined {
    let ownership: GenerationOwnershipToken
    let abortController: AbortController | undefined
    if(handoff){
        if(get(generationStates).has(chatKey)
            || handoff.chatKey !== chatKey
            || handoff.kind !== kind
            || !availableHandoffs.delete(handoff)){
            return undefined
        }
        ownership = handoff.ownership
        abortController = handoff.abortController
    } else {
        ownership = Object.freeze({ initialGenerationId: generationId, kind })
        abortController = pendingAborts.get(chatKey)
        // Registration consumes this exact pre-registration controller. It is
        // now reachable through the entry and cannot leak to a later owner.
        pendingAborts.delete(chatKey)
    }
    generationStates.update((m) => {
        const next = new Map(m)
        next.set(chatKey, { generationId, kind, ownership, abortController })
        // Capture the exact registration before writable-store subscribers can
        // synchronously end or replace it while this update publishes.
        for(const observer of generationStartObservers.get(chatKey) ?? []){
            observer(ownership)
        }
        return next
    })
    syncDoingChat()
    return ownership
}

// Thin wrapper over the global compat store (the per-key stage field had no
// consumers; last writer wins, same as the previous global-only behavior).
export function setGenerationStage(_chatKey: string, stage: number): void {
    chatProcessStage.set(stage)
}

function removeGenerationEntry(
    chatKey: string,
    expectedOwnership?: GenerationOwnershipToken,
): GenState | undefined {
    let removed: GenState | undefined
    generationStates.update((m) => {
        const current = m.get(chatKey)
        if (!current || (expectedOwnership && current.ownership !== expectedOwnership)) {
            return m
        }
        removed = current
        const next = new Map(m)
        next.delete(chatKey)
        return next
    })
    return removed
}

function finishGenerationRemoval(chatKey: string): void {
    pendingAborts.delete(chatKey)
    syncDoingChat()
}

export function endGeneration(chatKey: string): void {
    const removed = removeGenerationEntry(chatKey)
    if (removed) {
        finishGenerationRemoval(chatKey)
        return
    }
    // Preserve historical pending-abort cleanup even when registration never
    // happened.
    pendingAborts.delete(chatKey)
    syncDoingChat()
}

// Compare and delete in the same synchronous store update. A send that ended
// before its promise settled cannot accidentally tear down a replacement that
// acquired the same chat key in the meantime.
export function endGenerationIfOwned(
    chatKey: string,
    ownership: GenerationOwnershipToken,
): boolean {
    const removed = removeGenerationEntry(chatKey, ownership)
    if (!removed) return false
    finishGenerationRemoval(chatKey)
    return true
}

// Atomically exchange the current owned entry for a one-shot restart
// capability. A mismatch leaves the replacement entry untouched and returns
// undefined, which callers must treat as "do not recurse".
export function handoffGenerationIfOwned(
    chatKey: string,
    ownership: GenerationOwnershipToken,
): GenerationHandoff | undefined {
    const removed = removeGenerationEntry(chatKey, ownership)
    if(!removed) return undefined
    const handoff = Object.freeze({
        chatKey,
        kind: removed.kind,
        ownership: removed.ownership,
        abortController: removed.abortController,
    })
    availableHandoffs.add(handoff)
    syncDoingChat()
    return handoff
}

// A recursive send can be rejected before it knows/registers its chat key.
// Explicit cancellation invalidates the scoped capability; its controller then
// becomes unreachable instead of leaking into the next send for that key.
export function cancelGenerationHandoff(handoff: GenerationHandoff): boolean {
    return availableHandoffs.delete(handoff)
}

export function clearPendingAbortIfOwned(
    chatKey: string,
    controller: AbortController,
): boolean {
    if(pendingAborts.get(chatKey) !== controller) return false
    pendingAborts.delete(chatKey)
    return true
}

// Used by UI callers that register an AbortController before invoking
// sendChat. It releases only their captured generation, or only their exact
// still-pending controller when sendChat exited before registration.
export function concludeGenerationAttempt(
    chatKey: string,
    ownership: GenerationOwnershipToken | undefined,
    controller: AbortController,
): boolean {
    const ended = ownership
        ? endGenerationIfOwned(chatKey, ownership)
        : false
    return clearPendingAbortIfOwned(chatKey, controller) || ended
}

// Direct request roots that do not use the main chat UI wrapper still need an
// exception-safe owner conclusion. The request callback must invoke sendChat
// synchronously; sendChat installs its entry before returning its promise.
// A synchronous registration observer records the exact emitted token even if
// the callback ends/replaces it before returning. A rejected request that
// registers nothing therefore cannot claim a pre-existing owner.
export async function runScopedGeneration<T>(
    chatKey: string,
    startRequest: () => Promise<T>,
): Promise<T> {
    let acquired: GenerationOwnershipToken | undefined
    const observer = (ownership: GenerationOwnershipToken) => {
        acquired ??= ownership
    }
    const observers = generationStartObservers.get(chatKey) ?? new Set()
    observers.add(observer)
    generationStartObservers.set(chatKey, observers)
    let observing = true
    const stopObserving = () => {
        if(!observing) return
        observing = false
        observers.delete(observer)
        if(observers.size === 0){
            generationStartObservers.delete(chatKey)
        }
    }
    try {
        const pendingRequest = startRequest()
        // Registration is synchronous; never attribute a later async start to
        // this request root.
        stopObserving()
        return await pendingRequest
    } finally {
        // Also runs when startRequest throws before returning a Promise.
        stopObserving()
        if(acquired){
            endGenerationIfOwned(chatKey, acquired)
        }
    }
}

// Intentional global administrative reset only. Per-request roots must use
// runScopedGeneration/concludeGenerationAttempt instead, because a blanket
// reset can tear down unrelated or replacement owners. Does not abort.
// Background entries (reattached server-side jobs) survive: these cleanup
// writes must not orphan a running job's guard (its poll loop releases it).
export function endAllGenerations(): void {
    generationStates.update((m) => {
        const next = new Map<string, GenState>()
        for (const [key, entry] of m) {
            if (entry.kind === 'background') next.set(key, entry)
        }
        return next
    })
    const survivors = get(generationStates)
    for (const key of [...pendingAborts.keys()]) {
        if (!survivors.has(key)) pendingAborts.delete(key)
    }
    syncDoingChat()
}

// Called by the UI right before sendChat, while the map entry does not exist
// yet; startGeneration adopts the pending controller into the entry.
export function registerAbort(chatKey: string, controller: AbortController): void {
    const entry = get(generationStates).get(chatKey)
    if (entry) {
        generationStates.update((m) => {
            const cur = m.get(chatKey)
            if (!cur) return m
            const next = new Map(m)
            next.set(chatKey, { ...cur, abortController: controller })
            return next
        })
    } else {
        pendingAborts.set(chatKey, controller)
    }
}

// Abort THIS chat's generation (registered or still pending). Returns whether
// a not-yet-aborted controller was actually aborted — false when nothing was
// wired (or everything reachable had already been aborted).
export function abortGeneration(chatKey: string): boolean {
    const entry = get(generationStates).get(chatKey)
    const pending = pendingAborts.get(chatKey)
    let aborted = false
    for (const controller of new Set([entry?.abortController, pending])) {
        if (controller && !controller.signal.aborted) {
            controller.abort()
            aborted = true
        }
    }
    return aborted
}
