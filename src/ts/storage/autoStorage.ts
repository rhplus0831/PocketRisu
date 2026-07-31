import {
    NodeStorage,
    type PatchItemResult,
    type PluginStorageMutationTransport,
    type PluginStorageStagedTransitionBegin,
    type PluginStorageManifestSnapshotTransport,
    type PluginStorageManifestStateTransport,
    type PluginStorageViewerPageTransport,
    type PluginStorageTransitionTransport,
    type StorageReadOptions,
} from "./nodeStorage"
import type {
    PluginStorageMutationRequest,
    PluginStorageMutationResult,
} from "./pluginStorageMutation"
import type {
    PluginStorageBatchRequest,
    PluginStorageBatchResult,
    PluginStorageVersionedState,
} from "./pluginStorageBatch"
import type { PluginStorageBulkTransitionRequest } from "./pluginStorageTransitionBulk"

export class AutoStorage{
    isAccount:boolean = false

    realStorage:NodeStorage

    async setItem(
        key:string,
        value:Uint8Array,
        etag?:string,
        signal?: AbortSignal | null,
    ):Promise<string|null> {
        if (signal) await this.realStorage.setItem(key, value, etag, signal)
        else await this.realStorage.setItem(key, value, etag)
        return null
    }
    async getItem(
        key:string,
        options: StorageReadOptions | AbortSignal | null = {},
    ):Promise<Buffer> {
        return await this.realStorage.getItem(key, options)
    }
    async readDatabaseCandidate(signal?: AbortSignal | null) {
        await this.Init()
        return signal
            ? await this.realStorage.readDatabaseCandidate(signal)
            : await this.realStorage.readDatabaseCandidate()
    }
    async getItemCached(
        key: string,
        options: StorageReadOptions | AbortSignal | null = {},
    ): Promise<Buffer | null> {
        await this.Init()
        return await this.realStorage.getItemCached(key, options)
    }
    async readDatabaseForBoot() {
        await this.Init()
        return await this.realStorage.readDatabaseForBoot()
    }
    async reconcileOptimizedPluginStorageForBoot(signal?: AbortSignal | null) {
        await this.Init()
        return signal
            ? await this.realStorage.reconcileOptimizedPluginStorageForBoot(signal)
            : await this.realStorage.reconcileOptimizedPluginStorageForBoot()
    }
    async createDatabaseIfAbsent(value: Uint8Array, signal?: AbortSignal | null) {
        await this.Init()
        return signal
            ? await this.realStorage.createDatabaseIfAbsent(value, signal)
            : await this.realStorage.createDatabaseIfAbsent(value)
    }
    async listInternalSnapshotsForBoot(signal?: AbortSignal | null) {
        await this.Init()
        return signal
            ? await this.realStorage.listInternalSnapshotsForBoot(signal)
            : await this.realStorage.listInternalSnapshotsForBoot()
    }
    async restoreInternalSnapshot(
        key: string,
        signal?: AbortSignal | null,
    ) {
        await this.Init()
        return signal
            ? await this.realStorage.restoreInternalSnapshot(key, signal)
            : await this.realStorage.restoreInternalSnapshot(key)
    }
    async keys(prefix: string = '', signal?: AbortSignal | null):Promise<string[]>{
        await this.Init()
        return signal
            ? await this.realStorage.keys(prefix, signal)
            : await this.realStorage.keys(prefix)
    }
    async getStorageCapacity(signal?: AbortSignal | null) {
        await this.Init()
        return signal
            ? await this.realStorage.getStorageCapacity(signal)
            : await this.realStorage.getStorageCapacity()
    }
    async listEntriesWithSizes(prefix: string, signal?: AbortSignal | null) {
        await this.Init()
        return signal
            ? await this.realStorage.listEntriesWithSizes(prefix, signal)
            : await this.realStorage.listEntriesWithSizes(prefix)
    }
    async removeItem(key:string, signal?: AbortSignal | null){
        return signal
            ? await this.realStorage.removeItem(key, signal)
            : await this.realStorage.removeItem(key)
    }
    async clearPluginSaveStorage(signal?: AbortSignal | null) {
        await this.Init()
        return signal
            ? await this.realStorage.clearPluginSaveStorage(signal)
            : await this.realStorage.clearPluginSaveStorage()
    }

