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
import { loadV3Plugins } from "./apiV3/v3.svelte";
import { pluginCodeTranspiler } from "./apiV3/transpiler";
import {
    canEnablePlugin,
    isPluginStorageModeTransitioning,
    shouldDisableImportedPlugin,
} from "./pluginMemoryOptimization";
import {
    copyDatabasePluginStorageRecord,
    createDatabasePluginStorageRecord,
    createPluginStorageRecord,
    definePluginStorageRecordValue,
    getPluginStorageRecordKeys,
    hasPluginStorageRecordValue,
    setDatabasePluginStorageRecordValue,
} from "./pluginStorageRecord";

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

        // The duplicate-confirmation await may overlap a storage mode
        // transition. Re-evaluate at the commit point so a legacy import can
        // never become enabled from a stale pre-transition decision.
        disabledForMemoryOptimization = shouldDisableImportedPlugin(
            apiInternalVersion,
            db.optimizePluginMemory,
        )
        pluginData.enabled = !disabledForMemoryOptimization

        if(oldPluginIndex !== -1){
            db.plugins[oldPluginIndex] = pluginData;
        }
        else if(!isUpdate || argu.isHotReload){
            db.plugins.push(pluginData)
        }

        if(argu.isHotReload && !hotReloading.includes(pluginData.name)){
            hotReloading.push(pluginData.name)
        }

        console.log(`Imported plugin: ${pluginData.name} (API v${apiVersion})`)
        if (disabledForMemoryOptimization) {
            notifyWarning(language.optimizePluginMemoryImportDisabled)
        }
        setDatabaseLite(db)
        void requestImmediateSave()

        loadPlugins()
        
    } catch (error) {
        console.error(error)
        alertError(language.errors.noData)
    }
}

let pluginTranslator = false

