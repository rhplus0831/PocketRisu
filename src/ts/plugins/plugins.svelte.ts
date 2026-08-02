import { get, writable } from "svelte/store";
import { language } from "../../lang";
import { getCurrentCharacter, getDatabase, setDatabase, setDatabaseLite } from "../storage/database.svelte";
import { alertConfirm, alertError, alertPluginConfirm, notifyWarning } from "../alert";
import { selectSingleFile, sleep } from "../util";
import type { OpenAIChat } from "../process/index.svelte";
import { fetchNative, globalFetch, readImage, requestImmediateSave, saveAsset, toGetter } from "../globalApi.svelte";
import { DBState, hotReloading, pluginAlertModalStore, selectedCharID } from "../stores.svelte";
import type { ScriptMode } from "../process/scripts";
import { checkCodeSafety } from "./pluginSafety";
import { SafeDocument, SafeIdbFactory, SafeLocalStorage } from "./pluginSafeClass";
import {
    loadV3PluginGenerationOutcomes,
    teardownV3Plugins,
} from "./apiV3/v3.svelte";
import { pluginCodeTranspiler } from "./apiV3/transpiler";
import {
    canEnablePlugin,
    disableEnabledLegacyPluginsForOptimizedMemory,
    isPluginStorageModeTransitioning,
    shouldDisableImportedPlugin,
    type PluginLifecycleLease,
    withPluginLifecycleLock,
} from "./pluginMemoryOptimization";
import { requireCommittedDatabaseSave } from "../storage/databaseSave";
import {
    copyDatabasePluginStorageRecord,
    createDatabasePluginStorageRecord,
    createPluginStorageRecord,
    definePluginStorageRecordValue,
    getPluginStorageRecordKeys,
    hasPluginStorageRecordValue,
    setDatabasePluginStorageRecordValue,
} from "./pluginStorageRecord";
import { markPluginStorageKeySetChanged } from "./pluginStorageEnumeration";
import { cloneDatabaseField } from "../storage/databaseClone";

export const customProviderStore = writable([] as string[])

interface ProviderPlugin {
    name: string
    displayName?: string
    script: string
    arguments: { [key: string]: 'int' | 'string' | string[] }
    realArg: { [key: string]: number | string }
    version?: 1 | 2 | '2.1' | '3.0'
    customLink: ProviderPluginCustomLink[]
    argMeta: { [key: string]: {[key:string]:string} }
    versionOfPlugin?: string
    updateURL?: string
    enabled?: boolean
    allowedIPC?: string[]
}
interface ProviderPluginCustomLink {
    link: string
    hoverText?: string
}

export type RisuPlugin = ProviderPlugin

function getRemovedPluginArgumentNames(
    existingPlugin: RisuPlugin | undefined,
    replacementPlugin: RisuPlugin,
): string[] {
    if (!existingPlugin) return []

    const replacementArguments = new Set(Object.keys(replacementPlugin.arguments ?? {}))
    return Object.keys(existingPlugin.arguments ?? {})
        .filter(argumentName => !replacementArguments.has(argumentName))
        .sort()
}

function preservePluginArgumentValues(
    existingPlugin: RisuPlugin | undefined,
    replacementPlugin: RisuPlugin,
): void {
    if (!existingPlugin) return

    const existingValues = existingPlugin.realArg ?? {}
    for (const argumentName of Object.keys(replacementPlugin.arguments ?? {})) {
        if (Object.prototype.hasOwnProperty.call(existingValues, argumentName)) {
            replacementPlugin.realArg[argumentName] = existingValues[argumentName]
        }
    }
}

function pluginArgumentRemovalConfirmation(argumentNames: string[]): string {
    return language.pluginUpdateRemovesArgumentsConfirm.replace(
        "{}",
        argumentNames.map(argumentName => JSON.stringify(argumentName)).join(", "),
    )
}

export async function createBlankPlugin(){
    await importPlugin(
`
//@name New Plugin
//@display-name New Plugin Display Name
//@api 3.0
//@arg example_arg string

Risuai.log("Hello from New Plugin!");
`.trim()
    )
}

const compareVersions = (v1: string, v2: string): 0|1|-1 => {
    const v1parts = v1.split('.').map(Number);
    const v2parts = v2.split('.').map(Number);
    const len = Math.max(v1parts.length, v2parts.length);
    for (let i = 0; i < len; i++) {
        const part1 = v1parts[i] || 0;
        const part2 = v2parts[i] || 0;
        if (part1 > part2) return 1;
        if (part1 < part2) return -1;
    }
    return 0;
}

const updateCache = new Map<string, { version: string, updateURL: string } | undefined>();

export const checkPluginUpdate = async (plugin: RisuPlugin) => {
    try {
        if(!plugin.updateURL){
            return
        }

        if(updateCache.has(plugin.name)){
            const cached = updateCache.get(plugin.name)
            if(compareVersions(cached.version, plugin.versionOfPlugin || '0.0.0') === 1){
                return cached
            }
        }

        const response = (await fetch(plugin.updateURL, {
            method: 'GET',
            headers: {
                'Range': 'bytes=0-512'
            }
        }))

        if(response.status >= 200 && response.status < 300){
            const text = await response.text()
            const versioRegex = /\/\/@version\s+([^\s]+)/;
            const match = text.match(versioRegex);
            if(match && match[1]){
                const latestVersion = match[1].trim()
                if(compareVersions(latestVersion, plugin.versionOfPlugin || '0.0.0') === 1){
                    updateCache.set(plugin.name, {
                        version: latestVersion,
                        updateURL: plugin.updateURL
                    })
                    return {
                        version: latestVersion,
                        updateURL: plugin.updateURL
                    }
                }
            }
        }
    } catch (error) {
        console.warn('Failed to check plugin update:', error)
    }
}

export async function updatePlugin(plugin: RisuPlugin) {
    try {
        if(!plugin.updateURL){
            return false
        }
        const response = await fetch(plugin.updateURL)
        if(response.status >= 200 && response.status < 300){
            const jsFile = await response.text()
            await importPlugin(jsFile, {
                isUpdate: true,
                originalPluginName: plugin.name
            })
            return true
        }
    } catch (error) {
        console.error('Failed to update plugin:', error)
    }
    return false
}

