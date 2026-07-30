import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, test, vi } from 'vitest'

const pluginDatabase = vi.hoisted(() => ({
    plugins: [{
        name: 'demo-plugin',
        displayName: 'Demo Plugin',
        version: 3,
        enabled: true,
        script: '',
        arguments: {},
        realArg: {},
    }],
    legacyPluginCompatibility: false,
    optimizePluginMemory: false,
    autoConvertPluginStorageValues: false,
}))
const getPermissionDecisions = vi.hoisted(() => vi.fn())
const resetPermission = vi.hoisted(() => vi.fn())
const setPermissionDecision = vi.hoisted(() => vi.fn())
const confirmReset = vi.hoisted(() => vi.fn())
const mutationError = vi.hoisted(() => vi.fn())
const mutationSuccess = vi.hoisted(() => vi.fn())
const transitionStorageMode = vi.hoisted(() => vi.fn())

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: pluginDatabase },
    hotReloading: [],
    loadingOverlayStore: { set: vi.fn() },
    selIdState: { selId: -1 },
}))

vi.mock('src/ts/alert', () => ({
    alertConfirm: confirmReset,
    alertMd: vi.fn(),
    alertSelect: vi.fn(),
    notifyError: mutationError,
    notifySuccess: mutationSuccess,
    notifyWarning: vi.fn(),
}))

vi.mock('src/ts/plugins/apiV3/v3.svelte', () => ({
    getPluginPermissionDecisions: getPermissionDecisions,
    pluginPermissionDescs: ['db'],
    resetPluginPermission: resetPermission,
    setPluginPermissionDecision: setPermissionDecision,
}))

vi.mock('src/ts/plugins/plugins.svelte', () => ({
    checkPluginUpdate: vi.fn(async () => null),
    createBlankPlugin: vi.fn(),
    importPlugin: vi.fn(),
    removePluginAndReload: vi.fn(),
    setPluginEnabledAndReload: vi.fn(),
    updatePlugin: vi.fn(),
}))

vi.mock('src/ts/plugins/apiV3/developMode', () => ({
    hotReloadPluginFiles: vi.fn(),
}))

vi.mock('src/ts/plugins/pluginMemoryOptimization', () => ({
    canOptimizePluginMemory: vi.fn(() => true),
    waitForPluginLifecycleIdle: vi.fn(),
}))

vi.mock('src/ts/plugins/pluginSaveStorage', () => ({
    reconcilePluginStorageModeForBoot: vi.fn(),
    transitionPluginStorageMode: transitionStorageMode,
}))

vi.mock('src/ts/plugins/pluginStorageRecovery', () => ({
    createPluginStorageRecoveryDiagnostic: vi.fn(),
    pluginStorageRecoveryStore: {
        subscribe(run: (value: null) => void) {
            run(null)
            return () => undefined
        },
    },
}))

vi.mock('src/ts/plugins/pluginStorageTransitionUi', () => ({
    formatPluginStorageTransitionBytes: vi.fn((value: number) => String(value)),
}))

const { default: PluginSettings } = await import('./PluginSettings.svelte')

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (true) {
        try {
            assertion()
            return
        } catch (error) {
            if (Date.now() >= deadline) throw error
            await tick()
            await new Promise(resolve => setTimeout(resolve, 0))
        }
    }
}

function click(element: Element): void {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function buttonWithText(target: ParentNode, text: string): HTMLButtonElement {
    const button = [...target.querySelectorAll<HTMLButtonElement>('button')]
        .find(candidate => candidate.textContent?.trim() === text)
    if (!button) throw new Error(`Missing button: ${text}`)
    return button
}

afterEach(() => {
    getPermissionDecisions.mockReset()
    resetPermission.mockReset()
    setPermissionDecision.mockReset()
    confirmReset.mockReset()
    mutationError.mockReset()
    mutationSuccess.mockReset()
    transitionStorageMode.mockReset()
    pluginDatabase.optimizePluginMemory = false
    pluginDatabase.autoConvertPluginStorageValues = false
    document.body.replaceChildren()
})

describe('PluginSettings storage transition', () => {
    test('confirms before disabling optimization for a large inline publication', async () => {
        pluginDatabase.optimizePluginMemory = true
        confirmReset.mockResolvedValue(false)
        transitionStorageMode.mockImplementationOnce(async (
            enabled: boolean,
            options: {
                confirmLargeInlineTransition: (warning: {
                    totalBytes: number
                    largestRowBytes: number
                }) => Promise<boolean>
            },
        ) => {
            expect(enabled).toBe(false)
            const confirmed = await options.confirmLargeInlineTransition({
                totalBytes: 65 * 1024 * 1024,
                largestRowBytes: 40 * 1024 * 1024,
            })
            if (!confirmed) {
                throw new DOMException('cancelled', 'AbortError')
            }
        })
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginSettings, { target })
        const checkbox = target.querySelector<HTMLInputElement>(
            'input[alt="Optimize plugin memory usage"]',
        )
        expect(checkbox).not.toBeNull()

        checkbox!.checked = false
        checkbox!.dispatchEvent(new Event('change', { bubbles: true }))

        await waitFor(() => expect(confirmReset).toHaveBeenCalledOnce())
        expect(confirmReset).toHaveBeenCalledWith(expect.stringContaining(
            String(65 * 1024 * 1024),
        ))
        expect(confirmReset).toHaveBeenCalledWith(expect.stringContaining(
            String(40 * 1024 * 1024),
        ))

        await unmount(component)
    })
})

describe('PluginSettings permission editor', () => {
    test('resets all saved decisions to Ask from the rendered settings UI', async () => {
        getPermissionDecisions.mockResolvedValue({ db: 'revoked' })
        resetPermission.mockResolvedValue(undefined)
        confirmReset.mockResolvedValue(true)
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginSettings, { target })

        const manageButton = target.querySelector<HTMLButtonElement>(
            'button[aria-label="Manage plugin permissions"]',
        )
        expect(manageButton).not.toBeNull()
        click(manageButton!)

        await waitFor(() => {
            expect(getPermissionDecisions).toHaveBeenCalledWith('demo-plugin')
            expect(target.querySelector('[aria-live="polite"]')?.textContent?.trim())
                .toBe('Revoked')
        })

        click(buttonWithText(target, 'Reset all to Ask'))

        await waitFor(() => expect(resetPermission).toHaveBeenCalledWith('demo-plugin'))
        expect(confirmReset).toHaveBeenCalledWith(expect.stringContaining('Demo Plugin'))
        await waitFor(() => {
            expect(target.querySelector('[aria-live="polite"]')?.textContent?.trim())
                .toBe('Ask when requested')
        })
        expect(mutationSuccess).toHaveBeenCalledWith(
            'Permission responses for "Demo Plugin" have been reset',
        )

        await unmount(component)
    })
})
