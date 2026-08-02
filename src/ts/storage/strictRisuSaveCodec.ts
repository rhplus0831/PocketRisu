import { ensureCompressionStreams } from './compressionStreams'

export const magicRisuSaveHeader = new TextEncoder().encode('RISUSAVE\0')

export enum RisuSaveType {
    CONFIG = 0,
    ROOT = 1,
    CHARACTER_WITH_CHAT = 2,
    CHAT = 3,
    BOTPRESET = 4,
    MODULES = 5,
    REMOTE = 6,
    CHARACTER_WITHOUT_CHAT = 7,
    ROOT_COMPONENT = 8,
    PLUGINS = 9,
    LOADOUTS = 10,
    PLUGIN_STORAGE = 11,
}

export class RisuSaveBlockIntegrityError extends Error {
    readonly code = 'RISU_SAVE_INVALID'

    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'RisuSaveBlockIntegrityError'
    }
}

function blockIntegrityError(message: string, cause?: unknown): RisuSaveBlockIntegrityError {
    return new RisuSaveBlockIntegrityError(
        message,
        cause === undefined ? undefined : { cause },
    )
}

function isKnownJsonRisuSaveType(type: RisuSaveType): boolean {
    return Number.isInteger(type)
        && type >= RisuSaveType.CONFIG
        && type <= RisuSaveType.PLUGIN_STORAGE
}

export type StrictRisuSaveDatabase = Record<string, any> & {
    characters?: any[]
    botPresets?: any[]
    botPresetsId?: number
    modules?: any
    plugins?: any
    pluginCustomStorage?: any
}

export interface StrictRisuSaveDecodeOptions {
    readRemoteBlock?: (fileName: string) => Promise<Uint8Array | null>
}

