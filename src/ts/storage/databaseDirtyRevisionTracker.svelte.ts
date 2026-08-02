import { deepTouch } from '../gui/deepTouch.svelte'
import { DatabaseDirtyRevisionLedger } from './databaseDirtyRevisions'

const ENCODER_ROOT_COLLECTIONS = new Set([
    'characters',
    'botPresets',
    'modules',
    'plugins',
    'pluginCustomStorage',
])

export interface DatabaseDirtyRevisionCallbacks {
    rootKey: (key: string) => void
    character: (chaId: string | null) => void
    botPreset: () => void
    module: (moduleId: string | null) => void
    plugins: () => void
    pluginCustomStorage: () => void
}

export interface DatabaseDirtyRevisionTrackerOptions {
    getDatabase: () => any
    onDirty: DatabaseDirtyRevisionCallbacks
}

export interface DatabaseDirtyRevisionTracker {
    ledger: DatabaseDirtyRevisionLedger
    markCharacter: (chaId: string) => void
    stop: () => void
}

function sameOrder(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Observe the canonical Svelte deep proxy at branch granularity. Each root
 * key, character, and module owns an independent effect, so a mutation wakes
 * and re-walks only its containing persistence branch. Chat bodies are
 * intentionally excluded from character revisions; only their database.bin
 * stub metadata participates here.
 */
export function watchDatabaseDirtyRevisions(
    options: DatabaseDirtyRevisionTrackerOptions,
): DatabaseDirtyRevisionTracker {
    const ledger = new DatabaseDirtyRevisionLedger()
    const rootStops = new Map<string, () => void>()
    const characterStops = new Map<string, () => void>()
    const moduleStops = new Map<string, () => void>()
    let previousRootKeys: string[] | null = null
    let previousCharacterIds: string[] | null = null
    let previousModuleIds: string[] | null = null

    const markRootKey = (key: string) => {
        ledger.markRootKey(key)
        options.onDirty.rootKey(key)
    }
    const markCharacter = (chaId: string) => {
        if (!chaId) return
        ledger.markCharacter(chaId)
        options.onDirty.character(chaId)
    }
    const markModule = (moduleId: string | null) => {
        if (moduleId) ledger.markModule(moduleId)
        else ledger.markBranch('modulesStructural')
        options.onDirty.module(moduleId)
    }

    const createRootWatcher = (key: string) => {
        let initialized = false
        return $effect.root(() => {
            $effect(() => {
                let trusted = true
                try {
                    deepTouch(options.getDatabase()?.[key])
                } catch (error) {
                    trusted = false
                    console.warn(`[Save] deepTouch(root.${key}) failed:`, error)
                }
                ledger.trustRootKey(key, trusted)
                if (!initialized) {
                    initialized = true
                    return
                }
                markRootKey(key)
            })
        })
    }

    const findCharacter = (chaId: string) => (
        (options.getDatabase()?.characters ?? []).find((character: any) => character?.chaId === chaId)
    )
    const createCharacterWatcher = (chaId: string) => {
        let initialized = false
        return $effect.root(() => {
            $effect(() => {
                const character = findCharacter(chaId)
                let trusted = true
                try {
                    if (character) {
                        for (const key of Object.keys(character)) {
                            if (key !== 'chats') deepTouch(character[key])
                        }
                        const chats = Array.isArray(character.chats) ? character.chats : []
                        deepTouch(chats.map((chat: any) => ({
                            id: chat?.id,
                            name: chat?.name,
                            lastDate: chat?.lastDate,
                            folderId: chat?.folderId,
                            modules: chat?.modules,
                        })))
                    }
                } catch (error) {
                    trusted = false
                    console.warn(`[Save] deepTouch(character.${chaId}) failed:`, error)
                }
                ledger.trustCharacter(chaId, trusted)
                if (!initialized) {
                    initialized = true
                    return
                }
                markCharacter(chaId)
            })
        })
    }

    const findModule = (moduleId: string) => (
        (options.getDatabase()?.modules ?? []).find((module: any) => module?.id === moduleId)
    )
    const createModuleWatcher = (moduleId: string) => {
        let initialized = false
        return $effect.root(() => {
            $effect(() => {
                let trusted = true
                try {
                    deepTouch(findModule(moduleId))
                } catch (error) {
                    trusted = false
                    console.warn(`[Save] deepTouch(module.${moduleId}) failed:`, error)
                }
                ledger.trustModule(moduleId, trusted)
                if (!initialized) {
                    initialized = true
                    return
                }
                markModule(moduleId)
            })
        })
    }

    const stop = $effect.root(() => {
        $effect(() => {
            const database = options.getDatabase()
            const rootKeys = Object.keys(database ?? {})
                .filter(key => !ENCODER_ROOT_COLLECTIONS.has(key))
            const rootKeySet = new Set(rootKeys)
            for (const [key, stopWatcher] of rootStops) {
                if (!rootKeySet.has(key)) {
                    stopWatcher()
                    rootStops.delete(key)
                }
            }
            for (const key of rootKeys) {
                if (!rootStops.has(key)) rootStops.set(key, createRootWatcher(key))
            }
            ledger.trustRootStructure(true)
            if (previousRootKeys !== null && !sameOrder(previousRootKeys, rootKeys)) {
                const changedKeys = new Set([...previousRootKeys, ...rootKeys])
                for (const key of changedKeys) {
                    if (!previousRootKeys.includes(key) || !rootKeySet.has(key)) markRootKey(key)
                }
            }
            previousRootKeys = rootKeys
        })

        $effect(() => {
            const characters = options.getDatabase()?.characters ?? []
            const characterIds = Array.isArray(characters)
                ? characters.map((character: any) => character?.chaId ?? '')
                : []
            const valid = characterIds.every(Boolean)
                && new Set(characterIds).size === characterIds.length
            ledger.trustCharacterStructure(valid)
            ledger.trustBranch('charactersStructural', valid)
            const characterIdSet = new Set(characterIds.filter(Boolean))
            for (const [chaId, stopWatcher] of characterStops) {
                if (!characterIdSet.has(chaId)) {
                    stopWatcher()
                    characterStops.delete(chaId)
                }
            }
            for (const chaId of characterIdSet) {
                if (!characterStops.has(chaId)) {
                    characterStops.set(chaId, createCharacterWatcher(chaId))
                }
            }
            if (previousCharacterIds !== null && !sameOrder(previousCharacterIds, characterIds)) {
                ledger.markBranch('charactersStructural')
                options.onDirty.character(null)
                for (const chaId of new Set([...previousCharacterIds, ...characterIds])) {
                    if (chaId) markCharacter(chaId)
                }
            }
            previousCharacterIds = characterIds
        })

        let initializedInvalidCharacters = false
        $effect(() => {
            const characters = options.getDatabase()?.characters ?? []
            const characterIds = Array.isArray(characters)
                ? characters.map((character: any) => character?.chaId ?? '')
                : []
            const valid = characterIds.every(Boolean)
                && new Set(characterIds).size === characterIds.length
            if (valid) {
                initializedInvalidCharacters = false
                return
            }
            try {
                for (const character of characters) {
                    if (!character) continue
                    for (const key of Object.keys(character)) {
                        if (key !== 'chats') deepTouch(character[key])
                    }
                    deepTouch((character.chats ?? []).map((chat: any) => ({
                        id: chat?.id,
                        name: chat?.name,
                        lastDate: chat?.lastDate,
                        folderId: chat?.folderId,
                        modules: chat?.modules,
                    })))
                }
            } catch (error) {
                console.warn('[Save] deepTouch(invalid characters) failed:', error)
            }
            if (!initializedInvalidCharacters) initializedInvalidCharacters = true
            else {
                ledger.markBranch('charactersStructural')
                options.onDirty.character(null)
            }
        })

        $effect(() => {
            const modules = options.getDatabase()?.modules ?? []
            const moduleIds = Array.isArray(modules)
                ? modules.map((module: any) => module?.id ?? '')
                : []
            const valid = moduleIds.every(id => id && typeof id === 'string')
                && new Set(moduleIds).size === moduleIds.length
            ledger.trustModuleStructure(valid)
            ledger.trustBranch('modulesStructural', valid)
            const moduleIdSet = new Set(moduleIds.filter((id): id is string => (
                !!id && typeof id === 'string'
            )))
            for (const [moduleId, stopWatcher] of moduleStops) {
                if (!moduleIdSet.has(moduleId)) {
                    stopWatcher()
                    moduleStops.delete(moduleId)
                }
            }
            for (const moduleId of moduleIdSet) {
                if (!moduleStops.has(moduleId)) {
                    moduleStops.set(moduleId, createModuleWatcher(moduleId))
                }
            }
            if (previousModuleIds !== null && !sameOrder(previousModuleIds, moduleIds)) {
                ledger.markBranch('modulesStructural')
                options.onDirty.module(null)
            }
            previousModuleIds = moduleIds
        })

        let initializedInvalidModules = false
        $effect(() => {
            const modules = options.getDatabase()?.modules ?? []
            const moduleIds = Array.isArray(modules)
                ? modules.map((module: any) => module?.id ?? '')
                : []
            const valid = moduleIds.every(id => id && typeof id === 'string')
                && new Set(moduleIds).size === moduleIds.length
            if (valid) {
                initializedInvalidModules = false
                return
            }
            try { deepTouch(modules) } catch (error) {
                console.warn('[Save] deepTouch(invalid modules) failed:', error)
            }
            if (!initializedInvalidModules) initializedInvalidModules = true
            else {
                ledger.markBranch('modulesStructural')
                options.onDirty.module(null)
            }
        })

        let initializedBotPresets = false
        $effect(() => {
            let trusted = true
            try { deepTouch(options.getDatabase()?.botPresets) } catch (error) {
                trusted = false
                console.warn('[Save] deepTouch(botPresets) failed:', error)
            }
            ledger.trustBranch('botPreset', trusted)
            if (!initializedBotPresets) initializedBotPresets = true
            else {
                ledger.markBranch('botPreset')
                options.onDirty.botPreset()
            }
        })

        let initializedPlugins = false
        $effect(() => {
            let trusted = true
            try { deepTouch(options.getDatabase()?.plugins) } catch (error) {
                trusted = false
                console.warn('[Save] deepTouch(plugins) failed:', error)
            }
            ledger.trustBranch('plugins', trusted)
            if (!initializedPlugins) initializedPlugins = true
            else {
                ledger.markBranch('plugins')
                options.onDirty.plugins()
            }
        })

        let initializedPluginStorage = false
        $effect(() => {
            let trusted = true
            try {
                deepTouch(options.getDatabase()?.pluginCustomStorage)
                deepTouch(options.getDatabase()?.pluginStorageMeta)
            } catch (error) {
                trusted = false
                console.warn('[Save] deepTouch(plugin storage) failed:', error)
            }
            ledger.trustBranch('pluginCustomStorage', trusted)
            if (!initializedPluginStorage) initializedPluginStorage = true
            else {
                ledger.markBranch('pluginCustomStorage')
                options.onDirty.pluginCustomStorage()
            }
        })

        return () => {
            for (const stopWatcher of rootStops.values()) stopWatcher()
            for (const stopWatcher of characterStops.values()) stopWatcher()
            for (const stopWatcher of moduleStops.values()) stopWatcher()
            rootStops.clear()
            characterStops.clear()
            moduleStops.clear()
        }
    })

    return { ledger, markCharacter, stop }
}
