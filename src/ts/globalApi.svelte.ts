import { changeFullscreen, checkNullish, sleep } from "./util"
import { v4 as uuidv4, v4 } from 'uuid';
import { tick } from "svelte";
import { get } from "svelte/store";
import streamSaver from 'streamsaver';
import { setDatabase, type Database, defaultSdDataFunc, getDatabase, appVer, nodeOnlyVer, getCurrentCharacter, loadTogglesFromChat } from "./storage/database.svelte";
import { checkRisuUpdate } from "./update";
import { MobileGUI, botMakerMode, selectedCharID, loadedStore, DBState, LoadingStatusState, selIdState, ReloadGUIPointer, bodyIntercepterStore, loadingOverlayStore, chatDeselected } from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertConfirm, alertError, alertMd, alertNormalWait, alertSelect, alertTOS, waitAlert, notifySuccess, notifyError } from "./alert";
import { hasher } from "./parser/parser.svelte";
import { characterURLImport, hubURL } from "./characterCards";
import { defaultJailbreak, defaultMainPrompt, oldJailbreak, oldMainPrompt } from "./storage/defaultPrompts";
import { decodeAuthoritativeRisuSave, encodeRisuSaveLegacy, findDangerousChatOps, RisuSaveEncoder, RisuSavePatcher, type toSaveType } from "./storage/risuSave";
import { isHydrating, saveChatToServer, ensureChatHydrated, chatToStub, classifyChat, convertStubsToPlaceholders } from "./storage/chatStorage";
import {
    buildKnownChatIdsByCharacter,
    capturePreTrackingFullChatChanges,
    CHECKPOINT_INTERVAL_MS,
    prepareChatPersistStage,
    rediscoverUnbackedFullChats,
} from "./storage/chatPersistStage";
import { AutoStorage } from "./storage/autoStorage";
import { ConflictError, type PersistWarning } from "./storage/nodeStorage";
import { withAssetSaveRetry } from "./storage/assetSaveRetry";
import { supportsPatchSync } from "./platform";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { updateLorebooks } from "./characters";
import { initMobileGesture } from "./hotkey";
import { moduleUpdate } from "./process/modules";
import { doingChat } from "./process/index.svelte";
import { chatGenKey, generationStates } from "./process/generationState";
import { chatOperationActive } from './process/chatSendState';
import { isLocalNetworkUrl } from "./network/localNetwork";
import { decodeProxyJobWsChunk, formatProxyStreamErrorMessage, parseProxyJobWsEvent } from "./network/proxyJobWs";
import { capturePreTrackingPluginStorageChanges } from "./plugins/pluginStorageTracking";
import {
    cloneDatabaseState,
    mergeTrackedDatabaseOnConflict,
} from "./storage/databaseClone";
import { checkWriterTakeoverOnReturn, enterWriterTakeoverFlow } from "./storage/writerTakeover";
import {
    DatabaseSaveCoordinator,
    type DatabaseSaveOutcome,
} from "./storage/databaseSave"
import { DirtyTargetBridge } from "./storage/dirtyTargetBridge"
import {
    clientBuildFetch,
    setClientBuildDirtyStateProbe,
    type ClientUpgradeRequiredDetail,
} from "./storage/clientBuildHandshake"
import { watchActiveChatDirty } from "./storage/activeChatDirtyTracker.svelte"
import { recordConflictRebaseGraphBudget } from "./storage/conflictRebaseBudget"
import { watchDatabaseDirtyRevisions } from "./storage/databaseDirtyRevisionTracker.svelte"
import type { RisuSaveDirtyRevisions } from "./storage/databaseDirtyRevisions"
import { StagedAckTracker } from "./storage/stagedAckTracker"
import { SaveRetryScheduler } from "./storage/saveRetryScheduler"
import {
    createRequestLogScope, recordRequestLog, fetchRequestLogs,
    type RequestLogCategory, type RequestLogSource, type RequestLogRoute,
} from "./requestLog";

export const forageStorage = new AutoStorage()

export async function downloadFile(name: string, dat: Uint8Array | ArrayBuffer | string) {
    if (typeof (dat) === 'string') {
        dat = Buffer.from(dat, 'utf-8')
    }
    const data = new Uint8Array(dat)
    await downloadFileParts(name, [data as unknown as BlobPart])
}

export async function downloadFileParts(
    name: string,
    parts: BlobPart[],
    type = 'application/octet-stream',
) {
    const downloadURL = (data: string, fileName: string) => {
        const a = document.createElement('a')
        a.href = data
        a.download = fileName
        document.body.appendChild(a)
        a.style.display = 'none'
        a.click()
        a.remove()
    }

    const blob = new Blob(parts, { type })
    const url = URL.createObjectURL(blob)

    downloadURL(url, name)

    setTimeout(() => {
        URL.revokeObjectURL(url)
    }, 10000)
}

let fileCache: {
    origin: string[], res: (Uint8Array | 'loading' | 'done')[]
} = {
    origin: [],
    res: []
}

let pathCache: { [key: string]: string } = {}
let checkedPaths: string[] = []

function buildTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
    if (!timeoutMs || timeoutMs <= 0) {
        return {
            signal,
            cleanup: () => {}
        }
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    if (signal) {
        if (signal.aborted) {
            controller.abort()
        } else {
            signal.addEventListener('abort', () => controller.abort(), { once: true })
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timeoutId)
    }
}

/**
 * Gets the source URL of a file.
 * 
 * @param {string} loc - The location of the file.
 * @returns {Promise<string>} - A promise that resolves to the source URL of the file.
 */
export async function getFileSrc(loc: string) {
    // NodeOnly: return a direct server URL instead of fetching + base64-encoding.
    // The browser will cache the response using HTTP Cache-Control headers,
    // so repeated renders (sidebar, chat) cost zero network after first load.
    if ((globalThis as any).__NODE__) {
        return `/api/asset/${Buffer.from(loc, 'utf-8').toString('hex')}`
    }
    try {
        if (usingSw) {
            const encoded = Buffer.from(loc, 'utf-8').toString('hex')
            let ind = fileCache.origin.indexOf(loc)
            if (ind === -1) {
                ind = fileCache.origin.length
                fileCache.origin.push(loc)
                fileCache.res.push('loading')
                try {
                    const hasCache: boolean = (await (await fetch("/sw/check/" + encoded)).json()).able
                    if (hasCache) {
                        fileCache.res[ind] = 'done'
                        return "/sw/img/" + encoded
                    }
                    else {
                        const f: Uint8Array = await forageStorage.getItem(loc) as unknown as Uint8Array
                        await fetch("/sw/register/" + encoded, {
                            method: "POST",
                            body: f as any
                        })
                        fileCache.res[ind] = 'done'
                        await sleep(10)
                    }
                    return "/sw/img/" + encoded
                } catch (error) {

                }
            }
            else {
                const f = fileCache.res[ind]
                if (f === 'loading') {
                    while (fileCache.res[ind] === 'loading') {
                        await sleep(10)
                    }
                }
                return "/sw/img/" + encoded
            }
        }
        else {
            let ind = fileCache.origin.indexOf(loc)
            if (ind === -1) {
                ind = fileCache.origin.length
                fileCache.origin.push(loc)
                fileCache.res.push('loading')
                const f: Uint8Array = await forageStorage.getItem(loc) as unknown as Uint8Array
                fileCache.res[ind] = f
                return `data:image/png;base64,${Buffer.from(f).toString('base64')}`
            }
            else {
                const f = fileCache.res[ind]
                if (f === 'loading') {
                    while (fileCache.res[ind] === 'loading') {
                        await sleep(10)
                    }
                    return `data:image/png;base64,${Buffer.from(fileCache.res[ind]).toString('base64')}`
                }
                return `data:image/png;base64,${Buffer.from(f).toString('base64')}`
            }
        }
    } catch (error) {
        console.error(error)
        return ''
    }
}

/**
 * Reads an image file and returns its data.
 * 
 * @param {string} data - The path to the image file.
 * @returns {Promise<Uint8Array>} - A promise that resolves to the data of the image file.
 */
export async function readImage(data: string) {
    return (await forageStorage.getItemCached(data) as unknown as Uint8Array)
}

/**
 * Saves an asset file with the given data, custom ID, and file name.
 * 
 * @param {Uint8Array} data - The data of the asset file.
 * @param {string} [customId=''] - The custom ID for the asset file.
 * @param {string} [fileName=''] - The name of the asset file.
 * @returns {Promise<string>} - A promise that resolves to the path of the saved asset file.
 */
export async function saveAsset(data: Uint8Array, customId: string = '', fileName: string = '') {
    let id = ''
    if (customId !== '') {
        id = customId
    }
    else {
        try {
            id = await hasher(data)
        } catch (error) {
            id = uuidv4()
        }
    }
    let fileExtension: string = 'png'
    if (fileName && fileName.split('.').length > 0) {
        fileExtension = fileName.split('.').pop()
    }
    let form = `assets/${id}.${fileExtension}`
    return await withAssetSaveRetry(form, async () => {
        const replacer = await forageStorage.setItem(form, data)
        if (replacer) {
            return replacer
        }
        return form
    })
}

/**
 * Loads an asset file with the given ID.
 * 
 * @param {string} id - The ID of the asset file to load.
 * @returns {Promise<Uint8Array>} - A promise that resolves to the data of the loaded asset file.
 */
export async function loadAsset(id: string) {
    return await forageStorage.getItemCached(id) as unknown as Uint8Array
}

let lastSave = ''
export let saving = $state({
    state: false
})

/**
 * Saves the current state of the database and reports whether that exact
 * attempt was durably committed.
 */
export let requiresFullEncoderReload = $state({
    state: false
})

let requestImmediateSaveImpl: ((options?: {
    forceFullWrite?: boolean
}) => Promise<DatabaseSaveOutcome>) = async () => ({
    status: 'failed',
    error: new Error('Database save loop is not initialized'),
})
let immediateDatabaseSaveReady = false
const dirtyTargetBridge = new DirtyTargetBridge()
let patchSyncBaseline: Database | null = null

type PersistTrackedChangesResult =
    | { status: 'saved', durable: boolean, etag?: string }
    | { status: 'retry' | 'noop' | 'displaced' }

// Surfaces server-side persist failures (Stage 1 visibility — see issues.md).
// The same failure is re-attached on every patch response until cleared, so we
// dedupe by timestamp to fire one toast per distinct failure event.
let lastShownPersistWarningTs = 0

function showPersistWarningOnce(warning: PersistWarning) {
    if (warning.timestamp <= lastShownPersistWarningTs) return
    lastShownPersistWarningTs = warning.timestamp

    // Stub-flag-loss is the chat-data corruption guard firing at the disk
    // boundary — this means the persist was REFUSED, not that the save was
    // safely re-routed. Show the dedicated "save aborted" toast so the user
    // knows their latest changes may not be on disk yet.
    if (warning.source && warning.source.includes('stub-flag-loss')) {
        showChatGuardPersistAbortToast()
        return
    }

    const sizeStr = warning.attemptedSize != null
        ? ` (${language.errors.persistFailureAttemptedSize} ${(warning.attemptedSize / 1024 / 1024 / 1024).toFixed(2)}GB)`
        : ''
    notifyError(`${language.errors.persistFailureTitle}${sizeStr}`, {
        description: warning.message,
        source: 'persist-failure',
    })
}

// Throttle the client/server-PATCH chat-guard toast — the underlying root
// cause may keep firing every 5s save cycle, and we don't want to spam the
// user. One toast per 5-minute window is enough to surface the situation.
// Guards 2/3 fall through to a safe full-write so the data IS persisted —
// the toast is informational, not actionable.
const CHAT_GUARD_TOAST_INTERVAL_MS = 5 * 60 * 1000
let lastChatGuardToastTs = 0

