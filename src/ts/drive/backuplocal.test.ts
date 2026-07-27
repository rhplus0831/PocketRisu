import { beforeEach, describe, expect, test, vi } from 'vitest'
import { StorageError } from '../storage/storageError'

const mocks = vi.hoisted(() => ({
    alertConfirm: vi.fn(),
    alertClear: vi.fn(),
    alertError: vi.fn(),
    alertMd: vi.fn(),
    alertStoreSet: vi.fn(),
    alertWait: vi.fn(),
    notifyInfo: vi.fn(),
    notifySuccess: vi.fn(),
    waitAlert: vi.fn(),
    exportBackup: vi.fn(),
    uploadSaveFolderZip: vi.fn(),
    downloadFile: vi.fn(),
    createWriteStream: vi.fn(),
    reload: vi.fn(),
}))

vi.mock('../alert', () => ({
    alertConfirm: mocks.alertConfirm,
    alertClear: mocks.alertClear,
    alertError: mocks.alertError,
    alertMd: mocks.alertMd,
    alertStore: { set: mocks.alertStoreSet },
    alertWait: mocks.alertWait,
    notifyError: vi.fn(),
    notifyInfo: mocks.notifyInfo,
    notifySuccess: mocks.notifySuccess,
    waitAlert: mocks.waitAlert,
}))

vi.mock('../globalApi.svelte', () => ({
    downloadFile: mocks.downloadFile,
    forageStorage: {
        exportBackup: mocks.exportBackup,
        uploadSaveFolderZip: mocks.uploadSaveFolderZip,
    },
}))

vi.mock('src/lang', () => ({
    language: {
        partialBackupFirstConfirm: 'first',
        partialBackupSecondConfirm: 'second',
        backupLoadConfirm2: 'replace current data',
        importSaveFolderConfirmZip: (name: string, size: string) => `import ${name} (${size})`,
        importSaveFolderSuccess: 'save-folder import complete',
        importSaveFolderCommittedFailure: 'save-folder import committed with an error',
        importSaveFolderOutcomeUnknown: 'save-folder import outcome unknown',
        importSaveFolderFailure: 'save-folder import not committed',
    },
}))

vi.mock('streamsaver', () => ({
    createWriteStream: mocks.createWriteStream,
}))

const { ImportFromSaveZip, SavePartialLocalBackup, runSaveFolderZipImport } = await import('./backuplocal')

function backupResponse(missingAssets = 0) {
    const bytes = new Uint8Array([1, 2, 3, 4])
    return {
        body: null,
        headers: new Headers({
            'content-disposition': 'attachment; filename="server-partial.bin"',
            'x-risu-backup-missing-assets': String(missingAssets),
        }),
        arrayBuffer: async () => bytes.buffer,
    } as Response
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.alertConfirm.mockResolvedValue(true)
    mocks.exportBackup.mockResolvedValue(backupResponse())
    mocks.uploadSaveFolderZip.mockResolvedValue({ ok: true, imported: 7 })
    mocks.downloadFile.mockResolvedValue(undefined)
    mocks.createWriteStream.mockReset()
    vi.stubGlobal('location', { search: '?stale-client-state', reload: mocks.reload })
})

function saveFolderFailure(
    outcome: 'committed' | 'not-committed' | 'unknown',
    message = `injected ${outcome} failure`,
) {
    return new StorageError(message, {
        status: 500,
        code: outcome === 'unknown' ? 'COMMIT_OUTCOME_UNKNOWN' : 'SAVE_FOLDER_IMPORT_FAILED',
        retryable: outcome === 'not-committed',
        commitOutcome: outcome,
        commitOutcomeUnknown: outcome === 'unknown',
        operation: 'write',
    })
}

