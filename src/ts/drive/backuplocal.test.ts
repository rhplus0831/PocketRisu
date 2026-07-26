import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    alertConfirm: vi.fn(),
    alertClear: vi.fn(),
    alertError: vi.fn(),
    alertMd: vi.fn(),
    alertWait: vi.fn(),
    notifyInfo: vi.fn(),
    notifySuccess: vi.fn(),
    exportBackup: vi.fn(),
    downloadFile: vi.fn(),
}))

vi.mock('../alert', () => ({
    alertConfirm: mocks.alertConfirm,
    alertClear: mocks.alertClear,
    alertError: mocks.alertError,
    alertMd: mocks.alertMd,
    alertStore: { set: vi.fn() },
    alertWait: mocks.alertWait,
    notifyError: vi.fn(),
    notifyInfo: mocks.notifyInfo,
    notifySuccess: mocks.notifySuccess,
    waitAlert: vi.fn(),
}))

vi.mock('../globalApi.svelte', () => ({
    downloadFile: mocks.downloadFile,
    forageStorage: {
        exportBackup: mocks.exportBackup,
    },
}))

vi.mock('src/lang', () => ({
    language: {
        partialBackupFirstConfirm: 'first',
        partialBackupSecondConfirm: 'second',
    },
}))

const { SavePartialLocalBackup } = await import('./backuplocal')

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
    mocks.downloadFile.mockResolvedValue(undefined)
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
})
