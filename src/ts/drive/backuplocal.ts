import { alertClear, alertError, alertStore, alertWait, alertMd, alertConfirm, waitAlert, notifySuccess, notifyInfo, notifyError } from "../alert";
import { downloadFile, forageStorage } from "../globalApi.svelte";
import { language } from "src/lang";
import { runBackupReplacementUi } from "../storage/backupReplacementUi";

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function throwIfBackupAborted(signal?: AbortSignal | null) {
    if (!signal?.aborted) return
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The backup was cancelled.', 'AbortError')
}

async function streamBackupToDisk(
    response: Response,
    fallbackName: string,
    signal?: AbortSignal | null,
){
    const disposition = response.headers.get('content-disposition') ?? ''
    const fileName = disposition.match(/filename=\"?([^"]+)\"?/)?.[1] ?? fallbackName
    const totalBytes = Number(response.headers.get('content-length') ?? '0')

    if (response.body) {
        const body = response.body
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        let writableStream: WritableStream<Uint8Array> | undefined
        let writer: WritableStreamDefaultWriter<Uint8Array> | undefined
        let downloadedBytes = 0

        try {
            // Own the response stream before any optional sink setup can fail so
            // every setup failure can release the server-side export promptly.
            reader = body.getReader()
            throwIfBackupAborted(signal)
            const streamSaver = await import('streamsaver')
            throwIfBackupAborted(signal)
            writableStream = streamSaver.createWriteStream(fileName)
            writer = writableStream.getWriter()

            while (true) {
                throwIfBackupAborted(signal)
                const { done, value } = await reader.read()
                if (done) {
                    break
                }
                downloadedBytes += value.length
                if (totalBytes > 0) {
                    const progress = ((downloadedBytes / totalBytes) * 100).toFixed(2)
                    alertWait(`Saving local backup... (${progress}%)`)
                } else {
                    alertWait(`Saving local backup... (${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB)`)
                }
                await writer.write(value)
            }
            await writer.close()
        } catch (error) {
            // Cleanup is deliberately best-effort: a failing cancel/abort must
            // never hide or indefinitely delay the primary backup failure.
            startBackupCleanup(() => reader ? reader.cancel(error) : body.cancel(error))
            startBackupCleanup(() => writer
                ? writer.abort(error)
                : writableStream?.abort(error))
            throw error
        } finally {
            try {
                reader?.releaseLock()
            } catch {
                // A broken stream implementation must not replace the primary error.
            }
            try {
                writer?.releaseLock()
            } catch {
                // A broken sink implementation must not replace the primary error.
            }
        }
    } else {
        throwIfBackupAborted(signal)
        await downloadFile(fileName, new Uint8Array(await response.arrayBuffer()))
        throwIfBackupAborted(signal)
    }
}

function startBackupCleanup(cleanup: () => Promise<unknown> | undefined) {
    try {
        void Promise.resolve(cleanup()).catch(() => {})
    } catch {
        // Preserve the failure that initiated cleanup.
    }
}

export async function SaveLocalBackup(){
    try {
        alertWait("Saving local backup...")
        const response = await forageStorage.exportBackup()
        await streamBackupToDisk(response, `risu-backup-${Date.now()}.bin`)
        notifySuccess('Success')
    } catch (error) {
        console.error(error)
        alertError('Failed')
    }
}

export async function SaveLocalBackupForUpstream(){
    try {
        alertWait("Saving local backup...")
        const response = await forageStorage.exportBackup({ target: 'upstream' })
        await streamBackupToDisk(response, `risu-backup-${Date.now()}-upstream.bin`)
        notifySuccess('Success')
    } catch (error) {
        console.error(error)
        alertError('Failed')
    }
}

export async function SaveLocalBackupForMain(){
    try {
        alertWait("Preparing a main-compatible rollback export...")
        const response = await forageStorage.exportBackup({ target: 'main' })
        await streamBackupToDisk(response, `risu-backup-${Date.now()}-main.bin`)
        notifySuccess('Success')
    } catch (error) {
        console.error(error)
        alertError(error instanceof Error ? error.message : 'Failed')
    }
}