function showChatGuardToastThrottled(source: 'client' | 'server') {
    const now = Date.now()
    if (now - lastChatGuardToastTs < CHAT_GUARD_TOAST_INTERVAL_MS) return
    lastChatGuardToastTs = now
    notifyError(language.errors.chatGuardTitle, {
        description: `${language.errors.chatGuardDesc} [${source}]`,
        source: 'chat-guard',
    })
}

// Persist-side guard (guard 1) refuses the disk write outright — there is no
// fallback path that recovers this cycle's changes automatically. Use a
// shorter throttle (30s) since this is more severe and actionable: the user
// should be aware before refreshing that their latest changes might not be
// persisted. Each separate persist-failure timestamp on the server gates this
// path via showPersistWarningOnce, so a single corruption won't repeat-toast.
const CHAT_GUARD_PERSIST_TOAST_INTERVAL_MS = 30 * 1000
let lastChatGuardPersistToastTs = 0

// Verbose chat-guard dump is gated behind a localStorage flag so chronic
// root-cause environments (e.g. a still-corrupt v1.4.x install) don't flood
// the console every 5-second save cycle. Toggle with:
//   localStorage.setItem('risu-chat-guard-debug', '1')
const CHAT_GUARD_DEBUG_KEY = 'risu-chat-guard-debug'
function isChatGuardDebugEnabled(): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(CHAT_GUARD_DEBUG_KEY) === '1'
    } catch {
        return false
    }
}

function showChatGuardPersistAbortToast() {
    const now = Date.now()
    if (now - lastChatGuardPersistToastTs < CHAT_GUARD_PERSIST_TOAST_INTERVAL_MS) return
    lastChatGuardPersistToastTs = now
    notifyError(language.errors.chatGuardPersistTitle, {
        description: language.errors.chatGuardPersistDesc,
        source: 'chat-guard-persist',
    })
}

// Dev-only preview helpers — bypass throttling so the dev panel always shows
// the toast immediately. Mirror the production helpers above so any wording
// or source-tag tweak shows up in the preview without extra synchronization.
export function previewChatGuardToast(variant: 'client' | 'server' | 'server-persist') {
    if (variant === 'server-persist') {
        notifyError(language.errors.chatGuardPersistTitle, {
            description: language.errors.chatGuardPersistDesc,
            source: 'chat-guard-persist',
        })
        return
    }
    notifyError(language.errors.chatGuardTitle, {
        description: `${language.errors.chatGuardDesc} [${variant}]`,
        source: 'chat-guard',
    })
}

export function previewPersistFailureToast() {
    notifyError(`${language.errors.persistFailureTitle} (${language.errors.persistFailureAttemptedSize} 2.10GB)`, {
        description: 'preview: simulated kvSet failure (BLOB size > INT_MAX)',
        source: 'persist-failure',
    })
}

export function requestImmediateSave(options?: {
    forceFullWrite?: boolean
}): Promise<DatabaseSaveOutcome> {
    return requestImmediateSaveImpl(options)
}

export function isImmediateDatabaseSaveReady(): boolean {
    return immediateDatabaseSaveReady
}

// Explicit arbitrary-target writers keep this bridge even though the state
// tracker now observes every proxied character. It gives import/plugin paths a
// synchronous durable target and covers work queued before saveDb() starts.
export function markCharacterDirty(chaId: string) {
    dirtyTargetBridge.markCharacter(chaId)
}

// Full chat bodies live in their own authoritative rows. Arbitrary-target
// writers must name the row explicitly because the reactive effect watches
// only the active chat.
export function markChatDirty(chaId: string, chatId: string) {
    dirtyTargetBridge.markChat(chaId, chatId)
}

export function setPatchSyncBaseline(data: Database | null) {
    patchSyncBaseline = data ? cloneDatabaseState(data) : null
}

