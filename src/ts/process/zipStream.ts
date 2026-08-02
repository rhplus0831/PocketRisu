import * as fflate from 'fflate'

export type ReplayableZipSource = Uint8Array | Blob

const ZIP_SOURCE_CHUNK_BYTES = 64 * 1024
const ZIP_EOCD_MIN_BYTES = 22
const ZIP_MAX_COMMENT_BYTES = 0xffff

interface ZipIndexEntry {
    name: string
    compression: number
    compressedSize: number
    uncompressedSize: number
    localHeaderOffset: number
}

function sourceSize(source: ReplayableZipSource): number {
    return source instanceof Uint8Array ? source.byteLength : source.size
}

async function readSourceRange(
    source: ReplayableZipSource,
    start: number,
    end: number,
): Promise<Uint8Array> {
    if (start < 0 || end < start || end > sourceSize(source)) {
        throw new RangeError('ZIP range is outside the selected file')
    }
    if (source instanceof Uint8Array) return source.subarray(start, end)
    return new Uint8Array(await source.slice(start, end).arrayBuffer())
}

function uint64(view: DataView, offset: number): number {
    const value = view.getBigUint64(offset, true)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError('ZIP64 value exceeds the browser safe integer range')
    }
    return Number(value)
}

function findEndRecord(bytes: Uint8Array): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = bytes.byteLength - ZIP_EOCD_MIN_BYTES; offset >= 0; offset--) {
        if (view.getUint32(offset, true) === 0x06054b50
            && offset + ZIP_EOCD_MIN_BYTES + view.getUint16(offset + 20, true) === bytes.byteLength) {
            return offset
        }
    }
    return -1
}

async function readCentralDirectoryLocation(source: ReplayableZipSource): Promise<{
    entryCount: number
    centralOffset: number
    centralSize: number
}> {
    const size = sourceSize(source)
    const tailStart = Math.max(0, size - ZIP_EOCD_MIN_BYTES - ZIP_MAX_COMMENT_BYTES)
    const tail = await readSourceRange(source, tailStart, size)
    const eocdOffset = findEndRecord(tail)
    if (eocdOffset < 0 || eocdOffset + ZIP_EOCD_MIN_BYTES > tail.byteLength) {
        throw new Error('Invalid ZIP end record')
    }
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    let entryCount = view.getUint16(eocdOffset + 10, true)
    let centralSize = view.getUint32(eocdOffset + 12, true)
    let centralOffset = view.getUint32(eocdOffset + 16, true)

    if (entryCount !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff) {
        return { entryCount, centralOffset, centralSize }
    }

    const absoluteEocdOffset = tailStart + eocdOffset
    if (absoluteEocdOffset < 20) throw new Error('Invalid ZIP64 locator')
    const locator = await readSourceRange(source, absoluteEocdOffset - 20, absoluteEocdOffset)
    const locatorView = new DataView(locator.buffer, locator.byteOffset, locator.byteLength)
    if (locatorView.getUint32(0, true) !== 0x07064b50) {
        throw new Error('Missing ZIP64 locator')
    }
    const zip64Offset = uint64(locatorView, 8)
    const zip64 = await readSourceRange(source, zip64Offset, zip64Offset + 56)
    const zip64View = new DataView(zip64.buffer, zip64.byteOffset, zip64.byteLength)
    if (zip64View.getUint32(0, true) !== 0x06064b50) {
        throw new Error('Invalid ZIP64 end record')
    }
    entryCount = uint64(zip64View, 32)
    centralSize = uint64(zip64View, 40)
    centralOffset = uint64(zip64View, 48)
    return { entryCount, centralOffset, centralSize }
}

function readZip64CentralValues(
    extra: Uint8Array,
    needs: { uncompressed: boolean, compressed: boolean, offset: boolean },
): Partial<Pick<ZipIndexEntry, 'uncompressedSize' | 'compressedSize' | 'localHeaderOffset'>> {
    const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
    let cursor = 0
    while (cursor + 4 <= extra.byteLength) {
        const id = view.getUint16(cursor, true)
        const length = view.getUint16(cursor + 2, true)
        cursor += 4
        if (cursor + length > extra.byteLength) throw new Error('Invalid ZIP extra field')
        if (id === 0x0001) {
            const end = cursor + length
            const result: Partial<Pick<ZipIndexEntry, 'uncompressedSize' | 'compressedSize' | 'localHeaderOffset'>> = {}
            if (needs.uncompressed) {
                if (cursor + 8 > end) throw new Error('Invalid ZIP64 uncompressed size')
                result.uncompressedSize = uint64(view, cursor)
                cursor += 8
            }
            if (needs.compressed) {
                if (cursor + 8 > end) throw new Error('Invalid ZIP64 compressed size')
                result.compressedSize = uint64(view, cursor)
                cursor += 8
            }
            if (needs.offset) {
                if (cursor + 8 > end) throw new Error('Invalid ZIP64 local offset')
                result.localHeaderOffset = uint64(view, cursor)
            }
            return result
        }
        cursor += length
    }
    return {}
}