export async function importPlugin(code:string|null = null, argu:{
    isUpdate?: boolean
    originalPluginName?: string
    isHotReload?: boolean
    isTypescript?: boolean
} = {}) {
    try {
        let jsFile = ''
        let db = getDatabase()
        let isUpdate = argu.isUpdate || false
        let originalPluginName = argu.originalPluginName || ''
        let isTypescript = argu.isTypescript || false
        
        if(!code){
            const f = await selectSingleFile(['js','ts'])
            if (!f) {
                return
            }
            if(f.name.endsWith('.ts')){
                isTypescript = true
            }
            //support utf-8 with BOM or without BOM
            jsFile = Buffer.from(f.data).toString('utf-8').replace(/^\uFEFF/gm, "");
        }
        else{
            jsFile = code
        }

        const splitedJs = jsFile.split('\n')
        let name = ''
        for (const line of splitedJs) {
            if (line.startsWith('//@name')) {
                name = line.slice(7).trim()
                break
            }
        }

        const showError = (msg: string) => {
            if(argu.isHotReload){
                console.error(`Hot-reload plugin "${name}" error: ${msg}`)
            }
            else{
                alertError(msg)
            }
        }

        let displayName: string = undefined
        let arg: { [key: string]: 'int' | 'string' | string[] } = {}
        let realArg: { [key: string]: number | string } = {}
        let argMeta: { [key: string]: {[key:string]:string} } = {}
        let customLink: ProviderPluginCustomLink[] = []
        let updateURL: string = ''
        let versionOfPlugin: string = '' //This is the version of the plugin itself, not the API version
        let apiVersion = '2.0'
        let ipcList: string[] = []
        for (const line of splitedJs) {
            if (line.startsWith('//@name')) {
                const provied = line.slice(7)
                if (provied === '') {
                    showError('plugin name must be longer than 0, did you put it correctly?')
                    return
                }
                name = provied.trim()
            }
            if(line.startsWith('//@api')){
                const proviedVersions = line.slice(6).trim().split(' ')
                const supportedVersions = ['2.0','2.1','3.0']
                for(const ver of proviedVersions){
                    if(supportedVersions.includes(ver)){
                        apiVersion = ver
                        break
                    }
                    else{
                        console.warn(`Plugin API version "${ver}" is not supported.`)
                    }
                }
            }
            if (line.startsWith('//@display-name')) {
                const provied = line.slice('//@display-name'.length + 1)
                if (provied === '') {
                    showError('plugin display name must be longer than 0, did you put it correctly?')
                    return
                }
                displayName = provied.trim()
            }

            if (line.startsWith('//@link')) {
                const link = line.split(" ")[1]
                if (!link || link === '') {
                    showError('plugin link is empty, did you put it correctly?')
                    return
                }
                if (!link.startsWith('https')) {
                    showError('plugin link must start with https, did you check it?')
                    return
                }
                const hoverText = line.split(' ').slice(2).join(' ').trim()
                if (hoverText === '') {
                    // OK, no hover text. It's fine.
                    customLink.push({
                        link: link,
                        hoverText: undefined
                    });
                }
                else
                    customLink.push({
                        link: link,
                        hoverText: hoverText || undefined
                    });
            }
            if (line.startsWith('//@risu-arg') || line.startsWith('//@arg')) {
                const provied = line.trim().split(' ')
                if (provied.length < 3) {
                    showError('plugin argument is incorrect, did you put space in argument name?')
                    return
                }
                const provKey = provied[1]

                if (provied[2] !== 'int' && provied[2] !== 'string') {
                    showError(`plugin argument type is "${provied[2]}", which is an unknown type.`)
                    return
                }
                if (provied[2] === 'int') {
                    arg[provKey] = 'int'
                    realArg[provKey] = 0
                }
                else if (provied[2] === 'string') {
                    arg[provKey] = 'string'
                    realArg[provKey] = ''
                }

                if(provied.length > 3){
                    const meta: {[key:string]:string} = {}
                    //Compatibility layer for unofficial meta
                    let metaStr = provied.slice(3).join(' ').replace(
                        /{{(.+?)(::?(.+?))?}}/g,
                        (a,g1:string,g2,g3:string) => {
                            console.log(g1,g3)
                            meta[g1] = g3 || '1'
                            return ''
                        }
                    ).trim()

                    if(metaStr){
                        meta['description'] = metaStr
                    }

                    argMeta[provKey] = meta
                }
            }

            if(line.startsWith('//@update-url')){
                updateURL = line.split(' ')[1]

                try {
                    const url = new URL(updateURL)
                    if(url.protocol !== 'https:'){
                        showError('plugin update URL must start with https, did you put it correctly?')
                        return
                    }
                } catch (error) {
                    showError('plugin update URL is not a valid URL, did you put it correctly?')
                    return
                }
            }

            if(line.startsWith('//@version')){
                versionOfPlugin = line.split(' ').slice(1).join(' ').trim()

                const versionLocation = jsFile.indexOf('//@version')
                const numberOfBytesBefore = new TextEncoder().encode(jsFile.slice(0, versionLocation) + line).length
                if(numberOfBytesBefore > 500){
                    showError('plugin version declaration must be within the first 512 Bytes of the file for proper parsing. move //@version line to the top of the file.')
                    return
                }
            }

            if(line.startsWith('//@allowed-ipc')){
                const provied = line.trim().split(' ')
                if(provied.length < 2){
                    showError('plugin allowed IPC declaration is incorrect, did you put space after //@allowed-ipc?')
                    return
                }

                const allowedIPCList = provied.slice(1)

                ipcList.push(...allowedIPCList)
            }
        }

        if (name.length === 0) {
            showError('plugin name not found, did you put it correctly?')
            return
        }

        if(updateURL && versionOfPlugin.length === 0){
            showError('plugin version not found, did you put it correctly? It is required when update URL is provided.')
            return
        }

        if(versionOfPlugin && compareVersions(versionOfPlugin, '0.0.1') === -1){
            showError('plugin version must be at least 0.0.1')
            return
        }

        
        if(isTypescript){
            try {
                jsFile = await pluginCodeTranspiler(jsFile)                
            } catch (error) {
                showError('Failed to transpile TypeScript code: ' + error.message)
            }
        }

        let apiInternalVersion: 2|'2.1'|'3.0' = '2.1'

        if(apiVersion === '2.1'){
            const safety = await checkCodeSafety(jsFile)
            if(!safety.isSafe){
                pluginAlertModalStore.errors = safety.errors
                pluginAlertModalStore.open = true
                
                //I can use event but lazy
                while(pluginAlertModalStore.open){
                    await sleep(100)
                }

                if(pluginAlertModalStore.errors.length > 0){
                    return
                }
            }
            apiInternalVersion = '2.1'
        }
        else if(apiVersion === '2.0'){
            if(!DBState.db.allowV2Plugin){
                showError('Your code does not include //@api or specifies API version 2.0, which is outdated. Please update your plugin to use at least API version 2.1.')
                return
            }
            apiInternalVersion = 2
        }
        else if(apiVersion === '3.0'){
            apiInternalVersion = '3.0'
        }

        if(apiInternalVersion !== '3.0' && argu.isHotReload){
            showError('Only API version 3.0 plugins can be hot-reloaded.')
            return
        }
        
        let disabledForMemoryOptimization = shouldDisableImportedPlugin(
            apiInternalVersion,
            db.optimizePluginMemory,
        );
        let pluginData: RisuPlugin = {
            name: name,
            script: jsFile,
            realArg: realArg,
            arguments: arg,
            displayName: displayName,
            version: apiInternalVersion,
            customLink: customLink,
            argMeta: argMeta,
            versionOfPlugin: versionOfPlugin,
            updateURL: updateURL,
            allowedIPC: ipcList,
            enabled: !disabledForMemoryOptimization
        }

        db.plugins ??= []

        const oldPluginIndex = db.plugins.findIndex((p: RisuPlugin) => p.name === pluginData.name);

        if(originalPluginName && originalPluginName !== pluginData.name){
            showError(`When updating plugin "${originalPluginName}", the plugin name cannot be changed to "${pluginData.name}". Please keep the original name to update.`)
            return
        }


        if(!isUpdate && oldPluginIndex !== -1){
            const c = await alertConfirm(language.duplicatePluginFoundUpdateIt)
            if(!c){
                return
            }
        }

        const confirmedRemovedArguments = new Set<string>()
        while (true) {
            const mutationResult = await withPluginLifecycleLock(async (lifecycleLease) => {
                // Any confirmation await may have overlapped another plugin-list
                // mutation or a storage-mode transition. Re-read authoritative
                // state under the lifecycle lock before deciding what is removed.
                const commitDatabase = getDatabase()
                commitDatabase.plugins ??= []
                const commitPluginIndex = commitDatabase.plugins.findIndex(
                    (plugin: RisuPlugin) => plugin.name === pluginData.name,
                )
                disabledForMemoryOptimization = shouldDisableImportedPlugin(
                    apiInternalVersion,
                    commitDatabase.optimizePluginMemory,
                )
                const previousPlugin = commitPluginIndex === -1
                    ? undefined
                    : safeStructuredClone(commitDatabase.plugins[commitPluginIndex])
                const unconfirmedRemovedArguments = getRemovedPluginArgumentNames(
                    previousPlugin,
                    pluginData,
                ).filter(argumentName => !confirmedRemovedArguments.has(argumentName))
                if (unconfirmedRemovedArguments.length > 0) {
                    return { unconfirmedRemovedArguments }
                }

                preservePluginArgumentValues(previousPlugin, pluginData)
                pluginData.enabled = disabledForMemoryOptimization
                    ? false
                    : previousPlugin === undefined
                        ? true
                        : previousPlugin.enabled === true
                let mutationApplied = false

                if(commitPluginIndex !== -1){
                    commitDatabase.plugins[commitPluginIndex] = pluginData;
                    mutationApplied = true
                }
                else if(!isUpdate || argu.isHotReload){
                    commitDatabase.plugins.push(pluginData)
                    mutationApplied = true
                }

                const wasHotReloading = hotReloading.includes(pluginData.name)
                if(argu.isHotReload && !hotReloading.includes(pluginData.name)){
                    hotReloading.push(pluginData.name)
                }

                setDatabaseLite(commitDatabase)
                await commitPluginListMutation(
                    lifecycleLease,
                    "Plugin import",
                    () => {
                        if (mutationApplied) {
                            if (previousPlugin === undefined) {
                                removePluginFromLiveList(pluginData.name)
                            } else {
                                restorePluginInLiveList(
                                    pluginData.name,
                                    commitPluginIndex,
                                    previousPlugin,
                                )
                            }
                        }
                        if (!wasHotReloading) {
                            const hotReloadIndex = hotReloading.indexOf(pluginData.name)
                            if (hotReloadIndex !== -1) hotReloading.splice(hotReloadIndex, 1)
                        }
                    },
                    {
                        rollbackOnReloadFailure: true,
                        targetPluginName: pluginData.name,
                    },
                )
                console.log(`Imported plugin: ${pluginData.name} (API v${apiVersion})`)
                if (disabledForMemoryOptimization) {
                    notifyWarning(language.optimizePluginMemoryImportDisabled)
                }
                return { unconfirmedRemovedArguments: [] }
            })

            if (mutationResult.unconfirmedRemovedArguments.length === 0) break
            const confirmed = await alertConfirm(pluginArgumentRemovalConfirmation(
                mutationResult.unconfirmedRemovedArguments,
            ))
            if (!confirmed) return
            for (const argumentName of mutationResult.unconfirmedRemovedArguments) {
                confirmedRemovedArguments.add(argumentName)
            }
        }

    } catch (error) {
        console.error(error)
        alertError(error instanceof Error ? error.message : String(error))
    }
}

let pluginTranslator = false

type PluginReloadPhase = "teardown" | "loading"
type PluginLifecycleFailure = {
    phase: "compatibility-repair" | "v2-teardown" | "v3-teardown" | "v2-load" | "v3-load"
    error: unknown
    pluginName?: string
}
type PluginLifecycleReport = { failures: PluginLifecycleFailure[] }
let activePluginReloadPhase: PluginReloadPhase | undefined
let pluginApiReloadPending = false
let pluginApiReloadDrainPromise: Promise<void> | undefined
const MAX_DEFERRED_PLUGIN_RELOAD_ATTEMPTS = 2

function retainDeferredPluginReloadDemand(): Promise<void> {
    pluginApiReloadPending = true
    if (pluginApiReloadDrainPromise) return pluginApiReloadDrainPromise

    const drainPromise = Promise.resolve().then(() => drainDeferredPluginApiReload())
    pluginApiReloadDrainPromise = drainPromise
    void drainPromise.then(
        () => {
            if (pluginApiReloadDrainPromise === drainPromise) {
                pluginApiReloadDrainPromise = undefined
            }
        },
        () => {
            if (pluginApiReloadDrainPromise === drainPromise) {
                pluginApiReloadDrainPromise = undefined
            }
        },
    )
    return drainPromise
}

/**
 * Outside plugin lifecycle work, callers share a promise that settles only
 * after the requested reload generation drains. Lifecycle callbacks receive
 * acknowledgement instead: awaiting a generation queued behind the active
 * generation would deadlock the lifecycle operation that invoked the callback.
 */
export function requestDeferredPluginApiReload(): Promise<void> {
    // Teardown-time demand is covered by the live plugin-list read immediately
    // after every unload callback settles.
    if (activePluginReloadPhase === "teardown") return Promise.resolve()

    const drainPromise = retainDeferredPluginReloadDemand()
    if (activePluginReloadPhase !== undefined) return Promise.resolve()
    return drainPromise
}

export async function waitForDeferredPluginApiReloadIdle(): Promise<void> {
    while (true) {
        await Promise.resolve()
        const drainPromise = pluginApiReloadDrainPromise
        if (!drainPromise) return
        await drainPromise
        if (pluginApiReloadDrainPromise === drainPromise) return
    }
}

async function drainDeferredPluginApiReload(): Promise<void> {
    let attempts = 0
    let lastError: unknown
    try {
        while (pluginApiReloadPending && attempts < MAX_DEFERRED_PLUGIN_RELOAD_ATTEMPTS) {
            pluginApiReloadPending = false
            attempts += 1
            try {
                await withPluginLifecycleLock(loadPluginsUnlocked)
                lastError = undefined
            } catch (error) {
                lastError = error
                pluginApiReloadPending = true
            }
        }
    } finally {
        if (pluginApiReloadPending) {
            console.error(
                "[Plugins] Deferred plugin reload remains pending after bounded attempts",
                lastError,
            )
            notifyWarning(language.pluginReloadDeferredPending)
            throw lastError ?? new Error(
                "Plugin reload remained pending after bounded lifecycle attempts.",
            )
        }
    }
}

