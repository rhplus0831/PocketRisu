import { changeFullscreen, checkNullish } from "./util"
import { v4 as uuidv4 } from 'uuid';
import { get } from "svelte/store";
import { setDatabase, defaultSdDataFunc, getDatabase, changeToThemePreset, type Chat, type Database } from "./storage/database.svelte";
import { chatDraftKey, sweepOrphanDrafts } from "./storage/chatDraft";
import { checkRisuUpdate } from "./update";
import { fetchPublicStats } from "./publicStats";
import { MobileGUI, botMakerMode, selectedCharID, loadedStore, DBState, LoadingStatusState, bootBackupPromptStore } from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertError, alertMd, alertTOS, waitAlert, alertConfirm, alertConfirmMulti, alertInput, notifyWarning } from "./alert";
import { characterURLImport } from "./characterCards";
import { defaultJailbreak, defaultMainPrompt, oldJailbreak, oldMainPrompt } from "./storage/defaultPrompts";
import { decodeAuthoritativeRisuSave, encodeRisuSaveLegacy, RisuSaveEncoder } from "./storage/risuSave";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { applyEarlyLanguage, changeLanguage, language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { updateLorebooks } from "./characters";
import { initMobileGesture } from "./hotkey";
import { moduleUpdate } from "./process/modules";
import {
    forageStorage,
    saveDb,
    setPatchSyncBaseline,
    getBasename,
    checkCharOrder
} from "./globalApi.svelte";
import { registerModelDynamic } from "./model/modellist";
import { convertStubsToPlaceholders } from "./storage/chatStorage";
import { isChatStub, purgeUnsupportedGroupChats } from "./storage/database.svelte";
import { allowInsecureContext } from "./platform";
import { isSecureContext, shouldBlockInsecureBoot } from "./secureContext";
import { reconcilePluginStorageModeForBoot } from "./plugins/pluginSaveStorage";
import { disableEnabledLegacyPluginsForOptimizedMemory } from "./plugins/pluginMemoryOptimization";
import { setPluginStorageRecoveryState } from "./plugins/pluginStorageRecovery";
import {
    isResourceCacheEnabled,
    isResourceCacheSupported,
    setResourceCacheEnabled,
} from "./storage/resourceCache";
import { recoverDatabaseFromInternalSnapshots } from "./storage/bootSnapshotRecovery";

const RESOURCE_CACHE_ANNOUNCED_KEY = 'pocketrisu-resource-cache-announced'

async function persistBootPluginStorageReconcile(): Promise<void> {
    // saveDb() is installed near the end of boot. Encode the same stub-only
    // block format directly here and refresh the future patch baseline after
    // the compatibility repair/migration has durably committed.
    const encoder = new RisuSaveEncoder();
    await encoder.init(getDatabase(), {
        compression: false,
        skipRemoteSavingOnCharacters: false,
    });
    const encoded = encoder.encode();
    if (!encoded) throw new Error("Failed to encode plugin storage migration");
    const data = new Uint8Array(encoded);
    await forageStorage.setItem(
        "database/database.bin",
        data,
        forageStorage.getDbEtag() ?? undefined,
    );
    setPatchSyncBaseline(await decodeAuthoritativeRisuSave(data));
}

function renderInsecureContextFatalError() {
    const overlay = document.createElement('div')
    overlay.id = 'pocketrisu-insecure-context-error'
    overlay.setAttribute('role', 'alert')
    overlay.setAttribute('aria-live', 'assertive')
    Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: '#111827',
        color: '#f9fafb',
        fontFamily: 'system-ui, sans-serif',
    })

    const panel = document.createElement('div')
    Object.assign(panel.style, {
        width: '100%',
        maxWidth: '640px',
        padding: '32px',
        border: '1px solid #374151',
        borderRadius: '12px',
        background: '#1f2937',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.35)',
    })

    const title = document.createElement('h1')
    title.textContent = 'Secure connection required'
    Object.assign(title.style, {
        margin: '0 0 20px',
        fontSize: '24px',
        fontWeight: '700',
    })
    panel.appendChild(title)

    const paragraphs = [
        'PocketRisu must be accessed over HTTPS or from localhost.',
        'Remote plain HTTP is not a secure context. The browser disables WebCrypto, which breaks asset content-addressing and integrity.',
        'Configure HTTPS on the server or use Tailscale for secure remote access.',
        'The server operator can set POCKETRISU_ALLOW_INSECURE_CONTEXT=1 to bypass this check at their own risk.',
    ]
    for (const message of paragraphs) {
        const paragraph = document.createElement('p')
        paragraph.textContent = message
        Object.assign(paragraph.style, {
            margin: '12px 0 0',
            lineHeight: '1.6',
        })
        panel.appendChild(paragraph)
    }

    overlay.appendChild(panel)
    document.body.appendChild(overlay)
}

