<script lang="ts">
    import ShAlert from 'src/lib/UI/GUI/ShAlert.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { language } from 'src/lang'
    import { alertSelect, notifyError, notifySuccess } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import { importChatBackup } from 'src/ts/storage/chatStorage'
    import type { character } from 'src/ts/storage/database.svelte'
    import type { ChatBackupSummary, ChatBackupVersion } from 'src/ts/storage/nodeStorage'
    import {
        ChevronDownIcon,
        ChevronRightIcon,
        MessageSquareTextIcon,
        RefreshCwIcon,
        RotateCcwIcon,
        TriangleAlertIcon,
    } from '@lucide/svelte'

    interface Props {
        formatBytes: (bytes: number) => string
    }

    let { formatBytes }: Props = $props()

    let chats = $state<ChatBackupSummary[]>([])
    let versionsByChat = $state<Record<string, ChatBackupVersion[]>>({})
    let expandedKey = $state<string | null>(null)
    let loading = $state(false)
    let loadingVersionsKey = $state<string | null>(null)
    let importingKey = $state<string | null>(null)
    let loadError = $state<string | null>(null)

    function backupKey(chat: ChatBackupSummary): string {
        return `${encodeURIComponent(chat.chaId)}/${encodeURIComponent(chat.chatId)}`
    }

    function truncateId(id: string): string {
        if (id.length <= 18) return id
        return `${id.slice(0, 9)}…${id.slice(-6)}`
    }

    function findCharacter(chaId: string): character | undefined {
        return DBState.db.characters?.find(candidate => candidate.chaId === chaId)
    }

    function findChat(summary: ChatBackupSummary, target?: character) {
        return target?.chats?.find(candidate => candidate?.id === summary.chatId)
    }

    function displayReason(reason: string): string {
        return reason.replace(/[-_]+/g, ' ')
    }

    async function loadChats() {
        loading = true
        loadError = null
        try {
            const result = await forageStorage.listChatBackupChats()
            chats = result.chats
            versionsByChat = {}
            expandedKey = null
        } catch (error) {
            loadError = error instanceof Error ? error.message : String(error)
        } finally {
            loading = false
        }
    }

    async function toggleChat(summary: ChatBackupSummary) {
        const key = backupKey(summary)
        if (expandedKey === key) {
            expandedKey = null
            return
        }
        expandedKey = key
        if (versionsByChat[key]) return

        loadingVersionsKey = key
        try {
            const result = await forageStorage.listChatBackupVersions(summary.chaId, summary.chatId)
            versionsByChat = { ...versionsByChat, [key]: result.versions }
        } catch (error) {
            notifyError(`${language.chatBackupsLoadFailed}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            loadingVersionsKey = null
        }
    }

    async function chooseCharacter(candidates: character[]): Promise<string | null> {
        if (candidates.length === 0) return null
        const selected = Number.parseInt(await alertSelect(
            [
                ...candidates.map(candidate => candidate.name || truncateId(candidate.chaId)),
                language.cancel,
            ],
            language.chatBackupSelectTarget,
        ))
        return selected >= 0 && selected < candidates.length
            ? candidates[selected].chaId
            : null
    }

    async function chooseTarget(summary: ChatBackupSummary): Promise<string | null> {
        const characters = (DBState.db.characters ?? []).filter(candidate => !!candidate?.chaId)
        if (characters.length === 0) {
            notifyError(language.chatBackupNoCharacters)
            return null
        }

        const original = characters.find(candidate => candidate.chaId === summary.chaId)
        if (!original) return chooseCharacter(characters)

        const mode = Number.parseInt(await alertSelect(
            [
                language.chatBackupImportIntoOriginal(original.name || truncateId(original.chaId)),
                language.chatBackupImportAnother,
                language.cancel,
            ],
            language.chatBackupSelectTarget,
        ))
        if (mode === 0) return original.chaId
        if (mode !== 1) return null

        const others = characters.filter(candidate => candidate.chaId !== original.chaId)
        if (others.length === 0) {
            notifyError(language.chatBackupNoOtherCharacters)
            return null
        }
        return chooseCharacter(others)
    }

    async function importVersion(summary: ChatBackupSummary, version: ChatBackupVersion) {
        const targetChaId = await chooseTarget(summary)
        if (!targetChaId) return

        const key = `${backupKey(summary)}/${version.versionId}`
        importingKey = key
        try {
            const backup = await forageStorage.fetchChatBackupVersion(
                summary.chaId,
                summary.chatId,
                version.versionId,
            )
            if (!backup) {
                notifyError(language.chatBackupVersionMissing)
                return
            }
            const restored = importChatBackup(targetChaId, backup)
            notifySuccess(language.chatBackupImportSuccess(restored.name))
        } catch (error) {
            notifyError(`${language.chatBackupImportFailed}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            importingKey = null
        }
    }

    loadChats()
</script>

<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-center justify-between gap-2 mb-3">
        <div class="flex items-center gap-2 text-textcolor">
            <MessageSquareTextIcon size={16} />
            <span class="font-medium">{language.chatBackups}</span>
        </div>
        <ShButton
            variant="outline"
            size="sm"
            onclick={loadChats}
            disabled={loading}
            title={language.chatBackupsRefresh}
            aria-label={language.chatBackupsRefresh}
        >
            <RefreshCwIcon size={14} class={loading ? 'animate-spin' : ''} />
        </ShButton>
    </div>
    <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.chatBackupsDesc}</p>

    {#if loadError}
        <ShAlert variant="destructive">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {language.chatBackupsLoadFailed}: {loadError}
        </ShAlert>
    {:else if loading}
        <p class="text-textcolor2 text-sm">{language.chatBackupsLoading}</p>
    {:else if chats.length === 0}
        <p class="text-textcolor2 text-sm">{language.chatBackupsEmpty}</p>
    {:else}
        <div class="border border-darkborderc rounded-md bg-darkbg/30 overflow-hidden">
            {#each chats as summary, i (backupKey(summary))}
                {@const key = backupKey(summary)}
                {@const target = findCharacter(summary.chaId)}
                {@const localChat = findChat(summary, target)}
                <div class={i > 0 ? 'border-t border-darkborderc/50' : ''}>
                    <button
                        class="w-full flex items-center gap-2 px-3 py-2.5 text-left cursor-pointer hover:bg-bgcolor/40"
                        onclick={() => toggleChat(summary)}
                        aria-expanded={expandedKey === key}
                    >
                        {#if expandedKey === key}
                            <ChevronDownIcon size={16} class="text-textcolor2 shrink-0" />
                        {:else}
                            <ChevronRightIcon size={16} class="text-textcolor2 shrink-0" />
                        {/if}
                        <div class="flex flex-col min-w-0 flex-1">
                            <span
                                class="text-sm truncate"
                                class:text-textcolor={!!target}
                                class:text-red-300={!target}
                                class:italic={!target}
                                title={target?.name ?? summary.chaId}
                            >
                                {target
                                    ? target.name || language.chatBackupUnnamedCharacter
                                    : language.chatBackupDeletedCharacter(truncateId(summary.chaId))}
                            </span>
                            <span
                                class="text-xs truncate"
                                class:text-textcolor2={!!localChat}
                                class:text-red-300={!localChat}
                                class:italic={!localChat}
                                title={localChat?.name || summary.chatId}
                            >
                                {localChat
                                    ? localChat.name || language.chatBackupUntitledChat
                                    : language.chatBackupDeletedChat(truncateId(summary.chatId))}
                            </span>
                            <span class="text-xs text-textcolor2 opacity-75 mt-0.5">
                                {language.chatBackupVersionCount(summary.versionCount)}
                                · {language.chatBackupNewest(new Date(summary.newestTs).toLocaleString())}
                                · {formatBytes(summary.totalBytes)}
                            </span>
                        </div>
                    </button>

                    {#if expandedKey === key}
                        <div class="border-t border-darkborderc/50 bg-bgcolor/25 pl-6">
                            {#if loadingVersionsKey === key}
                                <p class="text-textcolor2 text-sm px-3 py-3">{language.chatBackupVersionsLoading}</p>
                            {:else if (versionsByChat[key]?.length ?? 0) === 0}
                                <p class="text-textcolor2 text-sm px-3 py-3">{language.chatBackupVersionsEmpty}</p>
                            {:else}
                                {#each versionsByChat[key] as version, versionIndex (version.versionId)}
                                    {@const versionKey = `${key}/${version.versionId}`}
                                    <div class="flex items-center gap-3 px-3 py-2.5 {versionIndex > 0 ? 'border-t border-darkborderc/40' : ''}">
                                        <div class="flex flex-col min-w-0 flex-1">
                                            <span class="text-sm text-textcolor">
                                                {new Date(version.ts).toLocaleString()}
                                            </span>
                                            <span class="text-xs text-textcolor2">
                                                {language.chatBackupReason(displayReason(version.reason))}
                                                · {formatBytes(version.size)}
                                            </span>
                                        </div>
                                        <ShButton
                                            variant="outline"
                                            size="xs"
                                            onclick={() => importVersion(summary, version)}
                                            disabled={importingKey !== null}
                                        >
                                            <RotateCcwIcon
                                                size={14}
                                                class={importingKey === versionKey ? 'animate-spin' : ''}
                                            />
                                            {language.chatBackupImportAsNew}
                                        </ShButton>
                                    </div>
                                {/each}
                            {/if}
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>