function pluginLifecycleError(failures: PluginLifecycleFailure[]): AggregateError {
    return new AggregateError(
        failures.map(failure => failure.error),
        "One or more plugin lifecycle phases failed.",
    )
}

async function loadPluginsWithReportUnlocked(
    _lifecycleLease: PluginLifecycleLease,
    afterTeardown?: () => void,
): Promise<PluginLifecycleReport> {
    console.log('Loading plugins...')
    const db = getDatabase()
    const legacyPluginCompatibility = db.legacyPluginCompatibility === true
    const autoDisabledPlugins = disableEnabledLegacyPluginsForOptimizedMemory(
        db.plugins,
        db.optimizePluginMemory,
    )
    let compatibilityRepairError: unknown
    if (autoDisabledPlugins.length > 0) {
        setDatabaseLite(db)
        notifyWarning(language.optimizePluginMemoryLegacyAutoDisabled(
            autoDisabledPlugins.join(", "),
        ))
        try {
            requireCommittedDatabaseSave(
                await requestImmediateSave({ forceFullWrite: true }),
                "Optimized plugin-memory invalid-state repair",
            )
        } catch (error) {
            compatibilityRepairError = error
        }
    }

    const previousPhase = activePluginReloadPhase
    activePluginReloadPhase = "teardown"
    let v2TeardownError: unknown
    let v3TeardownError: unknown
    try {
        await teardownV2Plugins()
    } catch (error) {
        v2TeardownError = error
    }
    try {
        await teardownV3Plugins()
    } catch (error) {
        v3TeardownError = error
    }

    if (legacyPluginCompatibility && (v2TeardownError || v3TeardownError)) {
        console.warn(
            "[Plugins] Compatibility mode ignored one or more teardown failures.",
            v2TeardownError,
            v3TeardownError,
        )
        notifyWarning(language.legacyPluginCompatibilityTeardownWarning)
        v2TeardownError = undefined
        v3TeardownError = undefined
    }

    activePluginReloadPhase = "loading"
    let v2LoadError: unknown
    const v3LoadFailures: PluginLifecycleFailure[] = []
    try {
        afterTeardown?.()
        const currentDatabase = getDatabase()
        const enabledPlugins = safeStructuredClone(currentDatabase.plugins ?? [])
            .filter((plugin: RisuPlugin) => (
                plugin.enabled
                && canEnablePlugin(plugin, currentDatabase.optimizePluginMemory)
            ))
        try {
            await loadV2PluginGeneration(enabledPlugins.filter(
                (plugin: RisuPlugin) => plugin.version === 2 || plugin.version === "2.1",
            ))
        } catch (error) {
            v2LoadError = error
        }
        const v3Outcomes = await loadV3PluginGenerationOutcomes(enabledPlugins.filter(
            (plugin: RisuPlugin) => plugin.version === "3.0",
        ))
        for (const outcome of v3Outcomes) {
            if (outcome.status === "rejected") {
                v3LoadFailures.push({
                    phase: "v3-load",
                    pluginName: outcome.pluginName,
                    error: outcome.reason,
                })
            }
        }
    } finally {
        activePluginReloadPhase = previousPhase
    }

    const failures: PluginLifecycleFailure[] = []
    if (compatibilityRepairError !== undefined) {
        failures.push({ phase: "compatibility-repair", error: compatibilityRepairError })
    }
    if (v2TeardownError !== undefined) {
        failures.push({ phase: "v2-teardown", error: v2TeardownError })
    }
    if (v3TeardownError !== undefined) {
        failures.push({ phase: "v3-teardown", error: v3TeardownError })
    }
    if (v2LoadError !== undefined) {
        failures.push({ phase: "v2-load", error: v2LoadError })
    }
    failures.push(...v3LoadFailures)
    return { failures }
}

async function loadPluginsUnlocked(lifecycleLease: PluginLifecycleLease) {
    const report = await loadPluginsWithReportUnlocked(lifecycleLease)
    if (report.failures.length > 0) throw pluginLifecycleError(report.failures)
}

export function loadPlugins(): Promise<void> {
    return withPluginLifecycleLock(loadPluginsUnlocked)
}

function removePluginFromLiveList(pluginName: string): void {
    const liveDatabase = getDatabase()
    liveDatabase.plugins = (liveDatabase.plugins ?? [])
        .filter(plugin => plugin.name !== pluginName)
}

function restorePluginInLiveList(
    pluginName: string,
    originalIndex: number,
    originalPlugin: RisuPlugin,
): void {
    const liveDatabase = getDatabase()
    // Teardown callbacks may replace the array with cloned records, reinsert
    // this plugin, or create duplicates. Reconcile against the current list by
    // stable name and deliberately restore the original record and ordering.
    const nextPlugins = (liveDatabase.plugins ?? [])
        .filter(plugin => plugin.name !== pluginName)
    const insertionIndex = Math.min(
        Math.max(originalIndex, 0),
        nextPlugins.length,
    )
    nextPlugins.splice(insertionIndex, 0, safeStructuredClone(originalPlugin))
    liveDatabase.plugins = nextPlugins
}

async function commitPluginListMutation(
    lifecycleLease: PluginLifecycleLease,
    operation: string,
    rollback: () => void,
    options: {
        rollbackOnReloadFailure: boolean
        targetPluginName?: string
        persistBeforeLifecycle?: boolean
        reapplyAfterTeardown?: () => void
    },
): Promise<void> {
    const rollbackMutation = async (
        causes: unknown[],
        reloadAfterRollback: boolean,
    ): Promise<never> => {
        const errors = [...causes]
        let rollbackSaveCommitted = false
        try {
            rollback()
            setDatabaseLite(getDatabase())
        } catch (error) {
            errors.push(error)
        }
        if (reloadAfterRollback) {
            try {
                await loadPluginsUnlocked(lifecycleLease)
            } catch (error) {
                errors.push(error)
            }
        }
        try {
            requireCommittedDatabaseSave(
                await requestImmediateSave({ forceFullWrite: true }),
                `${operation} rollback`,
            )
            rollbackSaveCommitted = true
        } catch (error) {
            errors.push(error)
        }
        throw new AggregateError(
            errors,
            rollbackSaveCommitted
                ? `${operation} failed and was rolled back.`
                : `${operation} failed and its rollback was not durably committed.`,
        )
    }

    if (options.persistBeforeLifecycle) {
        try {
            requireCommittedDatabaseSave(
                await requestImmediateSave({ forceFullWrite: true }),
                operation,
            )
        } catch (saveError) {
            // No plugin code has run yet, so the existing runtime generation
            // still matches the restored list and must not be torn down.
            return rollbackMutation([saveError], false)
        }
    }

    let lifecycleReport: PluginLifecycleReport = { failures: [] }
    let lifecycleError: unknown
    try {
        lifecycleReport = await loadPluginsWithReportUnlocked(
            lifecycleLease,
            options.reapplyAfterTeardown,
        )
    } catch (error) {
        lifecycleError = error
    }

    const actionableFailures = lifecycleReport.failures.filter(failure => !(
        options.rollbackOnReloadFailure
        && options.targetPluginName !== undefined
        && failure.phase === "v3-load"
        && failure.pluginName !== options.targetPluginName
    ))
    const unrelatedFailures = lifecycleReport.failures.filter(
        failure => !actionableFailures.includes(failure),
    )
    if (unrelatedFailures.length > 0) {
        // V3 startup already emits a plugin-specific error notification. Record
        // that the requested mutation remains valid despite those failures.
        console.warn(
            `[Plugins] ${operation} continued despite unrelated V3 startup failures:`,
            unrelatedFailures.map(failure => failure.pluginName),
        )
    }
    if (lifecycleError === undefined && actionableFailures.length > 0) {
        lifecycleError = pluginLifecycleError(actionableFailures)
    }

    if (lifecycleError && options.rollbackOnReloadFailure) {
        return rollbackMutation([lifecycleError], true)
    }

    try {
        requireCommittedDatabaseSave(
            await requestImmediateSave({ forceFullWrite: true }),
            operation,
        )
    } catch (saveError) {
        if (options.persistBeforeLifecycle) {
            throw new AggregateError(
                lifecycleError ? [lifecycleError, saveError] : [saveError],
                `${operation} was durably committed, but plugin cleanup state was not durably saved.`,
            )
        }
        return rollbackMutation(
            lifecycleError ? [lifecycleError, saveError] : [saveError],
            true,
        )
    }

    if (lifecycleError) {
        throw new AggregateError(
            [lifecycleError],
            `${operation} was durably committed, but plugin teardown or reload failed.`,
        )
    }
}

export type PluginEnabledUpdateResult = "updated" | "blocked" | "missing"

export function setPluginEnabledAndReload(
    pluginName: string,
    enabled: boolean,
): Promise<PluginEnabledUpdateResult> {
    return withPluginLifecycleLock(async (lifecycleLease) => {
        const db = getDatabase()
        const plugin = db.plugins?.find(candidate => candidate.name === pluginName)
        if (!plugin) return "missing"
        if (enabled && !canEnablePlugin(plugin, db.optimizePluginMemory)) return "blocked"

        const originalIndex = db.plugins.indexOf(plugin)
        const originalPlugin = safeStructuredClone(plugin)
        plugin.enabled = enabled
        setDatabaseLite(db)
        await commitPluginListMutation(
            lifecycleLease,
            `Plugin ${enabled ? "enable" : "disable"}`,
            () => restorePluginInLiveList(pluginName, originalIndex, originalPlugin),
            {
                rollbackOnReloadFailure: enabled,
                targetPluginName: enabled ? pluginName : undefined,
                persistBeforeLifecycle: !enabled,
                reapplyAfterTeardown: enabled ? undefined : () => {
                    const liveDatabase = getDatabase()
                    const livePlugin = liveDatabase.plugins?.find(
                        candidate => candidate.name === pluginName,
                    )
                    if (livePlugin) {
                        livePlugin.enabled = false
                        liveDatabase.plugins = (liveDatabase.plugins ?? []).filter(
                            candidate => candidate.name !== pluginName
                                || candidate === livePlugin,
                        )
                    } else {
                        const disabledPlugin = safeStructuredClone(originalPlugin)
                        disabledPlugin.enabled = false
                        const insertionIndex = Math.min(
                            Math.max(originalIndex, 0),
                            liveDatabase.plugins?.length ?? 0,
                        )
                        liveDatabase.plugins ??= []
                        liveDatabase.plugins.splice(insertionIndex, 0, disabledPlugin)
                    }
                    setDatabaseLite(liveDatabase)
                },
            },
        )
        return "updated"
    })
}

