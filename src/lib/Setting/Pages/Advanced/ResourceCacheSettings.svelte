<script lang="ts">
    import Check from 'src/lib/UI/GUI/CheckInput.svelte'
    import { language } from 'src/lang'
    import {
        isResourceCacheEnabled,
        isResourceCacheSupported,
        setResourceCacheEnabled,
    } from 'src/ts/storage/resourceCache'

    const supported = isResourceCacheSupported()
    let enabled = $state(isResourceCacheEnabled())
    let changing = $state(false)

    async function updateEnabled(value: boolean) {
        changing = true
        try {
            await setResourceCacheEnabled(value)
            enabled = isResourceCacheEnabled()
        } finally {
            changing = false
        }
    }
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
</div>