describe('save-folder ZIP replacement UI', () => {
    test('reports success and reloads once after one authoritative upload', async () => {
        const file = new File(['zip'], 'save.zip', { type: 'application/zip' })

        await expect(runSaveFolderZipImport(file)).resolves.toBe('committed')

        expect(mocks.uploadSaveFolderZip).toHaveBeenCalledOnce()
        expect(mocks.alertStoreSet).toHaveBeenCalledWith({
            type: 'wait',
            msg: 'save-folder import complete (7 files). Refreshing...',
        })
        expect(mocks.reload).toHaveBeenCalledOnce()
        expect(location.search).toBe('')
    })

    test('warns and reloads once for a committed failure without replaying', async () => {
        const failure = saveFolderFailure('committed')
        mocks.uploadSaveFolderZip.mockRejectedValueOnce(failure)

        await expect(runSaveFolderZipImport(new File(['zip'], 'save.zip')))
            .resolves.toBe('committed-with-error')

        expect(mocks.uploadSaveFolderZip).toHaveBeenCalledOnce()
        expect(mocks.alertError).toHaveBeenCalledWith(expect.stringContaining('save-folder import committed with an error'))
        expect(mocks.waitAlert).toHaveBeenCalledOnce()
        expect(mocks.reload).toHaveBeenCalledOnce()
    })

    test('warns and reloads once for an unknown outcome without replaying', async () => {
        const failure = saveFolderFailure('unknown')
        mocks.uploadSaveFolderZip.mockRejectedValueOnce(failure)

        await expect(runSaveFolderZipImport(new File(['zip'], 'save.zip')))
            .resolves.toBe('commit-unknown')

        expect(mocks.uploadSaveFolderZip).toHaveBeenCalledOnce()
        expect(mocks.alertError).toHaveBeenCalledWith(expect.stringContaining('save-folder import outcome unknown'))
        expect(mocks.waitAlert).toHaveBeenCalledOnce()
        expect(mocks.reload).toHaveBeenCalledOnce()
    })

    test('reports a definitive not-committed failure without reloading or replaying', async () => {
        const failure = saveFolderFailure('not-committed')
        mocks.uploadSaveFolderZip.mockRejectedValueOnce(failure)
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

        await expect(runSaveFolderZipImport(new File(['zip'], 'save.zip')))
            .resolves.toBe('not-committed')

        expect(mocks.uploadSaveFolderZip).toHaveBeenCalledOnce()
        expect(mocks.alertError).toHaveBeenCalledWith(expect.stringContaining('save-folder import not committed'))
        expect(mocks.reload).not.toHaveBeenCalled()
        expect(consoleError).toHaveBeenCalledWith(failure)
        consoleError.mockRestore()
    })

    test('owns the mounted picker promise and removes its callback before upload', async () => {
        const originalCreateElement = document.createElement.bind(document)
        let picker: HTMLInputElement | undefined
        const createElement = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
            const element = originalCreateElement(tagName)
            if (tagName.toLowerCase() === 'input') picker = element as HTMLInputElement
            return element
        }) as typeof document.createElement)

        await ImportFromSaveZip()
        expect(picker).toBeDefined()
        const file = new File(['zip'], 'mounted.zip', { type: 'application/zip' })
        Object.defineProperty(picker!, 'files', { configurable: true, value: [file] })
        picker!.dispatchEvent(new Event('change'))

        await vi.waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce())
        expect(mocks.uploadSaveFolderZip).toHaveBeenCalledOnce()
        expect(picker!.onchange).toBeNull()
        expect(picker!.isConnected).toBe(false)
        createElement.mockRestore()
    })

    test('catches a mounted success-callback throw while still reloading exactly once', async () => {
        const callbackFailure = new Error('injected alert render failure')
        mocks.alertStoreSet.mockImplementationOnce(() => { throw callbackFailure })
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const originalCreateElement = document.createElement.bind(document)
        let picker: HTMLInputElement | undefined
        const createElement = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
            const element = originalCreateElement(tagName)
            if (tagName.toLowerCase() === 'input') picker = element as HTMLInputElement
            return element
        }) as typeof document.createElement)

        await ImportFromSaveZip()
        Object.defineProperty(picker!, 'files', {
            configurable: true,
            value: [new File(['zip'], 'callback.zip', { type: 'application/zip' })],
        })
        picker!.dispatchEvent(new Event('change'))

        await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(callbackFailure))
        expect(mocks.uploadSaveFolderZip).toHaveBeenCalledOnce()
        expect(mocks.reload).toHaveBeenCalledOnce()
        expect(mocks.alertError).not.toHaveBeenCalled()
        expect(picker!.onchange).toBeNull()
        createElement.mockRestore()
        consoleError.mockRestore()
    })
})