export function removePluginAndReload(pluginName: string): Promise<boolean> {
    return withPluginLifecycleLock(async (lifecycleLease) => {
        const db = getDatabase()
        const index = db.plugins?.findIndex(plugin => plugin.name === pluginName) ?? -1
        if (index === -1) return false

        const removedPlugin = safeStructuredClone(db.plugins[index])
        const previousProvider = db.currentPluginProvider
        if (db.currentPluginProvider === pluginName) db.currentPluginProvider = ""
        db.plugins.splice(index, 1)
        setDatabaseLite(db)
        await commitPluginListMutation(
            lifecycleLease,
            "Plugin removal",
            () => {
                restorePluginInLiveList(pluginName, index, removedPlugin)
                getDatabase().currentPluginProvider = previousProvider
            },
            {
                rollbackOnReloadFailure: false,
                persistBeforeLifecycle: true,
                reapplyAfterTeardown: () => {
                    const liveDatabase = getDatabase()
                    liveDatabase.plugins = (liveDatabase.plugins ?? [])
                        .filter(plugin => plugin.name !== pluginName)
                    if (liveDatabase.currentPluginProvider === pluginName) {
                        liveDatabase.currentPluginProvider = ""
                    }
                    setDatabaseLite(liveDatabase)
                },
            },
        )
        return true
    })
}

export type PluginV2ProviderArgument = {
    prompt_chat: OpenAIChat[]
    frequency_penalty: number
    min_p: number
    presence_penalty: number
    repetition_penalty: number
    top_k: number
    top_p: number
    temperature: number
    mode: string
    max_tokens: number
}

export type PluginV2ProviderOptions = {
    tokenizer?: string
    tokenizerFunc?: (content: string) => number[] | Promise<number[]>
}

export type EditFunction = (content: string) => string | null | undefined | Promise<string | null | undefined>
type ReplacerFunction = (content: OpenAIChat[], type: string) => OpenAIChat[] | Promise<OpenAIChat[]>

export const pluginV2 = {
    providers: new Map<string, (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string | ReadableStream<string> }>>(),
    providerOptions: new Map<string, PluginV2ProviderOptions>(),
    editdisplay: new Set<EditFunction>(),
    editoutput: new Set<EditFunction>(),
    editprocess: new Set<EditFunction>(),
    editinput: new Set<EditFunction>(),
    replacerbeforeRequest: new Set<ReplacerFunction>(),
    replacerafterRequest: new Set<(content: string, type: string) => string | Promise<string>>(),
    unload: new Set<() => void | Promise<void>>(),
    loaded: false
}

export function clearPluginV2RuntimeRegistries() {
    pluginV2.unload.clear()
    pluginV2.loaded = false
    pluginV2.providers.clear()
    pluginV2.providerOptions.clear()
    pluginV2.editdisplay.clear()
    pluginV2.editoutput.clear()
    pluginV2.editprocess.clear()
    pluginV2.editinput.clear()
    pluginV2.replacerbeforeRequest.clear()
    pluginV2.replacerafterRequest.clear()
    customProviderStore.set([])
}

export const allowedDbKeys = [
    'characters',
    'modules',
    'enabledModules',
    'moduleIntergration',
    'pluginV2',
    'personas',
    'plugins',
    'pluginCustomStorage',
    'temperature',
    'maxContext',
    'maxResponse',
    'frequencyPenalty',
    'PresensePenalty',
    'theme',
    'textTheme',
    'lineHeight',
    'seperateModelsForAxModels',
    'seperateModels',
    'customCSS',
    'guiHTML',
    'colorSchemeName',
    'selectedPersona',
    'characterOrder'
]

export const V2_PLUGIN_UNLOAD_GRACE_MS = 5_000

type V2PluginApiGeneration = {
    readonly id: symbol
    active: boolean
}

let activeV2PluginApiGeneration: V2PluginApiGeneration | undefined

function assertV2PluginApiGenerationActive(
    generation: V2PluginApiGeneration | undefined,
): void {
    if (generation && !generation.active) {
        throw new Error("This V2 plugin generation has already been unloaded.")
    }
}

/**
 * Keep every host object reached through a loaded V2 generation revocable.
 * Functions are wrapped at property-read time, so callbacks that retain a
 * method cannot regain access by waiting until a newer generation is live.
 */
function createV2PluginApiGenerationFacade<T extends object>(
    source: T,
    generation: V2PluginApiGeneration,
): T {
    const facadeBySource = new WeakMap<object, object>()
    const sourceByFacade = new WeakMap<object, object>()

    const unwrap = <V>(value: V): V => {
        if ((typeof value === "object" && value !== null) || typeof value === "function") {
            return (sourceByFacade.get(value as object) ?? value) as V
        }
        return value
    }

    const wrap = <V>(value: V): V => {
        if ((typeof value !== "object" || value === null) && typeof value !== "function") {
            return value
        }
        const target = value as object
        const cached = facadeBySource.get(target)
        if (cached) return cached as V

        const facade = new Proxy(target, {
            apply(callable, thisArg, args) {
                assertV2PluginApiGenerationActive(generation)
                const result = Reflect.apply(
                    callable as (...args: unknown[]) => unknown,
                    unwrap(thisArg),
                    args.map(unwrap),
                )
                // Function.prototype.bind/valueOf can otherwise reveal a raw
                // host method that outlives this generation.
                return typeof result === "function" ? wrap(result) : result
            },
            construct(callable, args, newTarget) {
                assertV2PluginApiGenerationActive(generation)
                return wrap(Reflect.construct(
                    callable as new (...args: unknown[]) => object,
                    args.map(unwrap),
                    unwrap(newTarget),
                ))
            },
            get(nestedTarget, prop, receiver) {
                assertV2PluginApiGenerationActive(generation)
                const descriptor = Reflect.getOwnPropertyDescriptor(nestedTarget, prop)
                if (descriptor
                    && !descriptor.configurable
                    && "value" in descriptor
                    && !descriptor.writable) {
                    // Proxy invariants require the exact value for intrinsic
                    // non-configurable callable metadata.
                    return descriptor.value
                }
                return wrap(Reflect.get(nestedTarget, prop, receiver))
            },
            set(nestedTarget, prop, nestedValue, receiver) {
                assertV2PluginApiGenerationActive(generation)
                return Reflect.set(nestedTarget, prop, nestedValue, receiver)
            },
            deleteProperty(nestedTarget, prop) {
                assertV2PluginApiGenerationActive(generation)
                return Reflect.deleteProperty(nestedTarget, prop)
            },
            defineProperty(nestedTarget, prop, descriptor) {
                assertV2PluginApiGenerationActive(generation)
                return Reflect.defineProperty(
                    nestedTarget,
                    prop,
                    descriptor,
                )
            },
            getOwnPropertyDescriptor(nestedTarget, prop) {
                assertV2PluginApiGenerationActive(generation)
                const descriptor = Reflect.getOwnPropertyDescriptor(nestedTarget, prop)
                if (!descriptor || !("value" in descriptor) || !descriptor.configurable) {
                    return descriptor
                }
                return { ...descriptor, value: wrap(descriptor.value) }
            },
            getPrototypeOf(nestedTarget) {
                assertV2PluginApiGenerationActive(generation)
                return Reflect.getPrototypeOf(nestedTarget)
            },
            setPrototypeOf(nestedTarget, prototype) {
                assertV2PluginApiGenerationActive(generation)
                return Reflect.setPrototypeOf(nestedTarget, prototype)
            },
            has(nestedTarget, prop) {
                assertV2PluginApiGenerationActive(generation)
                return Reflect.has(nestedTarget, prop)
            },
            ownKeys(nestedTarget) {
                assertV2PluginApiGenerationActive(generation)
                return Reflect.ownKeys(nestedTarget)
            },
            isExtensible(nestedTarget) {
                assertV2PluginApiGenerationActive(generation)
                return Reflect.isExtensible(nestedTarget)
            },
            preventExtensions(_nestedTarget) {
                assertV2PluginApiGenerationActive(generation)
                // Keeping source properties configurable prevents Object.freeze
                // from forcing raw host functions through Proxy invariants.
                return false
            },
        })
        facadeBySource.set(target, facade)
        sourceByFacade.set(facade, target)
        return facade as V
    }

    return wrap(source)
}

