import { describe, expect, it } from 'vitest'

import { shouldSendOnEnter } from './sendHotkey'

describe('shouldSendOnEnter', () => {
    it('sends on Enter when sendWithEnter is enabled', () => {
        expect(shouldSendOnEnter(
            { sendWithEnter: true, sendOnlyWithButton: false },
            { key: 'Enter', shiftKey: false, isComposing: false }
        )).toBe(true)
    })

    it('sends on Shift+Enter when sendWithEnter is disabled', () => {
        expect(shouldSendOnEnter(
            { sendWithEnter: false, sendOnlyWithButton: false },
            { key: 'Enter', shiftKey: true, isComposing: false }
        )).toBe(true)
    })

    it('never sends from Enter when button-only mode is enabled', () => {
        expect(shouldSendOnEnter(
            { sendWithEnter: true, sendOnlyWithButton: true },
            { key: 'Enter', shiftKey: false, isComposing: false }
        )).toBe(false)
        expect(shouldSendOnEnter(
            { sendWithEnter: false, sendOnlyWithButton: true },
            { key: 'Enter', shiftKey: true, isComposing: false }
        )).toBe(false)
    })

    it('does not send while IME composition is active', () => {
        expect(shouldSendOnEnter(
            { sendWithEnter: true, sendOnlyWithButton: false },
            { key: 'Enter', shiftKey: false, isComposing: true }
        )).toBe(false)
    })
})
