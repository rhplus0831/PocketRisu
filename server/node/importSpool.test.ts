import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { zipSync } from 'fflate'
import pkg from './importSpool.cjs'

const {
    IMPORT_IO_PAGE_BYTES,
    finiteByteLimit,
    importErrorPayload,
    spoolAsyncIterable,
    readFileToBufferBounded,
    validateJsonFileStreaming,
    inspectZipFile,
    extractZipEntries,
} = pkg as {
    IMPORT_IO_PAGE_BYTES: number
    finiteByteLimit: (raw: unknown, fallback: number) => number
    importErrorPayload: (error: unknown) => Record<string, unknown> | null
    spoolAsyncIterable: (
        source: AsyncIterable<Uint8Array>,
        filePath: string,
        options: {
            maxBytes: number
            expectedBytes?: number
            signal?: AbortSignal
            onPage?: (page: { index: number; size: number; total: number }) => void
        },
    ) => Promise<{ size: number; pages: number; maxPageBytes: number }>
    readFileToBufferBounded: (
        filePath: string,
        options: {
            size?: number
            maxBytes: number
            signal?: AbortSignal
            onPage?: (page: { index: number; size: number; total: number }) => void
        },
    ) => Promise<Buffer>
    validateJsonFileStreaming: (
        filePath: string,
        options: { size?: number; maxBytes: number; signal?: AbortSignal },
    ) => Promise<{ size: number }>
    inspectZipFile: (
        zipPath: string,
        options: {
            acceptEntry: (name: string) => string | null
            maxEntries: number
            maxExpandedBytes: number
            signal?: AbortSignal
            onPage?: (page: { kind: string; size: number }) => void
        },
    ) => Promise<{
        zipPath: string
        size: number
        entries: unknown[]
        entryCount: number
        expandedBytes: number
    }>
    extractZipEntries: (
        inventory: {
            zipPath: string
            entries: unknown[]
        },
        stageDir: string,
        options?: {
            signal?: AbortSignal
            onPage?: (page: { index: number; size: number; total: number }) => void
        },
    ) => Promise<Array<{
        key: string
        filePath: string
        size: number
        pages: number
        maxPageBytes: number
    }>>
}

const roots: string[] = []

function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-import-spool-'))
    roots.push(root)
    return root
}

function bytes(size: number, seed = 7): Buffer {
    const output = Buffer.allocUnsafe(size)
    let value = seed >>> 0
    for (let index = 0; index < size; index++) {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0
        output[index] = value >>> 24
    }
    return output
}

function writeZip(root: string, entries: Record<string, Uint8Array>, level: 0 | 6): string {
    const zipPath = path.join(root, `save-${level}.zip`)
    fs.writeFileSync(zipPath, Buffer.from(zipSync(entries, { level })))
    return zipPath
}

function locateSingleZipEntry(zip: Buffer) {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (end < 0) throw new Error('test ZIP is missing EOCD')
    const central = zip.readUInt32LE(end + 16)
    const local = zip.readUInt32LE(central + 42)
    return { end, central, local }
}

