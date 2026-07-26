<script lang="ts">
    // System → Plugin Storage tab. Built-in replacement for the community
    // "plugin-storage-viewer" plugin. Plugin data is stored in a single global
    // namespace (not per-plugin), so this is a flat key/value manager over the
    // three backends a plugin can write to:
    //   - save:  db.pluginCustomStorage, or on-demand pluginsave/ KV entries
    //            while optimized (both travel with backups)
    //   - local: localStorage `safe_plugin_*`  (device-local, strings only)
    //   - idb:   SafeLocalPluginStorage  (IndexedDB, device-local, JSON)
    // Origin plugin is best-effort: new V3 writes are tagged into a sidecar
    // meta store (pluginStorageMeta), but legacy/V2 keys have no record and show
    // as unknown. Edit/delete are allowed directly, guarded by confirm.
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte'
    import ShToggle from 'src/lib/UI/GUI/ShToggle.svelte'
    import {
        RefreshCwIcon,
        Trash2Icon,
        PencilIcon,
        AlignLeftIcon,
        SaveIcon,
        ChevronLeftIcon,
        ChevronRightIcon,
    } from '@lucide/svelte'
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert'
    import { SafeLocalStorage, SafeLocalPluginStorage } from 'src/ts/plugins/pluginSafeClass'
    import { getOwners, removeOwner } from 'src/ts/plugins/pluginStorageMeta'
    import { language } from 'src/lang'
    import {
        clearOwnedPluginSaveStorage,
        getPluginSaveStorageItem,
        getPluginSaveStorageKeys,
        removeOwnedPluginSaveStorageItem,
        setPluginSaveStorageItem,
    } from 'src/ts/plugins/pluginSaveStorage'
    import {
        loadPluginStorageViewerPage,
        PluginStorageViewerLoadCancelled,
        type PluginStorageViewerEntry,
        type PluginStorageViewerKey,
    } from 'src/ts/plugins/pluginStorageViewerPage'

    type BackendId = 'save' | 'local' | 'idb'

    // Sentinel filter value for entries with no recorded origin plugin.
    const UNKNOWN = '__risu_unknown__'

    type Entry = PluginStorageViewerEntry

    const BACKENDS: { id: BackendId; label: () => string; desc: () => string }[] = [
        { id: 'save', label: () => language.pluginStorageBackendSave, desc: () => language.pluginStorageBackendSaveDesc },
        { id: 'local', label: () => language.pluginStorageBackendLocal, desc: () => language.pluginStorageBackendLocalDesc },
        { id: 'idb', label: () => language.pluginStorageBackendIdb, desc: () => language.pluginStorageBackendIdbDesc },
    ]

    const safeLocal = new SafeLocalStorage()
    const idb = new SafeLocalPluginStorage()

    let backendIndex = $state(0)
    const backend = $derived(BACKENDS[backendIndex].id)
    let keyEntries = $state<PluginStorageViewerKey[]>([])
    let entries = $state<Entry[]>([])
    let page = $state(0)
    let pageCount = $state(1)
    let loading = $state(false)
    let loadError = $state<string | null>(null)
    let loadProgress = $state(0)
    let loadTotal = $state(0)
    // Monotonic token: a newer load() invalidates any in-flight older one
    // (e.g. when the user switches backend tabs mid-load).
    let loadToken = 0
    let searchKey = $state('')
    let searchVal = $state('')
    let ownerFilter = $state('')   // '' = all; UNKNOWN = no recorded origin; else plugin name

    let detailOpen = $state(false)
    let selected = $state<Entry | null>(null)
    let editing = $state(false)
    let editText = $state('')
    let saving = $state(false)

    const filteredKeys = $derived.by(() => {
        const k = searchKey.trim().toLowerCase()
        const f = ownerFilter
        return keyEntries.filter((e) => {
            const keyMatch = !k || e.key.toLowerCase().includes(k)
            const ownerMatch =
                !f || (f === UNKNOWN ? !e.owner : e.owner === f)
            return keyMatch && ownerMatch
        })
    })
    // Value search intentionally applies to the resident page only. Searching
    // every value would defeat the page bound that keeps this viewer safe for
    // large repositories.
    const filtered = $derived.by(() => {
        const value = searchVal.trim().toLowerCase()
        return value
            ? entries.filter((entry) => entry.text.toLowerCase().includes(value))
            : entries
    })

    // True when any search/owner filter narrows the list — drives the bulk
    // button label (delete-shown vs clear-all).
    const isFiltered = $derived(
        searchKey.trim() !== '' || searchVal.trim() !== '' || ownerFilter !== '',
    )

    // Distinct origin plugins present in the current backend, for the filter.
    const ownerOptions = $derived.by(() => {
        const set = new Set<string>()
        for (const e of keyEntries) if (e.owner) set.add(e.owner)
        return [...set].sort((a, b) => a.localeCompare(b))
    })
    const hasUnknown = $derived(keyEntries.some((e) => !e.owner))
    const bulkTargetCount = $derived(
        !isFiltered
            ? keyEntries.length
            : searchVal.trim() !== ''
                ? filtered.length
                : filteredKeys.length,
    )

    // ── helpers ────────────────────────────────────────────────────────────
    function prettyPrint(raw: string): string {
        try {
            return JSON.stringify(JSON.parse(raw), null, 2)
        } catch {
            return raw
        }
    }

    function formatSize(bytes: number): string {
        if (bytes < 1024) return bytes + ' B'
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }

    // ── backend access ───────────────────────────────────────────────────────
    async function backendSet(key: string, value: unknown): Promise<void> {
        if (backend === 'save') {
            await setPluginSaveStorageItem(key, value)
            return
        }
        if (backend === 'local') {
            safeLocal.setItem(key, value as string)
            return
        }
        await idb.setItem(key, value)
    }

    async function backendRemove(key: string): Promise<void> {
        // Drop the value, then its origin record so the sidecar doesn't keep a
        // dangling entry. (The idb instance here has no owner, so its own
        // removeItem won't touch meta — we clean it explicitly.)
        if (backend === 'save') {
            await removeOwnedPluginSaveStorageItem(key)
            return
        } else if (backend === 'local') {
            safeLocal.removeItem(key)
        } else {
            await idb.removeItem(key)
        }
        await removeOwner(backend, key)
    }

    // ── actions ────────────────────────────────────────────────────────────
    function readBackendValue(key: string): unknown | Promise<unknown> {
        if (backend === 'save') return getPluginSaveStorageItem(key)
        if (backend === 'local') return safeLocal.getItem(key)
        return idb.getItem(key)
    }

    async function loadPage(nextPage = page, token = ++loadToken) {
        loading = true
        loadError = null
        loadProgress = 0
        loadTotal = 0
        entries = []
        selected = null
        detailOpen = false
        try {
            const result = await loadPluginStorageViewerPage({
                keys: filteredKeys,
                page: nextPage,
                read: readBackendValue,
                cancelled: () => token !== loadToken,
                onProgress: (completed, total) => {
                    if (token !== loadToken) return
                    loadProgress = completed
                    loadTotal = total
                },
            })
            if (token !== loadToken) return
            entries = result.entries
            page = result.page
            pageCount = result.pageCount
        } catch (e) {
            if (token !== loadToken || e instanceof PluginStorageViewerLoadCancelled) return
            loadError = e instanceof Error ? e.message : String(e)
            entries = []
        } finally {
            if (token === loadToken) loading = false
        }
    }

    async function load() {
        const token = ++loadToken
        loading = true
        loadError = null
        loadProgress = 0
        loadTotal = 0
        entries = []
        keyEntries = []
        page = 0
        pageCount = 1
        try {
            let keys: string[]
            if (backend === 'save') keys = await getPluginSaveStorageKeys()
            else if (backend === 'local') keys = safeLocal.keys()
            else keys = await idb.keys()
            if (token !== loadToken) return

            const owners = await getOwners(backend)
            if (token !== loadToken) return
            keyEntries = keys
                .map((key) => ({ key, owner: owners[key] }))
                .sort((a, b) => a.key.localeCompare(b.key))
            await loadPage(0, token)
        } catch (e) {
            if (token !== loadToken || e instanceof PluginStorageViewerLoadCancelled) return
            loadError = e instanceof Error ? e.message : String(e)
            entries = []
            keyEntries = []
        } finally {
            if (token === loadToken) loading = false
        }
    }

    function openDetail(entry: Entry) {
        selected = entry
        editing = false
        editText = prettyPrint(entry.text)
        detailOpen = true
    }

    function startEdit() {
        if (!selected) return
        editText = prettyPrint(selected.text)
        editing = true
    }

    function formatJson() {
        try {
            editText = JSON.stringify(JSON.parse(editText), null, 2)
        } catch (e) {
            notifyError(language.pluginStorageJsonError(e instanceof Error ? e.message : String(e)))
        }
    }

    async function saveEdit() {
        if (!selected) return
        saving = true
        try {
            let saveValue: unknown
            if (backend === 'local') {
                // localStorage holds strings; normalize valid JSON, keep raw otherwise.
                saveValue = editText
                try {
                    saveValue = JSON.stringify(JSON.parse(editText))
                } catch {}
            } else {
                // save/idb keep parsed JSON when possible, raw string otherwise.
                try {
                    saveValue = JSON.parse(editText)
                } catch {
                    saveValue = editText
                }
            }
            await backendSet(selected.key, saveValue)
            const savedKey = selected.key
            await loadPage(page)
            selected = entries.find((e) => e.key === savedKey) ?? null
            editing = false
            if (!selected) detailOpen = false
            notifySuccess(language.pluginStorageSaved(savedKey))
        } catch (e) {
            notifyError(e instanceof Error ? e.message : String(e))
        } finally {
            saving = false
        }
    }

    async function removeEntry(entry: Entry) {
        const ok = await alertConfirm(language.pluginStorageDeleteConfirm(entry.key))
        if (!ok) return
        try {
            await backendRemove(entry.key)
            if (selected?.key === entry.key) detailOpen = false
            await load()
            notifySuccess(language.pluginStorageDeleted)
        } catch (e) {
            notifyError(e instanceof Error ? e.message : String(e))
        }
    }

    // Bulk-delete every entry currently shown (i.e. matching the active search /
    // owner filter). With no filter this is the whole backend, so one button
    // serves both partial and full clears. The label reflects which it is.
    async function removeFiltered() {
        // Snapshot before load() swaps `entries` out from under `filtered`.
        const targets = !isFiltered
            ? keyEntries.slice()
            : searchVal.trim() !== ''
                ? filtered.slice()
                : filteredKeys.slice()
        if (targets.length === 0) return

        const isAll = !isFiltered
        const backendLabel = BACKENDS[backendIndex].label()
        const msg = isAll
            ? language.pluginStorageBulkDeleteAllConfirm(backendLabel, targets.length)
            : language.pluginStorageBulkDeleteConfirm(backendLabel, targets.length)
        const ok = await alertConfirm(msg)
        if (!ok) return

        try {
            if (backend === 'save' && !isFiltered) {
                // The optimized backend clears value + owner prefixes in one
                // server transaction; inline mode publishes one empty value
                // map through the same primitive.
                await clearOwnedPluginSaveStorage()
            } else {
                for (const e of targets) await backendRemove(e.key)
            }
            detailOpen = false
            await load()
            notifySuccess(language.pluginStorageBulkDeleted(targets.length))
        } catch (e) {
            notifyError(e instanceof Error ? e.message : String(e))
            // Re-sync the UI to whatever actually got removed on partial failure.
            await load()
        }
    }

    // Load on mount and whenever the backend tab changes; reset search per tab.
    let loadedIndex = -1
    $effect(() => {
        const idx = backendIndex
        if (idx === loadedIndex) return
        loadedIndex = idx
        searchKey = ''
        searchVal = ''
        ownerFilter = ''
        load()
    })

    let filterSignature = ''
    $effect(() => {
        const signature = `${backendIndex}\u0000${searchKey.trim()}\u0000${ownerFilter}`
        if (signature === filterSignature) return
        filterSignature = signature
        if (loadedIndex === backendIndex && keyEntries.length > 0) loadPage(0)
    })