async function indexZip(source: ReplayableZipSource): Promise<ZipIndexEntry[]> {
    const { entryCount, centralOffset, centralSize } = await readCentralDirectoryLocation(source)
    const central = await readSourceRange(source, centralOffset, centralOffset + centralSize)
    const view = new DataView(central.buffer, central.byteOffset, central.byteLength)
    const entries: ZipIndexEntry[] = []
    let cursor = 0

    while (cursor + 46 <= central.byteLength && entries.length < entryCount) {
        if (view.getUint32(cursor, true) !== 0x02014b50) {
            throw new Error('Invalid ZIP central directory entry')
        }
        const flags = view.getUint16(cursor + 8, true)
        const compression = view.getUint16(cursor + 10, true)
        let compressedSize = view.getUint32(cursor + 20, true)
        let uncompressedSize = view.getUint32(cursor + 24, true)
        const nameLength = view.getUint16(cursor + 28, true)
        const extraLength = view.getUint16(cursor + 30, true)
        const commentLength = view.getUint16(cursor + 32, true)
        let localHeaderOffset = view.getUint32(cursor + 42, true)
        const recordEnd = cursor + 46 + nameLength + extraLength + commentLength
        if (recordEnd > central.byteLength) throw new Error('Truncated ZIP central directory')

        const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength)
        const extra = central.subarray(
            cursor + 46 + nameLength,
            cursor + 46 + nameLength + extraLength,
        )
        const zip64 = readZip64CentralValues(extra, {
            uncompressed: uncompressedSize === 0xffffffff,
            compressed: compressedSize === 0xffffffff,
            offset: localHeaderOffset === 0xffffffff,
        })
        if (uncompressedSize === 0xffffffff) {
            if (zip64.uncompressedSize === undefined) throw new Error('Missing ZIP64 uncompressed size')
            uncompressedSize = zip64.uncompressedSize
        }
        if (compressedSize === 0xffffffff) {
            if (zip64.compressedSize === undefined) throw new Error('Missing ZIP64 compressed size')
            compressedSize = zip64.compressedSize
        }
        if (localHeaderOffset === 0xffffffff) {
            if (zip64.localHeaderOffset === undefined) throw new Error('Missing ZIP64 local offset')
            localHeaderOffset = zip64.localHeaderOffset
        }
        if (flags & 1) throw new Error('Encrypted ZIP entries are not supported')

        entries.push({
            name: fflate.strFromU8(nameBytes, !(flags & 0x0800)),
            compression,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
        })
        cursor = recordEnd
    }
    if (entries.length !== entryCount) throw new Error('ZIP central directory entry count mismatch')
    return entries
}

class EntryStreamPipe {
    readonly stream: ReadableStream<Uint8Array>
    #controller!: ReadableStreamDefaultController<Uint8Array>
    #drainWaiters: (() => void)[] = []
    #closed = false

    constructor() {
        this.stream = new ReadableStream<Uint8Array>({
            start: controller => {
                this.#controller = controller
            },
            pull: () => this.#resolveDrainWaitersIfReady(),
            cancel: () => {
                this.#closed = true
                this.#resolveAllDrainWaiters()
            },
        }, {
            highWaterMark: ZIP_SOURCE_CHUNK_BYTES,
            size: chunk => chunk.byteLength,
        })
    }