export const getV2PluginAPIs = (generation?: V2PluginApiGeneration) => {
    const assertGenerationAccess = () => {
        assertV2PluginApiGenerationActive(generation)
    }
    const canUseSynchronousPluginStorage = () => {
        if (generation && !generation.active) return false
        const db = getDatabase()
        return db.optimizePluginMemory !== true && !isPluginStorageModeTransitioning()
    }
    const assertSynchronousPluginStorageAccess = () => {
        assertGenerationAccess()
        if (!canUseSynchronousPluginStorage()) {
            throw new Error("Legacy plugin database access is unavailable during a storage mode transition.")
        }
    }
    const guardedProxyByTarget = new WeakMap<object, object>()
    const targetByGuardedProxy = new WeakMap<object, object>()
    const unwrapGuardedValue = <T>(value: T): T => {
        if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
            return (targetByGuardedProxy.get(value as object) ?? value) as T
        }
        return value
    }
    /**
     * Detach V2/V2.1 inline values at the synchronous call boundary without
     * narrowing them to optimized storage's JSON-only domain. This mirrors the
     * structured-clone behavior already used by inline V3 storage while
     * avoiding arbitrary property reads from caller-controlled objects.
     *
     * Accessors remain unsupported because invoking a getter while taking the
     * pre-queue snapshot could mutate storage outside the transition barrier.
     * Enumerable data properties are normalized to ordinary mutable snapshot
     * properties, as the platform structured clone algorithm does.
     */
    const cloneLegacyStorageValue = <T>(input: T): T => {
        const snapshots = new Map<object, unknown>()

        const snapshot = (rawCandidate: unknown, path: string): unknown => {
            const candidate = unwrapGuardedValue(rawCandidate)
            if (candidate === null
                || candidate === undefined
                || typeof candidate === 'string'
                || typeof candidate === 'boolean'
                || typeof candidate === 'number'
                || typeof candidate === 'bigint') {
                return candidate
            }
            if (typeof candidate !== 'object') {
                throw new TypeError(`Legacy plugin storage requires cloneable data at ${path}.`)
            }

            const object = candidate as object
            const existing = snapshots.get(object)
            if (existing !== undefined || snapshots.has(object)) return existing

            // Brand checks use built-in operations rather than user-visible
            // methods, so an own getTime/entries/values override never runs.
            try {
                const value = Date.prototype.getTime.call(object)
                const result = new Date(value)
                snapshots.set(object, result)
                return result
            } catch {
                // Not a Date.
            }

            try {
                const iterator = Map.prototype.entries.call(object)
                const result = new Map<unknown, unknown>()
                snapshots.set(object, result)
                for (let next = iterator.next(); !next.done; next = iterator.next()) {
                    result.set(
                        snapshot(next.value[0], `${path}.<map key>`),
                        snapshot(next.value[1], `${path}.<map value>`),
                    )
                }
                return result
            } catch (error) {
                if (snapshots.has(object)) throw error
                // Not a Map.
            }

            try {
                const iterator = Set.prototype.values.call(object)
                const result = new Set<unknown>()
                snapshots.set(object, result)
                for (let next = iterator.next(); !next.done; next = iterator.next()) {
                    result.add(snapshot(next.value, `${path}.<set value>`))
                }
                return result
            } catch (error) {
                if (snapshots.has(object)) throw error
                // Not a Set.
            }

            if (object instanceof ArrayBuffer) {
                const result = object.slice(0)
                snapshots.set(object, result)
                return result
            }

            if (ArrayBuffer.isView(object)) {
                const source = object as ArrayBufferView & { length?: number }
                const clonedBuffer = snapshot(source.buffer, `${path}.buffer`) as ArrayBuffer
                let result: ArrayBufferView
                if (source instanceof DataView) {
                    result = new DataView(clonedBuffer, source.byteOffset, source.byteLength)
                } else {
                    const typedArrayConstructors: Record<string, new (
                        buffer: ArrayBuffer,
                        byteOffset: number,
                        length: number,
                    ) => ArrayBufferView> = {
                        Buffer: Uint8Array,
                        Int8Array,
                        Uint8Array,
                        Uint8ClampedArray,
                        Int16Array,
                        Uint16Array,
                        Int32Array,
                        Uint32Array,
                        Float32Array,
                        Float64Array,
                        ...(typeof BigInt64Array === 'undefined' ? {} : { BigInt64Array }),
                        ...(typeof BigUint64Array === 'undefined' ? {} : { BigUint64Array }),
                    }
                    const name = Object.getPrototypeOf(source)?.constructor?.name
                    const Constructor = typedArrayConstructors[name]
                    if (!Constructor || !Number.isSafeInteger(source.length)) {
                        throw new TypeError(`Legacy plugin storage received an unsupported binary view at ${path}.`)
                    }
                    result = new Constructor(
                        clonedBuffer,
                        source.byteOffset,
                        source.length!,
                    )
                }
                snapshots.set(object, result)
                return result
            }

            if (object instanceof RegExp) {
                const result = new RegExp(object.source, object.flags)
                result.lastIndex = object.lastIndex
                snapshots.set(object, result)
                return result
            }

            const isArray = Array.isArray(object)
            let result: Record<PropertyKey, unknown> | unknown[]
            if (isArray) {
                const lengthDescriptor = Reflect.getOwnPropertyDescriptor(object, 'length')
                const length = lengthDescriptor && "value" in lengthDescriptor
                    ? lengthDescriptor.value
                    : undefined
                if (!Number.isSafeInteger(length) || length < 0) {
                    throw new TypeError(`Legacy plugin storage received an invalid array at ${path}.`)
                }
                result = new Array(length)
            } else {
                // structuredClone and msgpack both turn custom instances into
                // ordinary data objects. defineProperty keeps __proto__ inert.
                result = {}
            }
            snapshots.set(object, result)

            for (const key of Reflect.ownKeys(object)) {
                if (key === 'length' && isArray) continue
                // Structured clone and msgpack omit symbol and hidden fields.
                if (typeof key !== 'string') continue
                const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
                if (!descriptor || !descriptor.enumerable) continue
                if (!("value" in descriptor)) {
                    throw new TypeError(`Legacy plugin storage does not accept accessors at ${path}.${key}.`)
                }
                Object.defineProperty(result, key, {
                    configurable: true,
                    enumerable: true,
                    value: snapshot(descriptor.value, `${path}.${key}`),
                    writable: true,
                })
            }
            return result
        }

        return snapshot(input, "$") as T
    }

    const cloneLegacyStorageRecord = (input: unknown): Record<string, unknown> => {
        const source = unwrapGuardedValue(input)
        if (source === null || typeof source !== 'object' || Array.isArray(source)) {
            throw new TypeError("Legacy plugin storage must be an object.")
        }
        const prototype = Reflect.getPrototypeOf(source)
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("Legacy plugin storage must be a plain object.")
        }
        const result = createDatabasePluginStorageRecord<unknown>()
        for (const key of Reflect.ownKeys(source)) {
            if (typeof key !== 'string') {
                throw new TypeError("Legacy plugin storage does not accept symbol keys.")
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(source, key)
            if (!descriptor || !("value" in descriptor)) {
                throw new TypeError(`Legacy plugin storage does not accept an accessor for ${key}.`)
            }
            if (!descriptor.enumerable) {
                throw new TypeError(`Legacy plugin storage requires enumerable data for ${key}.`)
            }
            definePluginStorageRecordValue(
                result,
                key,
                cloneLegacyStorageValue(descriptor.value),
            )
        }
        return result
    }
    const validateLegacyStorageDescriptor = (
        descriptor: PropertyDescriptor,
        storageRecord = false,
    ): unknown => {
        if (!("value" in descriptor) || descriptor.get || descriptor.set) {
            throw new TypeError("Legacy plugin storage does not accept accessor descriptors.")
        }
        if (descriptor.configurable !== true
            || descriptor.enumerable !== true
            || descriptor.writable !== true) {
            throw new TypeError(
                "Legacy plugin storage descriptors must be configurable, enumerable, and writable.",
            )
        }
        return storageRecord
            ? cloneLegacyStorageRecord(descriptor.value)
            : cloneLegacyStorageValue(descriptor.value)
    }
    const guardedStorageProxyByTarget = new WeakMap<object, object>()
    const guardNestedValue = <T>(value: T, storageValue = false): T => {
        if (typeof value !== 'object' || value === null) return value
        const target = value as object
        const proxyCache = storageValue ? guardedStorageProxyByTarget : guardedProxyByTarget
        const cached = proxyCache.get(target)
        if (cached) return cached as T

        const guarded = new Proxy(target, {
            get(nestedTarget, prop, receiver) {
                assertSynchronousPluginStorageAccess()
                return guardNestedValue(Reflect.get(nestedTarget, prop, receiver), storageValue)
            },
            set(nestedTarget, prop, nestedValue) {
                assertSynchronousPluginStorageAccess()
                if (storageValue) {
                    if (Array.isArray(nestedTarget) && prop === 'length') {
                        const changed = Reflect.set(nestedTarget, prop, nestedValue, nestedTarget)
                        if (changed) markPluginStorageKeySetChanged()
                        return changed
                    }
                    defineLegacyStorageValue(
                        nestedTarget as Record<PropertyKey, unknown>,
                        prop,
                        nestedValue,
                    )
                    markPluginStorageKeySetChanged()
                    return true
                }
                return Reflect.set(
                    nestedTarget,
                    prop,
                    unwrapGuardedValue(nestedValue),
                    nestedTarget,
                )
            },
            deleteProperty(nestedTarget, prop) {
                assertSynchronousPluginStorageAccess()
                const changed = Reflect.deleteProperty(nestedTarget, prop)
                if (changed && storageValue) markPluginStorageKeySetChanged()
                return changed
            },
            defineProperty(nestedTarget, prop, descriptor) {
                assertSynchronousPluginStorageAccess()
                if (storageValue) {
                    setDatabasePluginStorageRecordValue(
                        nestedTarget as Record<string, unknown>,
                        prop,
                        validateLegacyStorageDescriptor(descriptor),
                    )
                    markPluginStorageKeySetChanged()
                    return true
                }
                const guardedDescriptor = "value" in descriptor
                    ? { ...descriptor, value: unwrapGuardedValue(descriptor.value) }
                    : descriptor
                return Reflect.defineProperty(nestedTarget, prop, guardedDescriptor)
            },
            has(nestedTarget, prop) {
                assertSynchronousPluginStorageAccess()
                return Reflect.has(nestedTarget, prop)
            },
            ownKeys(nestedTarget) {
                assertSynchronousPluginStorageAccess()
                return Reflect.ownKeys(nestedTarget)
            },
            getOwnPropertyDescriptor(nestedTarget, prop) {
                assertSynchronousPluginStorageAccess()
                const descriptor = Reflect.getOwnPropertyDescriptor(nestedTarget, prop)
                if (!descriptor || !("value" in descriptor) || !descriptor.configurable) {
                    return descriptor
                }
                return {
                    ...descriptor,
                    value: guardNestedValue(descriptor.value, storageValue),
                }
            },
            getPrototypeOf(nestedTarget) {
                assertSynchronousPluginStorageAccess()
                return Reflect.getPrototypeOf(nestedTarget)
            },
            setPrototypeOf(nestedTarget, prototype) {
                assertSynchronousPluginStorageAccess()
                if (storageValue) {
                    throw new TypeError("Legacy plugin storage prototypes cannot be changed.")
                }
                return Reflect.setPrototypeOf(nestedTarget, prototype)
            },
            isExtensible(nestedTarget) {
                assertSynchronousPluginStorageAccess()
                return Reflect.isExtensible(nestedTarget)
            },
            preventExtensions(nestedTarget) {
                assertSynchronousPluginStorageAccess()
                if (storageValue) {
                    throw new TypeError("Legacy plugin storage objects must remain extensible.")
                }
                return Reflect.preventExtensions(nestedTarget)
            },
        })
        proxyCache.set(target, guarded)
        targetByGuardedProxy.set(guarded, target)
        return guarded as T
    }
    const readLegacyStorageInput = (
        source: object,
        key: string,
        storageRecord = false,
    ): unknown => {
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key)
        if (!descriptor || !("value" in descriptor)) {
            throw new TypeError(`Legacy plugin storage does not accept an accessor for ${key}.`)
        }
        if (!descriptor.configurable || !descriptor.enumerable) {
            throw new TypeError(
                `Legacy plugin storage requires configurable enumerable data for ${key}.`,
            )
        }
        return storageRecord
            ? cloneLegacyStorageRecord(descriptor.value)
            : cloneLegacyStorageValue(descriptor.value)
    }
    const defineLegacyStorageValue = (
        storage: Record<PropertyKey, unknown>,
        key: PropertyKey,
        value: unknown,
    ): void => {
        setDatabasePluginStorageRecordValue(
            storage as Record<string, unknown>,
            key,
            cloneLegacyStorageValue(value),
        )
    }
    const replaceLegacyStorageValue = (
        db: ReturnType<typeof getDatabase>,
        key: PropertyKey,
        value: unknown,
    ): void => {
        // Svelte's state proxy cannot enumerate a first virtual `__proto__`
        // source because its ownKeys implementation treats the inherited
        // Object.prototype member as already present. Seed every root write on
        // a detached record and replace the map so all keys are real target
        // properties. The live facade below keeps retained handles current.
        const next = copyDatabasePluginStorageRecord(db.pluginCustomStorage)
        definePluginStorageRecordValue(next, key, cloneLegacyStorageValue(value))
        db.pluginCustomStorage = next
        markPluginStorageKeySetChanged()
    }
    const removeLegacyStorageValue = (
        db: ReturnType<typeof getDatabase>,
        key: PropertyKey,
    ): boolean => {
        if (!hasPluginStorageRecordValue(db.pluginCustomStorage, key)) return true
        const next = copyDatabasePluginStorageRecord(db.pluginCustomStorage)
        Reflect.deleteProperty(next, key)
        db.pluginCustomStorage = next
        markPluginStorageKeySetChanged()
        return true
    }
    const snapshotLegacyStorage = (): Record<string, unknown> => {
        const source = getDatabase().pluginCustomStorage
            ?? createDatabasePluginStorageRecord<unknown>()
        const snapshot = createPluginStorageRecord<unknown>()
        const seen = new WeakSet<object>()
        const trackNestedState = (candidate: unknown): void => {
            if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) {
                return
            }
            seen.add(candidate)
            for (const key of getPluginStorageRecordKeys(
                candidate as Record<string, unknown>,
            )) {
                trackNestedState((candidate as Record<string, unknown>)[key])
            }
        }
        for (const key of getPluginStorageRecordKeys(source)) {
            const value = source[key]
            // Descriptor-only cloning intentionally avoids arbitrary Proxy get
            // traps. These values have already crossed that validated ingress,
            // so explicitly read their nested state here to establish Svelte
            // dependencies for JSON/snapshot effects on the facade.
            trackNestedState(value)
            definePluginStorageRecordValue(
                snapshot,
                key,
                cloneLegacyStorageValue(value),
            )
        }
        return snapshot
    }
    let legacyStorageFacade: Record<PropertyKey, unknown> | null = null
    const getLegacyStorageFacade = (): Record<PropertyKey, unknown> => {
        if (legacyStorageFacade) return legacyStorageFacade

        const facadeToJSON = () => snapshotLegacyStorage()
        legacyStorageFacade = new Proxy(Object.create(null), {
            get(_target, prop, receiver) {
                assertSynchronousPluginStorageAccess()
                const storage = getDatabase().pluginCustomStorage
                if (hasPluginStorageRecordValue(storage, prop)) {
                    return guardNestedValue(storage![prop as keyof typeof storage], true)
                }
                // Keep the virtual toJSON hook ahead of inherited lookup so
                // JSON serialization preserves an own `__proto__` without
                // exposing the hook as an enumerable storage key.
                if (prop === "toJSON") return facadeToJSON
                // The proxy target stays prototype-free so special storage
                // keys are inert, but the public V2 facade must retain the
                // ordinary-object behavior exposed by main and upstream.
                return Reflect.get(Object.prototype, prop, receiver)
            },
            set(_target, prop, value) {
                assertSynchronousPluginStorageAccess()
                replaceLegacyStorageValue(getDatabase(), prop, value)
                return true
            },
            deleteProperty(_target, prop) {
                assertSynchronousPluginStorageAccess()
                return removeLegacyStorageValue(getDatabase(), prop)
            },
            defineProperty(_target, prop, descriptor) {
                assertSynchronousPluginStorageAccess()
                replaceLegacyStorageValue(
                    getDatabase(),
                    prop,
                    validateLegacyStorageDescriptor(descriptor),
                )
                return true
            },
            has(_target, prop) {
                assertSynchronousPluginStorageAccess()
                return hasPluginStorageRecordValue(getDatabase().pluginCustomStorage, prop)
                    || Reflect.has(Object.prototype, prop)
            },
            ownKeys() {
                assertSynchronousPluginStorageAccess()
                return Reflect.ownKeys(
                    getDatabase().pluginCustomStorage
                        ?? createDatabasePluginStorageRecord<unknown>(),
                )
            },
            getOwnPropertyDescriptor(_target, prop) {
                assertSynchronousPluginStorageAccess()
                const storage = getDatabase().pluginCustomStorage
                const descriptor = storage
                    ? Reflect.getOwnPropertyDescriptor(storage, prop)
                    : undefined
                if (!descriptor) return undefined
                if (!("value" in descriptor)) {
                    throw new TypeError("Legacy plugin storage does not accept accessor descriptors.")
                }
                return {
                    configurable: true,
                    enumerable: descriptor.enumerable,
                    value: guardNestedValue(descriptor.value, true),
                    writable: true,
                }
            },
            getPrototypeOf() {
                assertSynchronousPluginStorageAccess()
                return Object.prototype
            },
            setPrototypeOf() {
                assertSynchronousPluginStorageAccess()
                throw new TypeError("Legacy plugin storage prototypes cannot be changed.")
            },
            isExtensible() {
                assertSynchronousPluginStorageAccess()
                return true
            },
            preventExtensions() {
                assertSynchronousPluginStorageAccess()
                throw new TypeError("Legacy plugin storage objects must remain extensible.")
            },
        })
        return legacyStorageFacade
    }

    const pluginApis = {
        risuFetch: globalFetch,
        nativeFetch: fetchNative,
        getArg: (arg: string) => {
            const db = getDatabase()
            const [name, realArg] = arg.split('::')
            for (const plugin of db.plugins) {
                if (plugin.name === name) {
                    return plugin.realArg[realArg]
                }
            }
        },
        getChar: () => {
            return getCurrentCharacter({ snapshot: true })
        },
        setChar: (char: any) => {
            const db = getDatabase()
            const charid = get(selectedCharID)
            // Do not retain a plugin-owned raw alias behind Svelte's deep
            // proxy. Later writes through that alias would bypass reactive
            // dirty revisions.
            db.characters[charid] = cloneDatabaseField('characters', char)
            setDatabaseLite(db)
        },
        addProvider: (name: string, func: (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string }>, options?: PluginV2ProviderOptions) => {
            let provs = get(customProviderStore)
            provs.push(name)
            pluginV2.providers.set(name, func)
            pluginV2.providerOptions.set(name, options ?? {})
            customProviderStore.set(provs)
        },
        addRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
            if (pluginV2['edit' + name]) {
                pluginV2['edit' + name].add(func)
            }
            else {
                throw (`script handler named ${name} not found`)
            }
        },
        removeRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
            if (pluginV2['edit' + name]) {
                pluginV2['edit' + name].delete(func)
            }
            else {
                throw (`script handler named ${name} not found`)
            }
        },
        addRisuReplacer: (name: string, func: ReplacerFunction) => {
            if (pluginV2['replacer' + name]) {
                pluginV2['replacer' + name].add(func)
            }
            else {
                throw (`replacer handler named ${name} not found`)
            }
        },
        removeRisuReplacer: (name: string, func: ReplacerFunction) => {
            if (pluginV2['replacer' + name]) {
                pluginV2['replacer' + name].delete(func)
            }
            else {
                throw (`replacer handler named ${name} not found`)
            }
        },
        onUnload: (func: () => void | Promise<void>) => {
            pluginV2.unload.add(func)
        },
        setArg: (arg: string, value: string | number) => {
            const db = getDatabase();
            const [name, realArg] = arg.split("::");
            for (const plugin of db.plugins) {
                if (plugin.name === name) {
                    plugin.realArg[realArg] = value;
                }
            }
        },
        safeGlobalThis: {} as any,
        getSafeGlobalThis: () => {
            if(Object.keys(globalThis.__pluginApis__.safeGlobalThis).length > 0){
                return globalThis.__pluginApis__.safeGlobalThis;
            }
            //safeGlobalThis
            const keys = Object.keys(globalThis);
            const safeGlobal: any = {};
            const allowedKeys = [
                'console',
                'TextEncoder',
                'TextDecoder',
                'URL',
                'URLSearchParams',
            ]
            for (const key of keys) {
                if(allowedKeys.includes(key)){
                    safeGlobal[key] = (globalThis as any)[key];
                }
            }

            //compatibility layer with old unsafe APIs

            //from PBV2
            safeGlobal.showDirectoryPicker = (...args: Parameters<typeof window.showDirectoryPicker>) => {
                assertGenerationAccess()
                return window.showDirectoryPicker(...args)
            }

            safeGlobal.DBState = {
                db: toGetter(
                    globalThis.__pluginApis__.getDatabase
                )
            }
            safeGlobal.setInterval = (...args: any[]) => {
                assertGenerationAccess()
                //@ts-expect-error spreading any[] into setInterval params causes type mismatch with TimerHandler signature
                return globalThis.setInterval(...args);
            }
            safeGlobal.setTimeout = (...args: any[]) => {
                assertGenerationAccess()
                //@ts-expect-error spreading any[] into setTimeout params causes type mismatch with TimerHandler signature
                return globalThis.setTimeout(...args);
            }
            safeGlobal.clearInterval = (...args: any[]) => {
                assertGenerationAccess()
                //@ts-expect-error spreading any[] into clearInterval - first arg should be number | undefined
                return globalThis.clearInterval(...args);
            }
            safeGlobal.clearTimeout = (...args: any[]) => {
                assertGenerationAccess()
                //@ts-expect-error spreading any[] into clearTimeout - first arg should be number | undefined
                return globalThis.clearTimeout(...args);
            }
            safeGlobal.alert = (...args: Parameters<typeof globalThis.alert>) => {
                assertGenerationAccess()
                return globalThis.alert(...args)
            };
            safeGlobal.confirm = (...args: Parameters<typeof globalThis.confirm>) => {
                assertGenerationAccess()
                return globalThis.confirm(...args)
            };
            safeGlobal.prompt = (...args: Parameters<typeof globalThis.prompt>) => {
                assertGenerationAccess()
                return globalThis.prompt(...args)
            };
            safeGlobal.innerWidth = window.innerWidth;
            safeGlobal.innerHeight = window.innerHeight;
            safeGlobal.getComputedStyle = (...args: Parameters<typeof window.getComputedStyle>) => {
                assertGenerationAccess()
                return window.getComputedStyle(...args)
            }
            safeGlobal.navigator = window.navigator;
            safeGlobal.localStorage = globalThis.__pluginApis__.safeLocalStorage;
            safeGlobal.indexedDB = globalThis.__pluginApis__.safeIdbFactory;
            safeGlobal.__pluginApis__ = globalThis.__pluginApis__
            safeGlobal.Object = Object;
            safeGlobal.Array = Array;
            safeGlobal.String = String;
            safeGlobal.Number = Number;
            safeGlobal.Boolean = Boolean;
            safeGlobal.Math = Math;
            safeGlobal.Date = Date;
            safeGlobal.RegExp = RegExp;
            safeGlobal.Error = Error;
            safeGlobal.Function = globalThis.__pluginApis__.SafeFunction;
            safeGlobal.document = globalThis.__pluginApis__.safeDocument;
            safeGlobal.addEventListener = (...args: any[]) => {
                assertGenerationAccess()
                //@ts-expect-error spreading any[] into addEventListener - expects (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions)
                window.addEventListener(...args);
            }
            safeGlobal.removeEventListener = (...args: any[]) => {
                assertGenerationAccess()
                //@ts-expect-error spreading any[] into removeEventListener - expects (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions)
                window.removeEventListener(...args);
            }
            return safeGlobal;
        },
        safeLocalStorage: new SafeLocalStorage(),
        safeIdbFactory: SafeIdbFactory,
        safeDocument: SafeDocument,
        alertStore: {
            set: (msg: string) => {}
        },
        apiVersion: "2.1",
        apiVersionCompatibleWith: ["2.0","2.1"],
        // The proxy and pluginStorage object below are the synchronous
        // V2/V2.1 compatibility surface. Optimized mode prevents those plugins
        // from loading; V3 uses the async mode-aware aliases in v3.svelte.ts.
        getDatabase: () => {
            const db = DBState?.db
            if(!db){
                return {}
            }
            return new Proxy(db, {
                get(target, prop) {
                    assertSynchronousPluginStorageAccess()
                    if (typeof prop === 'string' && allowedDbKeys.includes(prop)) {
                        if (prop === 'pluginCustomStorage') {
                            return getLegacyStorageFacade()
                        }
                        return guardNestedValue(
                            (target as any)[prop],
                            false,
                        );
                    }
                    else if(target.pluginCustomStorage){
                        console.log('Getting custom db property', prop.toString());
                        if (!hasPluginStorageRecordValue(
                            target.pluginCustomStorage,
                            prop.toString(),
                        )) return undefined;
                        return guardNestedValue(
                            target.pluginCustomStorage[prop.toString()],
                            true,
                        );
                    }
                    return undefined;
                },
                set(target, prop, value) {
                    assertSynchronousPluginStorageAccess()
                    if (typeof prop === 'string' && allowedDbKeys.includes(prop)) {
                        (target as any)[prop] = prop === 'pluginCustomStorage'
                            ? cloneLegacyStorageRecord(value)
                            : unwrapGuardedValue(value);
                        if (prop === 'pluginCustomStorage') {
                            markPluginStorageKeySetChanged()
                        }
                        return true;
                    }
                    else{
                        console.log('Setting custom db property', prop.toString(), value);
                        replaceLegacyStorageValue(target, prop, value)
                        return true;
                    }
                },
                ownKeys(target) {
                    assertSynchronousPluginStorageAccess()
                    const keys = new Set(Reflect.ownKeys(target).filter(
                        key => typeof key === 'string' && allowedDbKeys.includes(key),
                    ));
                    if(target.pluginCustomStorage){
                        for (const key of getPluginStorageRecordKeys(target.pluginCustomStorage)) {
                            keys.add(key)
                        }
                    }
                    return [...keys];
                },
                deleteProperty(target, prop) {
                    assertSynchronousPluginStorageAccess()
                    console.log('Attempt to delete db.' + String(prop) + ' denied in safe database proxy.');
                    return false;
                },
                getPrototypeOf(target) {
                    assertSynchronousPluginStorageAccess()
                    return Reflect.getPrototypeOf(target);
                },
                setPrototypeOf() {
                    assertSynchronousPluginStorageAccess()
                    throw new TypeError("Legacy plugin database prototypes cannot be changed.")
                },
                isExtensible(target) {
                    assertSynchronousPluginStorageAccess()
                    return Reflect.isExtensible(target)
                },
                preventExtensions() {
                    assertSynchronousPluginStorageAccess()
                    throw new TypeError("Legacy plugin database proxies must remain extensible.")
                },
                has(target, prop) {
                    assertSynchronousPluginStorageAccess()
                    return (typeof prop === 'string' && allowedDbKeys.includes(prop))
                        || Object.hasOwn(target.pluginCustomStorage ?? {}, prop)
                },
                defineProperty(target, prop, descriptor) {
                    assertSynchronousPluginStorageAccess()
                    if (typeof prop === 'string' && allowedDbKeys.includes(prop)) {
                        if (!("value" in descriptor)) return false
                        const defined = Reflect.defineProperty(target, prop, {
                            ...descriptor,
                            value: prop === 'pluginCustomStorage'
                                ? validateLegacyStorageDescriptor(descriptor, true)
                                : unwrapGuardedValue(descriptor.value),
                        })
                        if (defined && prop === 'pluginCustomStorage') {
                            markPluginStorageKeySetChanged()
                        }
                        return defined
                    }
                    replaceLegacyStorageValue(
                        target,
                        prop,
                        validateLegacyStorageDescriptor(descriptor),
                    )
                    return true
                },
                getOwnPropertyDescriptor(target, prop) {
                    assertSynchronousPluginStorageAccess()
                    const source = typeof prop === 'string' && allowedDbKeys.includes(prop)
                        ? target
                        : target.pluginCustomStorage
                    const descriptor = source
                        ? Reflect.getOwnPropertyDescriptor(source, prop)
                        : undefined
                    if (!descriptor || !("value" in descriptor) || !descriptor.configurable) {
                        return descriptor
                    }
                    const storageValue = !(typeof prop === 'string' && allowedDbKeys.includes(prop))
                        || prop === 'pluginCustomStorage'
                    return {
                        ...descriptor,
                        value: prop === 'pluginCustomStorage'
                            ? getLegacyStorageFacade()
                            : guardNestedValue(descriptor.value, storageValue),
                    }
                },
            })
        },
        pluginStorage: {
            getItem: (key: string) => {
                if (!canUseSynchronousPluginStorage()) return null
                // Svelte's snapshot currently omits an own `__proto__` key.
                // Read the live proxy with an own-presence check, then return
                // the same detached structured-clone value used by legacy writes.
                const db = getDatabase();
                if (!hasPluginStorageRecordValue(db.pluginCustomStorage, key)) return null;
                const value = db.pluginCustomStorage![key];
                return value === undefined || value === null
                    ? null
                    : cloneLegacyStorageValue(value);
            },
            setItem: (key: string, value: unknown) => {
                if (!canUseSynchronousPluginStorage()) return
                const db = getDatabase();
                replaceLegacyStorageValue(db, key, value)
            },
            removeItem: (key: string) => {
                if (!canUseSynchronousPluginStorage()) return
                const db = getDatabase();
                removeLegacyStorageValue(db, key)
            },
            clear: () => {
                if (!canUseSynchronousPluginStorage()) return
                const db = getDatabase();
                db.pluginCustomStorage = createDatabasePluginStorageRecord();
                markPluginStorageKeySetChanged()
            },
            key: (index: number) => {
                if (!canUseSynchronousPluginStorage()) return null
                const db = getDatabase();
                db.pluginCustomStorage ??= createDatabasePluginStorageRecord()
                const keys = getPluginStorageRecordKeys(db.pluginCustomStorage);
                return keys[index] ?? null;
            },
            keys: () => {
                if (!canUseSynchronousPluginStorage()) return []
                const db = getDatabase();
                db.pluginCustomStorage ??= createDatabasePluginStorageRecord()
                return getPluginStorageRecordKeys(db.pluginCustomStorage);
            },
            length: () => {
                if (!canUseSynchronousPluginStorage()) return 0
                const db = getDatabase();
                db.pluginCustomStorage ??= createDatabasePluginStorageRecord()
                return getPluginStorageRecordKeys(db.pluginCustomStorage).length;
            }
        },
        setDatabaseLite: (newDb: any) => {
            // A stale legacy task can retain this API while a transition is
            // pending, so enforce the transition guard at the mutation itself.
            if (!canUseSynchronousPluginStorage()) return
            const db = getDatabase();
            db.pluginCustomStorage ??= createDatabasePluginStorageRecord()
            for (const key of Object.keys(newDb)) {
                if (allowedDbKeys.includes(key)) {
                    if (key === 'pluginCustomStorage') {
                        // Publish invalidation with the successful key-set
                        // replacement itself. A later field may throw, so an
                        // end-of-loop marker cannot keep V3 key()/length()
                        // coherent with this already-visible mutation.
                        db.pluginCustomStorage = readLegacyStorageInput(newDb, key, true) as any
                        markPluginStorageKeySetChanged()
                    } else {
                        (db as any)[key] = cloneDatabaseField(key, newDb[key])
                    }
                }
                else{
                    replaceLegacyStorageValue(db, key, readLegacyStorageInput(newDb, key))
                }
            }
            DBState.db = db;
        },
        setDatabase: async (newDb: any) => {
            // V2-only compatibility path; see setDatabaseLite above. Plugin
            // installation delegated below accepts V3 plugins only.
            if (!canUseSynchronousPluginStorage()) return
            const db = getDatabase();
            db.pluginCustomStorage ??= createDatabasePluginStorageRecord()
            for (const key of Object.keys(newDb)) {
                if (!canUseSynchronousPluginStorage()) return
                if (key === 'plugins') {
                    console.warn('[WARN] Plugin attempted to access plugin directly. this would be blocked in future versions. Instead, use the provided APIs to manage plugins. Attempting to handle plugin installation via plugin for new plugins in the provided database object.')
                    newDb[key] = await handlePluginInstallViaPlugin(newDb.plugins)
                }
                if (!canUseSynchronousPluginStorage()) return
                
                if (allowedDbKeys.includes(key)) {
                    if (key === 'pluginCustomStorage') {
                        // The following iteration may await plugin approval,
                        // reject, or interleave with V3 enumeration. Mark this
                        // replacement immediately after it becomes live.
                        db.pluginCustomStorage = readLegacyStorageInput(newDb, key, true) as any
                        markPluginStorageKeySetChanged()
                    } else {
                        (db as any)[key] = cloneDatabaseField(key, newDb[key])
                    }
                }
                else{
                    replaceLegacyStorageValue(db, key, readLegacyStorageInput(newDb, key))
                }
            }
            setDatabase(db);
        },
        SafeFunction: new Proxy(Function, {
            construct(target, args) {
                return function() {
                    return globalThis.__pluginApis__.getSafeGlobalThis();
                }
            },
            
            //call too
            apply(target, thisArg, args) {
                return function() {
                    return globalThis.__pluginApis__.getSafeGlobalThis();
                }
            }

        }),
        loadPlugins: requestDeferredPluginApiReload,
        readImage: (path:string) => {
            if(path.startsWith('assets/')){
                //trim assets/ prefix temporarily
                path = path.slice(7);
            }
            if(path.includes('/') || path.includes('\\')){
                throw new Error("readImage path cannot contain '/' or '\\' for security reasons, except assets/ prefix.");
            }
            //re-add assets/ prefix
            return readImage('assets/' + path);
        },
        saveAsset: (data:Uint8Array) => {
            return saveAsset(data);
        },

    }
    return generation
        ? createV2PluginApiGenerationFacade(pluginApis, generation)
        : pluginApis
}

