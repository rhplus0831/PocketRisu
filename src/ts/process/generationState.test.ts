import { beforeEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
    abortGeneration,
    cancelGenerationHandoff,
    captureGenerationOwnership,
    chatGenKey,
    chatProcessStage,
    concludeGenerationAttempt,
    doingChat,
    endAllGenerations,
    endGeneration,
    endGenerationIfOwned,
    generationStates,
    handoffGenerationIfOwned,
    isAnyGenerating,
    isChatGenerating,
    registerAbort,
    runScopedGeneration,
    setGenerationStage,
    startGeneration,
    syncDoingChat,
} from './generationState'

beforeEach(() => {
    // endAllGenerations preserves background entries by design; drop them too.
    generationStates.set(new Map())
    endAllGenerations()
    chatProcessStage.set(0)
})

describe('chatGenKey', () => {
    it('uses the real chat id when present', () => {
        expect(chatGenKey('chat-1')).toBe('chat-1')
    })
    it('falls back to a shared key for id-less chats', () => {
        expect(chatGenKey(undefined)).toBe(chatGenKey(undefined))
    })
})

describe('map lifecycle', () => {
    it('start/end creates and removes the entry', () => {
        startGeneration('c1', 'g1')
        expect(isChatGenerating('c1')).toBe(true)
        expect(get(generationStates).get('c1')?.generationId).toBe('g1')
        endGeneration('c1')
        expect(isChatGenerating('c1')).toBe(false)
        expect(get(generationStates).size).toBe(0)
    })

    it('isChatGenerating is per chat', () => {
        startGeneration('c1', 'g1')
        expect(isChatGenerating('c1')).toBe(true)
        expect(isChatGenerating('c2')).toBe(false)
        startGeneration('c2', 'g2')
        endGeneration('c1')
        expect(isChatGenerating('c1')).toBe(false)
        expect(isChatGenerating('c2')).toBe(true)
    })

    it('endGeneration on an unknown chat is a no-op', () => {
        startGeneration('c1', 'g1')
        endGeneration('other')
        expect(isChatGenerating('c1')).toBe(true)
    })

    it('stop cleanup preserves a same-key replacement owner', () => {
        startGeneration('c1', 'g1')
        const firstOwnership = captureGenerationOwnership('c1')
        expect(firstOwnership).toBeDefined()

        endGeneration('c1')
        startGeneration('c1', 'g2')
        const replacementOwnership = captureGenerationOwnership('c1')

        expect(endGenerationIfOwned('c1', firstOwnership!)).toBe(false)
        expect(captureGenerationOwnership('c1')).toBe(replacementOwnership)
        expect(get(generationStates).get('c1')?.generationId).toBe('g2')
        expect(endGenerationIfOwned('c1', replacementOwnership!)).toBe(true)
        expect(isChatGenerating('c1')).toBe(false)
    })

    it('preserves ownership across a scoped auto-continue restart and final cleanup', () => {
        const ownership = startGeneration('c1', 'g1')
        const handoff = handoffGenerationIfOwned('c1', ownership)

        expect(handoff).toBeDefined()
        expect(startGeneration('c1', 'g2', 'live', handoff!)).toBe(ownership)

        expect(get(generationStates).get('c1')?.generationId).toBe('g2')
        expect(captureGenerationOwnership('c1')).toBe(ownership)
        expect(endGenerationIfOwned('c1', ownership)).toBe(true)
        expect(isChatGenerating('c1')).toBe(false)
    })

    it('auto-continue/resend handoff failure preserves replacement and prevents recurse', () => {
        const ownership = startGeneration('c1', 'g1')
        endGenerationIfOwned('c1', ownership)
        const replacementOwnership = startGeneration('c1', 'g2', 'background')
        let recursed = false

        const handoff = handoffGenerationIfOwned('c1', ownership)
        if(handoff) recursed = true

        expect(handoff).toBeUndefined()
        expect(recursed).toBe(false)
        expect(captureGenerationOwnership('c1')).toBe(replacementOwnership)
        expect(get(generationStates).get('c1')?.kind).toBe('background')
    })

    it('UI conclusion preserves a background replacement acquired before settlement', () => {
        const originalController = new AbortController()
        registerAbort('c1', originalController)
        const ownership = startGeneration('c1', 'g1')
        endGenerationIfOwned('c1', ownership)

        const replacementController = new AbortController()
        registerAbort('c1', replacementController)
        const replacementOwnership = startGeneration('c1', 'g2', 'background')

        expect(concludeGenerationAttempt('c1', ownership, originalController)).toBe(false)
        expect(captureGenerationOwnership('c1')).toBe(replacementOwnership)
        expect(abortGeneration('c1')).toBe(true)
        expect(replacementController.signal.aborted).toBe(true)
    })

    it('endAllGenerations clears everything live', () => {
        startGeneration('c1', 'g1')
        startGeneration('c2', 'g2')
        endAllGenerations()
        expect(get(generationStates).size).toBe(0)
        expect(get(doingChat)).toBe(false)
    })

    it('endAllGenerations preserves background entries (running server-side jobs)', () => {
        startGeneration('c1', 'g1')
        startGeneration('bg', 'g-bg', 'background')
        endAllGenerations()
        expect(isChatGenerating('c1')).toBe(false)
        expect(isChatGenerating('bg')).toBe(true)
        expect(get(generationStates).get('bg')?.kind).toBe('background')
    })
})