export async function saveDb() {
    let changed = false
    let gotChannel = false
    const stagedAckTracker = new StagedAckTracker({
        flush: () => forageStorage.flushDatabase(),
        onReplay: () => {
            changed = true
        },
    })
    const saveRetryScheduler = new SaveRetryScheduler()
    const claimWriterAccessLoss = () => {
        if (gotChannel) return false
        gotChannel = true
        stagedAckTracker.replayAll('displaced')
        return true
    }
    const sessionID = v4()
    const saveCoordinator = new DatabaseSaveCoordinator()
    let doingChatState = get(doingChat)
    // Bootstrap can mutate live state before save tracking starts. The server-
    // read baseline is the only valid proof that a chat id already has a row.
    const initialSaveBaseline = patchSyncBaseline
        ?? cloneDatabaseState(getDatabase())
    const knownChatIdsByCharacter = buildKnownChatIdsByCharacter(initialSaveBaseline)
    const generationChatCheckpoints = new Map<string, number>()
    let channel: BroadcastChannel
    if (window.BroadcastChannel) {
        channel = new BroadcastChannel('risu-db')
    }
    if (channel) {
        channel.onmessage = (ev) => {
            if (ev.data === sessionID) {
                return
            }
            if (claimWriterAccessLoss()) {
                enterWriterTakeoverFlow()
            }
        }
    }
    // Cross-device single-writer lock: mirrors BroadcastChannel behavior
    // across devices via server-side session checks. Both a mutation-time 423
    // and a stale foreground status enter the same explicit recovery flow.
    window.addEventListener('risu-session-deactivated', (event) => {
        if (claimWriterAccessLoss()) {
            const detail = (event as CustomEvent<ClientUpgradeRequiredDetail>).detail
            enterWriterTakeoverFlow(
                detail?.reason === 'server-upgrade' || detail?.reason === 'server-restart'
                    ? detail.reason
                    : 'session-takeover',
            )
        }
    })

    // While this tab was hidden, another device may have taken the writer lock
    // and changed data. Detect that on return, before the next write can fail,
    // but preserve local state until the user explicitly chooses what to do.
    let lastLockReturnCheck = 0
    const checkWriterLockOnReturn = () => {
        const nowMs = Date.now()
        if (nowMs - lastLockReturnCheck < 5000) return
        lastLockReturnCheck = nowMs
        void checkWriterTakeoverOnReturn({
            getWriterLockState: () => forageStorage.getWriterLockState(),
            isOperationActive: () => get(chatOperationActive),
            claimWriterAccessLoss,
        }).catch(() => { /* status check failed — do nothing, write path 423 still guards */ })
    }
    window.addEventListener('focus', checkWriterLockOnReturn)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkWriterLockOnReturn()
    })

    const changeTracker: toSaveType = {
        character: [],
        chat: [],
        root: false,
        botPreset: false,
        modules: false,
        plugins: false,
        pluginCustomStorage: false
    }
    let databaseDirtyRevisionTracker: ReturnType<typeof watchDatabaseDirtyRevisions> | null = null
    // The boot patch baseline can predate setDatabase() defaults/plugin startup.
    // One acknowledged equality-fallback save is required before clean
    // revisions may be trusted against that baseline.
    let revisionTrustReady = false

    let encoder: RisuSaveEncoder | null = new RisuSaveEncoder()
    await encoder.init(getDatabase(), {
        compression: false
    })

    let patcher: RisuSavePatcher | null = new RisuSavePatcher()
    if (supportsPatchSync) {
        await patcher.init(initialSaveBaseline)
        patchSyncBaseline = null
        // setDatabase() defaults and plugin startup run before reactive
        // revision effects exist. Prove whether that live graph still matches
        // the server-read patch baseline once at startup; if it does not,
        // schedule a conservative all-branch synchronization. This is the
        // equality-backed foundation required before clean revisions can skip.
        const startupProposal = await patcher.set(getDatabase(), {
            character: [],
            chat: [],
            root: true,
            botPreset: true,
            modules: true,
            plugins: true,
            pluginCustomStorage: true,
        })
        if (startupProposal.patch.length > 0) {
            changeTracker.character = (getDatabase().characters ?? [])
                .map(character => character?.chaId)
                .filter((chaId): chaId is string => !!chaId)
            changeTracker.root = true
            changeTracker.botPreset = true
            changeTracker.modules = true
            changeTracker.plugins = true
            changeTracker.pluginCustomStorage = true
            changed = true
        }
        patcher.discard(startupProposal)
    }
    if (capturePreTrackingPluginStorageChanges(
        changeTracker,
        getDatabase(),
        initialSaveBaseline,
    )) {
        changed = true
    }

    function hasTrackedChanges(toSave: toSaveType) {
        return !!(
            toSave.botPreset ||
            toSave.modules ||
            toSave.plugins ||
            toSave.pluginCustomStorage ||
            toSave.root ||
            toSave.character.length > 0 ||
            toSave.chat.length > 0
        )
    }

    const hasQueuedDirtyState = () => (
        hasTrackedChanges(changeTracker)
        || !!databaseDirtyRevisionTracker?.ledger.hasDirty()
    )

    // A five-failure outage enters slow mode; reconnecting wakes the queued
    // save immediately instead of waiting for the capped retry interval.
    window.addEventListener('online', () => {
        if (gotChannel) return
        if (hasQueuedDirtyState() && saveRetryScheduler.expediteOnline()) {
            changed = true
        }
    })

    setClientBuildDirtyStateProbe(() => (
        changed
        || saving.state
        || hasQueuedDirtyState()
        || stagedAckTracker.hasStaged()
        || get(chatOperationActive)
    ))

    function takeTrackedChanges() {
        const toSave = safeStructuredClone(changeTracker)
        changeTracker.character = changeTracker.character.length === 0 ? [] : [changeTracker.character[0]]
        changeTracker.chat = changeTracker.chat.length === 0 ? [] : [changeTracker.chat[0]]
        changeTracker.root = false
        changeTracker.botPreset = false
        changeTracker.modules = false
        changeTracker.plugins = false
        changeTracker.pluginCustomStorage = false
        return toSave
    }

    async function flushServerDbKeepalive() {
        try {
            clientBuildFetch('/api/db/flush', {
                method: 'POST',
                keepalive: true,
                credentials: 'same-origin'
            }).catch(() => {})
        } catch {
            // ignore best-effort flush failures
        }
    }

    $effect.root(() => {

        let selIdState = $state(0)
        const debounceTime = 500; // 500 milliseconds
        let saveTimeout: ReturnType<typeof setTimeout> | null = null;
        let rearmActiveChatDirty = () => {}

        selectedCharID.subscribe((v) => {
            selIdState = v
        })

        function saveTimeoutExecute() {
            if (saveTimeout) {
                clearTimeout(saveTimeout);
            }
            saveTimeout = setTimeout(() => {
                changed = true;
            }, debounceTime);
        }

        doingChat.subscribe((isDoingChat) => {
            const wasDoingChat = doingChatState
            doingChatState = isDoingChat
            if (!wasDoingChat && isDoingChat) {
                generationChatCheckpoints.clear()
            }
            if (wasDoingChat && !isDoingChat) {
                rearmActiveChatDirty()
                saveTimeoutExecute()
            }
        })

        // Start a best-effort save immediately when the page is hidden/unloaded.
        function flushImmediate() {
            rearmActiveChatDirty()
            if (saveTimeout) {
                clearTimeout(saveTimeout);
                saveTimeout = null;
            }
            changed = true;
            void triggerSave({
                skipBroadcast: true,
                forceChatPersist: true,
            })
            void flushServerDbKeepalive()
        }
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushImmediate();
        });
        window.addEventListener('pagehide', flushImmediate);

        databaseDirtyRevisionTracker = watchDatabaseDirtyRevisions({
            getDatabase,
            onDirty: {
                rootKey: () => {
                    changeTracker.root = true
                    saveTimeoutExecute()
                },
                character: (chaId) => {
                    if (chaId) {
                        changeTracker.character = [
                            chaId,
                            ...changeTracker.character.filter(id => id !== chaId),
                        ]
                    }
                    saveTimeoutExecute()
                },
                botPreset: () => {
                    changeTracker.botPreset = true
                    saveTimeoutExecute()
                },
                module: () => {
                    changeTracker.modules = true
                    saveTimeoutExecute()
                },
                plugins: () => {
                    changeTracker.plugins = true
                    saveTimeoutExecute()
                },
                pluginCustomStorage: () => {
                    changeTracker.pluginCustomStorage = true
                    saveTimeoutExecute()
                },
            },
        })
        const activeChatDirtyTracker = watchActiveChatDirty({
            retouchDelayMs: ({ chatId }) => (
                get(generationStates).get(chatGenKey(chatId))?.kind === 'live'
                    ? CHECKPOINT_INTERVAL_MS
                    : debounceTime
            ),
            select: () => {
                const activeChar = DBState?.db?.characters?.[selIdState]
                const activeChat = activeChar?.chats?.[activeChar?.chatPage]
                const activeChaId = activeChar?.chaId ?? ''
                const activeChatId = activeChat?.id ?? ''
                return {
                    chaId: activeChaId,
                    chatId: activeChatId,
                    chat: activeChat,
                    suppressDirty: !!(
                        activeChaId && activeChatId && isHydrating(activeChaId, activeChatId)
                    ),
                }
            },
            onDirty: (activeChaId, activeChatId) => {
                if (
                    changeTracker.chat[0]?.[0] !== activeChaId ||
                    changeTracker.chat[0]?.[1] !== activeChatId
                ) {
                    changeTracker.chat.unshift([activeChaId, activeChatId])
                }
                saveTimeoutExecute()
            },
        })
        rearmActiveChatDirty = activeChatDirtyTracker.rearm

        return () => {
            activeChatDirtyTracker.stop()
            databaseDirtyRevisionTracker?.stop()
            databaseDirtyRevisionTracker = null
        }
    })

    // The state tracker establishes a clean reactive baseline synchronously;
    // reconcile startup-created/replaced full chats after its first flush so
    // their row writes cannot be discarded as initialization noise.
    await tick()
    if (capturePreTrackingFullChatChanges(
        changeTracker,
        getDatabase(),
        initialSaveBaseline,
    )) {
        for (const chaId of changeTracker.character) {
            databaseDirtyRevisionTracker?.markCharacter(chaId)
        }
        changed = true
    }

    function requeueChatChanges(chats: [string, string][]) {
        const chatSeen = new Set<string>()
        changeTracker.chat = [...chats, ...changeTracker.chat].filter((chatPair) => {
            const key = `${chatPair?.[0] ?? ''}|${chatPair?.[1] ?? ''}`
            if (chatSeen.has(key)) {
                return false
            }
            chatSeen.add(key)
            return true
        })
    }

    function requeueTrackedChanges(toSave: toSaveType) {
        changeTracker.character = [...new Set([...toSave.character, ...changeTracker.character])]
        requeueChatChanges(toSave.chat)
        changeTracker.botPreset = changeTracker.botPreset || toSave.botPreset
        changeTracker.modules = changeTracker.modules || toSave.modules
        changeTracker.plugins = changeTracker.plugins || toSave.plugins
        changeTracker.pluginCustomStorage = changeTracker.pluginCustomStorage || toSave.pluginCustomStorage
        changeTracker.root = changeTracker.root || toSave.root
    }

    async function rebaseTrackedLocalChangesOnLatestServerDb(
        db: Database,
        toSave: toSaveType,
        revisionProposal: RisuSaveDirtyRevisions | undefined,
    ) {
        // The replacement patcher is based on the authoritative candidate,
        // while the installed live graph includes local overlays. Require one
        // full equality run before clean revisions become authoritative again.
        revisionTrustReady = false
        const candidate = await forageStorage.readDatabaseCandidate()
        if (!candidate.data || candidate.data.length === 0) {
            throw new Error('Conflict recovery could not read the authoritative database')
        }

        const latestDb = await decodeAuthoritativeRisuSave(candidate.data) as Database
        recordConflictRebaseGraphBudget({
            phase: "candidate-decoded",
            liveGraphs: [
                "local-working",
                "latest-authoritative-working",
                "old-patcher-baseline",
            ],
        })

        // Release the rejected encoder/patcher generation before constructing
        // replacements. Proposal/full-write candidates are discarded by the
        // caller before entry, so no unacknowledged graph survives this point.
        encoder?.retire()
        patcher?.retire()
        encoder = null
        patcher = null
        recordConflictRebaseGraphBudget({
            phase: "old-codecs-retired",
            liveGraphs: ["local-working", "latest-authoritative-working"],
        })

        // The patch baseline is the body paired with candidate.etag, not the
        // merged local result. Initialize it before mutating latestDb in place.
        const nextPatcher = new RisuSavePatcher()
        if (supportsPatchSync) await nextPatcher.init(latestDb)
        recordConflictRebaseGraphBudget({
            phase: "replacement-baseline-ready",
            liveGraphs: [
                "local-working",
                "latest-authoritative-working",
                "replacement-patcher-baseline",
            ],
        })
        // Flush reactive dirtiness created during either network await, then
        // peek at revisions newer than this save proposal. The live tracker is
        // deliberately left untouched so these branches remain queued for the
        // retry after their current values are overlaid below.
        await tick()
        const lateRevisions = revisionProposal
            ? databaseDirtyRevisionTracker?.ledger.captureAfter(revisionProposal)
            : undefined
        const lateDirty: toSaveType = {
            character: [...(lateRevisions?.characters ?? [])],
            chat: safeStructuredClone(changeTracker.chat),
            root: (lateRevisions?.rootKeys.size ?? 0) > 0,
            rootKeys: [...(lateRevisions?.rootKeys ?? [])],
            botPreset: lateRevisions?.botPreset ?? false,
            modules: (lateRevisions?.modules.size ?? 0) > 0
                || lateRevisions?.modulesStructural === true,
            plugins: lateRevisions?.plugins ?? false,
            pluginCustomStorage: lateRevisions?.pluginCustomStorage ?? false,
        }
        const mergedDb = mergeTrackedDatabaseOnConflict(
            latestDb,
            db,
            toSave,
            knownChatIdsByCharacter,
            lateDirty,
        )
        for (const character of mergedDb.characters ?? []) {
            character.chats = convertStubsToPlaceholders(character.chats ?? [])
        }
        setDatabase(mergedDb)

        const nextEncoder = new RisuSaveEncoder()
        await nextEncoder.init(getDatabase(), {
            compression: false
        })
        encoder = nextEncoder
        patcher = nextPatcher
        recordConflictRebaseGraphBudget({
            phase: "authoritative-graph-installed",
            liveGraphs: [
                "local-working",
                "latest-authoritative-working",
                "replacement-patcher-baseline",
            ],
        })
        // Publish the ETag last. Any failure above leaves the rejected response
        // unable to authorize a full write of stale client state.
        forageStorage.setDbEtag(candidate.etag)
        requeueTrackedChanges(toSave)
        changed = true
    }

    async function persistTrackedChanges(
        toSave: toSaveType,
        dirtyRevisions: RisuSaveDirtyRevisions | undefined,
        revisionProposal: RisuSaveDirtyRevisions | undefined,
        options?: {
            forceFullWrite?: boolean
            skipBroadcast?: boolean
            forceChatPersist?: boolean
        }
    ): Promise<PersistTrackedChangesResult> {
        if (gotChannel) {
            // Another session owns the server. Keep this page's live state in
            // memory for the read-only recovery UI, but never retry stale data.
            stagedAckTracker.replayAll('displaced')
            return { status: 'displaced' }
        }
        if (channel && !options?.skipBroadcast) {
            channel.postMessage(sessionID)
        }

        const db = getDatabase()
        if (!db.characters) {
            await sleep(1000)
            return { status: 'noop' }
        }

        const chatPersistStage = await prepareChatPersistStage({
            db,
            toSave,
            doingChat: doingChatState,
            forceChatPersist: options?.forceChatPersist,
            knownChatIdsByCharacter,
            generationCheckpoints: generationChatCheckpoints,
            saveChat: saveChatToServer,
            requeueChats: requeueChatChanges,
            onRowWriteFailure: (chaId, chatId, error) => {
                console.error(`[Save] Failed to save chat ${chaId}/${chatId}:`, error)
            },
        })

        const activeEncoder = encoder
        const activePatcher = patcher
        if (!activeEncoder || !activePatcher) {
            throw new Error('Database save codecs are unavailable after conflict recovery')
        }

        // ── database.bin: exclude chat payload (stubs only via encoder) ──
        await activeEncoder.set(db, safeStructuredClone(toSave), dirtyRevisions)

        let saved = false
        let durable = false
        let newEtag: string | undefined
        let conflictRebaseToSave = toSave

        if (supportsPatchSync && !options?.forceFullWrite) {
            const patchData = await activePatcher.set(
                db,
                safeStructuredClone(toSave),
                dirtyRevisions,
            )
            conflictRebaseToSave = activePatcher.conflictDirtyBranches(patchData)
            // Refuse to send patches that would corrupt server-side lazy chats.
            // chatToStub strips chats to metadata before diffing, so the only
            // way these ops appear is a baseline desync. Falling through to a
            // full write rebuilds the server's stub view from scratch and
            // resyncs the patcher baseline. The console.error is the primary
            // breadcrumb for tracking down the unknown root cause.
            const dangerous = findDangerousChatOps(patchData.patch)
            if (dangerous.length > 0) {
                // Always log a one-line summary so production environments
                // see enough to file a bug report. The rich dump below is
                // gated behind a localStorage flag — chronic loops would
                // otherwise dump 5 console.errors every 5s save cycle.
                const sampleOps = dangerous.slice(0, 3).map(d => `${d.op} ${d.path}`).join(', ')
                console.error(
                    `[Save] Patcher emitted ${dangerous.length} chat-internal field op(s) — `
                    + `falling back to full write. sample: ${sampleOps}`
                    + ` (verbose dump: localStorage.setItem('${CHAT_GUARD_DEBUG_KEY}', '1') then reproduce)`
                )
                showChatGuardToastThrottled('client')

                if (isChatGuardDebugEnabled()) {
                // ── Diagnostic dump for unknown root cause ────────────────
                // chatToStub is supposed to strip every chat down to 6
                // metadata fields before the diff. If non-stub fields end
                // up in patch ops, something slipped past it. Dump enough
                // shape info to figure out which side of the diff carries
                // the contraband (baseline vs current) and what flags the
                // chat object has.
                const affectedChats: Record<string, any> = {}
                const seen = new Set<string>()
                const baselineCharsLen = (activePatcher as any).lastSyncedDb?.characters?.length ?? -1
                const currentCharsLen = db.characters?.length ?? -1

                const summarize = (c: any) => {
                    if (c == null) return null
                    const keys = Object.keys(c)
                    // Per-key shape: which fields are strings vs arrays vs objects vs primitives
                    const keyShapes: Record<string, string> = {}
                    for (const k of keys) {
                        const v = c[k]
                        if (v === null) keyShapes[k] = 'null'
                        else if (Array.isArray(v)) keyShapes[k] = `Array(${v.length})`
                        else if (typeof v === 'object') keyShapes[k] = `Object(${Object.keys(v).length})`
                        else keyShapes[k] = `${typeof v}=${typeof v === 'string' && v.length > 30 ? v.slice(0, 30) + '…' : JSON.stringify(v)}`
                    }
                    return {
                        keys,                                  // full key list, not just length
                        keyShapes,                             // per-key type/preview
                        classification: classifyChat(c),
                        _stub: c._stub,
                        _placeholder: c._placeholder,
                        hasMessage: Array.isArray(c.message),
                        messageLen: Array.isArray(c.message) ? c.message.length : null,
                        id: c.id,
                        name: c.name,
                        // Type fingerprints help identify Svelte $state proxies
                        // or other wrapper objects that might bypass deep clone.
                        ctor: c?.constructor?.name,
                        isFrozen: Object.isFrozen(c),
                        isProxy: typeof c === 'object' && c !== null && (c as any)?.[Symbol.toStringTag] !== undefined,
                    }
                }

                // Re-run chatToStub on the current chat to see what the patcher
                // would have produced. If this still has non-stub fields, the
                // bug is INSIDE chatToStub's isChatStub short-circuit (chat
                // already has `_stub: true` but isn't actually a stub).
                const stubReplay = (c: any) => {
                    if (c == null) return null
                    try {
                        const result = chatToStub(c)
                        return summarize(result)
                    } catch (e) {
                        return { error: String(e) }
                    }
                }

                for (const op of dangerous) {
                    const m = op.path.match(/^\/characters\/(\d+)\/chats\/(\d+)\//)
                    if (!m) continue
                    const key = `${m[1]}/${m[2]}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    if (seen.size > 5) break
                    const ci = +m[1], chi = +m[2]
                    const baselineChar = (activePatcher as any).lastSyncedDb?.characters?.[ci]
                    const currentChar = db.characters?.[ci]
                    const baselineChat = baselineChar?.chats?.[chi]
                    const currentChat = currentChar?.chats?.[chi]
                    const opsForThisChat = dangerous.filter(d => d.path.startsWith(`/characters/${ci}/chats/${chi}/`))
                    // Reference identity: same object? same chats array? same chat slot?
                    const refIdentity = {
                        sameCharacter: baselineChar === currentChar,
                        sameChatsArray: baselineChar?.chats === currentChar?.chats,
                        sameChatSlot: baselineChat === currentChat,
                    }
                    affectedChats[key] = {
                        characterContext: {
                            baselineChaId: baselineChar?.chaId,
                            currentChaId: currentChar?.chaId,
                            chaIdsMatch: baselineChar?.chaId === currentChar?.chaId,
                            baselineChatsLen: baselineChar?.chats?.length ?? -1,
                            currentChatsLen: currentChar?.chats?.length ?? -1,
                            refIdentity,
                        },
                        baselineChat: summarize(baselineChat),
                        currentChat: summarize(currentChat),
                        // The crucial diagnostic: if this still leaks message etc,
                        // chatToStub's isChatStub fast-path was the offender.
                        currentAfterChatToStub: stubReplay(currentChat),
                        baselineAfterChatToStub: stubReplay(baselineChat),
                        opsForThisChat,
                    }
                }

                // Distribution of stub/placeholder flags across the affected
                // characters' chats — useful to spot wholesale corruption
                // (e.g. a plugin replacing the entire chats array with
                // _stub-tagged objects).
                const charsDistribution: Record<string, any> = {}
                for (const k of Array.from(seen).slice(0, 3)) {
                    const ci = +k.split('/')[0]
                    const baselineChats = (activePatcher as any).lastSyncedDb?.characters?.[ci]?.chats ?? []
                    const currentChats = db.characters?.[ci]?.chats ?? []
                    const tally = (chats: any[]) => {
                        const t = { total: chats.length, stub: 0, placeholder: 0, hybrid: 0, full: 0, neither: 0 }
                        for (const c of chats) {
                            if (!c) continue
                            const isStub = c._stub === true
                            const isPh = c._placeholder === true
                            const hasMsg = Array.isArray(c.message)
                            if (isStub && hasMsg) t.hybrid++
                            else if (isStub) t.stub++
                            else if (isPh) t.placeholder++
                            else if (hasMsg) t.full++
                            else t.neither++
                        }
                        return t
                    }
                    charsDistribution[`character[${ci}]`] = {
                        baseline: tally(baselineChats),
                        current: tally(currentChats),
                    }
                }

                let activeCharID = -1
                try { selectedCharID.subscribe(v => { activeCharID = v })() } catch {}
                console.error('[Save:guard-debug] context:', {
                    baselineCharsLen,
                    currentCharsLen,
                    selectedCharID: activeCharID,
                    totalDangerousOps: dangerous.length,
                    uniqueAffectedChats: seen.size,
                })
                console.error('[Save:guard-debug] all dangerous ops:', dangerous)
                console.error('[Save:guard-debug] affected chats (baseline / current / stubReplay):', affectedChats)
                console.error('[Save:guard-debug] chats[] distribution per affected character:', charsDistribution)
                }
                activePatcher.discard(patchData)
                // Leave saved=false so the full-write path below kicks in.
            } else {
                const unbackedChats = rediscoverUnbackedFullChats(
                    db,
                    knownChatIdsByCharacter,
                    chatPersistStage.durableChatKeys,
                )
                if (unbackedChats.length > 0) {
                    activePatcher.discard(patchData)
                    requeueChatChanges(unbackedChats)
                    changed = true
                    return chatPersistStage.completeStubCommit({
                        committed: false,
                        result: { status: 'retry' } as const,
                    })
                }
                // Keep the final live-graph guard and dispatch in one synchronous
                // turn. Later mutations cannot enter this already-computed patch.
                let patchResult
                try {
                    patchResult = await forageStorage.patchItem('database/database.bin', patchData)
                } catch (error) {
                    activePatcher.discard(patchData)
                    throw error
                }
                saved = patchResult.success
                durable = patchResult.success && patchResult.durable === true
                if (patchResult.success) activePatcher.commit(patchData)
                else activePatcher.discard(patchData)
                if (patchResult.success && patchResult.etag) {
                    newEtag = patchResult.etag
                    forageStorage.setDbEtag(patchResult.etag)
                }
                if (patchResult.persistWarning) {
                    showPersistWarningOnce(patchResult.persistWarning)
                }
                // Server's chat-internal-field guard rejected the patch — the
                // client-side guard above missed this case. Surface to user
                // and continue to the full-write fallback below.
                if (patchResult.chatGuardRejected) {
                    console.error('[Save] Server rejected patch — chat-internal field ops detected server-side')
                    showChatGuardToastThrottled('server')
                }
                if (patchResult.conflict) {
                    console.warn('[Save] Patch conflict detected, rebasing tracked local changes on latest server DB...')
                    stagedAckTracker.replayAll('conflict')
                    await rebaseTrackedLocalChangesOnLatestServerDb(
                        db,
                        conflictRebaseToSave,
                        revisionProposal,
                    )
                    await sleep(saveRetryScheduler.conflictBackoffMs())
                    return chatPersistStage.completeStubCommit({
                        committed: false,
                        result: { status: 'retry' } as const,
                    })
                }
            }
        }
        if (!saved) {
            if (supportsPatchSync && !options?.forceFullWrite) {
                console.warn('[Save] Patch rejected without a database conflict, falling through to ETag-guarded full write...')
            }
            const currentEtag = forageStorage.getDbEtag()
            if (supportsPatchSync && !currentEtag) {
                throw new Error('Refusing an unversioned full database write; authoritative reload required')
            }

            // Keep the encoder's blocks current before patching, but assemble
            // the payload-sized contiguous database only after the patch path
            // has actually selected a full write.
            const encoded = activeEncoder.encode()
            if (!encoded) {
                await sleep(1000)
                return chatPersistStage.completeStubCommit({
                    committed: false,
                    result: { status: 'noop' } as const,
                })
            }
            const dbData = new Uint8Array(encoded)

            const unbackedChats = rediscoverUnbackedFullChats(
                db,
                knownChatIdsByCharacter,
                chatPersistStage.durableChatKeys,
            )
            if (unbackedChats.length > 0) {
                activeEncoder.discardNormalizedBaseline()
                requeueChatChanges(unbackedChats)
                changed = true
                return chatPersistStage.completeStubCommit({
                    committed: false,
                    result: { status: 'retry' } as const,
                })
            }
            // Keep the final live-graph guard and dispatch in one synchronous
            // turn. Later mutations cannot enter these already-encoded bytes.

            try {
                await forageStorage.setItem('database/database.bin', dbData, currentEtag ?? undefined)
            } catch (conflictErr) {
                activeEncoder.discardNormalizedBaseline()
                if (conflictErr instanceof ConflictError) {
                    if (supportsPatchSync && conflictRebaseToSave === toSave) {
                        const dirtyProposal = await activePatcher.set(
                            db,
                            safeStructuredClone(toSave),
                            dirtyRevisions,
                        )
                        conflictRebaseToSave = activePatcher.conflictDirtyBranches(dirtyProposal)
                        activePatcher.discard(dirtyProposal)
                    }
                    console.warn('[Save] Full-write conflict detected, rebasing tracked local changes on latest server DB...')
                    stagedAckTracker.replayAll('conflict')
                    await rebaseTrackedLocalChangesOnLatestServerDb(
                        db,
                        conflictRebaseToSave,
                        revisionProposal,
                    )
                    await sleep(saveRetryScheduler.conflictBackoffMs())
                    return chatPersistStage.completeStubCommit({
                        committed: false,
                        result: { status: 'retry' } as const,
                    })
                }
                throw conflictErr
            }

            durable = true

            // Transfer the exact graph represented by the acknowledged bytes;
            // no decode of our own full-write output is necessary.
            if (supportsPatchSync) {
                await activePatcher.initNormalizedBaseline(
                    activeEncoder.takeNormalizedBaseline(),
                )
            } else {
                activeEncoder.discardNormalizedBaseline()
            }
        }

        if (newEtag) {
            forageStorage.setDbEtag(newEtag)
        }

        return chatPersistStage.completeStubCommit({
            committed: true,
            result: { status: 'saved', durable, etag: newEtag } as const,
        })
    }

    async function triggerSave(options?: {
        forceFullWrite?: boolean
        skipBroadcast?: boolean
        forceChatPersist?: boolean
        requireDurable?: boolean
    }): Promise<DatabaseSaveOutcome> {
        return saveCoordinator.run(async () => {
            const toSave = takeTrackedChanges()
            const revisionProposal = databaseDirtyRevisionTracker?.ledger.capture()
            if (revisionProposal && revisionProposal.rootKeys.size > 0) {
                toSave.rootKeys = [...revisionProposal.rootKeys.keys()]
            }
            const hasDirtyRevisions = revisionProposal
                ? databaseDirtyRevisionTracker?.ledger.hasDirty(revisionProposal) === true
                : false
            if (!hasTrackedChanges(toSave) && !hasDirtyRevisions && !options?.forceFullWrite) {
                if (options?.requireDurable && stagedAckTracker.hasStaged()) {
                    const confirmed = await stagedAckTracker.confirmNow()
                    if (confirmed) return { status: 'committed' }
                    return gotChannel ? { status: 'displaced' } : { status: 'retry' }
                }
                return { status: 'committed' }
            }

            saving.state = true
            try {
                const result = await persistTrackedChanges(
                    toSave,
                    revisionTrustReady ? revisionProposal : undefined,
                    revisionProposal,
                    options,
                )
                if (result.status === 'saved' && result.durable) {
                    stagedAckTracker.confirmAll()
                    if (revisionProposal) databaseDirtyRevisionTracker?.ledger.commit(revisionProposal)
                    revisionTrustReady = true
                    saveRetryScheduler.recordSuccess()
                    return { status: 'committed' }
                } else if (result.status === 'saved') {
                    stagedAckTracker.recordStaged({
                        etag: result.etag,
                        commit: () => {
                            if (revisionProposal) {
                                databaseDirtyRevisionTracker?.ledger.commit(revisionProposal)
                            }
                        },
                        replay: () => {
                            if (revisionProposal) {
                                databaseDirtyRevisionTracker?.ledger.discard(revisionProposal)
                            }
                            requeueTrackedChanges(toSave)
                            changed = true
                        },
                    })
                    revisionTrustReady = true
                    saveRetryScheduler.recordSuccess()
                    if (options?.requireDurable) {
                        const confirmed = await stagedAckTracker.confirmNow()
                        if (!confirmed) {
                            return gotChannel ? { status: 'displaced' } : { status: 'retry' }
                        }
                    }
                    return { status: 'committed' }
                } else if (result.status === 'retry') {
                    if (revisionProposal) {
                        databaseDirtyRevisionTracker?.ledger.discard(revisionProposal)
                    }
                    return { status: 'retry' }
                } else if (result.status === 'displaced') {
                    stagedAckTracker.replayAll('displaced')
                    if (revisionProposal) {
                        databaseDirtyRevisionTracker?.ledger.discard(revisionProposal)
                    }
                    return { status: 'displaced' }
                } else if (result.status === 'noop' && (hasTrackedChanges(toSave) || hasDirtyRevisions)) {
                    requeueTrackedChanges(toSave)
                    // Once displaced, pause instead of spinning forever. The
                    // frozen page can only leave through an explicit reload.
                    if (!gotChannel) changed = true
                }
                if (revisionProposal) {
                    databaseDirtyRevisionTracker?.ledger.discard(revisionProposal)
                }
                return {
                    status: 'failed',
                    error: new Error('Database save completed without a durable write'),
                }
            } catch (error) {
                if (revisionProposal) {
                    databaseDirtyRevisionTracker?.ledger.discard(revisionProposal)
                }
                requeueTrackedChanges(toSave)
                const retryPlan = saveRetryScheduler.recordFailure()
                if (retryPlan.kind === 'quick') {
                    console.error(error)
                    await sleep(retryPlan.delayMs)
                    changed = true
                } else {
                    if (retryPlan.alert) alertError(error)
                    else console.error(error)
                    // No sleep here: slow-mode pacing must not hold the save
                    // coordinator. The idle-loop watchdog re-arms `changed`.
                }
                return { status: 'failed', error }
            } finally {
                saving.state = false
            }
        }, {
            // A force request is a durability barrier for its caller. It must
            // run after an older save rather than inherit that save's promise.
            queueAfterInFlight: options?.forceFullWrite
                || options?.forceChatPersist
                || options?.requireDurable,
        })
    }

    requestImmediateSaveImpl = async (options) => {
        changed = true
        await tick()
        return triggerSave({
            forceFullWrite: options?.forceFullWrite,
            requireDurable: true,
        })
    }
    immediateDatabaseSaveReady = true

    // Publish the bridges only after encoder, patcher, and reactive tracking
    // are ready. Calls made during plugin/bootstrap work remain queued above
    // and are drained into the first ordinary save.
    dirtyTargetBridge.activate({
        character: (chaId) => {
            databaseDirtyRevisionTracker?.markCharacter(chaId)
            changeTracker.character = [chaId, ...changeTracker.character.filter(id => id !== chaId)]
            changed = true
        },
        chat: (chaId, chatId) => {
            changeTracker.chat = [
                [chaId, chatId],
                ...changeTracker.chat.filter(([queuedChaId, queuedChatId]) => (
                    queuedChaId !== chaId || queuedChatId !== chatId
                )),
            ]
            changed = true
        },
    })

    while (true) {
        if (!changed) {
            if (
                !gotChannel
                && hasQueuedDirtyState()
                && saveRetryScheduler.shouldWakeIdleLoop()
            ) {
                changed = true
            } else {
                await sleep(200)
                continue
            }
        }
        changed = false
        if (requiresFullEncoderReload.state) {
            encoder?.retire()
            encoder = new RisuSaveEncoder()
            await encoder.init(getDatabase(), {
                compression: false,
                skipRemoteSavingOnCharacters: false
            })
            requiresFullEncoderReload.state = false
        }
        await triggerSave()
        await sleep(100)
    }
}

/**
 * Retrieves the database backups.
 * 
 * @returns {Promise<number[]>} - A promise that resolves to an array of backup timestamps.
 */
export async function getDbBackups(currentDbSize?: number) {
    const keys = await forageStorage.keys()

    const backups = keys
        .filter(key => key.startsWith('database/dbbackup-'))
        .map(key => parseInt(key.slice(18, -4)))
        .sort((a, b) => b - a);

    const BACKUP_BUDGET = 500 * 1024 * 1024 // 500MB
    const maxBackups = currentDbSize
        ? Math.min(20, Math.max(3, Math.floor(BACKUP_BUDGET / currentDbSize)))
        : 20

    while (backups.length > maxBackups) {
        const last = backups.pop()
        await forageStorage.removeItem(`database/dbbackup-${last}.bin`)
    }
    return backups
}

let usingSw = false

export function setUsingSw(value: boolean) {
    usingSw = value
}


const knownHostes = ["localhost", "127.0.0.1", "0.0.0.0"];

/**
 * Interface representing the arguments for the global fetch function.
 * 
 * @interface GlobalFetchArgs
 * @property {boolean} [plainFetchForce] - Whether to force plain fetch.
 * @property {any} [body] - The body of the request.
 * @property {{ [key: string]: string }} [headers] - The headers of the request.
 * @property {boolean} [rawResponse] - Whether to return the raw response.
 * @property {'POST' | 'GET'} [method] - The HTTP method to use.
 * @property {AbortSignal} [abortSignal] - The abort signal to cancel the request.
 * @property {boolean} [useRisuToken] - Whether to use the Risu token.
 * @property {string} [chatId] - The chat ID associated with the request.
 */
interface GlobalFetchArgs {
    plainFetchForce?: boolean;
    plainFetchDeforce?: boolean;
    body?: any;
    headers?: { [key: string]: string };
    rawResponse?: boolean;
    method?: 'POST' | 'GET';
    abortSignal?: AbortSignal;
    useRisuToken?: boolean;
    chatId?: string;
    interceptor?: string;
    requestTimeoutMs?: number;
    networkRoute?: 'auto' | 'local_network';
    /** Request-log classification. Defaults to the neutral 'other'/'other';
     *  LLM call sites pass 'llm' plus the issuing part of the app so the log's
     *  default filter and the usage statistics can tell them apart. */
    logCategory?: RequestLogCategory;
    logSource?: RequestLogSource;
    logModel?: string;
}

/**
 * Interface representing the result of the global fetch function.
 * 
 * @interface GlobalFetchResult
 * @property {boolean} ok - Whether the request was successful.
 * @property {any} data - The data returned from the request.
 * @property {{ [key: string]: string }} headers - The headers returned from the request.
 */
interface GlobalFetchResult {
    ok: boolean;
    data: any;
    headers: { [key: string]: string };
    status: number;
}

/**
 * Performs a global fetch request.
 * 
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} [arg={}] - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
export async function globalFetch(url: string, arg: GlobalFetchArgs = {}): Promise<GlobalFetchResult> {
    try {
        const db = getDatabase();

        if (arg.abortSignal?.aborted) { return { ok: false, data: 'aborted', headers: {}, status: 400 }; }

        const urlHost = new URL(url).hostname
        const useLocalNetworkRoute = arg.networkRoute === 'local_network' && isLocalNetworkUrl(url)
        const forcePlainFetch = ((knownHostes.includes(urlHost)) || db.usePlainFetch || arg.plainFetchForce) && !arg.plainFetchDeforce && !useLocalNetworkRoute

        if(arg.interceptor){
            for (const interceptor of bodyIntercepterStore) {
                try {
                    arg.body = await interceptor.callback(arg.body, arg.interceptor) || arg.body
                }
                catch (e) {
                    console.error(e)
                }
            }
        }

        const timeoutSignal = buildTimeoutSignal(arg.abortSignal, arg.requestTimeoutMs)
        const requestArg = timeoutSignal.signal === arg.abortSignal
            ? arg
            : { ...arg, abortSignal: timeoutSignal.signal }

        try {
            if (useLocalNetworkRoute) {
                return await fetchWithProxy(url, requestArg);
            }

            if (forcePlainFetch) {
                return await fetchWithPlainFetch(url, requestArg);
            }
            //userScriptFetch is provided by userscript
            if (window.userScriptFetch && !arg.plainFetchDeforce) {
                return await fetchWithUSFetch(url, requestArg);
            }
            return await fetchWithProxy(url, requestArg);
        } finally {
            timeoutSignal.cleanup()
        }

    } catch (error) {
        console.error(error);
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Records a completed globalFetch request in the server request log.
 *
 * @param {any} response - The response data.
 * @param {boolean} success - Indicates if the fetch was successful.
 * @param {string} url - The URL of the fetch request.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @param {number} started - Epoch ms when the request was issued, for duration.
 */
function addFetchLogInGlobalFetch(response: any, success: boolean, url: string, arg: GlobalFetchArgs, status: number | undefined, started: number) {
    // Opt-in, same rule as fetchNative: untagged call sites (TTS polling,
    // asset downloads, plugin traffic) are not worth a persisted row.
    if (!arg.logCategory) return
    const stringify = (value: unknown) => {
        try {
            return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        } catch {
            return `${value}`
        }
    }
    recordRequestLog({
        timestamp: started,
        category: arg.logCategory ?? 'other',
        source: arg.logSource ?? 'other',
        chatId: arg.chatId,
        model: arg.logModel,
        url,
        method: arg.method ?? 'POST',
        status,
        success,
        streaming: false,
        durationMs: Date.now() - started,
        requestHeaders: stringify(arg.headers ?? {}),
        requestBody: stringify(arg.body),
        responseBody: stringify(response),
    })
}

/**
 * Performs a fetch request using plain fetch.
 * 
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithPlainFetch(url: string, arg: GlobalFetchArgs): Promise<GlobalFetchResult> {
    try {
        const started = Date.now();
        const headers = { 'Content-Type': 'application/json', ...arg.headers };
        const response = await fetch(new URL(url), { body: JSON.stringify(arg.body), headers, method: arg.method ?? "POST", signal: arg.abortSignal });
        const data = arg.rawResponse ? new Uint8Array(await response.arrayBuffer()) : await response.json();
        const ok = response.ok && response.status >= 200 && response.status < 300;
        addFetchLogInGlobalFetch(data, ok, url, arg, response.status, started);
        return { ok, data, headers: Object.fromEntries(response.headers), status: response.status };
    } catch (error) {
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Performs a fetch request using userscript provided fetch.
 * 
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithUSFetch(url: string, arg: GlobalFetchArgs): Promise<GlobalFetchResult> {
    try {
        const started = Date.now();
        const headers = { 'Content-Type': 'application/json', ...arg.headers };
        const response = await userScriptFetch(url, { body: JSON.stringify(arg.body), headers, method: arg.method ?? "POST", signal: arg.abortSignal });
        const data = arg.rawResponse ? new Uint8Array(await response.arrayBuffer()) : await response.json();
        const ok = response.ok && response.status >= 200 && response.status < 300;
        addFetchLogInGlobalFetch(data, ok, url, arg, response.status, started);
        return { ok, data, headers: Object.fromEntries(response.headers), status: response.status };
    } catch (error) {
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Performs a fetch request using a proxy.
 * 
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithProxy(url: string, arg: GlobalFetchArgs): Promise<GlobalFetchResult> {
    try {
        const started = Date.now();
        const furl = `/proxy2`;
        arg.headers["Content-Type"] ??= arg.body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json";
        const headers = {
            "risu-header": encodeURIComponent(JSON.stringify(arg.headers)),
            "risu-url": encodeURIComponent(url),
            "Content-Type": arg.body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json",
            ...(arg.useRisuToken && { "x-risu-tk": "use" }),
            ...(DBState?.db?.requestLocation && { "risu-location": DBState.db.requestLocation }),
        };

        // Add risu-auth header for Node.js server
        headers["risu-auth"] = await forageStorage.createAuth();

        const body = arg.body instanceof URLSearchParams ? arg.body.toString() : JSON.stringify(arg.body);

        const response = await fetch(furl, { body, headers, method: arg.method ?? "POST", signal: arg.abortSignal });
        const isSuccess = response.ok && response.status >= 200 && response.status < 300;

        if (arg.rawResponse) {
            const data = new Uint8Array(await response.arrayBuffer());
            addFetchLogInGlobalFetch("Uint8Array Response", isSuccess, url, arg, response.status, started);
            return { ok: isSuccess, data, headers: Object.fromEntries(response.headers), status: response.status };
        }

        const text = await response.text();
        try {
            const data = JSON.parse(text);
            addFetchLogInGlobalFetch(data, isSuccess, url, arg, response.status, started);
            return { ok: isSuccess, data, headers: Object.fromEntries(response.headers), status: response.status };
        } catch (error) {
            const errorMsg = text.startsWith('<!DOCTYPE') ? "Responded HTML. Is your URL, API key, and password correct?" : text;
            addFetchLogInGlobalFetch(text, false, url, arg, response.status, started);
            return { ok: false, data: errorMsg, headers: Object.fromEntries(response.headers), status: response.status };
        }
    } catch (error) {
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Regular expression to match backslashes.
 * 
 * @constant {RegExp}
 */
const re = /\\/g;

/**
 * Gets the basename of a given path.
 * 
 * @param {string} data - The path to get the basename from.
 * @returns {string} - The basename of the path.
 */
export function getBasename(data: string) {
    const splited = data.replace(re, '/').split('/');
    const lasts = splited[splited.length - 1];
    return lasts;
}

/**
 * Replaces database resources with the provided replacer object.
 * 
 * @param {Database} db - The database object containing resources to be replaced.
 * @param {{[key: string]: string}} replacer - An object mapping original resource keys to their replacements.
 * @returns {Database} - The updated database object with replaced resources.
 */
export function replaceDbResources(db: Database, replacer: { [key: string]: string }): Database {
    /**
     * Replaces a given data string with its corresponding value from the replacer object.
     * 
     * @param {string} data - The data string to be replaced.
     * @returns {string} - The replaced data string or the original data if no replacement is found.
     */
    function replaceData(data: string): string {
        if (!data) {
            return data;
        }
        return replacer[data] ?? data;
    }

    db.customBackground = replaceData(db.customBackground);
    db.userIcon = replaceData(db.userIcon);
    db.messageSound = replaceData(db.messageSound);
    db.translateSound = replaceData(db.translateSound);
    if (db.customSounds) {
        for (const s of db.customSounds) {
            s.path = replaceData(s.path);
        }
    }

    for (const cha of db.characters) {
        if (cha.image) {
            cha.image = replaceData(cha.image);
        }
        if (cha.emotionImages) {
            for (let i = 0; i < cha.emotionImages.length; i++) {
                cha.emotionImages[i][1] = replaceData(cha.emotionImages[i][1]);
            }
        }
        if (cha.additionalAssets) {
            for (let i = 0; i < cha.additionalAssets.length; i++) {
                cha.additionalAssets[i][1] = replaceData(cha.additionalAssets[i][1]);
            }
        }
    }
    return db;
}

/**
 * Checks and updates the character order in the database.
 * Ensures that all characters are properly ordered and removes any invalid entries.
 */
export function checkCharOrder() {
    let db = getDatabase()
    db.characterOrder = db.characterOrder ?? []
    let ordered = []
    for (let i = 0; i < db.characterOrder.length; i++) {
        const folder = db.characterOrder[i]
        if (typeof (folder) !== 'string' && folder) {
            for (const f of folder.data) {
                ordered.push(f)
            }
        }
        if (typeof (folder) === 'string') {
            ordered.push(folder)
        }
    }

    let charIdList: string[] = []

    for (let i = 0; i < db.characters.length; i++) {
        const char = db.characters[i]
        const charId = char.chaId
        if (!char.trashTime) {
            charIdList.push(charId)
        }
        if (!ordered.includes(charId)) {
            if (charId !== '§temp' && charId !== '§playground' && !char.trashTime) {
                db.characterOrder.push(charId)
            }
        }
    }


    for (let i = 0; i < db.characterOrder.length; i++) {
        const data = db.characterOrder[i]
        if (typeof (data) !== 'string') {
            if (!data) {
                db.characterOrder.splice(i, 1)
                i--;
                continue
            }
            if (data.data.length === 0) {
                db.characterOrder.splice(i, 1)
                i--;
                continue
            }
            for (let i2 = 0; i2 < data.data.length; i2++) {
                const data2 = data.data[i2]
                if (!charIdList.includes(data2)) {
                    data.data.splice(i2, 1)
                    i2--;
                }
            }
            db.characterOrder[i] = data
        }
        else {
            if (!charIdList.includes(data)) {
                db.characterOrder.splice(i, 1)
                i--;
            }
        }
    }


}

/**
 * Retrieves the most recent request logs. Kept for the plugin API (v3
 * getFetchLogs), which has always been Promise-returning, so moving the
 * storage server-side is invisible to plugins.
 */
export async function getFetchLogs(limit = 20) {
    return await fetchRequestLogs({ limit, bodies: true })
}

/**
 * Opens a URL in the appropriate environment.
 * 
 * @param {string} url - The URL to open.
 */
export function openURL(url: string) {
    window.open(url, "_blank")
}

/**
 * Converts FormData to a URL-encoded string.
 * 
 * @param {FormData} formData - The FormData to convert.
 * @returns {string} The URL-encoded string.
 */
function formDataToString(formData: FormData): string {
    const params: string[] = [];

    for (const [name, value] of formData.entries()) {
        params.push(`${encodeURIComponent(name)}=${encodeURIComponent(value.toString())}`);
    }

    return params.join('&');
}

/**
 * Class representing a local writer.
 */
export class LocalWriter {
    writer: WritableStreamDefaultWriter

    /**
     * Initializes the writer.
     * 
     * @param {string} [name='Binary'] - The name of the file.
     * @param {string[]} [ext=['bin']] - The file extensions.
     * @returns {Promise<boolean>} - A promise that resolves to a boolean indicating success.
     */
    async init(name = 'Binary', ext = ['bin']): Promise<boolean> {
        const writableStream = streamSaver.createWriteStream(name + '.' + ext[0])
        this.writer = writableStream.getWriter()
        return true
    }

    /**
     * Writes backup data to the file.
     * 
     * @param {string} name - The name of the backup.
     * @param {Uint8Array} data - The data to write.
     */
    async writeBackup(name: string, data: Uint8Array): Promise<void> {
        const encodedName = new TextEncoder().encode(getBasename(name))
        const nameLength = new Uint32Array([encodedName.byteLength])
        await this.writer.write(new Uint8Array(nameLength.buffer))
        await this.writer.write(encodedName)
        const dataLength = new Uint32Array([data.byteLength])
        await this.writer.write(new Uint8Array(dataLength.buffer))
        await this.writer.write(data)
    }

    /**
     * Writes data to the file.
     * 
     * @param {Uint8Array} data - The data to write.
     */
    async write(data: Uint8Array): Promise<void> {
        await this.writer.write(data)
    }

    /**
     * Closes the writer.
     */
    async close(): Promise<void> {
        await this.writer.close()
    }
}

/**
 * Class representing a virtual writer.
 */
export class VirtualWriter {
    buf = new AppendableBuffer()

    /**
     * Writes data to the buffer.
     * 
     * @param {Uint8Array} data - The data to write.
     */
    write(data: Uint8Array): void {
        this.buf.append(data)
    }

    /**
     * Closes the writer. (No operation for VirtualWriter)
     */
    close(): void {
        // do nothing
    }
}

/**
 * Index for fetch operations.
 * @type {number}
 */
let fetchIndex = 0

/**
 * Stores native fetch data.
 * @type {{ [key: string]: StreamedFetchChunk[] }}
 */
let nativeFetchData: { [key: string]: StreamedFetchChunk[] } = {}

/**
 * Interface representing a streamed fetch chunk data.
 * @interface
 */
interface StreamedFetchChunkData {
    type: 'chunk',
    body: string,
    id: string
}

/**
 * Interface representing a streamed fetch header data.
 * @interface
 */
interface StreamedFetchHeaderData {
    type: 'headers',
    body: { [key: string]: string },
    id: string,
    status: number
}

/**
 * Interface representing a streamed fetch end data.
 * @interface
 */
interface StreamedFetchEndData {
    type: 'end',
    id: string
}

/**
 * Type representing a streamed fetch chunk.
 * @typedef {StreamedFetchChunkData | StreamedFetchHeaderData | StreamedFetchEndData} StreamedFetchChunk
 */
type StreamedFetchChunk = StreamedFetchChunkData | StreamedFetchHeaderData | StreamedFetchEndData

/**
 * Interface representing a streamed fetch plugin.
 * @interface
 */
interface StreamedFetchPlugin {
    /**
     * Performs a streamed fetch operation.
     * @param {Object} options - The options for the fetch operation.
     * @param {string} options.id - The ID of the fetch operation.
     * @param {string} options.url - The URL to fetch.
     * @param {string} options.body - The body of the fetch request.
     * @param {{ [key: string]: string }} options.headers - The headers of the fetch request.
     * @returns {Promise<{ error: string, success: boolean }>} - The result of the fetch operation.
     */
    streamedFetch(options: { id: string, url: string, body: string, headers: { [key: string]: string } }): Promise<{ "error": string, "success": boolean }>;

    /**
     * Adds a listener for the specified event.
     * @param {string} eventName - The name of the event.
     * @param {(data: StreamedFetchChunk) => void} listenerFunc - The function to call when the event is triggered.
     */
    addListener(eventName: 'streamed_fetch', listenerFunc: (data: StreamedFetchChunk) => void): void;
}

/**
 * Indicates whether streamed fetch listening is active.
 * @type {boolean}
 */
let streamedFetchListening = false

/**
 * The streamed fetch plugin instance.
 * @type {StreamedFetchPlugin | undefined}
 */
let capStreamedFetch: StreamedFetchPlugin | undefined


/**
 * A class to manage a buffer that can be appended to and deappended from.
 */
export class AppendableBuffer {
    deapended: number = 0
    #buffer: Uint8Array
    #byteLength: number = 0

    /**
     * Creates an instance of AppendableBuffer.
     */
    constructor() {
        this.#buffer = new Uint8Array(128)
    }

    get buffer(): Uint8Array {
        return this.#buffer.slice(0, this.#byteLength)
    }

    /**
     * Appends data to the buffer.
     * @param {Uint8Array} data - The data to append.
     */
    append(data: Uint8Array) {
        // New way (faster)
        const requiredLength = this.#byteLength + data.length
        if (this.#buffer.byteLength < requiredLength) {
            let newLength = this.#buffer.byteLength * 2
            while (newLength < requiredLength) {
                newLength *= 2
            }
            const newBuffer = new Uint8Array(newLength)
            newBuffer.set(this.#buffer)
            this.#buffer = newBuffer
        }
        this.#buffer.set(data, this.#byteLength)
        this.#byteLength += data.length
    }

    /**
     * Deappends a specified length from the buffer.
     * @param {number} length - The length to deappend.
     */
    deappend(length: number) {
        this.#buffer = this.#buffer.slice(length)
        this.deapended += length
        this.#byteLength -= length
    }

    /**
     * Slices the buffer from start to end.
     * @param {number} start - The start index.
     * @param {number} end - The end index.
     * @returns {Uint8Array} - The sliced buffer.
     */
    slice(start: number, end: number) {
        return this.buffer.slice(start - this.deapended, end - this.deapended)
    }

    /**
     * Gets the total length of the buffer including deappended length.
     * @returns {number} - The total length.
     */
    length() {
        return this.#byteLength + this.deapended
    }

    /**
     * Clears the buffer.
     */
    clear() {
        this.#buffer = new Uint8Array(128)
        this.#byteLength = 0
        this.deapended = 0
    }
}

/**
 * Fetches data from a given URL using native fetch or through a proxy.
 * @param {string} url - The URL to fetch data from.
 * @param {Object} arg - The arguments for the fetch request.
 * @param {string} arg.body - The body of the request.
 * @param {Object} [arg.headers] - The headers of the request.
 * @param {string} [arg.method="POST"] - The HTTP method of the request.
 * @param {AbortSignal} [arg.signal] - The signal to abort the request.
 * @param {boolean} [arg.useRisuTk] - Whether to use Risu token.
 * @param {string} [arg.chatId] - The chat ID associated with the request.
 * @returns {Promise<Object>} - A promise that resolves to an object containing the response body, headers, and status.
 * @returns {ReadableStream<Uint8Array>} body - The response body as a readable stream.
 * @returns {Headers} headers - The response headers.
 * @returns {number} status - The response status code.
 * @throws {Error} - Throws an error if the request is aborted or if there is an error in the response.
 */
export interface FetchNativeArgs {
    body?: string | Uint8Array | ArrayBuffer,
    headers?: { [key: string]: string },
    method?: "POST" | "GET" | "PUT" | "DELETE",
    signal?: AbortSignal,
    useRisuTk?: boolean,
    chatId?: string
    interceptor?: string
    requestTimeoutMs?: number
    networkRoute?: 'auto' | 'local_network'
    /** Request-log classification; see GlobalFetchArgs for the same fields. */
    logCategory?: RequestLogCategory
    logSource?: RequestLogSource
    logModel?: string
    /** Reports which transport was actually used. Fires regardless of
     *  logCategory, so a caller that logs at a higher level (the model-preset
     *  path) can record the true route instead of guessing. */
    onLogRoute?: (route: RequestLogRoute) => void
}

export async function fetchNative(url: string, arg: FetchNativeArgs): Promise<Response> {
    // Logging is OPT-IN: only call sites that tag a category are recorded.
    // Logging everything that passes through here was actively harmful —
    // ComfyUI polls /history once a second, /view returns a PNG that would be
    // text-decoded and stored, an MCP SSE connection stays open for the whole
    // session, and makeProxiedFetch routes the model-preset path through here,
    // which produced a second, untagged row for every preset request.
    if (!arg.logCategory) {
        return fetchNativeRaw(url, arg, { onRoute: arg.onLogRoute })
    }
    // Logging wraps the transport rather than living inside it: fetchNativeRaw
    // returns from several branches (userscript / WS proxy job / proxy2 /
    // direct), and the response body is a stream that must be tee'd exactly
    // once. The scope handles both, and assembles the streamed text so the log
    // records the real response instead of a "Streamed Fetch" placeholder.
    const scope = createRequestLogScope({
        category: arg.logCategory ?? 'other',
        source: arg.logSource ?? 'other',
        chatId: arg.chatId,
        model: arg.logModel,
        streaming: true,
    })
    const logged = scope.wrap(((_input: RequestInfo | URL, _init?: RequestInit) =>
        fetchNativeRaw(url, arg, {
            onRealBody: (body) => scope.setRequestBody(body),
            onRoute: (route) => { scope.setRoute(route); arg.onLogRoute?.(route) },
        })
    ) as typeof fetch)
    try {
        return await logged(url, {
            method: arg.method ?? 'POST',
            headers: arg.headers,
            body: arg.body as BodyInit | undefined,
        })
    } finally {
        // Fire-and-forget: close() waits for the tee'd body to finish
        // assembling, which outlives this return for a streamed response.
        void scope.close()
    }
}

async function fetchNativeRaw(url: string, arg: FetchNativeArgs, hooks?: {
    onRealBody?: (body: string) => void,
    onRoute?: (route: RequestLogRoute) => void,
}): Promise<Response> {
    const useInterceptor = !!arg.interceptor
    if (arg.body === undefined && (arg.method === 'POST' || arg.method === 'PUT')) {
        throw new Error('Body is required for POST and PUT requests')
    }

    arg.method = arg.method ?? 'POST'

    const headers = arg.headers ?? {}
    let realBody: Uint8Array | undefined

    if (arg.method === 'GET' || arg.method === 'DELETE') {
        realBody = undefined
    }
    else if (typeof arg.body === 'string') {
        let body: string = arg.body
        if(useInterceptor) {
            for (const interceptor of bodyIntercepterStore) {
                try {
                    body = await interceptor.callback(body, arg.interceptor) || body
                }
                catch (e) {
                    console.error(e)
                }
            }
        }
        realBody = new TextEncoder().encode(body)
    }
    else if (arg.body instanceof Uint8Array) {
        realBody = arg.body
    }
    else if (arg.body instanceof ArrayBuffer) {
        realBody = new Uint8Array(arg.body)
    }
    else {
        throw new Error('Invalid body type')
    }

    // The logged body is the one actually sent — after any body interceptor
    // rewrote it — which is why it is reported from here rather than from the
    // wrapper's view of arg.body.
    hooks?.onRealBody?.(realBody ? new TextDecoder().decode(realBody) : '')
    const useLocalNetworkRoute = arg.networkRoute === 'local_network' && isLocalNetworkUrl(url)
    const timeoutSignal = buildTimeoutSignal(arg.signal, arg.requestTimeoutMs)
    const requestSignal = timeoutSignal.signal
    const db = getDatabase()
    let throughProxy = !db.usePlainFetch
    if (useLocalNetworkRoute) {
        throughProxy = true
    }

    try {
        if (window.userScriptFetch && !throughProxy) {
            hooks?.onRoute?.('direct')
            return await window.userScriptFetch(url, {
                body: realBody as any,
                headers: headers,
                method: arg.method,
                signal: requestSignal
            })
        }

        // Local network streaming: try WebSocket proxy job, fallback to /proxy2
        const useProxyJobWs = useLocalNetworkRoute
            && arg.interceptor === 'openai_streaming'
            && arg.method === 'POST'
        if (useProxyJobWs) {
            try {
                const res = await fetchViaProxyJobWs(url, {
                    method: arg.method,
                    headers,
                    body: realBody,
                    signal: requestSignal,
                    requestTimeoutMs: arg.requestTimeoutMs,
                })
                hooks?.onRoute?.('proxy')
                return res
            } catch (wsErr) {
                console.warn('[ProxyJobWS] fallback to /proxy2 due to error:', wsErr)
            }
        }

        // Local network non-streaming or WS fallback: go through /proxy2 directly
        if (useLocalNetworkRoute) {
            hooks?.onRoute?.('proxy')
            return await fetchViaProxy2(url, headers, realBody, {
                ...arg,
                signal: requestSignal
            })
        }

        // Try direct fetch first (upstream behavior), fall back to proxy on CORS/network error
        try {
            const res = await fetch(url, {
                body: realBody as any,
                headers: headers,
                method: arg.method,
                signal: requestSignal,
            })
            hooks?.onRoute?.('direct')
            return res
        } catch (e) {
            if (requestSignal?.aborted) throw e
            // The route is only known once the direct attempt has failed, which
            // is why it is reported here rather than guessed up front.
            hooks?.onRoute?.('proxy')
            return await fetchViaProxy2(url, headers, realBody, {
                ...arg,
                signal: requestSignal
            })
        }
    } finally {
        timeoutSignal.cleanup()
    }
}

const defaultProxyJobHeartbeatSec = 15

async function fetchViaProxy2(
    url: string,
    headers: Record<string, string>,
    realBody: Uint8Array | undefined,
    arg: { method?: string, signal?: AbortSignal, useRisuTk?: boolean, requestTimeoutMs?: number }
): Promise<Response> {
    const proxyHeaders: Record<string, string> = {
        "risu-header": encodeURIComponent(JSON.stringify(headers)),
        "risu-url": encodeURIComponent(url),
        "risu-auth": await forageStorage.createAuth(),
        ...(arg.useRisuTk ? { "x-risu-tk": "use" } : {}),
        ...(arg.requestTimeoutMs && { "risu-timeout-ms": Math.max(1, Math.floor(arg.requestTimeoutMs)).toString() }),
        ...(DBState?.db?.requestLocation ? { "risu-location": DBState.db.requestLocation } : {}),
    }

    if (realBody) {
        proxyHeaders["Content-Type"] = headers["Content-Type"] ?? headers["content-type"] ?? "application/json"
    }

    const r = await fetch(`/proxy2`, {
        body: realBody as any,
        headers: proxyHeaders,
        method: arg.method,
        signal: arg.signal
    })

    return new Response(r.body, {
        headers: r.headers,
        status: r.status
    })
}

async function fetchViaProxyJobWs(url: string, arg: {
    method: string,
    headers: Record<string, string>,
    body?: Uint8Array,
    signal?: AbortSignal,
    requestTimeoutMs?: number,
}): Promise<Response> {
    const auth = await forageStorage.createAuth()
    const bodyBase64 = arg.body ? Buffer.from(arg.body).toString('base64') : ''

    const jobRes = await fetch('/proxy-stream-jobs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'risu-auth': auth,
        },
        body: JSON.stringify({
            url,
            method: arg.method,
            headers: arg.headers,
            bodyBase64,
            timeoutMs: arg.requestTimeoutMs,
            heartbeatSec: defaultProxyJobHeartbeatSec,
        }),
        signal: arg.signal,
    })

    if (!jobRes.ok) {
        throw new Error(`Failed to create proxy stream job: ${jobRes.status} ${await jobRes.text()}`)
    }

    const { jobId } = await jobRes.json() as { jobId: string }
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${location.host}/proxy-stream-jobs/${encodeURIComponent(jobId)}/ws?risu-auth=${encodeURIComponent(auth)}`

    return new Promise<Response>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        let resolved = false
        let responseStatus = 200
        let responseHeaders: Record<string, string> = {}
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                streamController = controller
            },
            cancel() {
                ws.close()
                fetch(`/proxy-stream-jobs/${encodeURIComponent(jobId)}`, {
                    method: 'DELETE',
                    headers: { 'risu-auth': auth },
                }).catch(() => {})
            }
        })

        const abortHandler = () => {
            ws.close()
            fetch(`/proxy-stream-jobs/${encodeURIComponent(jobId)}`, {
                method: 'DELETE',
                headers: { 'risu-auth': auth },
            }).catch(() => {})
            if (!resolved) {
                resolved = true
                reject(new DOMException('Aborted', 'AbortError'))
            }
        }

        if (arg.signal) {
            if (arg.signal.aborted) {
                abortHandler()
                return
            }
            arg.signal.addEventListener('abort', abortHandler, { once: true })
        }

        ws.onmessage = (ev) => {
            const event = parseProxyJobWsEvent(typeof ev.data === 'string' ? ev.data : '')
            if (!event) return

            switch (event.type) {
                case 'job_accepted':
                case 'ping':
                    break
                case 'upstream_headers':
                    responseStatus = event.status
                    responseHeaders = event.headers
                    if (!resolved) {
                        resolved = true
                        resolve(new Response(stream, {
                            status: responseStatus,
                            headers: responseHeaders,
                        }))
                    }
                    break
                case 'chunk': {
                    const bytes = decodeProxyJobWsChunk(event.dataBase64)
                    streamController?.enqueue(bytes)
                    break
                }
                case 'error': {
                    const msg = formatProxyStreamErrorMessage(event.status, event.message)
                    if (!resolved) {
                        resolved = true
                        resolve(new Response(msg, {
                            status: event.status ?? 502,
                            headers: { 'content-type': 'text/plain' },
                        }))
                    }
                    streamController?.close()
                    break
                }
                case 'done':
                    streamController?.close()
                    break
            }
        }

        ws.onerror = () => {
            if (!resolved) {
                resolved = true
                reject(new Error('WebSocket connection failed'))
            }
        }

        ws.onclose = () => {
            arg.signal?.removeEventListener('abort', abortHandler)
            try { streamController?.close() } catch { /* already closed */ }
            if (!resolved) {
                resolved = true
                reject(new Error('WebSocket closed before response'))
            }
        }
    })
}

