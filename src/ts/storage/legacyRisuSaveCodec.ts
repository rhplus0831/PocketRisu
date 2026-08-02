import { Packr } from 'msgpackr/index-no-eval'
import * as fflate from 'fflate'
import {
    copyDatabasePluginStorageRecord,
    createDatabasePluginStorageRecord,
    definePluginStorageRecordValue,
    getPluginStorageRecordKeys,
    hasPluginStorageRecordValue,
} from '../plugins/pluginStorageRecord'
import { createBoundedMsgpackEncoder } from './boundedMsgpack'
import { ensureCompressionStreams } from './compressionStreams'
import { isWellFormedUnicode } from './unicodeWellFormed'

const packr = new Packr({
    useRecords: false,
    variableMapSize: true,
})
const encodeLegacyMsgpack = createBoundedMsgpackEncoder(packr)

export const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
export const magicCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8])
export const magicStreamCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9])
export const magicPluginStorageHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 10])
export const magicPluginStorageCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 11])
export const magicPluginStorageStreamHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 12])

const pluginStorageLegacyEscapeField = '__pocketRisuPluginStorageEscapesV1'
const pluginStorageLegacyEscapeMarker = 'PocketRisu.plugin-storage-escapes'

type PluginStorageLegacyEscape = {
    field: 'pluginCustomStorage' | 'pluginStorageMeta'
    index: number
    key: string
    value: unknown
}

type SerializedLegacyEscapeValue = [0] | [1, string]
type PluginStorageLegacyEscapeEnvelope = [
    typeof pluginStorageLegacyEscapeMarker,
    1 | 2,
    SerializedLegacyEscapeValue | null,
    Array<
        | [PluginStorageLegacyEscape['field'], number, SerializedLegacyEscapeValue]
        | [PluginStorageLegacyEscape['field'], number, string, SerializedLegacyEscapeValue]
    >,
]

function serializeLegacyEscapeValue(value: unknown): SerializedLegacyEscapeValue {
    const json = JSON.stringify(value)
    return json === undefined ? [0] : [1, json]
}

function deserializeLegacyEscapeValue(value: unknown): { valid: boolean; value?: unknown } {
    if (!Array.isArray(value)) return { valid: false }
    if (value.length === 1 && value[0] === 0) return { valid: true, value: undefined }
    if (value.length !== 2 || value[0] !== 1 || typeof value[1] !== 'string') {
        return { valid: false }
    }
    try {
        return { valid: true, value: JSON.parse(value[1]) }
    } catch {
        return { valid: false }
    }
}

function parseLegacyPluginStorageEnvelope(value: unknown): {
    originalField: { present: boolean; value?: unknown }
    escapes: PluginStorageLegacyEscape[]
} | null {
    if (!Array.isArray(value)
        || value.length !== 4
        || value[0] !== pluginStorageLegacyEscapeMarker
        || (value[1] !== 1 && value[1] !== 2)
        || (value[2] !== null && !Array.isArray(value[2]))
        || !Array.isArray(value[3])
        || (value[2] === null && value[3].length === 0)) {
        return null
    }
    const original = value[2] === null
        ? { valid: true, present: false, value: undefined }
        : { ...deserializeLegacyEscapeValue(value[2]), present: true }
    if (!original.valid) return null

    const seen = new Set<string>()
    const escapes: PluginStorageLegacyEscape[] = []
    for (const entry of value[3]) {
        const version = value[1]
        if (!Array.isArray(entry)
            || entry.length !== (version === 1 ? 3 : 4)
            || (entry[0] !== 'pluginCustomStorage' && entry[0] !== 'pluginStorageMeta')
            || !Number.isInteger(entry[1])
            || entry[1] < 0) {
            return null
        }
        let key = '__proto__'
        if (version === 2) {
            if (typeof entry[2] !== 'string') return null
            try {
                key = JSON.parse(entry[2])
            } catch {
                return null
            }
            if (typeof key !== 'string'
                || JSON.stringify(key) !== entry[2]
                || (key !== '__proto__' && isWellFormedUnicode(key))) return null
        }
        const identity = `${entry[0]}\0${key}`
        if (seen.has(identity)) return null
        const parsed = deserializeLegacyEscapeValue(entry[version === 1 ? 2 : 3])
        if (!parsed.valid) return null
        seen.add(identity)
        escapes.push({ field: entry[0], index: entry[1], key, value: parsed.value })
    }
    return {
        originalField: { present: original.present, value: original.value },
        escapes,
    }
}

