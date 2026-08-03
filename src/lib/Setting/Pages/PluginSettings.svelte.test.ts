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
const mutationWarning = vi.hoisted(() => vi.fn())
const transitionStorageMode = vi.hoisted(() => vi.fn())
const setLoadingOverlay = vi.hoisted(() => vi.fn())
const legacyReconcile = vi.hoisted(() => vi.fn())
const modernReconcile = vi.hoisted(() => vi.fn())
const inspectRecovery = vi.hoisted(() => vi.fn())
const downloadRecovery = vi.hoisted(() => vi.fn())
const resolveRecovery = vi.hoisted(() => vi.fn())
const openSettingsMock = vi.hoisted(() => vi.fn())
const recoveryHarness = vi.hoisted(() => {
    type Recovery = null | {
        direction: 'externalize' | 'internalize'
        issues: Array<{ code: string, encodedKey: string }>
    }
    let value: Recovery = null
    const subscribers = new Set<(next: Recovery) => void>()
    return {
        subscribe(run: (next: Recovery) => void) {
            subscribers.add(run)
            run(value)
            return () => subscribers.delete(run)
        },
        set(next: Recovery) {
            value = next
            for (const run of subscribers) run(value)
        },
    }
})

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: pluginDatabase },
    hotReloading: [],
    loadingOverlayStore: { set: setLoadingOverlay },
    selIdState: { selId: -1 },
}))

vi.mock('src/ts/alert', () => ({
    alertConfirm: confirmReset,
    alertMd: vi.fn(),
    alertSelect: vi.fn(),
    notifyError: mutationError,
    notifySuccess: mutationSuccess,
    notifyWarning: mutationWarning,
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
    reconcilePluginStorageModeForBoot: legacyReconcile,
    transitionPluginStorageMode: transitionStorageMode,
}))

vi.mock('src/ts/plugins/pluginStorageRecovery', () => ({
    createPluginStorageRecoveryDiagnostic: vi.fn(() => 'encoded diagnostics'),
    pluginStorageRecoveryStore: recoveryHarness,
    setPluginStorageRecoveryState: recoveryHarness.set,
}))

vi.mock('src/ts/globalApi.svelte', async importOriginal => ({
    ...await importOriginal<typeof import('src/ts/globalApi.svelte')>(),
    forageStorage: {
        reconcileOptimizedPluginStorageForBoot: modernReconcile,
        getPluginStorageRecoveryManagementInspection: inspectRecovery,
        downloadPluginStorageRecoveryRow: downloadRecovery,
        resolvePluginStorageRecoveryIssue: resolveRecovery,
    },
}))