export async function teardownV2Plugins(): Promise<void> {
    const callbacks = [...pluginV2.unload]
    const retiringGeneration = activeV2PluginApiGeneration
    const callbackErrors: Array<unknown | undefined> = new Array(callbacks.length)
    const callbackSettled = new Array(callbacks.length).fill(false)
    let graceExpired = false

    // Detach the dying generation from host event registries before invoking
    // third-party cleanup. Its captured host facade remains usable only for the
    // bounded grace period so awaited final inline writes can still complete.
    clearPluginV2RuntimeRegistries()
    try {
        const settlements = callbacks.map(async (unload, index) => {
            try {
                await unload()
            } catch (error) {
                if (graceExpired) {
                    console.warn("[Plugins] A V2 unload callback failed after its generation retired.", error)
                } else {
                    callbackErrors[index] = error
                }
            } finally {
                callbackSettled[index] = true
            }
        })

        if (settlements.length > 0) {
            let timeout: ReturnType<typeof setTimeout> | undefined
            const drained = Promise.all(settlements).then(() => "drained" as const)
            const deadline = new Promise<"timeout">((resolve) => {
                timeout = setTimeout(() => resolve("timeout"), V2_PLUGIN_UNLOAD_GRACE_MS)
            })
            const result = await Promise.race([drained, deadline])
            if (timeout !== undefined) clearTimeout(timeout)
            if (result === "timeout") {
                graceExpired = true
                const pendingCount = callbackSettled.filter(settled => !settled).length
                callbackErrors.push(new Error(
                    `${pendingCount} V2 unload callback${pendingCount === 1 ? "" : "s"} `
                    + `exceeded the ${V2_PLUGIN_UNLOAD_GRACE_MS} ms grace period.`,
                ))
            }
        }
    } finally {
        if (retiringGeneration) retiringGeneration.active = false
        if (activeV2PluginApiGeneration === retiringGeneration) {
            activeV2PluginApiGeneration = undefined
        }
        // Cleanup callbacks may register residue through captured APIs.
        clearPluginV2RuntimeRegistries()
    }

    const errors = callbackErrors.filter(error => error !== undefined)
    if (errors.length > 0) {
        throw new AggregateError(errors, "One or more V2 unload callbacks failed.")
    }
}