/**
 * Converts a ReadableStream of Uint8Array to a text string.
 * 
 * @param {ReadableStream<Uint8Array>} stream - The readable stream to convert.
 * @returns {Promise<string>} A promise that resolves to the text content of the stream.
 */
export function textifyReadableStream(stream: ReadableStream<Uint8Array>) {
    return new Response(stream).text()
}

/**
 * Toggles the fullscreen mode of the document.
 * If the document is currently in fullscreen mode, it exits fullscreen.
 * If the document is not in fullscreen mode, it requests fullscreen with navigation UI hidden.
 */
export function toggleFullscreen() {
    const fullscreenElement = document.fullscreenElement
    fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen({
        navigationUI: "hide"
    })
}

/**
 * Removes non-Latin characters from a string, replaces multiple spaces with a single space, and trims the string.
 * 
 * @param {string} data - The input string to be processed.
 * @returns {string} The processed string with non-Latin characters removed, multiple spaces replaced by a single space, and trimmed.
 */
export function trimNonLatin(data: string) {
    return data.replace(/[^\x00-\x7F]/g, "")
        .replace(/ +/g, ' ')
        .trim()
}

/**
 * A class that provides a blank writer implementation.
 * 
 * This class is used to provide a no-op implementation of a writer, making it compatible with other writer interfaces.
 */