    async mutatePluginStorage(
        request: PluginStorageMutationRequest,
        signal?: AbortSignal | null,
    ): Promise<PluginStorageMutationResult> {
        await this.Init()
        return signal
            ? await this.realStorage.mutatePluginStorage(request, signal)
            : await this.realStorage.mutatePluginStorage(request)
    }

    async batchPluginStorage(
        request: PluginStorageBatchRequest,
        signal?: AbortSignal | null,
    ): Promise<PluginStorageBatchResult> {
        await this.Init()
        return signal
            ? await this.realStorage.batchPluginStorage(request, signal)
            : await this.realStorage.batchPluginStorage(request)
    }

    async getPluginStorageState(
        valueKey: string,
        options: StorageReadOptions | AbortSignal | null = {},
    ): Promise<PluginStorageVersionedState> {
        await this.Init()
        return await this.realStorage.getPluginStorageState(valueKey, options)
    }

    async getPluginStorageManifestSnapshot(
        generation: string,
        signal?: AbortSignal | null,
    ): Promise<PluginStorageManifestSnapshotTransport> {
        await this.Init()
        return await this.realStorage.getPluginStorageManifestSnapshot(generation, signal)
    }

    async getPluginStorageManifestState(
        generation: string,
        signal?: AbortSignal | null,
    ): Promise<PluginStorageManifestStateTransport> {
        await this.Init()
        return await this.realStorage.getPluginStorageManifestState(generation, signal)
    }

    async getPluginStorageViewerPage(
        generation: string,
        options: {
            page: number
            pageSize: number
            keyQuery?: string
            ownerQuery?: string
            unknownOwner?: boolean
        },
        signal?: AbortSignal | null,
        onProgress?: (completed: number, total: number) => void,
    ): Promise<PluginStorageViewerPageTransport> {
        await this.Init()
        return await this.realStorage.getPluginStorageViewerPage(
            generation,
            options,
            signal,
            onProgress,
        )
    }

    async checkAccountSync(){
        return false
    }

    async Init(){
        if(!this.realStorage){
            console.log("using node storage")
            this.realStorage = new NodeStorage()
        }
    }

    async createAuth(signal?: AbortSignal | null): Promise<string> {
        if (!this.realStorage) {
            this.realStorage = new NodeStorage()
        }
        return signal
            ? this.realStorage.createAuth(signal)
            : this.realStorage.createAuth()
    }

    async exportBackup(
        opts?: {
            target?: 'upstream' | 'main'
            scope?: 'partial'
            signal?: AbortSignal | null
            onPreparationProgress?: (progress: {
                phase: string
                current: number
                total: number
                bytes: number
            }) => void
        },
        signal?: AbortSignal | null,
    ) {
        await this.Init()
        return this.realStorage.exportBackup(opts, signal)
    }

    async importBackup(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void,
        options: { allowLargeRestore?: boolean } = {},
    ) {
        await this.Init()
        return this.realStorage.importBackup(file, onProgress, options)
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        return await this.realStorage.patchItem(key, patchData)
    }

    async commitPluginStorageMutation(
        plan: PluginStorageMutationTransport,
        signal?: AbortSignal | null,
    ): Promise<void> {
        await this.Init()
        return await this.realStorage.commitPluginStorageMutation(plan, signal)
    }

    async commitPluginStorageTransition(
        plan: PluginStorageTransitionTransport,
        signal?: AbortSignal | null,
    ) {
        await this.Init()
        return await this.realStorage.commitPluginStorageTransition(plan, signal)
    }

    async beginPluginStorageTransition(
        plan: PluginStorageStagedTransitionBegin,
        signal?: AbortSignal | null,
    ) {
        await this.Init()
        return await this.realStorage.beginPluginStorageTransition(plan, signal)
    }

    async uploadPluginStorageTransitionRow(
        transitionId: string,
        storageKey: string,
        bytes: Uint8Array,
        signal?: AbortSignal | null,
    ) {
        await this.Init()
        return await this.realStorage.uploadPluginStorageTransitionRow(
            transitionId,
            storageKey,
            bytes,
            signal,
        )
    }