export async function loadV2PluginGeneration(plugins: RisuPlugin[]) {
    const canLoadLegacyPlugin = (plugin: RisuPlugin) =>
        canEnablePlugin(plugin, getDatabase().optimizePluginMemory)

    plugins = plugins.filter(canLoadLegacyPlugin)
    pluginV2.loaded = plugins.length > 0

    if (activeV2PluginApiGeneration) activeV2PluginApiGeneration.active = false
    const generation: V2PluginApiGeneration = {
        id: Symbol("v2-plugin-api-generation"),
        active: true,
    }
    activeV2PluginApiGeneration = generation
    globalThis.__pluginApis__ = getV2PluginAPIs(generation)

    for (const plugin of plugins) {
        let data = ''
        let version = plugin.version || 2

        const createRealScript = (data:string): string => {
            const tt = (window as unknown as Window & {
                trustedTypes?: {
                    createPolicy: (name: string, rules: { createScript: (input: string) => string }) => { createScript: (input: string) => string }
                }
            }).trustedTypes
            const policyFactory = tt ?? {
                createPolicy: (_name: string, rules: { createScript: (input: string) => string }) => rules // Just return the rules object as the "policy"
            }

            const policy = policyFactory.createPolicy('plugin-policy', {
                createScript: (_input) => {
                    return `(async () => {
                        const risuFetch = globalThis.__pluginApis__.risuFetch
                        const nativeFetch = globalThis.__pluginApis__.nativeFetch
                        const getArg = globalThis.__pluginApis__.getArg
                        const printLog = globalThis.__pluginApis__.printLog
                        const getChar = globalThis.__pluginApis__.getChar
                        const setChar = globalThis.__pluginApis__.setChar
                        const addProvider = globalThis.__pluginApis__.addProvider
                        const addRisuScriptHandler = globalThis.__pluginApis__.addRisuScriptHandler
                        const removeRisuScriptHandler = globalThis.__pluginApis__.removeRisuScriptHandler
                        const addRisuReplacer = globalThis.__pluginApis__.addRisuReplacer
                        const removeRisuReplacer = globalThis.__pluginApis__.removeRisuReplacer
                        const onUnload = globalThis.__pluginApis__.onUnload
                        const setArg = globalThis.__pluginApis__.setArg
                        const saveAsset = globalThis.__pluginApis__.saveAsset
                        const readImage = globalThis.__pluginApis__.readImage
                        ${version === '2.1' ? `
                            const safeGlobalThis = globalThis.__pluginApis__.getSafeGlobalThis()
                            const Risuai = globalThis.__pluginApis__
                            const safeLocalStorage = globalThis.__pluginApis__.safeLocalStorage
                            const safeIdbFactory = globalThis.__pluginApis__.safeIdbFactory
                            const alertStore = globalThis.__pluginApis__.alertStore
                            const safeDocument = globalThis.__pluginApis__.safeDocument
                            const getDatabase = globalThis.__pluginApis__.getDatabase
                            const setDatabaseLite = globalThis.__pluginApis__.setDatabaseLite
                            const setDatabase = globalThis.__pluginApis__.setDatabase
                            const loadPlugins = globalThis.__pluginApis__.loadPlugins
                            const SafeFunction = globalThis.__pluginApis__.SafeFunction
                        ` : ''}

                        ${data}
                    })();`
                }
            });

            return policy.createScript(data);
        }

        if(version === '2.1'){
            const safety = (await checkCodeSafety(plugin.script))
            data = safety.modifiedCode
            console.log('Safety check result:', safety)
            console.log('Loading V2.1 Plugin', plugin.name, data)

            if (!canLoadLegacyPlugin(plugin)) {
                console.warn(`[Plugins] ${plugin.name} was not loaded because plugin storage is transitioning.`)
                continue
            }
            try {
                new Function(createRealScript(data))()
            } catch (error) {
                console.error(error)
            }

            console.log('Loaded V2.1 Plugin', plugin.name)
        }
        else{
            data = plugin.script
            console.log('Loading V2.0 Plugin', plugin.name)

            if(DBState.db.allowV2Plugin){
                if (!canLoadLegacyPlugin(plugin)) {
                    console.warn(`[Plugins] ${plugin.name} was not loaded because plugin storage is transitioning.`)
                    continue
                }
                try {
                    new Function(createRealScript(data))()
                } catch (error) {
                    console.error(error)
                }

                console.warn(`Plugin 2.0 support is deprecated and disabled by default. Please update plugin "${plugin.name}" to API version 3.0`)
            }
            else{
                console.warn(`Plugin 2.0 is disabled by default. Enable deprecated V2.0 plugin support in advanced settings to run plugin "${plugin.name}", and please update it to API version 3.0`)
            }
        }
    }
}