describe('background kind', () => {
    it('does not flip the global doingChat', () => {
        startGeneration('bg', 'g1', 'background')
        expect(get(doingChat)).toBe(false)
        expect(isChatGenerating('bg')).toBe(true) // per-chat guard still held
        startGeneration('live', 'g2')
        expect(get(doingChat)).toBe(true)
        endGeneration('live')
        // background alone → global stays false
        expect(get(doingChat)).toBe(false)
        expect(isChatGenerating('bg')).toBe(true)
    })
})

describe('direct send roots', () => {
    const roots = [
        'V3 plugin send',
        'hotkey preview',
        'DevTool preview',
        'DevTool autopilot',
        'file multisend',
    ]

    it.each(roots)('%s preserves cross-chat and same-key replacement owners', async () => {
        startGeneration('other-chat', 'other-live')
        let settle!: (value: boolean) => void
        let requestOwnership!: ReturnType<typeof startGeneration>
        const request = runScopedGeneration('request-chat', () => {
            requestOwnership = startGeneration('request-chat', 'request-live')
            return new Promise<boolean>(resolve => {
                settle = resolve
            })
        })

        endGenerationIfOwned('request-chat', requestOwnership)
        const replacement = startGeneration('request-chat', 'replacement', 'background')
        settle(true)

        await expect(request).resolves.toBe(true)
        expect(captureGenerationOwnership('request-chat')).toBe(replacement)
        expect(isChatGenerating('other-chat')).toBe(true)
    })

    it.each(roots)('%s releases only its own entry when the request throws', async () => {
        startGeneration('other-chat', 'other-background', 'background')
        const failure = new Error('direct request failed')

        await expect(runScopedGeneration('request-chat', () => {
            startGeneration('request-chat', 'request-live')
            return Promise.reject(failure)
        })).rejects.toBe(failure)

        expect(isChatGenerating('request-chat')).toBe(false)
        expect(isChatGenerating('other-chat')).toBe(true)
    })

    it('does not claim a same-key generation that predated a rejected request', async () => {
        const existing = startGeneration('request-chat', 'existing')

        await expect(runScopedGeneration(
            'request-chat',
            () => Promise.resolve(false),
        )).resolves.toBe(false)

        expect(captureGenerationOwnership('request-chat')).toBe(existing)
    })

    it('preserves a replacement installed synchronously before the request callback returns', async () => {
        let replacement!: ReturnType<typeof startGeneration>

        await expect(runScopedGeneration('request-chat', () => {
            const owned = startGeneration('request-chat', 'request-live')
            endGenerationIfOwned('request-chat', owned)
            replacement = startGeneration('request-chat', 'replacement', 'background')
            return Promise.resolve(false)
        })).resolves.toBe(false)

        expect(captureGenerationOwnership('request-chat')).toBe(replacement)
        expect(get(generationStates).get('request-chat')?.kind).toBe('background')
    })

    it('releases the exact entry when the request callback throws synchronously', async () => {
        const failure = new Error('synchronous direct request failure')

        await expect(runScopedGeneration('request-chat', () => {
            startGeneration('request-chat', 'request-live')
            throw failure
        })).rejects.toBe(failure)

        expect(isChatGenerating('request-chat')).toBe(false)
    })
})