export class BlankWriter {
    constructor() {
    }

    /**
     * Initializes the writer.
     * 
     * This method does nothing and is provided for compatibility with other writer interfaces.
     */
    async init() {
        //do nothing, just to make compatible with other writer
    }

    /**
     * Writes data to the writer.
     * 
     * This method does nothing and is provided for compatibility with other writer interfaces.
     * 
     * @param {string} key - The key associated with the data.
     * @param {Uint8Array|string} data - The data to be written.
     */
    async write(key: string, data: Uint8Array | string) {
        //do nothing, just to make compatible with other writer
    }

    /**
     * Ends the writing process.
     * 
     * This method does nothing and is provided for compatibility with other writer interfaces.
     */
    async end() {
        //do nothing, just to make compatible with other writer
    }
}

export async function loadInternalBackup() {

    const keys = await forageStorage.keys()
    const internalBackups = keys
        .filter((key) => key.startsWith('database/dbbackup-'))
        .sort((a, b) => {
            const aTs = parseInt(a.replace('database/dbbackup-', '').replace('.bin', ''))
            const bTs = parseInt(b.replace('database/dbbackup-', '').replace('.bin', ''))
            return bTs - aTs
        })

    const selectOptions = [
        'Cancel',
        ...(internalBackups.map((a) => {
            return (new Date(parseInt(a.replace('database/dbbackup-', '').replace('dbbackup-', '')) * 100)).toLocaleString()
        }))
    ]

    const alertResult = parseInt(
        await alertSelect(selectOptions)
    ) - 1

    if (alertResult === -1) {
        return
    }

    const selectedBackup = internalBackups[alertResult]

    const data = await forageStorage.getItem(selectedBackup)

    const backupDecoded = await decodeAuthoritativeRisuSave(Buffer.from(data) as unknown as Uint8Array)
    setDatabase(backupDecoded)

    notifySuccess('Loaded backup')



}