    enqueue(chunk: Uint8Array): void {
        if (this.#closed || chunk.byteLength === 0) return
        this.#controller.enqueue(chunk)
    }

    close(): void {
        if (this.#closed) return
        this.#closed = true
        this.#controller.close()
        this.#resolveAllDrainWaiters()
    }

    error(error: Error): void {
        if (this.#closed) return
        this.#closed = true
        this.#controller.error(error)
        this.#resolveAllDrainWaiters()
    }

    async waitForDrain(): Promise<void> {
        if (this.#closed || (this.#controller.desiredSize ?? 1) > 0) return
        await new Promise<void>(resolve => this.#drainWaiters.push(resolve))
    }

    #resolveDrainWaitersIfReady(): void {
        if ((this.#controller.desiredSize ?? 1) > 0) this.#resolveAllDrainWaiters()
    }

    #resolveAllDrainWaiters(): void {
        const waiters = this.#drainWaiters
        this.#drainWaiters = []
        for (const resolve of waiters) resolve()
    }
}

export interface ZipEntryStreamStats {
    entriesStarted: number
    entriesCompleted: number
    maxActiveEntries: number
}

async function localDataOffset(source: ReplayableZipSource, entry: ZipIndexEntry): Promise<number> {
    const header = await readSourceRange(
        source,
        entry.localHeaderOffset,
        entry.localHeaderOffset + 30,
    )
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    if (view.getUint32(0, true) !== 0x04034b50) throw new Error('Invalid ZIP local header')
    return entry.localHeaderOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true)
}

async function pumpEntry(
    source: ReplayableZipSource,
    entry: ZipIndexEntry,
    pipe: EntryStreamPipe,
    consumer: Promise<void>,
): Promise<void> {
    const start = await localDataOffset(source, entry)
    const end = start + entry.compressedSize
    let emitted = 0

    const waitForConsumer = async () => {
        await Promise.race([pipe.waitForDrain(), consumer])
    }

    if (entry.compression === 0) {
        for (let offset = start; offset < end; offset += ZIP_SOURCE_CHUNK_BYTES) {
            const chunk = await readSourceRange(source, offset, Math.min(offset + ZIP_SOURCE_CHUNK_BYTES, end))
            emitted += chunk.byteLength
            pipe.enqueue(chunk)
            await waitForConsumer()
        }
        pipe.close()
    } else if (entry.compression === 8) {
        const inflate = new fflate.Inflate()
        inflate.ondata = (chunk, final) => {
            emitted += chunk.byteLength
            pipe.enqueue(chunk)
            if (final) pipe.close()
        }
        if (start === end) {
            inflate.push(new Uint8Array(0), true)
        } else {
            for (let offset = start; offset < end; offset += ZIP_SOURCE_CHUNK_BYTES) {
                const next = Math.min(offset + ZIP_SOURCE_CHUNK_BYTES, end)
                inflate.push(await readSourceRange(source, offset, next), next === end)
                await waitForConsumer()
            }
        }
    } else {
        const error = new Error(`Unknown ZIP compression method ${entry.compression}`)
        pipe.error(error)
        throw error
    }

    if (emitted !== entry.uncompressedSize) {
        const error = new Error('ZIP entry size mismatch')
        pipe.error(error)
        throw error
    }
}

/**
 * Index the bounded central directory, then inflate selected entries one at a
 * time. Central sizes avoid fflate's local-header ambiguity when an old stored
 * outer member contains a nested ZIP beginning with its own `PK` signature.
 */
export async function consumeZipEntries(
    source: ReplayableZipSource,
    selectedNames: ReadonlySet<string>,
    consume: (name: string, stream: ReadableStream<Uint8Array>) => void | Promise<void>,
): Promise<ZipEntryStreamStats> {
    const indexed = await indexZip(source)
    // fflate.unzip's dictionary semantics retain the last duplicate name.
    const selectedByName = new Map<string, ZipIndexEntry>()
    for (const entry of indexed) {
        if (selectedNames.has(entry.name)) selectedByName.set(entry.name, entry)
    }
    const selected = [...selectedByName.values()]
        .sort((left, right) => left.localHeaderOffset - right.localHeaderOffset)

    let entriesCompleted = 0
    for (const entry of selected) {
        const pipe = new EntryStreamPipe()
        const consumer = Promise.resolve().then(() => consume(entry.name, pipe.stream))
        try {
            await pumpEntry(source, entry, pipe, consumer)
            await consumer
            entriesCompleted++
        } catch (error) {
            pipe.error(error instanceof Error ? error : new Error(String(error)))
            throw error
        }
    }
    return {
        entriesStarted: selected.length,
        entriesCompleted,
        maxActiveEntries: selected.length > 0 ? 1 : 0,
    }
}

export async function consumeZipEntry(
    source: ReplayableZipSource,
    name: string,
    consume: (stream: ReadableStream<Uint8Array>) => void | Promise<void>,
): Promise<boolean> {
    const stats = await consumeZipEntries(source, new Set([name]), (_name, stream) => consume(stream))
    return stats.entriesStarted > 0
}

export async function readZipEntryBytes(
    source: ReplayableZipSource,
    name: string,
): Promise<Uint8Array | null> {
    let result: Uint8Array | null = null
    const found = await consumeZipEntry(source, name, async stream => {
        const reader = stream.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            total += value.byteLength
        }
        const joined = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
            joined.set(chunk, offset)
            offset += chunk.byteLength
        }
        result = joined
    })
    return found ? result : null
}