describe('SavePartialLocalBackup', () => {
    test('delegates selective folding to the bounded server export', async () => {
        await SavePartialLocalBackup()

        expect(mocks.alertConfirm).toHaveBeenNthCalledWith(1, 'first')
        expect(mocks.alertConfirm).toHaveBeenNthCalledWith(2, 'second')
        expect(mocks.exportBackup).toHaveBeenCalledWith(expect.objectContaining({
            scope: 'partial',
            onPreparationProgress: expect.any(Function),
        }))
        expect(mocks.downloadFile).toHaveBeenCalledWith(
            'server-partial.bin',
            new Uint8Array([1, 2, 3, 4]),
        )
        expect(mocks.notifySuccess).toHaveBeenCalledWith('Success')
    })

    test('reports bounded server preparation progress before downloading', async () => {
        mocks.exportBackup.mockImplementationOnce(async (options) => {
            options.onPreparationProgress({
                phase: 'pinning-assets',
                current: 2,
                total: 4,
                bytes: 2048,
            })
            return backupResponse()
        })

        await SavePartialLocalBackup()

        expect(mocks.alertWait).toHaveBeenCalledWith(
            expect.stringContaining('pinning-assets 2/4, 2.0 KB'),
            expect.any(Function),
        )
    })

    test('offers a cancel action that aborts preparation and closes the wait dialog', async () => {
        mocks.exportBackup.mockImplementationOnce(async (options) => (
            new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    reject(options.signal.reason)
                }, { once: true })
            })
        ))

        const saving = SavePartialLocalBackup()
        await vi.waitFor(() => expect(mocks.exportBackup).toHaveBeenCalled())
        const cancelAction = mocks.alertWait.mock.calls
            .map(call => call[1])
            .find(action => typeof action === 'function')
        expect(cancelAction).toBeTypeOf('function')
        cancelAction()
        await saving

        expect(mocks.alertClear).toHaveBeenCalledOnce()
        expect(mocks.notifyInfo).toHaveBeenCalledWith('Backup cancelled')
        expect(mocks.alertError).not.toHaveBeenCalled()
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
    })

    test('reports server-detected missing profile assets after a successful stream', async () => {
        mocks.exportBackup.mockResolvedValue(backupResponse(3))
        await SavePartialLocalBackup()
        expect(mocks.alertMd).toHaveBeenCalledWith(expect.stringContaining('3 referenced profile image'))
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
    })

    test('does not contact the server when either confirmation is declined', async () => {
        mocks.alertConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
        await SavePartialLocalBackup()
        expect(mocks.exportBackup).not.toHaveBeenCalled()
    })

    test('surfaces export failures and does not advertise success', async () => {
        mocks.exportBackup.mockRejectedValue(new Error('injected export failure'))
        await SavePartialLocalBackup()
        expect(mocks.alertError).toHaveBeenCalledWith('Failed')
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
    })

    test('cancels the response body when browser sink construction fails', async () => {
        const sinkError = new Error('injected sink construction failure')
        const cleanupError = new Error('injected response cancellation failure')
        const cancel = vi.fn().mockRejectedValue(cleanupError)
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const body = new ReadableStream<Uint8Array>({ cancel })
        mocks.exportBackup.mockResolvedValue({
            body,
            headers: new Headers(),
        } as Response)
        mocks.createWriteStream.mockImplementationOnce(() => {
            throw sinkError
        })

        await SavePartialLocalBackup()

        expect(cancel).toHaveBeenCalledOnce()
        expect(cancel).toHaveBeenCalledWith(sinkError)
        expect(consoleError).toHaveBeenCalledWith(sinkError)
        expect(consoleError).not.toHaveBeenCalledWith(cleanupError)
        expect(mocks.alertError).toHaveBeenCalledWith('Failed')
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
        consoleError.mockRestore()
    })

    test('aborts a constructed sink when acquiring its writer fails', async () => {
        const writerError = new Error('injected writer acquisition failure')
        const sourceCancel = vi.fn()
        const sinkAbort = vi.fn().mockResolvedValue(undefined)
        const body = new ReadableStream<Uint8Array>({ cancel: sourceCancel })
        mocks.exportBackup.mockResolvedValue({
            body,
            headers: new Headers(),
        } as Response)
        mocks.createWriteStream.mockReturnValueOnce({
            getWriter: vi.fn(() => {
                throw writerError
            }),
            abort: sinkAbort,
        })
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

        await SavePartialLocalBackup()

        expect(sourceCancel).toHaveBeenCalledWith(writerError)
        expect(sinkAbort).toHaveBeenCalledWith(writerError)
        expect(consoleError).toHaveBeenCalledWith(writerError)
        expect(mocks.alertError).toHaveBeenCalledWith('Failed')
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
        consoleError.mockRestore()
    })

    test('does not wait for pending response cancellation and sink abort hooks', async () => {
        const primaryError = new Error('injected setup failure after sink acquisition')
        const controller = new AbortController()
        const neverSettles = new Promise<void>(() => {})
        const sourceCancel = vi.fn(() => neverSettles)
        const sinkAbort = vi.fn(() => neverSettles)
        const body = new ReadableStream<Uint8Array>({ cancel: sourceCancel })
        mocks.exportBackup.mockResolvedValue({
            body,
            headers: new Headers(),
        } as Response)
        mocks.createWriteStream.mockImplementationOnce(() => {
            controller.abort(primaryError)
            return new WritableStream<Uint8Array>({ abort: sinkAbort })
        })
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

        const outcome = await Promise.race([
            SavePartialLocalBackup(controller.signal).then(() => 'settled'),
            new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 250)),
        ])

        expect(outcome).toBe('settled')
        expect(sourceCancel).toHaveBeenCalledWith(primaryError)
        expect(sinkAbort).toHaveBeenCalledWith(primaryError)
        expect(consoleError).toHaveBeenCalledWith(primaryError)
        expect(mocks.alertError).toHaveBeenCalledWith('Failed')
        consoleError.mockRestore()
    })

    test('preserves the primary failure when response cancellation and sink abort both reject', async () => {
        const primaryError = new Error('injected primary failure')
        const controller = new AbortController()
        const sourceCancel = vi.fn().mockRejectedValue(new Error('injected cancel failure'))
        const sinkAbort = vi.fn().mockRejectedValue(new Error('injected abort failure'))
        const body = new ReadableStream<Uint8Array>({ cancel: sourceCancel })
        mocks.exportBackup.mockResolvedValue({
            body,
            headers: new Headers(),
        } as Response)
        mocks.createWriteStream.mockImplementationOnce(() => {
            controller.abort(primaryError)
            return new WritableStream<Uint8Array>({ abort: sinkAbort })
        })
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

        await SavePartialLocalBackup(controller.signal)
        await Promise.resolve()

        expect(sourceCancel).toHaveBeenCalledWith(primaryError)
        expect(sinkAbort).toHaveBeenCalledWith(primaryError)
        expect(consoleError).toHaveBeenCalledWith(primaryError)
        expect(consoleError).toHaveBeenCalledTimes(1)
        expect(mocks.alertError).toHaveBeenCalledWith('Failed')
        consoleError.mockRestore()
    })

    test('closes the sink and releases both stream locks after a successful download', async () => {
        const first = new Uint8Array([1, 2])
        const second = new Uint8Array([3, 4])
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(first)
                controller.enqueue(second)
                controller.close()
            },
        })
        const written: Uint8Array[] = []
        const close = vi.fn()
        const writable = new WritableStream<Uint8Array>({
            write(value) {
                written.push(value)
            },
            close,
        })
        mocks.exportBackup.mockResolvedValue({
            body,
            headers: new Headers({ 'content-length': '4' }),
        } as Response)
        mocks.createWriteStream.mockReturnValueOnce(writable)

        await SavePartialLocalBackup()

        expect(written).toEqual([first, second])
        expect(close).toHaveBeenCalledOnce()
        expect(body.locked).toBe(false)
        expect(writable.locked).toBe(false)
        expect(mocks.notifySuccess).toHaveBeenCalledWith('Success')
        expect(mocks.alertError).not.toHaveBeenCalled()
    })
})