/**
 * A debugging class for performance measurement.
*/

export class PerformanceDebugger {
    kv: { [key: string]: number[] } = {}
    startTime: number
    endTime: number

    /**
     * Starts the timing measurement.
    */
    start() {
        this.startTime = performance.now()
    }

    /**
     * Ends the timing measurement and records the time difference.
     * 
     * @param {string} key - The key to associate with the recorded time.
    */
    endAndRecord(key: string) {
        this.endTime = performance.now()
        if (!this.kv[key]) {
            this.kv[key] = []
        }
        this.kv[key].push(this.endTime - this.startTime)
    }

    /**
     * Ends the timing measurement, records the time difference, and starts a new timing measurement.
     * 
     * @param {string} key - The key to associate with the recorded time.
    */
    endAndRecordAndStart(key: string) {
        this.endAndRecord(key)
        this.start()
    }

    /**
     * Logs the average time for each key to the console.
    */
    log() {
        let table: { [key: string]: number } = {}

        for (const key in this.kv) {
            table[key] = this.kv[key].reduce((a, b) => a + b, 0) / this.kv[key].length
        }


        console.table(table)
    }

    combine(other: PerformanceDebugger) {
        for (const key in other.kv) {
            if (!this.kv[key]) {
                this.kv[key] = []
            }
            this.kv[key].push(...other.kv[key])
        }
    }
}