export async function decodeStrictRisuSaveBlocks(
    data: Uint8Array,
    options: StrictRisuSaveDecodeOptions = {},
): Promise<StrictRisuSaveDatabase> {
    let offset = magicRisuSaveHeader.length
    const db: StrictRisuSaveDatabase = {}
    const loadedBlocks = new Set<string>()
    const directory = new Set<string>()
    const pendingRemoteBlocks: Array<{
        sourceName: string
        name: string
        type: RisuSaveType
    }> = []
    let rootBlocks = 0

    const consumeBlock = (name: string, type: RisuSaveType, blockData: Uint8Array) => {
        loadedBlocks.add(name)
        if (!isKnownJsonRisuSaveType(type)) {
            console.warn(`Not Implemented RisuSaveType: ${type} for ${name}`)
            return
        }

        let parsed: any
        try {
            parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(blockData))
        } catch (error) {
            throw blockIntegrityError(`Invalid RisuSave block ${name}`, error)
        }

        try {
            switch (type) {
                case RisuSaveType.ROOT: {
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                        throw blockIntegrityError(`Invalid RisuSave root block ${name}`)
                    }
                    rootBlocks++
                    for (const rootKey in parsed) {
                        if (!db[rootKey] && !rootKey.startsWith('__')) {
                            db[rootKey] = parsed[rootKey]
                        }
                        if (rootKey === '__directory') {
                            const rootDirectory = parsed[rootKey]
                            if (!Array.isArray(rootDirectory)
                                || rootDirectory.some(dirKey => typeof dirKey !== 'string')) {
                                throw blockIntegrityError(`Invalid RisuSave directory in root block ${name}`)
                            }
                            for (const dirKey of rootDirectory) directory.add(dirKey)
                        }
                    }
                    break
                }
                case RisuSaveType.CHARACTER_WITH_CHAT:
                case RisuSaveType.CHARACTER_WITHOUT_CHAT:
                    db.characters ??= []
                    db.characters.push(parsed)
                    break
                case RisuSaveType.BOTPRESET:
                    db.botPresets = parsed
                    break
                case RisuSaveType.MODULES:
                    db.modules = parsed
                    break
                case RisuSaveType.CONFIG:
                case RisuSaveType.LOADOUTS:
                    break
                case RisuSaveType.PLUGINS:
                    db.plugins = parsed
                    break
                case RisuSaveType.PLUGIN_STORAGE:
                    db.pluginCustomStorage = parsed
                    break
                case RisuSaveType.REMOTE: {
                    const remoteInfo = parsed as {
                        v: number
                        type: RisuSaveType
                        name: string
                    }
                    if (!remoteInfo
                        || typeof remoteInfo.name !== 'string'
                        || remoteInfo.name.length === 0
                        || !Number.isInteger(remoteInfo.type)
                        || !isKnownJsonRisuSaveType(remoteInfo.type)) {
                        throw blockIntegrityError(`Invalid REMOTE block ${name}`)
                    }
                    pendingRemoteBlocks.push({
                        sourceName: name,
                        name: remoteInfo.name,
                        type: remoteInfo.type,
                    })
                    break
                }
                case RisuSaveType.ROOT_COMPONENT:
                    db[parsed.key] = parsed.data
                    break
                default:
                    console.warn(`Not Implemented RisuSaveType: ${type} for ${name}`)
            }
        } catch (error) {
            if (error instanceof RisuSaveBlockIntegrityError) throw error
            throw blockIntegrityError(`Invalid RisuSave block ${name}`, error)
        }
    }

    while (offset < data.length) {
        let name: string
        let type: RisuSaveType
        let blockData: Uint8Array
        try {
            if (offset + 7 > data.length) {
                throw blockIntegrityError(`Truncated RisuSave block header at byte ${offset}`)
            }
            type = data[offset]
            const compressionFlag = data[offset + 1]
            if (compressionFlag !== 0 && compressionFlag !== 1) {
                throw blockIntegrityError(`Invalid RisuSave compression flag at byte ${offset + 1}`)
            }
            const compression = compressionFlag === 1
            offset += 2

            const nameLength = data[offset]
            offset += 1
            if (offset + nameLength + 4 > data.length) {
                throw blockIntegrityError(`Truncated RisuSave block name at byte ${offset}`)
            }
            name = new TextDecoder('utf-8', { fatal: true })
                .decode(data.subarray(offset, offset + nameLength))
            offset += nameLength

            const length = new DataView(
                data.buffer,
                data.byteOffset + offset,
                4,
            ).getUint32(0, true)
            offset += 4

            if (offset + length > data.length) {
                throw blockIntegrityError(`Truncated RisuSave block body at byte ${offset}`)
            }
            blockData = data.subarray(offset, offset + length)
            offset += length

            if (compression) {
                await ensureCompressionStreams()
                const cs = new DecompressionStream('gzip')
                const writer = cs.writable.getWriter()
                void writer.write(blockData as BufferSource)
                void writer.close()
                blockData = new Uint8Array(await new Response(cs.readable).arrayBuffer())
            }
        } catch (error) {
            if (error instanceof RisuSaveBlockIntegrityError) throw error
            throw blockIntegrityError(`Failed to read RisuSave block at byte ${offset}`, error)
        }

        consumeBlock(name, type, blockData)
    }

    for (const remote of pendingRemoteBlocks) {
        const fileName = `remotes/${remote.name}.local.bin`
        let stored: Uint8Array | null
        try {
            stored = options.readRemoteBlock
                ? await options.readRemoteBlock(fileName)
                : null
        } catch (error) {
            throw blockIntegrityError(`Invalid RisuSave block ${remote.sourceName}`, error)
        }
        if (!stored) throw blockIntegrityError(`Remote file ${fileName} not found.`)
        consumeBlock(remote.name, remote.type, stored)
    }

    if (rootBlocks === 0) throw blockIntegrityError('RisuSave data has no root block')
    const missingBlocks = [...directory].filter(name => !loadedBlocks.has(name))
    if (missingBlocks.length > 0) {
        throw blockIntegrityError(
            `RisuSave directory references missing block${missingBlocks.length === 1 ? '' : 's'}: ${missingBlocks.join(', ')}`,
        )
    }
    return db
}

export function applyRisuSaveBotPresetDefault<T>(
    database: StrictRisuSaveDatabase,
    createDefault: () => T,
): StrictRisuSaveDatabase {
    if (!Array.isArray(database.botPresets) || database.botPresets.length === 0) {
        database.botPresets = [createDefault()]
        database.botPresetsId = 0
    }
    return database
}

export function isRisuSaveBlockFormat(data: Uint8Array): boolean {
    return data.length >= magicRisuSaveHeader.length
        && magicRisuSaveHeader.every((byte, index) => data[index] === byte)
}

/** A REMOTE block needs the main-thread storage adapter, so it is not worker eligible. */
export function hasRisuSaveRemoteBlock(data: Uint8Array): boolean {
    if (!isRisuSaveBlockFormat(data)) return false
    let offset = magicRisuSaveHeader.length
    while (offset < data.length) {
        if (offset + 3 > data.length) return false
        const type = data[offset]
        const nameLength = data[offset + 2]
        if (type === RisuSaveType.REMOTE) return true
        offset += 3
        if (offset + nameLength + 4 > data.length) return false
        offset += nameLength
        const length = new DataView(
            data.buffer,
            data.byteOffset + offset,
            4,
        ).getUint32(0, true)
        offset += 4
        if (length > data.length - offset) return false
        offset += length
    }
    return false
}
