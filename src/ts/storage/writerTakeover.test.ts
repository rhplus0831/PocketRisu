import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    alertSelect: vi.fn(),
}))

vi.mock('../alert', () => ({
    alertSelect: mocks.alertSelect,
}))

vi.mock('../../lang', () => ({
    language: {
        writerTakeoverBody: 'another session took over',
        writerTakeoverStayOffline: 'stay read-only',
        writerTakeoverReload: 'discard and reload',
        writerOfflineBanner: 'offline and read-only',
    },
}))

import {
    checkWriterTakeoverOnReturn,
    enterWriterTakeoverFlow,
    isWriterAccessLost,
    resetWriterTakeoverForTests,
} from './writerTakeover'

describe('writer takeover recovery UI', () => {
    const reload = vi.fn()

    beforeEach(() => {
        resetWriterTakeoverForTests()
        mocks.alertSelect.mockReset()
        reload.mockReset()
        vi.stubGlobal('location', { reload })
        document.body.innerHTML = `
            <div id="app">
                <button id="action">mutate</button>
                <input id="draft" type="text" value="draft">
                <textarea id="message">message</textarea>
                <div id="editor" contenteditable="true">editable</div>
            </div>
        `
    })

    afterEach(() => {
        resetWriterTakeoverForTests()
        vi.unstubAllGlobals()
        document.body.innerHTML = ''
    })

    it('routes a stale foreground status through the explicit chooser', async () => {
        mocks.alertSelect.mockResolvedValue('0')
        const claimWriterAccessLoss = vi.fn(() => true)

        await expect(checkWriterTakeoverOnReturn({
            getWriterLockState: async () => 'stale',
            isOperationActive: () => false,
            claimWriterAccessLoss,
        })).resolves.toBe(true)

        await vi.waitFor(() => {
            expect(document.getElementById('app')?.classList.contains('risu-writer-offline-frozen')).toBe(true)
        })
        expect(claimWriterAccessLoss).toHaveBeenCalledOnce()
        expect(mocks.alertSelect).toHaveBeenCalledWith(
            ['stay read-only', 'discard and reload'],
            'another session took over',
        )
        expect(reload).not.toHaveBeenCalled()
    })

    it('does not claim writer loss for a current foreground session', async () => {
        const claimWriterAccessLoss = vi.fn(() => true)

        await expect(checkWriterTakeoverOnReturn({
            getWriterLockState: async () => 'active',
            isOperationActive: () => false,
            claimWriterAccessLoss,
        })).resolves.toBe(false)

        expect(claimWriterAccessLoss).not.toHaveBeenCalled()
        expect(mocks.alertSelect).not.toHaveBeenCalled()
        expect(reload).not.toHaveBeenCalled()
    })

    it('defers recovery if a chat operation starts during the status request', async () => {
        let resolveState!: (state: 'stale') => void
        const state = new Promise<'stale'>(resolve => { resolveState = resolve })
        const claimWriterAccessLoss = vi.fn(() => true)
        let operationActive = false

        const check = checkWriterTakeoverOnReturn({
            getWriterLockState: () => state,
            isOperationActive: () => operationActive,
            claimWriterAccessLoss,
        })
        operationActive = true
        resolveState('stale')

        await expect(check).resolves.toBe(false)
        expect(claimWriterAccessLoss).not.toHaveBeenCalled()
        expect(mocks.alertSelect).not.toHaveBeenCalled()
        expect(reload).not.toHaveBeenCalled()
    })

    it('latches once and stays frozen without automatically reloading', async () => {
        mocks.alertSelect.mockResolvedValue('0')
        const accessLost = vi.fn()
        window.addEventListener('risu-writer-access-lost', accessLost)

        enterWriterTakeoverFlow()
        enterWriterTakeoverFlow()

        await vi.waitFor(() => {
            expect(document.getElementById('app')?.classList.contains('risu-writer-offline-frozen')).toBe(true)
        })
        expect(isWriterAccessLost()).toBe(true)
        expect(accessLost).toHaveBeenCalledOnce()
        expect(mocks.alertSelect).toHaveBeenCalledOnce()
        expect(mocks.alertSelect).toHaveBeenCalledWith(
            ['stay read-only', 'discard and reload'],
            'another session took over',
        )
        expect(reload).not.toHaveBeenCalled()

        expect((document.getElementById('draft') as HTMLInputElement).readOnly).toBe(true)
        expect((document.getElementById('message') as HTMLTextAreaElement).readOnly).toBe(true)
        expect(document.getElementById('editor')?.getAttribute('contenteditable')).toBe('false')
        expect(document.getElementById('risu-writer-offline-banner')?.textContent).toContain('offline and read-only')

        const mutate = vi.fn()
        document.getElementById('action')?.addEventListener('click', mutate)
        document.getElementById('action')?.click()
        expect(mutate).not.toHaveBeenCalled()

        const inputEvent = new Event('input', { bubbles: true, cancelable: true })
        expect(document.getElementById('draft')?.dispatchEvent(inputEvent)).toBe(false)

        window.removeEventListener('risu-writer-access-lost', accessLost)
    })

    it('keeps newly mounted editors read-only and lets the banner explicitly reload', async () => {
        mocks.alertSelect.mockResolvedValue('0')
        enterWriterTakeoverFlow()

        await vi.waitFor(() => {
            expect(document.getElementById('app')?.classList.contains('risu-writer-offline-frozen')).toBe(true)
        })
        const laterTextarea = document.createElement('textarea')
        document.getElementById('app')?.appendChild(laterTextarea)
        await vi.waitFor(() => expect(laterTextarea.readOnly).toBe(true))

        const bannerButton = document.querySelector<HTMLButtonElement>('#risu-writer-offline-banner button')
        expect(bannerButton).not.toBeNull()
        bannerButton?.click()
        expect(reload).toHaveBeenCalledOnce()
    })

    it('reloads only after the user explicitly chooses the destructive option', async () => {
        mocks.alertSelect.mockResolvedValue('1')

        enterWriterTakeoverFlow()

        await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
        expect(isWriterAccessLost()).toBe(true)
        expect(document.getElementById('app')?.classList.contains('risu-writer-offline-frozen')).toBe(false)
    })
})