async function inspect(zipPath: string, maxExpandedBytes = 128 * 1024 * 1024) {
    return inspectZipFile(zipPath, {
        acceptEntry: name => path.basename(name),
        maxEntries: 100,
        maxExpandedBytes,
    })
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('finite import limits and bounded spooling', () => {
    it('never treats zero, NaN, infinity, fractions, or unsafe values as unlimited', () => {
        const fallback = 2 * 1024 * 1024 * 1024
        expect(finiteByteLimit(undefined, fallback)).toBe(fallback)
        expect(finiteByteLimit(0, fallback)).toBe(fallback)
        expect(finiteByteLimit('NaN', fallback)).toBe(fallback)
        expect(finiteByteLimit(Infinity, fallback)).toBe(fallback)
        expect(finiteByteLimit(1.5, fallback)).toBe(fallback)
        expect(finiteByteLimit(Number.MAX_SAFE_INTEGER + 1, fallback)).toBe(fallback)
        expect(finiteByteLimit('1048576', fallback)).toBe(1048576)
    })

    it('accepts the exact cap, splits oversized source chunks, and rejects cap + 1 definitively', async () => {
        const root = makeRoot()
        const cap = IMPORT_IO_PAGE_BYTES * 3 + 17
        const body = bytes(cap)
        const pageSizes: number[] = []
        const exactPath = path.join(root, 'exact.tmp')
        const exact = await spoolAsyncIterable(Readable.from([body]), exactPath, {
            maxBytes: cap,
            expectedBytes: cap,
            onPage: page => pageSizes.push(page.size),
        })

        expect(exact.size).toBe(cap)
        expect(exact.maxPageBytes).toBe(IMPORT_IO_PAGE_BYTES)
        expect(Math.max(...pageSizes)).toBe(IMPORT_IO_PAGE_BYTES)
        expect(fs.readFileSync(exactPath)).toEqual(body)

        const tooLargePath = path.join(root, 'too-large.tmp')
        const error = await spoolAsyncIterable(
            Readable.from([Buffer.concat([body, Buffer.from([1])])]),
            tooLargePath,
            { maxBytes: cap },
        ).catch(value => value)
        expect(importErrorPayload(error)).toMatchObject({
            code: 'IMPORT_SIZE_LIMIT',
            limit: cap,
            actual: cap + 1,
            retryable: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
        })
        expect(fs.existsSync(tooLargePath)).toBe(false)
    })

    it('cancels between pages, removes partial output, and pages legacy fallback reads', async () => {
        const root = makeRoot()
        const body = bytes(IMPORT_IO_PAGE_BYTES * 5 + 9)
        const sourcePath = path.join(root, 'source.bin')
        fs.writeFileSync(sourcePath, body)

        const readPages: number[] = []
        await expect(readFileToBufferBounded(sourcePath, {
            size: body.length,
            maxBytes: body.length,
            onPage: page => readPages.push(page.size),
        })).resolves.toEqual(body)
        expect(Math.max(...readPages)).toBe(IMPORT_IO_PAGE_BYTES)

        const controller = new AbortController()
        const partialPath = path.join(root, 'cancelled.tmp')
        await expect(spoolAsyncIterable(Readable.from([body]), partialPath, {
            maxBytes: body.length,
            signal: controller.signal,
            onPage: page => {
                if (page.index === 1) controller.abort()
            },
        })).rejects.toMatchObject({ code: 'IMPORT_ABORTED' })
        expect(fs.existsSync(partialPath)).toBe(false)
    })

    it('validates large JSON incrementally and rejects malformed or over-limit rows', async () => {
        const root = makeRoot()
        const validPath = path.join(root, 'valid.json')
        const valid = Buffer.concat([
            Buffer.from('{"nested":[true,false,null,-12.5e+2,"\\uD800"]}'),
            Buffer.alloc(IMPORT_IO_PAGE_BYTES * 3, 0x20),
        ])
        fs.writeFileSync(validPath, valid)
        await expect(validateJsonFileStreaming(validPath, {
            size: valid.length,
            maxBytes: valid.length,
        })).resolves.toEqual({ size: valid.length })

        const malformedPath = path.join(root, 'malformed.json')
        fs.writeFileSync(malformedPath, '{"trailing":true,}')
        await expect(validateJsonFileStreaming(malformedPath, {
            maxBytes: 1024,
        })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_STORAGE_ROW' })
        await expect(validateJsonFileStreaming(validPath, {
            maxBytes: valid.length - 1,
        })).rejects.toMatchObject({ code: 'PLUGIN_VALUE_TOO_LARGE' })

        const crossingLexemes = [
            '1'.repeat(65),
            `0.${'1'.repeat(100)}`,
            `1e+${'0'.repeat(100)}1`,
            `1${'0'.repeat(200_000)}e-200000`,
            `0.${'0'.repeat(100_000)}1e100001`,
            `1${'0'.repeat(200_000)}e-200308`,
            `0.${'0'.repeat(100_000)}1e99793`,
            `0.${'0'.repeat(200_000)}1e200000`,
            `0.${'0'.repeat(100_001)}1e100310`,
            `1${'0'.repeat(200_000)}e-199692`,
            `1${'0'.repeat(200_000)}e-199693`,
        ]
        for (let index = 0; index < crossingLexemes.length; index++) {
            const lexeme = crossingLexemes[index]
            expect(() => JSON.parse(lexeme)).not.toThrow()
            const prefix = ' '.repeat(
                IMPORT_IO_PAGE_BYTES - Math.min(31, Math.max(1, Math.floor(lexeme.length / 2))),
            )
            const filePath = path.join(root, `long-number-${index}.json`)
            fs.writeFileSync(filePath, `${prefix}${lexeme}`)
            await expect(validateJsonFileStreaming(filePath, {
                maxBytes: prefix.length + lexeme.length,
            })).resolves.toMatchObject({ size: prefix.length + lexeme.length })
        }

        for (const [index, lexeme] of [
            `0${'1'.repeat(65)}`,
            '1.',
            '1e+',
            '1e309',
            `0.${'0'.repeat(100_001)}1e200000`,
            `1${'0'.repeat(200_000)}e109`,
            `2${'0'.repeat(200_000)}e-199692`,
            `0.${'0'.repeat(100_001)}1e100311`,
            `1${'0'.repeat(200_000)}e-199691`,
        ].entries()) {
            if (!['1.', '1e+', `0${'1'.repeat(65)}`].includes(lexeme)) {
                expect(Number.isFinite(JSON.parse(lexeme))).toBe(false)
            }
            const prefix = ' '.repeat(
                IMPORT_IO_PAGE_BYTES - Math.min(31, Math.max(1, Math.floor(lexeme.length / 2))),
            )
            const filePath = path.join(root, `invalid-number-${index}.json`)
            fs.writeFileSync(filePath, `${prefix}${lexeme}`)
            await expect(validateJsonFileStreaming(filePath, {
                maxBytes: prefix.length + lexeme.length,
            })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_STORAGE_ROW' })
        }

        for (const [index, value] of [
            '"\\uD800"',
            '"\\uD83D\\uDE00"',
            '"escaped\\ntext"',
        ].entries()) {
            const prefix = ' '.repeat(IMPORT_IO_PAGE_BYTES - 3)
            const filePath = path.join(root, `valid-string-${index}.json`)
            fs.writeFileSync(filePath, `${prefix}${value}`)
            await expect(validateJsonFileStreaming(filePath, {
                maxBytes: IMPORT_IO_PAGE_BYTES * 2,
            })).resolves.toMatchObject({ size: prefix.length + value.length })
        }
        for (const [index, value] of [
            '"\\u12G4"',
            '"\\x20"',
            '"raw\nnewline"',
        ].entries()) {
            const prefix = ' '.repeat(IMPORT_IO_PAGE_BYTES - 3)
            const filePath = path.join(root, `invalid-string-${index}.json`)
            fs.writeFileSync(filePath, `${prefix}${value}`)
            await expect(validateJsonFileStreaming(filePath, {
                maxBytes: IMPORT_IO_PAGE_BYTES * 2,
            })).rejects.toMatchObject({ code: 'INVALID_PLUGIN_STORAGE_ROW' })
        }
    })
})

describe('file-backed save-folder ZIP inspection and extraction', () => {
    it.each([0, 6] as const)('extracts stored/deflated entries with exact CRC and <=64 KiB pages (level %i)', async level => {
        const root = makeRoot()
        const database = bytes(1024 * 1024 + 29, 11)
        const row = bytes(512 * 1024 + 7, 29)
        const zipPath = writeZip(root, {
            'nested/database.hex': database,
            'row.hex': row,
        }, level)
        const centralPageSizes: number[] = []
        const inventory = await inspectZipFile(zipPath, {
            acceptEntry: name => path.basename(name),
            maxEntries: 10,
            maxExpandedBytes: database.length + row.length,
            onPage: page => centralPageSizes.push(page.size),
        })
        const outputPageSizes: number[] = []
        const sources = await extractZipEntries(inventory, path.join(root, 'stage'), {
            onPage: page => outputPageSizes.push(page.size),
        })

        expect(inventory.expandedBytes).toBe(database.length + row.length)
        expect(Math.max(...centralPageSizes)).toBeLessThanOrEqual(IMPORT_IO_PAGE_BYTES)
        expect(Math.max(...outputPageSizes)).toBeLessThanOrEqual(IMPORT_IO_PAGE_BYTES)
        expect(sources.map(source => source.key)).toEqual(['database.hex', 'row.hex'])
        expect(fs.readFileSync(sources[0].filePath)).toEqual(database)
        expect(fs.readFileSync(sources[1].filePath)).toEqual(row)
    }, 20_000)

    it('preflights entry count, expanded size, duplicate decoded keys, and ZIP64 sentinels', async () => {
        const root = makeRoot()
        const zipPath = writeZip(root, {
            'a/duplicate.hex': Buffer.from('one'),
            'b/duplicate.hex': Buffer.from('two'),
        }, 0)

        await expect(inspectZipFile(zipPath, {
            acceptEntry: name => path.basename(name),
            maxEntries: 1,
            maxExpandedBytes: 100,
        })).rejects.toMatchObject({ code: 'IMPORT_ENTRY_COUNT_LIMIT' })
        await expect(inspectZipFile(zipPath, {
            acceptEntry: name => name,
            maxEntries: 10,
            maxExpandedBytes: 5,
        })).rejects.toMatchObject({ code: 'IMPORT_EXPANDED_SIZE_LIMIT' })
        await expect(inspect(zipPath)).rejects.toMatchObject({
            code: 'DUPLICATE_SAVE_FOLDER_ENTRY',
        })

        const zip64Path = path.join(root, 'zip64-sentinel.zip')
        const zip64 = Buffer.from(fs.readFileSync(zipPath))
        const end = zip64.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
        zip64.writeUInt16LE(0xffff, end + 10)
        fs.writeFileSync(zip64Path, zip64)
        await expect(inspect(zip64Path)).rejects.toMatchObject({
            code: 'UNSUPPORTED_SAVE_FOLDER_ZIP64',
        })
    })

    it.each([0x0001, 0x0040, 0x2000])(
        'rejects central and local ZIP encryption flag %#x',
        async flag => {
            const root = makeRoot()
            const cleanPath = writeZip(root, { 'database.hex': Buffer.from('row') }, 0)
            const clean = Buffer.from(fs.readFileSync(cleanPath))
            const positions = locateSingleZipEntry(clean)

            const centralEncrypted = Buffer.from(clean)
            centralEncrypted.writeUInt16LE(
                centralEncrypted.readUInt16LE(positions.central + 8) | flag,
                positions.central + 8,
            )
            const centralPath = path.join(root, `central-encrypted-${flag}.zip`)
            fs.writeFileSync(centralPath, centralEncrypted)
            await expect(inspect(centralPath)).rejects.toMatchObject({
                code: 'ENCRYPTED_SAVE_FOLDER_ENTRY',
            })

            const inventory = await inspect(cleanPath)
            const localEncrypted = Buffer.from(clean)
            localEncrypted.writeUInt16LE(
                localEncrypted.readUInt16LE(positions.local + 6) | flag,
                positions.local + 6,
            )
            fs.writeFileSync(cleanPath, localEncrypted)
            const stage = path.join(root, `encrypted-stage-${flag}`)
            await expect(extractZipEntries(inventory, stage)).rejects.toMatchObject({
                code: 'ENCRYPTED_SAVE_FOLDER_ENTRY',
            })
            expect(fs.existsSync(stage)).toBe(false)
        },
    )

    it.each([14, 18, 22])(
        'rejects local ZIP metadata at offset %i that disagrees with the central directory',
        async fieldOffset => {
            const root = makeRoot()
            const zipPath = writeZip(root, { 'database.hex': bytes(257) }, 0)
            const inventory = await inspect(zipPath)
            const zip = Buffer.from(fs.readFileSync(zipPath))
            const { local } = locateSingleZipEntry(zip)
            zip.writeUInt32LE((zip.readUInt32LE(local + fieldOffset) + 1) >>> 0, local + fieldOffset)
            fs.writeFileSync(zipPath, zip)
            const stage = path.join(root, `metadata-stage-${fieldOffset}`)

            await expect(extractZipEntries(inventory, stage)).rejects.toMatchObject({
                code: 'INVALID_SAVE_FOLDER_ZIP',
            })
            expect(fs.existsSync(stage)).toBe(false)
        },
    )

    it('validates a declared zero-byte deflate stream instead of bypassing the inflater', async () => {
        const root = makeRoot()
        const zipPath = writeZip(root, { 'database.hex': Buffer.alloc(0) }, 6)
        const zip = Buffer.from(fs.readFileSync(zipPath))
        const { central, local } = locateSingleZipEntry(zip)
        for (const offset of [16, 20, 24]) zip.writeUInt32LE(0, central + offset)
        for (const offset of [14, 18, 22]) zip.writeUInt32LE(0, local + offset)
        fs.writeFileSync(zipPath, zip)
        const inventory = await inspect(zipPath)
        const stage = path.join(root, 'empty-deflate-stage')

        await expect(extractZipEntries(inventory, stage)).rejects.toMatchObject({
            code: 'CORRUPT_SAVE_FOLDER_ENTRY',
        })
        expect(fs.existsSync(stage)).toBe(false)
    })

    it('rejects trailing bytes inside a declared raw-deflate range', async () => {
        const root = makeRoot()
        const zipPath = writeZip(root, { 'database.hex': bytes(4096) }, 6)
        const original = Buffer.from(fs.readFileSync(zipPath))
        const old = locateSingleZipEntry(original)
        const junk = Buffer.alloc(257, 0xa5)
        const zip = Buffer.concat([
            original.subarray(0, old.central),
            junk,
            original.subarray(old.central),
        ])
        const central = old.central + junk.length
        const end = old.end + junk.length
        const compressedSize = original.readUInt32LE(old.central + 20) + junk.length
        zip.writeUInt32LE(compressedSize, old.local + 18)
        zip.writeUInt32LE(compressedSize, central + 20)
        zip.writeUInt32LE(central, end + 16)
        fs.writeFileSync(zipPath, zip)
        const inventory = await inspect(zipPath)
        const stage = path.join(root, 'trailing-deflate-stage')

        await expect(extractZipEntries(inventory, stage)).rejects.toMatchObject({
            code: 'CORRUPT_SAVE_FOLDER_ENTRY',
        })
        expect(fs.existsSync(stage)).toBe(false)
    })

    it('rejects altered output CRC and removes every tentative entry', async () => {
        const root = makeRoot()
        const zipPath = writeZip(root, { 'database.hex': bytes(4 * 1024 * 1024) }, 0)
        const corrupted = Buffer.from(fs.readFileSync(zipPath))
        const { central, local } = locateSingleZipEntry(corrupted)
        const alteredCrc = (corrupted.readUInt32LE(central + 16) + 1) >>> 0
        corrupted.writeUInt32LE(alteredCrc, central + 16)
        corrupted.writeUInt32LE(alteredCrc, local + 14)
        fs.writeFileSync(zipPath, corrupted)
        const inventory = await inspect(zipPath)
        const stage = path.join(root, 'stage')

        await expect(extractZipEntries(inventory, stage)).rejects.toMatchObject({
            code: 'CORRUPT_SAVE_FOLDER_ENTRY',
            commitOutcome: 'not-committed',
        })
        expect(fs.existsSync(stage)).toBe(false)
    })

    it('cancels extraction before publication and removes the private stage', async () => {
        const root = makeRoot()
        const zipPath = writeZip(root, { 'database.hex': bytes(12 * 1024 * 1024) }, 0)
        const inventory = await inspect(zipPath)
        const controller = new AbortController()
        const stage = path.join(root, 'stage')

        await expect(extractZipEntries(inventory, stage, {
            signal: controller.signal,
            onPage: page => {
                if (page.index === 2) controller.abort()
            },
        })).rejects.toMatchObject({ code: 'IMPORT_ABORTED' })
        expect(fs.existsSync(stage)).toBe(false)
    })
})