/**
 * Saves a partial local backup with only critical assets.
 * 
 * Differences from SaveLocalBackup:
 * - Only includes profile images for characters/groups (excludes emotion images, additional assets, VITS files, CC assets)
 * - Additionally includes: persona icons, folder images, bot preset images
 * - Processes only assets in assetMap (selective) instead of all .png files in assets folder
 * - Faster and more efficient for quick backups
 * - Ideal for backing up core visual identity without bulk data
 */
export async function SavePartialLocalBackup(signal?: AbortSignal | null){
    // First confirmation: Explain the difference from regular backup
    const firstConfirm = await alertConfirm(language.partialBackupFirstConfirm)
    
    if (!firstConfirm) {
        return
    }
    
    // Second confirmation: Final warning about not saving assets
    const secondConfirm = await alertConfirm(language.partialBackupSecondConfirm)
    
    if (!secondConfirm) {
        return
    }
    
    try {
        const localController = signal ? null : new AbortController()
        const activeSignal = signal ?? localController!.signal
        const cancelAction = localController
            ? () => localController.abort(new DOMException('Backup cancelled', 'AbortError'))
            : undefined
        alertWait("Saving partial local backup...", cancelAction)
        // The server pins one SQLite snapshot, folds external plugin rows into
        // database.risudat one entry at a time, and streams the finished archive.
        // This retains the historical upstream-compatible partial-backup shape
        // without materializing plugin storage in the browser.
        const response = await forageStorage.exportBackup({
            scope: 'partial',
            signal: activeSignal,
            onPreparationProgress: ({ phase, current, total, bytes }) => {
                const count = total > 0 ? ` ${current}/${total}` : ''
                const copied = bytes > 0 ? `, ${formatBytes(bytes)}` : ''
                alertWait(`Preparing partial local backup (${phase}${count}${copied})...`, cancelAction)
            },
        })
        const missingAssets = Number(response.headers.get('x-risu-backup-missing-assets') ?? '0')
        await streamBackupToDisk(response, `risu-backup-${Date.now()}-partial.bin`, activeSignal)
        if (Number.isFinite(missingAssets) && missingAssets > 0) {
            alertMd(`Partial backup successful, but ${missingAssets} referenced profile image(s) were missing and skipped.`)
        } else {
            notifySuccess('Success')
        }
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            alertClear()
            notifyInfo('Backup cancelled')
            return
        }
        console.error(error)
        alertError('Failed')
    }
}

export function LoadLocalBackup(){
    try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.bin';
        input.onchange = async () => {
            if (!input.files || input.files.length === 0) {
                input.remove();
                return;
            }
            const file = input.files[0];
            input.remove();
            alertWait(`Loading local Backup... (Uploading ${file.name})`);
            await runBackupReplacementUi({
                replace: () => forageStorage.importBackup(file, (loaded, total) => {
                    const progress = total > 0 ? ((loaded / total) * 100).toFixed(2) : '0.00'
                    alertWait(`Loading local Backup... (${progress}%)`)
                }, { allowLargeRestore: true }),
                onCommitted: async (result) => {
                    if (result.coldStorageFailed && result.coldStorageFailed > 0) {
                        alertError(`Warning: ${result.coldStorageFailed} character(s) could not be restored from cold storage. The imported save may be incomplete. The app will now reload.`)
                        await waitAlert()
                    } else {
                        alertStore.set({
                            type: "wait",
                            msg: "Success, Refreshing your app."
                        });
                    }
                },
                onCommittedFailure: async (error) => {
                    alertError(`${language.backupRestoreCommittedFailure}\n\n${error.message}`)
                    await waitAlert()
                },
                onDefinitiveFailure: (error) => {
                    console.error(error)
                    alertError('Failed, Is file corrupted?')
                },
                onCommitUnknown: async (error) => {
                    alertError(`${language.backupRestoreOutcomeUnknown}\n\n${error.message}`)
                    await waitAlert()
                },
                hardReload: () => {
                    location.search = ''
                    location.reload()
                },
            })
        };

        input.click();
    } catch (error) {
        console.error(error);
        alertError('Failed, Is file corrupted?')
    }
}

