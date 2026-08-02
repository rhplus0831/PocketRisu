import { flushSync } from 'svelte'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { deepTouch } from '../gui/deepTouch.svelte'
import { watchActiveChatDirty } from './activeChatDirtyTracker.svelte'

interface TestChat {
    message: Array<{ data: string }>
    note: string
}

function createHarness(
    retouchDelayMs: number | (() => number) = 500,
    messageCount = 1,
) {
    const selection = $state<{
        chaId: string
        chatId: string
        chat: TestChat | null
        suppressDirty: boolean
    }>({
        chaId: 'char-a',
        chatId: 'chat-a',
        chat: {
            message: Array.from({ length: messageCount }, (_, index) => ({
                data: `initial-${index}`,
            })),
            note: '',
        },
        suppressDirty: false,
    })
    const dirty: Array<[string, string]> = []
    let touches = 0
    const tracker = watchActiveChatDirty({
        select: () => selection,
        onDirty: (chaId, chatId) => dirty.push([chaId, chatId]),
        retouchDelayMs,
        touch: (chat) => {
            touches += 1
            deepTouch(chat)
        },
    })
    flushSync()

    return {
        selection,
        dirty,
        tracker,
        touches: () => touches,
    }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('watchActiveChatDirty', () => {
    test('coalesces repeated nested mutations into one deep re-walk per window', () => {
        vi.useFakeTimers()
        const harness = createHarness(500, 1_000)
        expect(harness.touches()).toBe(1)

        harness.selection.chat!.message[999].data = 'first'
        flushSync()
        expect(harness.dirty).toEqual([['char-a', 'chat-a']])
        expect(harness.touches()).toBe(1)

        for (let index = 0; index < 100; index += 1) {
            harness.selection.chat!.message[999].data = `stream-${index}`
            flushSync()
        }
        expect(harness.dirty).toHaveLength(1)
        expect(harness.touches()).toBe(1)

        vi.advanceTimersByTime(500)
        flushSync()
        expect(harness.touches()).toBe(2)

        harness.selection.chat!.note = 'after re-arm'
        flushSync()
        expect(harness.dirty).toEqual([
            ['char-a', 'chat-a'],
            ['char-a', 'chat-a'],
        ])
        harness.tracker.stop()
    })

    test('treats selection changes as clean baselines and cancels the old timer', () => {
        vi.useFakeTimers()
        const harness = createHarness()

        harness.selection.chat!.note = 'dirty old chat'
        flushSync()
        expect(harness.dirty).toEqual([['char-a', 'chat-a']])

        harness.selection.chatId = 'chat-b'
        harness.selection.chat = {
            message: [{ data: 'other' }],
            note: '',
        }
        flushSync()
        expect(harness.touches()).toBe(2)
        expect(harness.dirty).toHaveLength(1)

        vi.advanceTimersByTime(500)
        flushSync()
        expect(harness.touches()).toBe(2)

        harness.selection.chat.note = 'dirty new chat'
        flushSync()
        expect(harness.dirty.at(-1)).toEqual(['char-a', 'chat-b'])
        harness.tracker.stop()
    })

    test('marks same-id replacements dirty but suppresses hydration replacements', () => {
        const harness = createHarness()

        harness.selection.chat = {
            message: [{ data: 'replacement' }],
            note: '',
        }
        flushSync()
        expect(harness.dirty).toEqual([['char-a', 'chat-a']])
        expect(harness.touches()).toBe(2)

        harness.selection.suppressDirty = true
        harness.selection.chat = {
            message: [{ data: 'hydrated' }],
            note: '',
        }
        flushSync()
        expect(harness.dirty).toHaveLength(1)
        expect(harness.touches()).toBe(3)

        harness.selection.suppressDirty = false
        flushSync()
        expect(harness.dirty).toHaveLength(1)

        harness.selection.chat.note = 'user edit'
        flushSync()
        expect(harness.dirty).toEqual([
            ['char-a', 'chat-a'],
            ['char-a', 'chat-a'],
        ])
        harness.tracker.stop()
    })

    test('supports an immediate re-arm at generation and durability boundaries', () => {
        vi.useFakeTimers()
        const harness = createHarness()
        harness.selection.chat!.note = 'streaming mutation'
        flushSync()
        expect(harness.touches()).toBe(1)

        harness.tracker.rearm()
        flushSync()
        expect(harness.touches()).toBe(2)

        harness.selection.chat!.note = 'final mutation'
        flushSync()
        expect(harness.dirty).toHaveLength(2)
        harness.tracker.stop()
    })

    test('uses the generation checkpoint cadence selected for each dirty window', () => {
        vi.useFakeTimers()
        let retouchDelayMs = 20_000
        const harness = createHarness(() => retouchDelayMs)

        harness.selection.chat!.message[0].data = 'streaming'
        flushSync()
        vi.advanceTimersByTime(19_999)
        flushSync()
        expect(harness.touches()).toBe(1)

        vi.advanceTimersByTime(1)
        flushSync()
        expect(harness.touches()).toBe(2)

        retouchDelayMs = 500
        harness.selection.chat!.message.push({ data: 'new message' })
        flushSync()
        harness.selection.chat!.message[1].data = 'coalesced edit'
        flushSync()
        vi.advanceTimersByTime(500)
        flushSync()
        expect(harness.touches()).toBe(3)

        // The re-walk subscribes to graph nodes added while tracking was
        // dropped, so later edits to them still wake persistence.
        harness.selection.chat!.message[1].data = 'observed after re-arm'
        flushSync()
        expect(harness.dirty).toHaveLength(3)
        harness.tracker.stop()
    })

    test('does not carry a pending re-walk past cleanup', () => {
        vi.useFakeTimers()
        const harness = createHarness()
        harness.selection.chat!.note = 'dirty'
        flushSync()
        harness.tracker.stop()

        vi.runAllTimers()
        flushSync()
        expect(harness.touches()).toBe(1)
    })
})
