import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    alertNormal: vi.fn(),
    alertSelect: vi.fn(),
}))

vi.mock('../alert', () => ({
    alertNormal: mocks.alertNormal,
    alertSelect: mocks.alertSelect,
}))

vi.mock('src/lang', () => ({
    language: {
        clientUpgradeReloadFailed: 'cached client is still old',
        clientUpgradeInvalidResponse: 'invalid build response',
        clientUpgradeDirtyBody: 'server update requires reload',
        clientUpgradeOfflineBanner: 'copy changes before reloading the update',
        writerTakeoverBody: 'another session took over',
        writerTakeoverStayOffline: 'stay read-only',
        writerTakeoverReload: 'discard and reload',
        writerOfflineBanner: 'offline and read-only',
    },
}))

import {
    clientBuildStamp,
    handleClientBuildResponse,
    handleClientUpgradeRequired,
    handleWriterEpochChange,
    resetClientBuildHandshakeForTests,
    setClientBuildDirtyStateProbe,
} from './clientBuildHandshake'
import {
    enterWriterTakeoverFlow,
    resetWriterTakeoverForTests,
} from './writerTakeover'

describe('client build upgrade recovery', () => {
    const reload = vi.fn()
    const expectedBuild = {
        version: '9.9.9',
        stamp: '9.9.9-new-server-build',
    }

    beforeEach(() => {
        resetClientBuildHandshakeForTests()
        resetWriterTakeoverForTests()
        mocks.alertNormal.mockReset()
        mocks.alertSelect.mockReset()
        reload.mockReset()
        vi.stubGlobal('location', { reload })
        document.body.innerHTML = '<div id="app"><textarea>unsaved</textarea></div>'
    })

    afterEach(() => {
        resetClientBuildHandshakeForTests()
        resetWriterTakeoverForTests()
        vi.unstubAllGlobals()
        document.body.innerHTML = ''
    })

    it('reloads once for a clean upgrade-required response', async () => {
        const response = new Response(JSON.stringify({
            code: 'CLIENT_UPGRADE_REQUIRED',
            expectedBuild,
        }), {
            status: 426,
            headers: { 'content-type': 'application/json' },
        })

        await handleClientBuildResponse(response)

        expect(reload).toHaveBeenCalledOnce()
        expect(mocks.alertNormal).not.toHaveBeenCalled()
    })

    it('surfaces a cache/proxy error instead of entering a reload loop', async () => {
        expect(handleClientUpgradeRequired(expectedBuild)).toBe('reload')
        // A real reload creates a fresh JS runtime while sessionStorage keeps
        // the marker written by the old bundle.
        resetClientBuildHandshakeForTests({ preserveReloadGuard: true })
        expect(handleClientUpgradeRequired(expectedBuild)).toBe('blocked')

        expect(reload).toHaveBeenCalledOnce()
        await vi.waitFor(() => expect(mocks.alertNormal).toHaveBeenCalledOnce())
        expect(mocks.alertNormal.mock.calls[0][0]).toContain('cached client is still old')
        expect(mocks.alertNormal.mock.calls[0][0]).toContain(clientBuildStamp)
    })

    it('takes dirty state through the server-update recovery prompt without reloading', async () => {
        setClientBuildDirtyStateProbe(() => true)
        mocks.alertSelect.mockResolvedValue('0')
        const onDeactivated = (event: Event) => {
            const detail = (event as CustomEvent).detail
            if (detail?.reason === 'server-upgrade') {
                enterWriterTakeoverFlow('server-upgrade')
            }
        }
        window.addEventListener('risu-session-deactivated', onDeactivated)

        expect(handleClientUpgradeRequired(expectedBuild)).toBe('recovery')

        await vi.waitFor(() => {
            expect(mocks.alertSelect).toHaveBeenCalledWith(
                ['stay read-only', 'discard and reload'],
                'server update requires reload',
            )
        })
        expect(reload).not.toHaveBeenCalled()
        expect(document.getElementById('app')?.classList.contains(
            'risu-writer-offline-frozen',
        )).toBe(true)
        expect(document.getElementById('risu-writer-offline-banner')?.textContent)
            .toContain('copy changes before reloading the update')

        window.removeEventListener('risu-session-deactivated', onDeactivated)
    })

    it('reloads a clean page after observing a new server writer epoch', () => {
        expect(handleWriterEpochChange('writer-epoch-after-restart')).toBe('reload')
        expect(reload).toHaveBeenCalledOnce()
        expect(mocks.alertSelect).not.toHaveBeenCalled()
    })

    it('takes dirty state through the existing recovery prompt after an epoch change', async () => {
        setClientBuildDirtyStateProbe(() => true)
        mocks.alertSelect.mockResolvedValue('0')
        const onDeactivated = (event: Event) => {
            const detail = (event as CustomEvent).detail
            if (detail?.reason === 'server-restart') {
                enterWriterTakeoverFlow('server-restart')
            }
        }
        window.addEventListener('risu-session-deactivated', onDeactivated)

        expect(handleWriterEpochChange('writer-epoch-after-restart')).toBe('recovery')

        await vi.waitFor(() => {
            expect(mocks.alertSelect).toHaveBeenCalledWith(
                ['stay read-only', 'discard and reload'],
                'server update requires reload',
            )
        })
        expect(reload).not.toHaveBeenCalled()
        expect(document.getElementById('app')?.classList.contains(
            'risu-writer-offline-frozen',
        )).toBe(true)

        window.removeEventListener('risu-session-deactivated', onDeactivated)
    })
})