/**
 * Loads the application data.
 */
export async function loadData() {
    if (shouldBlockInsecureBoot(isSecureContext, allowInsecureContext)) {
        renderInsecureContextFatalError()
        return
    }

    const loaded = get(loadedStore)
    if (!loaded) {
        try {
            applyEarlyLanguage()
            let createdFreshDatabase = false
            {
                await forageStorage.Init()

                LoadingStatusState.text = "Loading Local Save File..."
                let databaseRead = await forageStorage.readDatabaseForBoot()
                LoadingStatusState.text = "Decoding Local Save File..."
                if (databaseRead.kind === 'missing') {
                    const freshBytes = encodeRisuSaveLegacy({})
                    const creation = await forageStorage.createDatabaseIfAbsent(freshBytes)
                    if (creation.kind === 'created') {
                        createdFreshDatabase = true
                        databaseRead = { kind: 'bytes', bytes: Buffer.from(freshBytes) }
                    } else {
                        // Another authenticated writer won first initialization.
                        // Install its authoritative bytes instead of the losing
                        // client's seed so both tabs converge on the same state.
                        databaseRead = await forageStorage.readDatabaseForBoot()
                        if (databaseRead.kind === 'missing') {
                            throw new Error('Database creation conflicted but no database is readable')
                        }
                    }
                }
                try {
                    const decoded: Database = databaseRead.kind === 'decoded'
                        ? databaseRead.database as Database
                        : await decodeAuthoritativeRisuSave(databaseRead.bytes)
                    setPatchSyncBaseline(decoded)
                    console.log(decoded)
                    setDatabase(decoded)
                } catch (error) {
                    console.error(error)
                    const restoredDecoded = await recoverDatabaseFromInternalSnapshots({
                        storage: forageStorage,
                        decode: decodeAuthoritativeRisuSave,
                        onStatus: (status) => { LoadingStatusState.text = status },
                    })
                    if (!restoredDecoded) {
                        throw "Forage: Your save file is corrupted"
                    }
                    setPatchSyncBaseline(restoredDecoded)
                    setDatabase(restoredDecoded)
                }

                LoadingStatusState.text = "Reconciling Plugin Storage..."
                const databaseForPluginCompatibility = getDatabase()
                const autoDisabledLegacyPlugins = disableEnabledLegacyPluginsForOptimizedMemory(
                    databaseForPluginCompatibility.plugins,
                    databaseForPluginCompatibility.optimizePluginMemory,
                )
                if (autoDisabledLegacyPlugins.length > 0) {
                    notifyWarning(language.optimizePluginMemoryLegacyAutoDisabled(
                        autoDisabledLegacyPlugins.join(", "),
                    ))
                }
                const pluginStorageDirection = getDatabase().optimizePluginMemory === true
                    ? "externalize"
                    : "internalize"
                let pluginStorageReconcileResult
                try {
                    pluginStorageReconcileResult = await reconcilePluginStorageModeForBoot()
                } catch {
                    // This is the final boot availability boundary. Known
                    // list/read/write/parse failures are isolated per row by
                    // reconcilePluginStorageModeForBoot; an unexpected failure
                    // must still not strand the whole app on the loading path.
                    const issue = {
                        code: "list-failed" as const,
                        encodedKey: pluginStorageDirection === "externalize"
                            ? "pluginsave/"
                            : "pluginsave-meta/",
                    }
                    pluginStorageReconcileResult = {
                        direction: pluginStorageDirection,
                        values: 0,
                        meta: 0,
                        issues: [issue],
                    }
                    setPluginStorageRecoveryState({
                        direction: pluginStorageDirection,
                        issues: [issue],
                    })
                    console.error("[Plugin storage] Boot reconciliation entered recovery mode")
                }
                if (pluginStorageReconcileResult.issues.length > 0) {
                    notifyWarning(
                        language.pluginStorageRecoveryBootWarning(
                            pluginStorageReconcileResult.issues.length,
                        ),
                        { source: "plugin-storage-recovery" },
                    )
                }
                if (
                    autoDisabledLegacyPlugins.length > 0
                    && pluginStorageReconcileResult.direction === "none"
                    && pluginStorageReconcileResult.issues.length === 0
                ) {
                    await persistBootPluginStorageReconcile()
                }

                if (getDatabase().didFirstSetup) {
                    characterURLImport()
                }
            }
            if (createdFreshDatabase) {
                // Brand-new instance (no save file existed): apply the default
                // theme preset (#0 = PocketRisu Standard) so the active display
                // settings (zoomsize 120, iconsize, line height, etc.) match the
                // standard theme instead of upstream's raw DB defaults. setDatabase
                // creates this preset but never applies it. Gated on
                // createdFreshDatabase, so migrating/updating users (who already
                // have a database.bin) are never touched. savecurrent=false skips
                // saving the default state back over the preset.
                changeToThemePreset(0, false)
                const browserLangShort = navigator.language.split('-')[0]
                const browserLanguageMap: Record<string, string> = {
                    de: 'de',
                    en: 'en',
                    ko: 'ko',
                    cn: 'cn',
                    vi: 'vi',
                    es: 'es',
                    zh: 'zh-Hant'
                }
                const mappedLanguage = browserLanguageMap[browserLangShort]
                if (mappedLanguage) {
                    const db = getDatabase()
                    db.language = mappedLanguage
                    changeLanguage(mappedLanguage)
                }
            }
            LoadingStatusState.text = "Loading Plugins..."
            try {
                await loadPlugins()
            } catch (error) { }
            try {
                //@ts-expect-error navigator.standalone is iOS Safari non-standard property, not in Navigator interface
                const isInStandaloneMode = (window.matchMedia('(display-mode: standalone)').matches) || (window.navigator.standalone) || document.referrer.includes('android-app://');
                if (isInStandaloneMode) {
                    await navigator.storage.persist()
                }
            } catch (error) {

            }
            LoadingStatusState.text = "Checking For Format Update..."
            await checkNewFormat()

            // Convert any ChatStubs (from server-stripped database.bin) to placeholder Chats
            // so runtime code only sees Chat objects
            {
                const dbForConvert = getDatabase()
                for (const char of dbForConvert.characters) {
                    char.chats = convertStubsToPlaceholders(char.chats)
                }
            }

            const db = getDatabase();

            LoadingStatusState.text = "Updating States..."
            updateColorScheme()
            updateTextThemeAndCSS()
            updateAnimationSpeed()
            updateHeightMode()
            updateErrorHandling()
            updateGuisize()
            if (!db.didFirstSetup) {
                // Node-only build skips the onboarding screen and lands on the main UI directly.
                db.didFirstSetup = true
            }
            if (db.botSettingAtStart) {
                botMakerMode.set(true)
            }
            if ((db.betaMobileGUI && window.innerWidth <= 800) || import.meta.env.VITE_RISU_LITE === 'TRUE') {
                initMobileGesture()
                MobileGUI.set(true)
            }
            // Startup prompts are deliberately awaited in sequence so the
            // resource-cache announcement and backup reminder never stack.
            try {
                await maybeAnnounceResourceCache()
            } catch (err) {
                console.warn('[bootstrap] resource cache announcement failed:', err)
            }
            try {
                await maybeRunBootBackupReminder()
            } catch (err) {
                console.warn('[bootstrap] boot backup reminder failed:', err)
            }
            loadedStore.set(true)
            selectedCharID.set(-1)
            startObserveDom()
            assignIds()
            registerModelDynamic()
            saveDb()
            moduleUpdate()
            // Remote-cache pruning remains client-side because its last-use
            // metadata is maintained by the browser. Ordinary asset reachability
            // and deletion are authoritative server responsibilities.
            setTimeout(() => {
                cleanRemoteCache().catch(console.error)
            }, 5_000)
            checkRisuUpdate()
            fetchPublicStats()
            if (import.meta.env.VITE_RISU_TOS === 'TRUE') {
                alertTOS().then((a) => {
                    if (a === false) {
                        location.reload()
                    }
                })
            }
        } catch (error) {
            alertError(error)
        }
    }
}