vi.mock('src/ts/routing', () => ({
    openSettings: openSettingsMock,
    SettingsRoute: { System: 22 },
    SystemTab: { Backups: 1 },
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
    mutationWarning.mockReset()
    transitionStorageMode.mockReset()
    setLoadingOverlay.mockReset()
    legacyReconcile.mockReset()
    modernReconcile.mockReset()
    inspectRecovery.mockReset()
    downloadRecovery.mockReset()
    resolveRecovery.mockReset()
    openSettingsMock.mockReset()
    recoveryHarness.set(null)
    pluginDatabase.legacyPluginCompatibility = false
    pluginDatabase.optimizePluginMemory = false
    pluginDatabase.autoConvertPluginStorageValues = false
    document.body.replaceChildren()
})

describe('PluginSettings recovery management', () => {
    const encodedKey = 'pluginsave/cG1fc3RvcmU.json'
    const warningState = {
        direction: 'externalize' as const,
        issues: [{ code: 'invalid-json', encodedKey }],
    }
    const managedIssue = {
        code: 'invalid-json',
        encodedKey,
        kind: 'value',
        inlineAvailable: true,
        externalAvailable: true,
        externalSize: 23,
        actions: { download: true, useInline: true, delete: false },
        token: 't'.repeat(43),
    }

    test('leads with restore points and opens the affected-data manager separately', async () => {
        recoveryHarness.set(warningState)
        inspectRecovery.mockResolvedValue({
            success: true,
            mode: 'optimized',
            checkedAt: 123,
            issues: [managedIssue],
        })
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginSettings, { target })

        click(buttonWithText(target, 'Restore from restore point'))
        expect(openSettingsMock).toHaveBeenCalledWith(22, 1)

        click(buttonWithText(target, 'Manage affected data…'))
        await waitFor(() => {
            expect(inspectRecovery).toHaveBeenCalledOnce()
            expect(document.body.textContent).toContain('Manage affected plugin data')
            expect(document.body.textContent).toContain(encodedKey)
            expect(buttonWithText(document.body, 'Download raw copy')).toBeTruthy()
            expect(buttonWithText(document.body, 'Use inline copy')).toBeTruthy()
        })
        expect([...document.body.querySelectorAll('button')].some(
            button => button.textContent?.trim() === 'Delete unrecoverable data',
        )).toBe(false)

        await unmount(component)
    })

    test('checks optimized recovery on the server instead of replaying the legacy read path', async () => {
        pluginDatabase.optimizePluginMemory = true
        recoveryHarness.set(warningState)
        modernReconcile.mockResolvedValue({
            direction: 'externalize',
            values: 0,
            meta: 0,
            issues: warningState.issues,
            databaseChanged: false,
            storageChanged: false,
        })
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginSettings, { target })

        click(buttonWithText(target, 'Check again'))

        await waitFor(() => expect(modernReconcile).toHaveBeenCalledOnce())
        expect(legacyReconcile).not.toHaveBeenCalled()
        await waitFor(() => expect(mutationWarning).toHaveBeenCalledWith(
            '1 affected plugin storage entry is still present. No data was changed.',
        ))

        await unmount(component)
    })

    test('requires confirmation before replacing a corrupt row with its inline copy', async () => {
        pluginDatabase.optimizePluginMemory = true
        recoveryHarness.set(warningState)
        inspectRecovery.mockResolvedValue({
            success: true,
            mode: 'optimized',
            checkedAt: 123,
            issues: [managedIssue],
        })
        confirmReset.mockResolvedValue(true)
        resolveRecovery.mockResolvedValue({
            success: true,
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
            action: 'use-inline',
            encodedKey,
        })
        modernReconcile.mockResolvedValue({
            direction: 'none',
            values: 0,
            meta: 0,
            issues: [],
            databaseChanged: false,
            storageChanged: false,
        })
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginSettings, { target })

        click(buttonWithText(target, 'Manage affected data…'))
        await waitFor(() => {
            expect(inspectRecovery).toHaveBeenCalledOnce()
            expect(buttonWithText(document.body, 'Use inline copy')).toBeTruthy()
        })
        click(buttonWithText(document.body, 'Use inline copy'))

        await waitFor(() => expect(resolveRecovery).toHaveBeenCalledWith(
            managedIssue,
            'use-inline',
        ))
        expect(confirmReset).toHaveBeenCalledWith(expect.stringContaining(encodedKey))
        await waitFor(() => expect(modernReconcile).toHaveBeenCalledOnce())
        expect(mutationSuccess).toHaveBeenCalledWith(
            'Replaced the affected external row with the inline copy.',
        )
        await waitFor(() => {
            expect(document.body.textContent).not.toContain('Manage affected plugin data')
        })

        await unmount(component)
    })
})