export function getLanguageCodes() {
    let languageCodes: {
        code: string
        name: string
    }[] = []

    for (let i = 0x41; i <= 0x5A; i++) {
        for (let j = 0x41; j <= 0x5A; j++) {
            languageCodes.push({
                code: String.fromCharCode(i) + String.fromCharCode(j),
                name: ''
            })
        }
    }

    languageCodes = languageCodes.map(v => {
        return {
            code: v.code.toLocaleLowerCase(),
            name: new Intl.DisplayNames([
                DBState.db.language === 'cn' ? 'zh' : DBState.db.language
            ], {
                type: 'language',
                fallback: 'none'
            }).of(v.code)
        }
    }).filter((a) => {
        return a.name
    }).sort((a, b) => a.name.localeCompare(b.name))

    return languageCodes
}

export function getVersionString(): string {
    return nodeOnlyVer
}

export function toGetter<T extends object>(
    getterFn: () => T,
    args?: {
        //blocks this.children from being accessed
        restrictChildren:string[]
    }
): T {

    const dummyTarget = () => { };

    return new Proxy(dummyTarget, {
        get(target, prop, receiver) {

            const realInstance = getterFn();
            
            if (args?.restrictChildren && args.restrictChildren.includes(prop as string)) {
                throw new Error(`Access to property '${String(prop)}' is restricted`);
            }

            if (realInstance === null || realInstance === undefined) {
                return (realInstance as any)[prop];
            }

            const value = Reflect.get(realInstance as object, prop);

            if (typeof value === 'function') {
                return value.bind(realInstance);
            }

            return value;
        },

        set(target, prop, value, receiver) {

            if(args?.restrictChildren && args.restrictChildren.includes(prop as string)) {
                throw new Error(`Access to property '${String(prop)}' is restricted`);
            }
            const realInstance = getterFn();
            return Reflect.set(realInstance as object, prop, value, receiver);
        },

        has(target, prop) {
            const realInstance = getterFn();
            return Reflect.has(realInstance as object, prop);
        },

        ownKeys(target) {
            const realInstance = getterFn();
            return Reflect.ownKeys(realInstance as object);
        },

        construct(target, argArray, newTarget) {
            const realInstance = getterFn() as any;
            return new realInstance(...argArray);
        },

        deleteProperty(target, prop) {
            const realInstance = getterFn();
            return Reflect.deleteProperty(realInstance as object, prop);
        },

        getPrototypeOf() {
            const realInstance = getterFn();
            return Reflect.getPrototypeOf(realInstance as object);
        }
    }) as unknown as T;
}