async function maybeAnnounceResourceCache() {
    if (!isResourceCacheSupported()) return
    try {
        if (localStorage.getItem(RESOURCE_CACHE_ANNOUNCED_KEY) === 'true') return
        if (isResourceCacheEnabled()) {
            localStorage.setItem(RESOURCE_CACHE_ANNOUNCED_KEY, 'true')
            return
        }
        localStorage.setItem(RESOURCE_CACHE_ANNOUNCED_KEY, 'true')
    } catch {
        return
    }

    const choice = await alertConfirmMulti(language.resourceCacheAnnouncement, [
        { label: language.resourceCacheAnnouncementEnable, variant: 'primary' },
        { label: language.resourceCacheAnnouncementNotNow, variant: 'outline' },
    ])
    if (choice === 0) await setResourceCacheEnabled(true)
}



/**
 * Hard-bounded fetch — the boot path can't tolerate an indefinite hang on a
 * stuck endpoint, since the loading screen blocks the user until we set
 * loadedStore. AbortError is rethrown like any fetch failure; the call site
 * swallows it.
 */
async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, ms = 5000): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
        return await fetch(input, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

/**
 * If the user has enabled the boot-time server-backup reminder, prompt with a
 * confirm dialog before the main UI loads. Confirming runs SaveServerBackup
 * synchronously (its alertWait progress overlays the loading screen).
 */
async function maybeRunBootBackupReminder() {
    let enabled = false
    try {
        const auth = await forageStorage.createAuth()
        const res = await fetchWithTimeout('/api/backup/boot-reminder', { headers: { 'risu-auth': auth } })
        if (!res.ok) return
        const json = await res.json()
        enabled = !!json.enabled
    } catch {
        return  // Non-fatal — skip the prompt if the endpoint is unreachable / slow.
    }
    if (!enabled) return

    // Best-effort stats fetch. The prompt component renders whatever we can
    // supply; missing values just hide their respective lines. Uses
    // backupDisk (actual backup destination) so warnings target the right
    // mount when backupsDir is on a different drive than save/.
    let estimate: number | null = null
    let free: number | null = null
    let total: number | null = null
    try {
        const auth = await forageStorage.createAuth()
        const res = await fetchWithTimeout('/api/db/stats', { headers: { 'risu-auth': auth } })
        if (res.ok) {
            const stats = await res.json()
            if (typeof stats?.estimatedBackupSize === 'number') estimate = stats.estimatedBackupSize
            const d = stats?.backupDisk ?? stats?.disk
            if (typeof d?.free === 'number') free = d.free
            if (typeof d?.total === 'number') total = d.total
        }
    } catch { /* keep nulls */ }

    const insufficient = (estimate != null && free != null && estimate > free)

    const proceed = await new Promise<boolean>((resolve) => {
        bootBackupPromptStore.set({ estimate, free, total, insufficient, resolve })
    })
    if (!proceed) return
    const { SaveServerBackup } = await import('./drive/backuplocal')
    await SaveServerBackup()
}

/**
 * Updates the error handling by adding custom handlers for errors and unhandled promise rejections.
 */
function updateErrorHandling() {
    const errorHandler = (event: ErrorEvent) => {
        console.error(event.error);
        if(!(event.error?.target instanceof Worker)){
            alertError(event.error);
        }
    };
    const rejectHandler = (event: PromiseRejectionEvent) => {
        console.error(event.reason);
        alertError(event.reason);
    };
    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', rejectHandler);
}

/**
 * Updates the height mode of the document based on the value stored in the database.
 */
function updateHeightMode() {
    const db = getDatabase()
    const root = document.querySelector(':root') as HTMLElement;
    switch (db.heightMode) {
        case 'auto':
            root.style.setProperty('--risu-height-size', '100%');
            break
        case 'vh':
            root.style.setProperty('--risu-height-size', '100vh');
            break
        case 'dvh':
            root.style.setProperty('--risu-height-size', '100dvh');
            break
        case 'lvh':
            root.style.setProperty('--risu-height-size', '100lvh');
            break
        case 'svh':
            root.style.setProperty('--risu-height-size', '100svh');
            break
        case 'percent':
            root.style.setProperty('--risu-height-size', '100%');
            break
    }
}

/**
 * Checks and updates the database format to the latest version.
 */
async function checkNewFormat(): Promise<void> {
    let db = getDatabase();

    // Check data integrity
    db.characters = db.characters.map((v) => {
        if (!v) {
            return null;
        }
        v.chaId ??= uuidv4();
        v.type ??= 'character';
        v.chatPage ??= 0;
        v.chats ??= [];
        v.customscript ??= [];
        v.firstMessage ??= '';
        v.globalLore ??= [];
        v.name ??= '';
        v.viewScreen ??= 'none';
        v.emotionImages = v.emotionImages ?? [];

        if (v.type === 'character') {
            v.bias ??= [];
            v.characterVersion ??= '';
            v.creator ??= '';
            v.desc ??= '';
            v.utilityBot ??= false;
            v.tags ??= [];
            v.systemPrompt ??= '';
            v.scenario ??= '';
        }
        return v;
    }).filter((v) => {
        return v !== null;
    });

    const removedGroupChats = purgeUnsupportedGroupChats(db)
    if (removedGroupChats > 0) {
        console.warn(`[bootstrap] Removed ${removedGroupChats} unsupported group chat entr${removedGroupChats === 1 ? 'y' : 'ies'} from database`)
    }

    db.modules = await Promise.all((db.modules ?? []).map(async (v) => {
        if (v?.lorebook) {
            if (!Array.isArray(v.lorebook)) {
                console.error('Critical: Invalid lorebook format detected in module');
                console.error('Module data:', JSON.stringify(v, null, 2));
                
                // Alert user about corrupted data
                alertError(language.bootstrap.dataCorruptionDetected(v.name || 'Unknown', typeof v.lorebook));
                await waitAlert();
                
                // Ask if user wants to report the issue
                const shouldReport = await alertConfirm(language.bootstrap.reportErrorQuestion);
                
                if (shouldReport) {
                    try {
                        // Collect diagnostic information (without personal data)
                        const diagnosticInfo = {
                            timestamp: new Date().toISOString(),
                            moduleName: v.name || 'Unknown',
                            lorebookType: typeof v.lorebook,
                            lorebookValue: JSON.stringify(v.lorebook).substring(0, 500), // First 500 chars only
                            isArray: Array.isArray(v.lorebook),
                            keys: v.lorebook ? Object.keys(v.lorebook).join(', ') : 'N/A',
                            formatVersion: db.formatversion || 'Unknown'
                        };
                        
                        // Show the diagnostic info and allow user to copy or send
                        const reportData = JSON.stringify(diagnosticInfo, null, 2);
                        await alertMd(language.bootstrap.diagnosticInformation(reportData));
                        await waitAlert();
                        
                        console.log('Diagnostic information for developers:', diagnosticInfo);
                    } catch (reportError) {
                        console.error('Failed to generate diagnostic report:', reportError);
                    }
                }
                
                // Ask if user wants to reset the data
                const shouldReset = await alertConfirm(language.bootstrap.resetLorebookQuestion);
                
                if (shouldReset) {
                    v.lorebook = [];
                    console.log('Lorebook reset to empty array by user choice');
                } else {
                    console.warn('User chose to keep corrupted lorebook data');
                }
            } else {
                v.lorebook = updateLorebooks(v.lorebook);
            }
        }
        return v
    }));
    
    db.modules = db.modules.filter((v) => {
        return v !== null && v !== undefined;
    });

    db.personas = (db.personas ?? []).map((v) => {
        v.id ??= uuidv4()
        return v
    }).filter((v) => {
        return v !== null && v !== undefined;
    });

    if (!db.formatversion) {
        function checkClean(data: string) {

            if (data.startsWith('assets') || (data.length < 3)) {
                return data
            }
            else {
                const d = 'assets/' + (data.replace(/\\/g, '/').split('assets/')[1])
                if (!d) {
                    return data
                }
                return d;
            }
        }

        db.customBackground = checkClean(db.customBackground);
        db.userIcon = checkClean(db.userIcon);

        for (let i = 0; i < db.characters.length; i++) {
            if (db.characters[i].image) {
                db.characters[i].image = checkClean(db.characters[i].image);
            }
            if (db.characters[i].emotionImages) {
                for (let i2 = 0; i2 < db.characters[i].emotionImages.length; i2++) {
                    if (db.characters[i].emotionImages[i2] && db.characters[i].emotionImages[i2].length >= 2) {
                        db.characters[i].emotionImages[i2][1] = checkClean(db.characters[i].emotionImages[i2][1]);
                    }
                }
            }
        }

        db.formatversion = 2;
    }
    if (db.formatversion < 3) {
        for (let i = 0; i < db.characters.length; i++) {
            let cha = db.characters[i];
            if (cha.type === 'character') {
                if (checkNullish(cha.sdData)) {
                    cha.sdData = defaultSdDataFunc();
                }
            }
        }

        db.formatversion = 3;
    }
    if (db.formatversion < 4) {
        //migration removed due to issues
        db.formatversion = 4;
    }
    if (db.formatversion < 5) {
        if (db.loreBookToken < 8000) {
            db.loreBookToken = 8000;
        }
        db.formatversion = 5;
    }
    if (!db.characterOrder) {
        db.characterOrder = [];
    }
    if (db.mainPrompt === oldMainPrompt) {
        db.mainPrompt = defaultMainPrompt;
    }
    if (db.mainPrompt === oldJailbreak) {
        db.mainPrompt = defaultJailbreak;
    }
    for (let i = 0; i < db.characters.length; i++) {
        const trashTime = db.characters[i].trashTime;
        const targetTrashTime = trashTime ? trashTime + 1000 * 60 * 60 * 24 * 3 : 0;
        if (trashTime && targetTrashTime < Date.now()) {
            db.characters.splice(i, 1);
            i--;
        }
    }
    setDatabase(db);
    checkCharOrder();

    // One-pass cleanup of composer drafts whose chat no longer exists (deleted
    // chats/characters, trash purge, plugin/script removals). Replaces per-delete
    // wiring: any orphan, however it was created, is swept here at boot.
    const validDraftKeys = new Set<string>();
    for (const char of db.characters) {
        if (!char?.chaId) continue;
        for (const chat of char.chats ?? []) {
            if (chat?.id) validDraftKeys.add(chatDraftKey(char.chaId, chat.id));
        }
    }
    void sweepOrphanDrafts(validDraftKeys);
}

/**
 * Purges stale character remote-cache entries.
 */
async function cleanRemoteCache() {
    const db = getDatabase()
    const indexes = await forageStorage.keys()
    const allKeys = new Set(indexes)
    const characterIds = new Set<string>(
        db.characters.map((v) => v.chaId)
    )
    for (const asset of indexes) {
        if (asset.endsWith('.meta')) {
            continue
        }
        else if (asset.startsWith('remotes/')) {
            const name = getBasename(asset).slice(0, -10) //remove .local.bin
            const exists = characterIds.has(name)
            if(!exists){
                let okayToDelete = false
                try {
                    const metaPath = asset + '.meta'
                    const metaExists = allKeys.has(metaPath)
                    if (metaExists) {
                        const metaData: Uint8Array = await forageStorage.getItem(metaPath) as unknown as Uint8Array
                        const metaJson = JSON.parse(new TextDecoder().decode(metaData))
                        const lastUsed = metaJson.lastUsed as number
                        if(Date.now() - lastUsed > 1000 * 60 * 60 * 24 * 7) { //not used for 7 days
                            okayToDelete = true
                        }
                    }
                    else{
                        //write meta for next time
                        const metaJson = {
                            lastUsed: Date.now()
                        }
                        await forageStorage.setItem(metaPath, new TextEncoder().encode(JSON.stringify(metaJson)))
                    }
                } catch (error) {}
                if (okayToDelete) {
                    await forageStorage.removeItem(asset)
                }
            }
        }
    }
}


/**
 * Assigns unique IDs to characters and chats.
 */
function assignIds() {
    if (!DBState?.db?.characters) {
        return
    }
    const assignedCharacterIds = new Set<string>()
    for (let i = 0; i < DBState.db.characters.length; i++) {
        const cha = DBState.db.characters[i]
        if (!cha.chaId) {
            cha.chaId = uuidv4()
        }
        if (assignedCharacterIds.has(cha.chaId)) {
            console.warn(`Duplicate chaId found: ${cha.chaId}. Assigning new ID.`);
            cha.chaId = uuidv4();
        }
        assignedCharacterIds.add(cha.chaId)
        const assignedChatIds = new Set<string>()
        for (let i2 = 0; i2 < cha.chats.length; i2++) {
            const chat = cha.chats[i2]
            if (!chat.id) {
                chat.id = uuidv4()
            }
            if (assignedChatIds.has(chat.id)) {
                if (chat._placeholder || (chat as Chat & { _stub?: boolean })._stub) {
                    // A cold chat body still lives under the old id. Renaming
                    // only its stub would create a dangling row reference, so
                    // leave the collision visible for the save integrity guard
                    // to reject instead of silently publishing corruption.
                    console.error(`Duplicate cold chat ID found: ${chat.id}. Persistence will be blocked.`)
                    continue
                }
                console.warn(`Duplicate full chat ID found: ${chat.id}. Assigning new ID.`)
                chat.id = uuidv4()
            }
            assignedChatIds.add(chat.id)
        }
    }
}