export function loadV2Plugin(plugins: RisuPlugin[]): Promise<void> {
    return withPluginLifecycleLock(async () => {
        let teardownError: unknown
        try {
            await teardownV2Plugins()
        } catch (error) {
            teardownError = error
        }
        await loadV2PluginGeneration(plugins)
        if (teardownError) throw teardownError
    })
}

export async function translatorPlugin(text: string, from: string, to: string) {
    return false
}

export async function pluginProcess(arg: {
    prompt_chat: OpenAIChat,
    temperature: number,
    max_tokens: number,
    presence_penalty: number
    frequency_penalty: number
    bias: { [key: string]: string }
} | {}) {
    return {
        success: false,
        content: language.pluginProviderNotFound
    }
}

export async function handlePluginInstallViaPlugin(plugins: RisuPlugin[]){

    const trimmedPlugins: RisuPlugin[] = []
    for(const plugin of plugins){
        if(!DBState.db.plugins.find((p: RisuPlugin) => p.name === plugin.name && p.script === plugin.script)){

            // This programmatic install path has always accepted V3 only, so it
            // cannot introduce an enabled V2 plugin in optimized-memory mode.
            if(plugin.version !== '3.0'){
                console.warn(`Plugin "${plugin.name}" has version "${plugin.version}", which is not supported for installation via plugin. Only API version 3.0 plugins can be installed via plugin. Skipping installation of this plugin.`)
                continue
            }
            const confirmation = await alertConfirm(language.confirmInstallPluginViaPlugin.replace('{plugin}', plugin.name))
            if(confirmation){
                trimmedPlugins.push(plugin)
            }
        }
        else{
            console.warn(`Plugin "${plugin.name}" already exists, skipping installation via plugin.`)
        }
    }

    return trimmedPlugins
}