describe('doingChat compat sync', () => {
    it('mirrors map emptiness through the lifecycle', () => {
        expect(get(doingChat)).toBe(false)
        startGeneration('c1', 'g1')
        expect(get(doingChat)).toBe(true)
        startGeneration('c2', 'g2')
        endGeneration('c1')
        // another chat still generating → stays true
        expect(get(doingChat)).toBe(true)
        endGeneration('c2')
        expect(get(doingChat)).toBe(false)
    })

    it('isAnyGenerating derives from the map', () => {
        expect(get(isAnyGenerating)).toBe(false)
        startGeneration('c1', 'g1')
        expect(get(isAnyGenerating)).toBe(true)
        endGeneration('c1')
        expect(get(isAnyGenerating)).toBe(false)
    })
})

describe('setGenerationStage', () => {
    it('feeds the global compat store (last write wins)', () => {
        setGenerationStage('c1', 3)
        setGenerationStage('c2', 1)
        expect(get(chatProcessStage)).toBe(1)
    })
})

describe('abort registry', () => {
    it('adopts a pre-registered controller into the generation and aborts it', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        startGeneration('c1', 'g1')
        expect(get(generationStates).get('c1')?.abortController).toBe(controller)
        expect(abortGeneration('c1')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
    })

    it('attaches to a live generation when the entry already exists', () => {
        startGeneration('c1', 'g1')
        const controller = new AbortController()
        registerAbort('c1', controller)
        abortGeneration('c1')
        expect(controller.signal.aborted).toBe(true)
    })

    it('aborts a still-pending controller (abort clicked before registration)', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        expect(abortGeneration('c1')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
    })

    it('only aborts the targeted chat', () => {
        const c1 = new AbortController()
        const c2 = new AbortController()
        registerAbort('c1', c1)
        registerAbort('c2', c2)
        startGeneration('c1', 'g1')
        startGeneration('c2', 'g2')
        abortGeneration('c1')
        expect(c1.signal.aborted).toBe(true)
        expect(c2.signal.aborted).toBe(false)
    })

    it('returns false when there is nothing to abort', () => {
        expect(abortGeneration('c1')).toBe(false)
        startGeneration('c1', 'g1') // no controller registered
        expect(abortGeneration('c1')).toBe(false)
    })

    it('the controller survives a scoped handoff/restart under the same key (auto-continue)', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        const ownership = startGeneration('c1', 'g1')
        const handoff = handoffGenerationIfOwned('c1', ownership)
        startGeneration('c1', 'g2', 'live', handoff!)
        expect(get(generationStates).get('c1')?.abortController).toBe(controller)
        expect(abortGeneration('c1')).toBe(true)
        expect(controller.signal.aborted).toBe(true)
    })

    it('a restart rejected before registration leaks neither token nor abort controller', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        const ownership = startGeneration('c1', 'g1')
        const handoff = handoffGenerationIfOwned('c1', ownership)

        expect(handoff).toBeDefined()
        expect(cancelGenerationHandoff(handoff!)).toBe(true)

        const unrelatedOwnership = startGeneration('c1', 'g2')
        expect(unrelatedOwnership).not.toBe(ownership)
        expect(get(generationStates).get('c1')?.abortController).toBeUndefined()
        expect(abortGeneration('c1')).toBe(false)
        expect(controller.signal.aborted).toBe(false)
    })

    it('a terminal endGeneration drops the pending controller (no stale adoption)', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        startGeneration('c1', 'g1')
        endGeneration('c1')
        startGeneration('c1', 'g2')
        expect(get(generationStates).get('c1')?.abortController).toBeUndefined()
        expect(abortGeneration('c1')).toBe(false)
        expect(controller.signal.aborted).toBe(false)
    })

    it('reports false when the wired controller was already aborted', () => {
        const controller = new AbortController()
        registerAbort('c1', controller)
        startGeneration('c1', 'g1')
        expect(abortGeneration('c1')).toBe(true)
        expect(abortGeneration('c1')).toBe(false)
    })

    it('endAllGenerations clears pending controllers', () => {
        registerAbort('c1', new AbortController())
        endAllGenerations()
        expect(abortGeneration('c1')).toBe(false)
    })
})

describe('syncDoingChat', () => {
    it('re-converges the compat store with the map after an external pulse', () => {
        doingChat.set(true) // Suggestion.svelte pulse
        syncDoingChat()
        expect(get(doingChat)).toBe(false)
        startGeneration('c1', 'g1')
        doingChat.set(false)
        syncDoingChat()
        expect(get(doingChat)).toBe(true)
    })
})