    async readPluginStorageTransitionRow(
        transitionId: string,
        storageKey: string,
        signal?: AbortSignal | null,
    ) {
        await this.Init()
        return await this.realStorage.readPluginStorageTransitionRow(
            transitionId,
            storageKey,
            signal,
        )
    }

    async getPluginStorageTransitionStatus(
        transitionId: string,
        signal?: AbortSignal | null,
    ) {
        await this.Init()
        return await this.realStorage.getPluginStorageTransitionStatus(transitionId, signal)
    }

    async finalizePluginStorageTransition(
        transitionId: string,
        signal?: AbortSignal | null,
    ) {
        await this.Init()
        return await this.realStorage.finalizePluginStorageTransition(transitionId, signal)
    }

    async getPluginStorageTransitionStreamCapabilities(signal?: AbortSignal | null) {
        await this.Init()
        return await this.realStorage.getPluginStorageTransitionStreamCapabilities(signal)
    }

    async commitBulkPluginStorageTransition(
        request: PluginStorageBulkTransitionRequest,
        signal?: AbortSignal | null,
    ) {
        await this.Init()
        return await this.realStorage.commitBulkPluginStorageTransition(request, signal)
    }

    async abortPluginStorageTransition(
        transitionId: string,
        signal?: AbortSignal | null,
    ) {
        await this.Init()
        return await this.realStorage.abortPluginStorageTransition(transitionId, signal)
    }

    /** Writer-lock state for the reload-on-return check (see NodeStorage). */
    async getWriterLockState() {
        await this.Init()
        return this.realStorage.getWriterLockState()
    }

    /** Get the last known ETag for database.bin */
    getDbEtag(): string | null {
        return this.realStorage._lastDbEtag
    }

    /** Update cached ETag for database.bin */
    setDbEtag(etag: string | null) {
        this.realStorage.setDbEtag(etag)
    }

    listItem = this.keys

    // ── Bulk asset operations ──────────────────────────────────────────────────
    async getItems(keys: string[]) { return this.realStorage.getItems(keys) }
    async setItems(entries: {key: string, value: Uint8Array}[]) { return this.realStorage.setItems(entries) }

    // ── Server-side backup ─────────────────────────────────────────────────────
    async saveServerBackup(onProgress?: (current: number, total: number, bytes: number, totalBytes: number) => void) { await this.Init(); return this.realStorage.saveServerBackup(onProgress) }
    async listServerBackups() { await this.Init(); return this.realStorage.listServerBackups() }
    async restoreServerBackup(filename: string, onProgress?: (bytes: number, totalBytes: number) => void) { await this.Init(); return this.realStorage.restoreServerBackup(filename, onProgress) }
    async deleteServerBackup(filename: string) { await this.Init(); return this.realStorage.deleteServerBackup(filename) }
    async downloadServerBackup(filename: string) { await this.Init(); return this.realStorage.downloadServerBackup(filename) }

    // ── Chat backups ─────────────────────────────────────────────────────────
    async listChatBackupChats() { await this.Init(); return this.realStorage.listChatBackupChats() }
    async listChatBackupVersions(chaId: string, chatId: string) { await this.Init(); return this.realStorage.listChatBackupVersions(chaId, chatId) }
    async fetchChatBackupVersion(chaId: string, chatId: string, versionId: string) { await this.Init(); return this.realStorage.fetchChatBackupVersion(chaId, chatId, versionId) }

    // ── Save-folder migration ─────────────────────────────────────────────────
    async scanSaveFolder(folderPath?: string) { await this.Init(); return this.realStorage.scanSaveFolder(folderPath) }
    async executeSaveFolderImport(folderPath?: string) { await this.Init(); return this.realStorage.executeSaveFolderImport(folderPath) }
    async uploadSaveFolderZip(file: Blob, onProgress?: (loaded: number, total: number) => void) { await this.Init(); return this.realStorage.uploadSaveFolderZip(file, onProgress) }
    async scanCleanup() { await this.Init(); return this.realStorage.scanCleanup() }
    async executeCleanup() { await this.Init(); return this.realStorage.executeCleanup() }
}