</script>

<p class="text-textcolor2 text-sm mb-4">{language.pluginStorageDesc}</p>

<!-- Backend selector (single-select ShToggle group). The active toggle is
     disabled so it can't be toggled off; opacity is restored so it still
     reads as the selected one. -->
<div class="flex flex-wrap gap-1 mb-2">
    {#each BACKENDS as b, i (b.id)}
        <ShToggle
            size="sm"
            pressed={backendIndex === i}
            disabled={backendIndex === i}
            onPressedChange={() => (backendIndex = i)}
            className="disabled:opacity-100"
        >
            {b.label()}
        </ShToggle>
    {/each}
</div>
<p class="text-textcolor2 text-xs mb-4 opacity-70">{BACKENDS[backendIndex].desc()}</p>

<!-- Search -->
<div class="flex flex-col sm:flex-row gap-2 mb-3">
    <ShInput bind:value={searchKey} placeholder={language.pluginStorageSearchKey} />
    <ShInput bind:value={searchVal} placeholder={language.pluginStorageSearchValue} />
</div>

<!-- Origin filter: System-Logs-style toggle chips. No chip selected = all.
     Clicking the active chip clears back to all (keeps pressed in sync with
     ownerFilter, so no toggle desync). -->
{#if ownerOptions.length > 0 || hasUnknown}
    <div class="flex items-start gap-2 mb-3">
        <span class="text-textcolor2 text-xs shrink-0 pt-1.5">{language.pluginStorageOwner}</span>
        <div class="flex flex-wrap gap-1">
            {#each ownerOptions as p (p)}
                <ShToggle size="xs" pressed={ownerFilter === p} onPressedChange={(on) => (ownerFilter = on ? p : '')}>
                    {p}
                </ShToggle>
            {/each}
            {#if hasUnknown}
                <ShToggle size="xs" pressed={ownerFilter === UNKNOWN} onPressedChange={(on) => (ownerFilter = on ? UNKNOWN : '')}>
                    {language.pluginStorageOwnerUnknown}
                </ShToggle>
            {/if}
        </div>
    </div>
{/if}

<!-- Count + bulk delete + refresh -->
<div class="flex items-center justify-between mb-2">
    <span class="text-textcolor2 text-xs">
        <ShBadge variant="secondary">{filtered.length}</ShBadge>
        {language.pluginStoragePageCount(page + 1, pageCount, filteredKeys.length)}
    </span>
    <div class="flex items-center gap-1">
        <ShButton
            variant="destructive"
            size="sm"
            onclick={removeFiltered}
            disabled={loading || bulkTargetCount === 0}
        >
            <Trash2Icon size={14} />
            {isFiltered
                ? language.pluginStorageBulkDeleteShown(bulkTargetCount)
                : language.pluginStorageBulkDeleteAll(bulkTargetCount)}
        </ShButton>
        <ShButton variant="ghost" size="sm" onclick={load} disabled={loading}>
            <RefreshCwIcon size={14} class={loading ? 'animate-spin' : ''} />
            {language.pluginStorageRefresh}
        </ShButton>
    </div>
</div>

<!-- List -->
<div class="flex flex-col gap-1 max-h-[60vh] overflow-y-auto rounded-md border border-darkborderc/50 p-1">
    {#if loading}
        <div class="flex flex-col items-center gap-3 text-textcolor2 text-sm py-12">
            <RefreshCwIcon size={20} class="animate-spin" />
            <span class="tabular-nums">{loadTotal > 0 ? `${loadProgress} / ${loadTotal}` : language.systemLogsLoading}</span>
            {#if loadTotal > 0}
                <div class="w-48 h-1 rounded-full bg-darkborderc/50 overflow-hidden">
                    <div class="h-full bg-primary transition-[width] duration-150" style="width: {Math.round((loadProgress / loadTotal) * 100)}%"></div>
                </div>
            {/if}
        </div>
    {:else if loadError}
        <div class="text-textcolor2 text-sm text-center py-12">
            {language.pluginStorageLoadError}<br />
            <span class="text-xs opacity-60">{loadError}</span>
        </div>
    {:else if filtered.length === 0}
        <div class="text-textcolor2 text-sm text-center py-12">{language.pluginStorageEmpty}</div>
    {:else}
        {#each filtered as entry (entry.key)}
            <div
                class="group flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-selected cursor-pointer"
                role="button"
                tabindex="0"
                onclick={() => openDetail(entry)}
                onkeydown={(e) => { if (e.key === 'Enter') openDetail(entry) }}
            >
                <span class="font-mono text-sm text-textcolor truncate flex-1 min-w-0" title={entry.key}>{entry.key}</span>
                {#if entry.owner}
                    <ShBadge variant="secondary" className="max-w-[35%] overflow-hidden">{entry.owner}</ShBadge>
                {/if}
                <span class="text-textcolor2 text-[10px] uppercase tracking-wide shrink-0 opacity-70">{entry.type}</span>
                <span class="text-textcolor2 text-xs shrink-0 tabular-nums">{formatSize(entry.size)}</span>
                <button
                    class="shrink-0 text-textcolor2 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer p-1"
                    aria-label={language.remove}
                    onclick={(e) => { e.stopPropagation(); removeEntry(entry) }}
                >
                    <Trash2Icon size={15} />
                </button>
            </div>
        {/each}
    {/if}
</div>

{#if !loading && !loadError && pageCount > 1}
    <div class="flex items-center justify-center gap-2 mt-2">
        <ShButton variant="ghost" size="sm" onclick={() => loadPage(page - 1)} disabled={page === 0}>
            <ChevronLeftIcon size={14} />
            {language.pluginStoragePreviousPage}
        </ShButton>
        <span class="text-textcolor2 text-xs tabular-nums">{page + 1} / {pageCount}</span>
        <ShButton variant="ghost" size="sm" onclick={() => loadPage(page + 1)} disabled={page + 1 >= pageCount}>
            {language.pluginStorageNextPage}
            <ChevronRightIcon size={14} />
        </ShButton>
    </div>
{/if}

<!-- Detail / edit dialog. tier="base" (z-40) so the delete confirm popup
     (alert tier, z-50) renders above this management dialog. -->
<ShDialog bind:open={detailOpen} size="xl" tier="base">
    {#snippet title()}
        <span class="font-mono break-all">{selected?.key ?? ''}</span>
    {/snippet}
    {#if selected}
        <div class="flex flex-wrap gap-x-6 gap-y-1 text-xs mb-3">
            <span class="text-textcolor2">{language.pluginStorageMetaType}: <span class="text-textcolor font-mono">{selected.type}</span></span>
            <span class="text-textcolor2">{language.pluginStorageMetaSize}: <span class="text-textcolor font-mono">{formatSize(selected.size)}</span></span>
            <span class="text-textcolor2">{language.pluginStorageMetaChars}: <span class="text-textcolor font-mono">{selected.text.length.toLocaleString()}</span></span>
            <span class="text-textcolor2">{language.pluginStorageOwner}: <span class="text-textcolor font-mono">{selected.owner ?? language.pluginStorageOwnerUnknown}</span></span>
        </div>

        {#if editing}
            <textarea
                bind:value={editText}
                class="w-full h-[50vh] resize-none rounded-md border border-darkborderc bg-black/40 p-3 font-mono text-xs leading-relaxed text-textcolor outline-none focus-visible:border-borderc whitespace-pre"
                spellcheck="false"
            ></textarea>
        {:else}
            <pre class="w-full h-[50vh] overflow-auto rounded-md border border-darkborderc bg-black/40 p-3 font-mono text-xs leading-relaxed text-textcolor2 whitespace-pre-wrap break-all">{prettyPrint(selected.text)}</pre>
        {/if}
    {/if}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            {#if editing}
                <ShButton variant="outline" onclick={formatJson} disabled={saving}>
                    <AlignLeftIcon size={14} />
                    {language.pluginStorageFormatJson}
                </ShButton>
                <ShButton variant="outline" onclick={() => (editing = false)} disabled={saving}>
                    {language.cancel}
                </ShButton>
                <ShButton variant="primary" onclick={saveEdit} disabled={saving}>
                    <SaveIcon size={14} />
                    {language.pluginStorageSave}
                </ShButton>
            {:else}
                <ShButton variant="destructive" onclick={() => selected && removeEntry(selected)}>
                    <Trash2Icon size={14} />
                    {language.remove}
                </ShButton>
                <ShButton variant="outline" onclick={() => (detailOpen = false)}>
                    {language.close}
                </ShButton>
                <ShButton variant="primary" onclick={startEdit}>
                    <PencilIcon size={14} />
                    {language.edit}
                </ShButton>
            {/if}
        </div>
    {/snippet}
</ShDialog>
