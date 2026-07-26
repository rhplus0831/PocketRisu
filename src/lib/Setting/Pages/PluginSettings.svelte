<script lang="ts">
    import { PlusIcon, TrashIcon, LinkIcon, CodeXmlIcon, PowerIcon, PowerOffIcon, ShieldIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import {
        alertClear,
        alertConfirm,
        alertMd,
        alertSelect,
        alertWait,
        notifyError,
        notifySuccess,
        notifyWarning,
    } from "src/ts/alert";
    import { TriangleAlert } from '@lucide/svelte';

    import { DBState, hotReloading } from "src/ts/stores.svelte";
    import {
        checkPluginUpdate,
        createBlankPlugin,
        importPlugin,
        removePluginAndReload,
        setPluginEnabledAndReload,
        updatePlugin,
    } from "src/ts/plugins/plugins.svelte";
    import { resetPluginPermission } from "src/ts/plugins/apiV3/v3.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { hotReloadPluginFiles } from "src/ts/plugins/apiV3/developMode";
    import ShBadge from "src/lib/UI/GUI/ShBadge.svelte";
    import {
        canOptimizePluginMemory,
        waitForPluginLifecycleIdle,
    } from "src/ts/plugins/pluginMemoryOptimization";
    import {
        reconcilePluginStorageModeForBoot,
        transitionPluginStorageMode,
    } from "src/ts/plugins/pluginSaveStorage";
    import {
        createPluginStorageRecoveryDiagnostic,
        pluginStorageRecoveryStore,
    } from "src/ts/plugins/pluginStorageRecovery";

    let showParams = $state([])
    let reconcilingPluginStorage = $state(false)
    let retryingPluginStorageRecovery = $state(false)
    const optimizePluginMemoryEligible = $derived(
        canOptimizePluginMemory(DBState.db.plugins),
    )

    async function togglePluginMemoryOptimization(enabled: boolean) {
        if (reconcilingPluginStorage) return

        reconcilingPluginStorage = true
        let blockingAlert = false

        try {
            await waitForPluginLifecycleIdle()
            if (enabled && !canOptimizePluginMemory(DBState.db.plugins)) return
            await transitionPluginStorageMode(enabled, {
                onStart: ({ total }) => {
                    // Key values can be arbitrarily large, so count alone is
                    // not a reliable size threshold. Block whenever data moves.
                    blockingAlert = total > 0
                    if (blockingAlert) {
                        alertWait(language.optimizePluginMemoryProgress(0, total))
                    }
                },
                onProgress: ({ completed, total: progressTotal }) => {
                    if (blockingAlert) {
                        alertWait(language.optimizePluginMemoryProgress(completed, progressTotal))
                    }
                },
            })
            notifySuccess(
                enabled
                    ? language.optimizePluginMemoryEnabled
                    : language.optimizePluginMemoryDisabled,
            )
        } catch {
            notifyError(language.optimizePluginMemoryFailedSafe)
        } finally {
            if (blockingAlert) alertClear()
            reconcilingPluginStorage = false
        }
    }

    async function retryPluginStorageRecovery() {
        if (retryingPluginStorageRecovery) return
        retryingPluginStorageRecovery = true
        try {
            const result = await reconcilePluginStorageModeForBoot()
            if (result.issues.length === 0) {
                notifySuccess(language.pluginStorageRecoveryRetrySuccess)
            } else {
                notifyWarning(language.pluginStorageRecoveryBootWarning(result.issues.length))
            }
        } catch {
            // Recovery diagnostics must never echo arbitrary exception text:
            // a hostile legacy row/proxy can put decoded keys or values there.
            notifyWarning(language.pluginStorageRecoveryBootWarning(1))
        } finally {
            retryingPluginStorageRecovery = false
        }
    }

    async function copyPluginStorageRecoveryDiagnostic() {
        const recovery = $pluginStorageRecoveryStore
        if (!recovery) return
        try {
            await navigator.clipboard.writeText(createPluginStorageRecoveryDiagnostic(recovery))
            notifySuccess(language.pluginStorageRecoveryCopySuccess)
        } catch {
            notifyError(language.pluginStorageRecoveryCopyFailed)
        }
    }
</script>

<SettingPage title={language.plugin}>
<span class="text-draculared text-xs mb-4">{language.pluginWarn}</span>

{#if $pluginStorageRecoveryStore}
    <div class="my-4 rounded border border-yellow-500/50 bg-yellow-500/10 p-3" role="alert">
        <div class="flex items-center gap-2 text-yellow-300 font-medium">
            <TriangleAlert size={18} />
            <span>{language.pluginStorageRecoveryTitle}</span>
        </div>
        <p class="mt-2 text-xs text-textcolor2">{language.pluginStorageRecoveryDesc}</p>
        <ul class="mt-2 max-h-32 overflow-auto space-y-1 text-xs font-mono text-textcolor2">
            {#each $pluginStorageRecoveryStore.issues as issue, index (`${issue.code}:${issue.encodedKey}:${index}`)}
                <li>{issue.code}: {issue.encodedKey}</li>
            {/each}
        </ul>
        <div class="mt-3 flex flex-wrap gap-2">
            <ShButton
                size="sm"
                variant="primary"
                onclick={retryPluginStorageRecovery}
                disabled={retryingPluginStorageRecovery}
            >
                {language.pluginStorageRecoveryRetry}
            </ShButton>
            <ShButton size="sm" variant="outline" onclick={copyPluginStorageRecoveryDiagnostic}>
                {language.pluginStorageRecoveryCopy}
            </ShButton>
        </div>
    </div>
{/if}

<div class="my-4 rounded border border-darkborderc bg-darkbg/40 p-3">
    <CheckInput
        check={DBState.db.optimizePluginMemory === true}
        onChange={togglePluginMemoryOptimization}
        disabled={reconcilingPluginStorage || (
            DBState.db.optimizePluginMemory !== true && !optimizePluginMemoryEligible
        )}
        margin={false}
        name={language.optimizePluginMemory}
    >
        <ShBadge variant="warning">Beta</ShBadge>
    </CheckInput>
    <p class="mt-1 text-xs text-textcolor2">{language.optimizePluginMemoryDesc}</p>
    {#if !optimizePluginMemoryEligible}
        <p class="mt-1 text-xs text-yellow-400">{language.optimizePluginMemoryV3Only}</p>
    {/if}
    {#if DBState.db.optimizePluginMemory === true}
        <p class="mt-1 text-xs text-yellow-400">{language.optimizePluginMemoryLegacyOff}</p>
    {/if}
</div>

<div class="text-textcolor2 mb-2 flex gap-2 justify-end">
    <button
        onclick={() => {
            importPlugin()
        }}
        class="hover:text-textcolor cursor-pointer"
    >
        <PlusIcon />
    </button>

    <button
        onclick={async () => {
            const v = parseInt(await alertSelect([
                "Import plugin with hot reload",
                "Download plugin template",
                language.cancel
            ]))
            switch(v){
                case 0:
                    await hotReloadPluginFiles()
                    break;
                case 1:{
                    const a = document.createElement('a');
                    a.href = '/plugin_start.7z';
                    a.download = 'plugin_starter.7z';
                    document.body.appendChild(a);
                }
            }
        }}
        class="hover:text-textcolor cursor-pointer"
    >
        <CodeXmlIcon />
    </button>
</div>

<div class="border-solid border-darkborderc p-2 flex flex-col border-1">
    {#if !DBState.db.plugins || DBState.db.plugins?.length === 0}
        <span class="text-textcolor2">{language.noPlugins}</span>
    {/if}
    {#each DBState.db.plugins as plugin, i}
        {#if i!==0}
        <div
            class="border-darkborderc mt-2 mb-2 w-full border-solid border-b-1 seperator"
        ></div>
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="flex gap-2" aria-labelledby="show-params" role='button' tabindex="0" onclick={() => {
            if(showParams.includes(i)){
                showParams.splice(showParams.indexOf(i),1)
            }
            else{
                showParams.push(i)
            }
        }}>
            <div class="font-bold grow">
                <span>
                    {plugin.displayName ?? plugin.name}
                </span>
                {#if hotReloading.includes(plugin.name)}
                    <span class="text-sm rounded bg-amber-700 ml-2 px-2 py-1 text-white">
                        Hot
                    </span>
                {/if}
            </div>
            {#if plugin.version === 2 || plugin.version === "2.1"}
                <button class="text-yellow-400 hover:gray-200 cursor-pointer" onclick={() => {
                    alertMd(language.pluginV2Warning);
                }} >
                    <TriangleAlert />
                </button>
            {/if}

            {#if plugin.customLink}
                {#each plugin.customLink as link}
                    {#if typeof link.link === "string" && (link.link.startsWith("http://") || link.link.startsWith("https://"))}
                        <a
                            href={link.link}
                            target="_blank"
                            rel="nofollow noopener noreferrer"
                            class="text-textcolor2 hover:text-textcolor cursor-pointer"
                            title={link.hoverText}
                        >
                            <LinkIcon></LinkIcon>
                        </a>
                    {/if}
                {/each}
            {/if}

            {#if plugin.updateURL}
                {#await checkPluginUpdate(plugin) then updateInfo}
                    {#if updateInfo}
                        <button
                            class="text-green-400 hover:gray-200 cursor-pointer"
                            onclick={async () => {
                                const v = await alertConfirm(
                                    language.pluginUpdateFoundInstallIt
                                );
                                if (v) {
                                    updatePlugin(plugin)
                                }
                            }}
                        >
                            <PlusIcon />
                        </button>
                    {/if}
                {/await}
            {/if}

            <button
                class="textcolor2 hover:gray-200 cursor-pointer"
                onclick={async (e) => {
                    e.preventDefault()
                    const nextEnabled = !plugin.enabled
                    try {
                        const result = await setPluginEnabledAndReload(plugin.name, nextEnabled)
                        if (result === "blocked") {
                            notifyWarning(language.optimizePluginMemoryEnableBlocked)
                        }
                    } catch (error) {
                        notifyError(error instanceof Error ? error.message : String(error))
                    }
                }}
            >
                {#if plugin.enabled}
                    <PowerIcon />
                {:else}
                    <PowerOffIcon />
                {/if}
            </button>

            <button
                class="textcolor2 hover:text-primary cursor-pointer"
                title={language.resetPluginPermission}
                onclick={async (e) => {
                    e.stopPropagation()
                    const v = await alertConfirm(
                        language.resetPluginPermissionConfirm.replace("{}", plugin.displayName ?? plugin.name)
                    )
                    if (v) {
                        await resetPluginPermission(plugin.name)
                        notifySuccess(language.resetPluginPermissionDone.replace("{}", plugin.displayName ?? plugin.name))
                    }
                }}
            >
                <ShieldIcon />
            </button>

            <!--Also, remove button.-->
            <button
                class="textcolor2 hover:gray-200 cursor-pointer"
                onclick={async () => {
                    const v = await alertConfirm(
                        language.removeConfirm +
                            (plugin.displayName ?? plugin.name),
                    );
                    if (v) {
                        try {
                            await removePluginAndReload(plugin.name)
                        } catch (error) {
                            notifyError(error instanceof Error ? error.message : String(error))
                        }
                    }
                }}
            >
                <TrashIcon />
            </button>
        </div>
        {#if plugin.version === 1}
            <span class="text-draculared text-xs">
                {language.pluginVersionWarn
                    .replace("{{plugin_version}}", "API V1")
                    .replace("{{required_version}}", "API V3")}
            </span>
            <!--List up args-->
        {:else if Object.keys(plugin.arguments).filter((i) => !i.startsWith("hidden_")).length > 0 && showParams.includes(i)}
            <div class="flex flex-col mt-2 bg-dark-900/50 p-3">
                {#each Object.keys(plugin.arguments) as arg}
                    {#if !arg.startsWith("hidden_")}
                        {#if typeof(plugin?.argMeta?.[arg]?.divider) === 'string'}
                            {#if plugin?.argMeta?.[arg]?.divider}
                                <div class="flex items-center mt-6">
                                    <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                                    <div class="relative flex justify-center">
                                        <span class="px-2 text-sm text-textarea text-nowrap">{plugin?.argMeta?.[arg]?.divider}</span>
                                    </div>
                                    <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                                </div>
                            {:else}
                                <div aria-hidden="true" class="w-full border-t border-darkborderc mt-6"></div>
                            {/if}
                        {/if}
                        <span class="mb-2 mt-6">{plugin?.argMeta?.[arg]?.name || arg}</span>
                        {#if plugin?.argMeta?.[arg]?.description}
                            <span class="mb-2 text-sm text-textcolor2">{plugin?.argMeta?.[arg]?.description}</span>
                        {/if}
                        {#if Array.isArray(plugin.arguments[arg])}
                            <SelectInput
                                className="mt-2 mb-4"
                                bind:value={
                                    DBState.db.plugins[i].realArg[arg] as string
                                }
                            >
                                {#each plugin.arguments[arg] as a}
                                    <OptionInput value={a}>{a}</OptionInput>
                                {/each}
                            </SelectInput>
                        {:else if plugin.arguments[arg] === "string"}

                            {#if plugin?.argMeta?.[arg]?.textarea}
                                <TextAreaInput
                                    className="mt-2"
                                    bind:value={
                                        DBState.db.plugins[i].realArg[arg] as string
                                    }
                                    placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                />
                            {:else if plugin?.argMeta?.[arg]?.radio}
                                {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                    <CheckInput
                                        check={DBState.db.plugins[i].realArg[arg] === (radioOption.split('|').at(-1))}
                                        onChange={(e) => {
                                            if(e){
                                                DBState.db.plugins[i].realArg[arg] = (radioOption.split('|').at(-1))
                                            }
                                        }}
                                        margin={false}
                                        name={radioOption.split('|').at(0)}
                                    />
                                {/each}
                            {:else}
                                <TextInput
                                    className="mt-2"
                                    bind:value={
                                        DBState.db.plugins[i].realArg[arg] as string
                                    }
                                    placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                />
                            {/if}
                        {:else if plugin.arguments[arg] === "int"}
                            {#if plugin?.argMeta?.[arg]?.checkbox}
                                <CheckInput
                                    check={DBState.db.plugins[i].realArg[arg] === '1'}
                                    onChange={(e) => {
                                        DBState.db.plugins[i].realArg[arg] = e ? '1' : '0'
                                    }}
                                    margin={false}
                                    name={
                                        plugin?.argMeta?.[arg]?.checkbox === '1' ? language.enable : plugin?.argMeta?.[arg]?.checkbox
                                    }
                                />
                            {:else if plugin?.argMeta?.[arg]?.radio}
                                {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                    <CheckInput
                                        check={DBState.db.plugins[i].realArg[arg] === parseInt(radioOption.split('|').at(-1))}
                                        onChange={(e) => {
                                            if(e){
                                                DBState.db.plugins[i].realArg[arg] = parseInt(radioOption.split('|').at(-1))
                                            }
                                        }}
                                        margin={false}
                                        name={radioOption.split('|').at(0)}
                                    />
                                {/each}
                            {:else}
                                <NumberInput
                                    className="mt-2"
                                    bind:value={
                                        DBState.db.plugins[i].realArg[arg] as number
                                    }
                                    placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                />
                            {/if}
                        {/if}
                    {/if}
                {/each}
            </div>
        {/if}
    {/each}
</div>
</SettingPage>
