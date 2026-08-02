import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import stageRowDownloadPkg from './stageRowDownload.cjs'

const { openStageRowDownload } = stageRowDownloadPkg as any
const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('staged transition row downloads', () => {
    it('validates and streams unchanged bytes from one file descriptor', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'stage-row-download-'))
        tempDirs.push(dir)
        const filePath = path.join(dir, 'row')
        const expected = Buffer.from('unchanged staged transition bytes')
        await writeFile(filePath, expected)
        const openFile = vi.fn((target: string, flags: string) => open(target, flags))

        const download = await openStageRowDownload(filePath, expected.length, { openFile })
        expect(download).not.toBeNull()
        const chunks: Buffer[] = []
        for await (const chunk of download.stream) chunks.push(Buffer.from(chunk))
        await download.close()

        expect(openFile).toHaveBeenCalledTimes(1)
        expect(Buffer.concat(chunks)).toEqual(expected)
    })

    it('refuses a size mismatch before returning a response stream', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'stage-row-download-'))
        tempDirs.push(dir)
        const filePath = path.join(dir, 'row')
        await writeFile(filePath, 'short')
        const openFile = vi.fn((target: string, flags: string) => open(target, flags))

        await expect(openStageRowDownload(filePath, 99, { openFile })).resolves.toBeNull()
        expect(openFile).toHaveBeenCalledTimes(1)
    })
})