export async function ImportFromSaveZip() {
    let input: HTMLInputElement | null = null
    try {
        input = document.createElement('input')
        input.type = 'file'
        input.accept = '.zip'
        input.onchange = () => {
            const file = input?.files?.[0]
            if (input) {
                input.onchange = null
                input.remove()
            }
            input = null
            if (!file) return

            // Event callbacks do not propagate their async failures to this
            // function's outer try/catch. Own the promise explicitly so even a
            // warning/render callback failure cannot become an unhandled
            // rejection after the destructive request has completed.
            void runSaveFolderZipImport(file).catch((error) => {
                console.error(error)
            })
        }

        input.click()
    } catch (error) {
        if (input) {
            input.onchange = null
            input.remove()
        }
        console.error(error)
        alertError(error instanceof Error ? error.message : 'Import failed')
    }
}

export async function runSaveFolderZipImport(file: File) {
    if (!(await alertConfirm(language.importSaveFolderConfirmZip(file.name, formatBytes(file.size))))) return
    if (!(await alertConfirm(language.backupLoadConfirm2))) return

    alertWait(`Uploading ${file.name}...`)
    return await runBackupReplacementUi({
        replace: () => forageStorage.uploadSaveFolderZip(file, (loaded, total) => {
            const progress = total > 0 ? ((loaded / total) * 100).toFixed(2) : '0.00'
            alertWait(`Uploading ${file.name}... (${progress}%)`)
        }),
        onCommitted: (result) => {
            alertStore.set({
                type: "wait",
                msg: `${language.importSaveFolderSuccess} (${result.imported} files). Refreshing...`
            })
        },
        onCommittedFailure: async (error) => {
            alertError(`${language.importSaveFolderCommittedFailure}\n\n${error.message}`)
            await waitAlert()
        },
        onDefinitiveFailure: (error) => {
            console.error(error)
            const message = error instanceof Error ? error.message : String(error)
            alertError(`${language.importSaveFolderFailure}\n\n${message}`)
        },
        onCommitUnknown: async (error) => {
            alertError(`${language.importSaveFolderOutcomeUnknown}\n\n${error.message}`)
            await waitAlert()
        },
        hardReload: () => {
            location.search = ''
            location.reload()
        },
    })
}

export async function CleanupMigratedFiles() {
    try {
        alertWait(language.importSaveFolderScanning)
        let scan: { count: number, totalSize: number }
        try {
            scan = await forageStorage.scanCleanup()
        } catch (error) {
            notifyError(error instanceof Error ? error.message : language.cleanupMigratedNotReady)
            return
        }

        if (scan.count === 0) {
            notifyInfo(language.cleanupMigratedNoFiles)
            return
        }

        const sizeStr = formatBytes(scan.totalSize)
        if (!(await alertConfirm(language.cleanupMigratedConfirm(scan.count, sizeStr)))) return

        alertWait(language.cleanupMigratedCleaning)
        const result = await forageStorage.executeCleanup()

        notifySuccess(language.cleanupMigratedSuccess(result.removed, formatBytes(result.freedBytes)))
    } catch (error) {
        console.error(error)
        notifyError(error instanceof Error ? error.message : 'Cleanup failed')
    }
}

// ── Server-side backup functions ─────────────────────────────────────────────

export async function SaveServerBackup() {
    try {
        alertWait(language.serverBackupSaving)
        const result = await forageStorage.saveServerBackup((current, total, bytes) => {
            const pct = total > 0 ? ((current / total) * 100).toFixed(1) : '0'
            const bytesStr = formatBytes(bytes)
            alertWait(`${language.serverBackupSaving} (${pct}% - ${bytesStr})`)
        })
        notifySuccess(language.serverBackupSaveSuccess(result.filename, formatBytes(result.size)))
    } catch (error) {
        console.error(error)
        alertError(error instanceof Error ? error.message : 'Server backup failed')
    }
}