const countriesWithAiLaw = new Set<string>([

    // EU
    // AI Act
    // https://artificialintelligenceact.eu/
    
    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "EL",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",

    //China 
    //Measures for Labeling of AI-Generated Synthetic Content
    // 关于印发《人工智能生成合成内容标识办法》的通知 
    // https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
    "CN",

    //Although CN Law doesn't apply, just in case
    "HK",
    "MO",

    //TW isn't under mainland china jurisdiction
    //de facto, de jure in TW law, unlike HK and MO,
    //So we don't include it for now
    //"TW", 

    // Republic of Korea
    // AI Basic Act
    // 인공지능 발전과 신뢰 기반 조성 등에 관한 기본법
    // https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%9D%B8%EA%B3%B5%EC%A7%80%EB%8A%A5%20%EB%B0%9C%EC%A0%84%EA%B3%BC%20%EC%8B%A0%EB%A2%B0%20%EA%B8%B0%EB%B0%98%20%EC%A1%B0%EC%84%B1%20%EB%93%B1%EC%97%90%20%EA%B4%80%ED%95%9C%20%EA%B8%B0%EB%B3%B8%EB%B2%95/(20676,20250121)
    "KR",

    // Vietnam
    // Digital Tech Law
    // Luật Công nghệ số
    "VN",

])

export function aiLawApplies(): boolean {

    //TODO: implement actual logic
    //lets now assume it always applies
    //so we don't have legal issues later

    return true
}

export function aiWatermarkingLawApplies(): boolean {

    //TODO: implement actual logic
    //lets now assume it is false for now,
    //becuase very few countries have it for now
    return false
}

export const chatFoldedState = $state<{
    data: null| {
        targetCharacterId: string,
        targetChatId: string,
        targetMessageId: string,
    }
}>({
    data: null
})

//Since its exported, we cannot use $derived here
export let chatFoldedStateMessageIndex = $state({
    index: -1
})

$effect.root(() => {
    $effect(() => {
        if(!chatFoldedState.data){
            return
        }
        const char = DBState.db.characters[selIdState.selId]
        const chat = char.chats[char.chatPage]
        if(chatFoldedState.data.targetCharacterId !== char.chaId){
            chatFoldedState.data = null
        }
        if(chatFoldedState.data.targetChatId !== chat.id){
            chatFoldedState.data = null
        }
    })

    $effect(() => {
        if(chatFoldedState.data === null){
            chatFoldedStateMessageIndex.index = -1
            return
        }
        const char = DBState.db.characters[selIdState.selId]
        const chat = char.chats[char.chatPage]
        const messageIndex = chat.message.findIndex((v) => {
            return chatFoldedState.data?.targetMessageId === v.chatId
        })
        if(messageIndex === -1){
            console.warn('Target message for folding id' + chatFoldedState.data?.targetMessageId + ' not found')
            chatFoldedStateMessageIndex.index = -1
            return
        }
        chatFoldedStateMessageIndex.index = messageIndex
    })
})

export function foldChatToMessage(targetMessageIdOrIndex: string | number) {
    let targetMessageId = ''
    if (typeof targetMessageIdOrIndex === 'number') {
        const char = getCurrentCharacter()
        const chat = char.chats[char.chatPage]
        const message = chat.message[targetMessageIdOrIndex]
        targetMessageId = message.chatId
    }
    else{
        targetMessageId = targetMessageIdOrIndex
    }
    const char = getCurrentCharacter()
    const chat = char.chats[char.chatPage]
    chatFoldedState.data = {
        targetCharacterId: char.chaId,
        targetChatId: chat.id,
        targetMessageId: targetMessageId,
    }
}

export function changeChatTo(IdOrIndex: string | number) {
    // A send is bound to the chat that owned the composer when it began.
    // Keep ordinary navigation from changing global chat-dependent hook
    // context while that operation is in flight.
    if (get(chatOperationActive)) return

    let index = -1
    if (typeof IdOrIndex === 'number') {
        index = IdOrIndex
    }

    if (typeof IdOrIndex === 'string') {
        const currentCharacter = getCurrentCharacter()
        index = currentCharacter.chats.findIndex((v) => {
            return v.id === IdOrIndex
        })
    }

    if(index === -1){
        return
    }

    chatDeselected.set(false)
    const char = DBState.db.characters[selIdState.selId]
    char.chatPage = index
    const newChat = char.chats[index]
    if(newChat){
        if(newChat._placeholder){
            const capturedIndex = index
            let cancelled = false
            loadingOverlayStore.set({ active: true, text: language.loading ?? '', onCancel: () => {
                cancelled = true
                chatDeselected.set(true)
                loadingOverlayStore.set({ active: false, text: '', onCancel: null })
            }})
            void ensureChatHydrated(char.chats, capturedIndex, char.chaId).then((hydrated) => {
                if(cancelled) return
                if(hydrated && char.chatPage === capturedIndex) loadTogglesFromChat(hydrated)
            }).catch((e) => {
                console.error('[changeChatTo] hydration failed:', e)
            }).finally(() => {
                if(!cancelled) loadingOverlayStore.set({ active: false, text: '', onCancel: null })
            })
        } else {
            loadTogglesFromChat(newChat)
        }
    }
    ReloadGUIPointer.set(Math.random())
}

export function createChatCopyName(originalName: string,type:'Copy'|'Branch'): string {
    let name = originalName.replaceAll(/\(((Copy|Branch)( \d+)?)\)$/g, '').trim()
    let copyIndex = 1
    let newName = `${name} (${type})`
    const char = getCurrentCharacter()
    while (char.chats.find((v) => v.name === newName)) {
        copyIndex++
        newName = `${name} (${type} ${copyIndex})`
    }
    return newName
}