export async function loadPlugins() {
    console.log('Loading plugins...')
    let db = getDatabase()


    const enabledPlugins = safeStructuredClone(db.plugins).filter((p: RisuPlugin) => {
        if (!p.enabled) return false
        if (!canEnablePlugin(p, db.optimizePluginMemory)) {
            // Defensive runtime gate for databases modified outside the normal
            // import/toggle UI. The plugin remains visibly enabled so the user
            // can turn it off, but its synchronous V2 code is never executed.
            console.warn(`[Plugins] ${p.name} was not loaded because optimized plugin memory requires V3.`)
            return false
        }
        return true
    })
    const pluginV2 = enabledPlugins.filter((a: RisuPlugin) => a.version === 2 || a.version === '2.1')
    const pluginV3 = enabledPlugins.filter((a: RisuPlugin) => a.version === '3.0')

    await loadV2Plugin(pluginV2)
    await loadV3Plugins(pluginV3)
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

export const getV2PluginAPIs = () => {
    const canUseSynchronousPluginStorage = () => {
        const db = getDatabase()
        return db.optimizePluginMemory !== true && !isPluginStorageModeTransitioning()
    }
    const assertSynchronousPluginStorageAccess = () => {
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
    const cloneLegacyStorageJson = <T>(input: T): T => {
        const value = unwrapGuardedValue(input)
        const visiting = new Set<object>()
        const snapshot = (candidate: unknown, path: string): unknown => {
            if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
                return candidate
            }
            if (typeof candidate === 'number') {
                if (!Number.isFinite(candidate)) {
                    throw new TypeError(`Legacy plugin storage requires finite JSON numbers at ${path}.`)
                }
                return Object.is(candidate, -0) ? 0 : candidate
            }
            if (typeof candidate !== 'object') {
                throw new TypeError(`Legacy plugin storage requires JSON data at ${path}.`)
            }

            const object = candidate as object
            if (visiting.has(object)) {
                throw new TypeError(`Legacy plugin storage does not accept circular data at ${path}.`)
            }
            const prototype = Reflect.getPrototypeOf(object)
            if (prototype !== Object.prototype && prototype !== null && !Array.isArray(object)) {
                throw new TypeError(`Legacy plugin storage requires plain JSON objects at ${path}.`)
            }

            visiting.add(object)
            let result: unknown
            if (Array.isArray(object)) {
                const lengthDescriptor = Reflect.getOwnPropertyDescriptor(object, 'length')
                const length = lengthDescriptor && "value" in lengthDescriptor
                    ? lengthDescriptor.value
                    : undefined
                if (!Number.isSafeInteger(length) || length < 0) {
                    throw new TypeError(`Legacy plugin storage received an invalid array at ${path}.`)
                }
                const arraySnapshot: unknown[] = []
                // Shadow any subsequently poisoned Array.prototype.toJSON.
                Object.defineProperty(arraySnapshot, 'toJSON', {
                    configurable: false,
                    enumerable: false,
                    value: undefined,
                    writable: false,
                })
                for (let index = 0; index < length; index += 1) {
                    const descriptor = Reflect.getOwnPropertyDescriptor(object, String(index))
                    if (!descriptor) {
                        // JSON serialization turns array holes into null.
                        Object.defineProperty(arraySnapshot, index, {
                            configurable: true,
                            enumerable: true,
                            value: null,
                            writable: true,
                        })
                        continue
                    }
                    if (!("value" in descriptor)) {
                        throw new TypeError(
                            `Legacy plugin storage does not accept accessors at ${path}[${index}].`,
                        )
                    }
                    if (!descriptor.configurable || !descriptor.enumerable) {
                        throw new TypeError(
                            `Legacy plugin storage requires configurable enumerable data at ${path}[${index}].`,
                        )
                    }
                    Object.defineProperty(arraySnapshot, index, {
                        configurable: true,
                        enumerable: true,
                        value: snapshot(descriptor.value, `${path}[${index}]`),
                        writable: true,
                    })
                }
                result = arraySnapshot
            } else {
                const objectSnapshot = createDatabasePluginStorageRecord<unknown>()
                for (const key of Reflect.ownKeys(object)) {
                    if (typeof key !== 'string') {
                        throw new TypeError(`Legacy plugin storage does not accept symbol keys at ${path}.`)
                    }
                    const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
                    if (!descriptor || !("value" in descriptor)) {
                        throw new TypeError(`Legacy plugin storage does not accept accessors at ${path}.${key}.`)
                    }
                    if (!descriptor.configurable || !descriptor.enumerable) {
                        throw new TypeError(
                            `Legacy plugin storage requires configurable enumerable data at ${path}.${key}.`,
                        )
                    }
                    Object.defineProperty(objectSnapshot, key, {
                        configurable: true,
                        enumerable: true,
                        value: snapshot(descriptor.value, `${path}.${key}`),
                        writable: true,
                    })
                }
                result = objectSnapshot
            }
            visiting.delete(object)
            return result
        }

        return snapshot(value, "$") as T
    }
    const validateLegacyStorageDescriptor = (descriptor: PropertyDescriptor): unknown => {
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
        return cloneLegacyStorageJson(descriptor.value)
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
                        return Reflect.set(nestedTarget, prop, nestedValue, nestedTarget)
                    }
                    defineLegacyStorageValue(
                        nestedTarget as Record<PropertyKey, unknown>,
                        prop,
                        nestedValue,
                    )
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
                return Reflect.deleteProperty(nestedTarget, prop)
            },
            defineProperty(nestedTarget, prop, descriptor) {
                assertSynchronousPluginStorageAccess()
                if (storageValue) {
                    setDatabasePluginStorageRecordValue(
                        nestedTarget as Record<string, unknown>,
                        prop,
                        validateLegacyStorageDescriptor(descriptor),
                    )
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
                if (storageValue) return null
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
    const readLegacyStorageInput = (source: object, key: string): unknown => {
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key)
        if (!descriptor || !("value" in descriptor)) {
            throw new TypeError(`Legacy plugin storage does not accept an accessor for ${key}.`)
        }
        if (!descriptor.configurable || !descriptor.enumerable) {
            throw new TypeError(
                `Legacy plugin storage requires configurable enumerable data for ${key}.`,
            )
        }
        return cloneLegacyStorageJson(descriptor.value)
    }
    const defineLegacyStorageValue = (
        storage: Record<PropertyKey, unknown>,
        key: PropertyKey,
        value: unknown,
    ): void => {
        setDatabasePluginStorageRecordValue(
            storage as Record<string, unknown>,
            key,
            cloneLegacyStorageJson(value),
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
        definePluginStorageRecordValue(next, key, cloneLegacyStorageJson(value))
        db.pluginCustomStorage = next
    }
    const removeLegacyStorageValue = (
        db: ReturnType<typeof getDatabase>,
        key: PropertyKey,
    ): boolean => {
        if (!hasPluginStorageRecordValue(db.pluginCustomStorage, key)) return true
        const next = copyDatabasePluginStorageRecord(db.pluginCustomStorage)
        Reflect.deleteProperty(next, key)
        db.pluginCustomStorage = next
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
                cloneLegacyStorageJson(value),
            )
        }
        return snapshot
    }
    let legacyStorageFacade: Record<PropertyKey, unknown> | null = null
    const getLegacyStorageFacade = (): Record<PropertyKey, unknown> => {
        if (legacyStorageFacade) return legacyStorageFacade

        const facadeToJSON = () => snapshotLegacyStorage()
        legacyStorageFacade = new Proxy(Object.create(null), {
            get(_target, prop) {
                assertSynchronousPluginStorageAccess()
                const storage = getDatabase().pluginCustomStorage
                if (hasPluginStorageRecordValue(storage, prop)) {
                    return guardNestedValue(storage![prop as keyof typeof storage], true)
                }
                // Svelte snapshot cannot structured-clone a user Proxy. A
                // null-prototype detached value lets its standard toJSON path
                // preserve an own `__proto__` without exposing the hook as an
                // enumerable storage key.
                if (prop === "toJSON") return facadeToJSON
                return undefined
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
                return null
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

    return {
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
            db.characters[charid] = char
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
            safeGlobal.showDirectoryPicker = window.showDirectoryPicker

            safeGlobal.DBState = {
                db: toGetter(
                    globalThis.__pluginApis__.getDatabase
                )
            }
            safeGlobal.setInterval = (...args: any[]) => {
                //@ts-expect-error spreading any[] into setInterval params causes type mismatch with TimerHandler signature
                return globalThis.setInterval(...args);
            }
            safeGlobal.setTimeout = (...args: any[]) => {
                //@ts-expect-error spreading any[] into setTimeout params causes type mismatch with TimerHandler signature
                return globalThis.setTimeout(...args);
            }
            safeGlobal.clearInterval = (...args: any[]) => {
                //@ts-expect-error spreading any[] into clearInterval - first arg should be number | undefined
                return globalThis.clearInterval(...args);
            }
            safeGlobal.clearTimeout = (...args: any[]) => {
                //@ts-expect-error spreading any[] into clearTimeout - first arg should be number | undefined
                return globalThis.clearTimeout(...args);
            }
            safeGlobal.alert = globalThis.alert;
            safeGlobal.confirm = globalThis.confirm;
            safeGlobal.prompt = globalThis.prompt;
            safeGlobal.innerWidth = window.innerWidth;
            safeGlobal.innerHeight = window.innerHeight;
            safeGlobal.getComputedStyle = window.getComputedStyle
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
                //@ts-expect-error spreading any[] into addEventListener - expects (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions)
                window.addEventListener(...args);
            }
            safeGlobal.removeEventListener = (...args: any[]) => {
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
                            ? cloneLegacyStorageJson(value)
                            : unwrapGuardedValue(value);
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
                        return Reflect.defineProperty(target, prop, {
                            ...descriptor,
                            value: prop === 'pluginCustomStorage'
                                ? validateLegacyStorageDescriptor(descriptor)
                                : unwrapGuardedValue(descriptor.value),
                        })
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
                // the same detached JSON value used by legacy writes.
                const db = getDatabase();
                if (!hasPluginStorageRecordValue(db.pluginCustomStorage, key)) return null;
                const value = db.pluginCustomStorage![key];
                return value === undefined || value === null
                    ? null
                    : cloneLegacyStorageJson(value);
            },
            setItem: (key: string, value: string) => {
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
                    (db as any)[key] = key === 'pluginCustomStorage'
                        ? readLegacyStorageInput(newDb, key)
                        : newDb[key];
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
                    (db as any)[key] = key === 'pluginCustomStorage'
                        ? readLegacyStorageInput(newDb, key)
                        : newDb[key];
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
        loadPlugins: loadPlugins,
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
}

export async function loadV2Plugin(plugins: RisuPlugin[]) {

    const canLoadLegacyPlugin = (plugin: RisuPlugin) =>
        canEnablePlugin(plugin, getDatabase().optimizePluginMemory)

    // This exported compatibility loader is also called defensively rather
    // than relying only on loadPlugins() to have filtered its input.
    plugins = plugins.filter(canLoadLegacyPlugin)

    if (pluginV2.loaded) {
        for (const unload of pluginV2.unload) {
            await unload()
        }

        pluginV2.providers.clear()
        pluginV2.editdisplay.clear()
        pluginV2.editoutput.clear()
        pluginV2.editprocess.clear()
        pluginV2.editinput.clear()
    }

    // Unload callbacks are asynchronous and a transition can begin while they
    // run. Do not execute a legacy plugin based on the earlier filter.
    plugins = plugins.filter(canLoadLegacyPlugin)

    pluginV2.loaded = true

    globalThis.__pluginApis__ = getV2PluginAPIs()

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