describe('PluginSettings storage transition', () => {
    test('groups both plugin compatibility settings in a named section', async () => {
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginSettings, { target })
        const section = target.querySelector<HTMLElement>(
            'section[aria-labelledby="plugin-compatibility-heading"]',
        )
        const compatibilityCheckbox = target.querySelector<HTMLInputElement>(
            'input[alt="Legacy plugin compatibility"]',
        )
        const conversionCheckbox = target.querySelector<HTMLInputElement>(
            'input[alt="Automatically convert compatible plugin values"]',
        )

        expect(pluginDatabase.optimizePluginMemory).toBe(false)
        expect(section).not.toBeNull()
        expect(section!.querySelector('#plugin-compatibility-heading')?.textContent?.trim()).toBe(
            'Compatibility',
        )
        expect(compatibilityCheckbox).not.toBeNull()
        expect(conversionCheckbox).not.toBeNull()
        expect(conversionCheckbox!.disabled).toBe(false)
        expect(section!.contains(compatibilityCheckbox)).toBe(true)
        expect(section!.contains(conversionCheckbox)).toBe(true)

        await unmount(component)
    })

    test.each([
        ['legacyPluginCompatibility', 'Legacy plugin compatibility'],
        ['autoConvertPluginStorageValues', 'Automatically convert compatible plugin values'],
    ] as const)('enables %s without confirmation', async (setting, label) => {
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginSettings, { target })
        const checkbox = target.querySelector<HTMLInputElement>(`input[alt="${label}"]`)
        expect(checkbox).not.toBeNull()

        checkbox!.checked = true
        checkbox!.dispatchEvent(new Event('change', { bubbles: true }))

        expect(pluginDatabase[setting]).toBe(true)
        expect(confirmReset).not.toHaveBeenCalled()

        await unmount(component)
    })

    test.each([
        ['legacyPluginCompatibility', 'Legacy plugin compatibility'],
        ['autoConvertPluginStorageValues', 'Automatically convert compatible plugin values'],
    ] as const)('keeps %s enabled when disabling is cancelled', async (setting, label) => {
        pluginDatabase[setting] = true
        confirmReset.mockResolvedValue(false)
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginSettings, { target })
        const checkbox = target.querySelector<HTMLInputElement>(`input[alt="${label}"]`)
        expect(checkbox).not.toBeNull()

        checkbox!.checked = false
        checkbox!.dispatchEvent(new Event('change', { bubbles: true }))

        await waitFor(() => expect(confirmReset).toHaveBeenCalledWith(
            'Disabling this option will break compatibility with nearly all plugins. Disabling it is not recommended.',
        ))
        await waitFor(() => expect(checkbox!.checked).toBe(true))
        expect(pluginDatabase[setting]).toBe(true)

        await unmount(component)
    })

    test.each([
        ['legacyPluginCompatibility', 'Legacy plugin compatibility'],
        ['autoConvertPluginStorageValues', 'Automatically convert compatible plugin values'],
    ] as const)('disables %s after confirmation', async (setting, label) => {
        pluginDatabase[setting] = true
        confirmReset.mockResolvedValue(true)
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginSettings, { target })
        const checkbox = target.querySelector<HTMLInputElement>(`input[alt="${label}"]`)
        expect(checkbox).not.toBeNull()

        checkbox!.checked = false
        checkbox!.dispatchEvent(new Event('change', { bubbles: true }))

        await waitFor(() => expect(pluginDatabase[setting]).toBe(false))
        expect(confirmReset).toHaveBeenCalledWith(
            'Disabling this option will break compatibility with nearly all plugins. Disabling it is not recommended.',
        )
        expect(checkbox!.checked).toBe(false)

        await unmount(component)
    })

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
        await waitFor(() => expect(checkbox!.checked).toBe(true))
        expect(pluginDatabase.optimizePluginMemory).toBe(true)
        expect(mutationWarning).toHaveBeenCalledWith(
            'Plugin storage mode change cancelled.',
        )

        await unmount(component)
    })

    test('keeps an indeterminate overlay visible during a bulk disable', async () => {
        pluginDatabase.optimizePluginMemory = true
        let finishTransition: (() => void) | undefined
        const transitionPending = new Promise<void>((resolve) => {
            finishTransition = resolve
        })
        transitionStorageMode.mockImplementationOnce(async (
            enabled: boolean,
            options: {
                onStart: (progress: {
                    direction: 'internalize'
                    completed: number
                    total: number
                    completedBytes: number
                    totalBytes: number
                }) => void
            },
        ) => {
            expect(enabled).toBe(false)
            options.onStart({
                direction: 'internalize',
                completed: 0,
                total: 0,
                completedBytes: 0,
                totalBytes: 0,
            })
            await transitionPending
            pluginDatabase.optimizePluginMemory = false
            return { direction: 'internalize', values: 2, meta: 1 }
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

        await waitFor(() => {
            expect(setLoadingOverlay.mock.calls.at(-1)?.[0]).toMatchObject({
                active: true,
                text: 'Changing plugin storage mode… This may take a while.',
                onCancel: expect.any(Function),
            })
        })

        finishTransition?.()
        await waitFor(() => expect(pluginDatabase.optimizePluginMemory).toBe(false))
        await waitFor(() => expect(setLoadingOverlay.mock.calls.at(-1)?.[0]).toEqual({
            active: false,
            text: '',
            onCancel: null,
        }))

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
