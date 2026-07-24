<script lang="ts">
    import Check from 'src/lib/UI/GUI/CheckInput.svelte'
    import { language } from 'src/lang'
    import {
        isResourceCacheEnabled,
        isResourceCacheSupported,
        getResourceCacheStats,
        setResourceCacheEnabled,
        type ResourceCacheStats,
    } from 'src/ts/storage/resourceCache'

    const supported = isResourceCacheSupported()
    let enabled = $state(isResourceCacheEnabled())
    let changing = $state(false)
    let stats = $state<ResourceCacheStats | null>(null)

    function formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    async function refreshStats() {
        stats = await getResourceCacheStats()
    }

    async function updateEnabled(value: boolean) {
        changing = true
        try {
            await setResourceCacheEnabled(value)
            enabled = isResourceCacheEnabled()
            await refreshStats()
        } finally {
            changing = false
        }
    }

    $effect(() => {
        if (supported) void refreshStats()
    })
</script>

<div class="mt-4 rounded-md border border-darkborderc/50 bg-darkbg/30 p-3">
    <Check
        bind:check={enabled}
        name={language.resourceCache}
        disabled={!supported || changing}
        onChange={(value) => { void updateEnabled(value) }}
        margin={false}
    />
    <p class="mt-1 pl-7 text-sm leading-relaxed text-textcolor2">
        {language.resourceCacheDesc}
    </p>
    {#if supported && stats}
        <p class="mt-1 pl-7 text-xs tabular-nums text-textcolor2/80">
            {language.resourceCacheUsage(stats.entryCount, formatBytes(stats.totalBytes))}
        </p>
    {/if}
</div>