function prepareLegacyPluginStorageKeys(data: any): { data: any; escaped: boolean } {
    const escapes: PluginStorageLegacyEscape[] = []
    let prepared = data
    for (const field of ['pluginCustomStorage', 'pluginStorageMeta'] as const) {
        const record = data?.[field] as Record<string, unknown> | undefined
        const keys = getPluginStorageRecordKeys(record)
        const escapedKeys = keys.filter(key => key === '__proto__' || !isWellFormedUnicode(key))
        if (escapedKeys.length === 0) continue
        if (prepared === data) prepared = { ...data }
        const recordCopy = copyDatabasePluginStorageRecord(record)
        for (const key of escapedKeys) {
            escapes.push({ field, index: keys.indexOf(key), key, value: recordCopy[key] })
            delete recordCopy[key]
        }
        prepared[field] = recordCopy
    }
    if (escapes.length === 0) return { data, escaped: false }

    const hasReservedField = hasPluginStorageRecordValue(data, pluginStorageLegacyEscapeField)
    const envelope: PluginStorageLegacyEscapeEnvelope = [
        pluginStorageLegacyEscapeMarker,
        2,
        hasReservedField ? serializeLegacyEscapeValue(data[pluginStorageLegacyEscapeField]) : null,
        escapes.map(escape => [
            escape.field,
            escape.index,
            JSON.stringify(escape.key),
            serializeLegacyEscapeValue(escape.value),
        ]),
    ]
    Object.defineProperty(prepared, pluginStorageLegacyEscapeField, {
        configurable: true,
        enumerable: true,
        value: envelope,
        writable: true,
    })
    return { data: prepared, escaped: true }
}

export function restoreLegacyPluginStorageKeys(data: any): any {
    if (!hasPluginStorageRecordValue(data, pluginStorageLegacyEscapeField)) return data
    const envelope = parseLegacyPluginStorageEnvelope(data[pluginStorageLegacyEscapeField])
    if (!envelope) return data
    for (const field of ['pluginCustomStorage', 'pluginStorageMeta'] as const) {
        const fieldEscapes = envelope.escapes
            .filter(escape => escape.field === field)
            .sort((left, right) => left.index - right.index)
        if (fieldEscapes.length === 0) continue
        const source = data[field] ?? createDatabasePluginStorageRecord()
        const record = createDatabasePluginStorageRecord<unknown>()
        const entries = getPluginStorageRecordKeys(source)
            .map(key => ({ key, value: source[key] }))
        for (const escape of fieldEscapes) {
            entries.splice(Math.min(escape.index, entries.length), 0, {
                key: escape.key,
                value: escape.value,
            })
        }
        for (const entry of entries) {
            definePluginStorageRecordValue(record, entry.key, entry.value)
        }
        data[field] = record
    }
    if (envelope.originalField.present) {
        definePluginStorageRecordValue(
            data,
            pluginStorageLegacyEscapeField,
            envelope.originalField.value,
        )
    } else {
        delete data[pluginStorageLegacyEscapeField]
    }
    return data
}

export function encodeRisuSaveLegacy(
    data: any,
    compression: 'noCompression' | 'compression' = 'noCompression',
): Uint8Array {
    const prepared = prepareLegacyPluginStorageKeys(data)
    let encoded = encodeLegacyMsgpack(prepared.data)
    if (compression === 'compression') {
        encoded = fflate.compressSync(encoded)
        const header = prepared.escaped
            ? magicPluginStorageCompressedHeader
            : magicCompressedHeader
        const result = new Uint8Array(encoded.length + header.length)
        result.set(header, 0)
        result.set(encoded, header.length)
        return result
    }
    const header = prepared.escaped ? magicPluginStorageHeader : magicHeader
    const result = new Uint8Array(encoded.length + header.length)
    result.set(header, 0)
    result.set(encoded, header.length)
    return result
}

export async function encodeRisuSaveCompressionStream(data: any): Promise<Uint8Array> {
    await ensureCompressionStreams()
    const prepared = prepareLegacyPluginStorageKeys(data)
    const encoded = encodeLegacyMsgpack(prepared.data)
    const cs = new CompressionStream('gzip')
    const writer = cs.writable.getWriter()
    void writer.write(encoded as BufferSource)
    void writer.close()
    const buf = await new Response(cs.readable).arrayBuffer()
    const header = prepared.escaped
        ? magicPluginStorageStreamHeader
        : magicStreamCompressedHeader
    const result = new Uint8Array(buf.byteLength + header.length)
    result.set(header, 0)
    result.set(new Uint8Array(buf), header.length)
    return result
}
