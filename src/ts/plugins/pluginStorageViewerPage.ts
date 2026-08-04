import {
    encodeLosslessPluginStorageValueToUtf8,
    PLUGIN_STORAGE_JSON_CODEC,
    PLUGIN_STORAGE_LOSSLESS_CODEC,
} from '../storage/pluginStorageValueCodec'
import { stringifyJsonValue } from '../storage/jsonValue'

export const PLUGIN_STORAGE_VIEWER_PAGE_SIZE = 50

export interface PluginStorageViewerKey {
    key: string
    owner?: string
}

export interface PluginStorageViewerEntry extends PluginStorageViewerKey {
    /** The only retained representation of the value for the current page. */
    text: string
    size: number
    type: string
    /** Faithful editor source, kept separate from the lossy display projection. */
    editor: PluginStorageViewerEditor
    /** Exact save-publication CAS token; absent for device-local backends. */
    revision?: string
}

export type PluginStorageViewerEditor =
    | {
        codec: typeof PLUGIN_STORAGE_JSON_CODEC
        kind: 'json' | 'string'
        text: string
    }
    | {
        codec: typeof PLUGIN_STORAGE_LOSSLESS_CODEC | 'unsupported'
        kind: 'readonly'
        text: null
    }

export class PluginStorageViewerLoadCancelled extends Error {
    constructor() {
        super('Plugin storage viewer load cancelled')
        this.name = 'PluginStorageViewerLoadCancelled'
    }
}

export interface PluginStorageViewerLoadLease {
    signal: AbortSignal
    isCurrent: () => boolean
    finish: () => void
}

/** Owns the one live viewer request and rejects late bodies by identity. */
export class PluginStorageViewerLoadCoordinator {
    private active: AbortController | null = null

    start(reason = 'Plugin storage viewer load superseded'): PluginStorageViewerLoadLease {
        this.active?.abort(new DOMException(reason, 'AbortError'))
        const controller = new AbortController()
        this.active = controller
        return {
            signal: controller.signal,
            isCurrent: () => this.active === controller && !controller.signal.aborted,
            finish: () => {
                if (this.active === controller) this.active = null
            },
        }
    }

    dispose(): void {
        this.active?.abort(new DOMException('Plugin storage viewer unmounted', 'AbortError'))
        this.active = null
    }
}

const encoder = new TextEncoder()

export function valueToPluginStorageViewerText(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === null || value === undefined) return ''
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

export function detectPluginStorageViewerType(value: unknown, text: string): string {
    if (value === null) return 'object'
    if (value === undefined || text === '') return 'empty'
    if (Array.isArray(value)) return 'array'
    return typeof value
}

export function valueToPluginStorageViewerEditor(value: unknown): PluginStorageViewerEditor {
    try {
        return {
            codec: PLUGIN_STORAGE_JSON_CODEC,
            kind: typeof value === 'string' ? 'string' : 'json',
            text: stringifyJsonValue(value),
        }
    } catch {
        try {
            // Classify values covered by the canonical lossless codec without
            // exposing that envelope as editable plain JSON.
            encodeLosslessPluginStorageValueToUtf8(value)
            return {
                codec: PLUGIN_STORAGE_LOSSLESS_CODEC,
                kind: 'readonly',
                text: null,
            }
        } catch {
            return { codec: 'unsupported', kind: 'readonly', text: null }
        }
    }
}

/**
 * Read exactly one viewer page, serially. Callers replace the previous page
 * with the result, so at most pageSize value bodies and one in-flight body are
 * retained regardless of repository cardinality.
 */
export async function loadPluginStorageViewerPage({
    keys,
    page,
    pageSize = PLUGIN_STORAGE_VIEWER_PAGE_SIZE,
    read,
    signal,
    cancelled = () => false,
    onProgress,
}: {
    keys: PluginStorageViewerKey[]
    page: number
    pageSize?: number
    read: (key: string, signal?: AbortSignal | null) => unknown | Promise<unknown>
    signal?: AbortSignal | null
    cancelled?: () => boolean
    onProgress?: (completed: number, total: number) => void
}): Promise<{
    entries: PluginStorageViewerEntry[]
    page: number
    pageCount: number
}> {
    if (!Number.isInteger(pageSize) || pageSize < 1) {
        throw new RangeError('Plugin storage viewer page size must be a positive integer')
    }
    const pageCount = Math.max(1, Math.ceil(keys.length / pageSize))
    const boundedPage = Math.max(0, Math.min(Math.trunc(page), pageCount - 1))
    const pageKeys = keys.slice(
        boundedPage * pageSize,
        Math.min(keys.length, (boundedPage + 1) * pageSize),
    )
    const entries: PluginStorageViewerEntry[] = []
    const throwIfCancelled = () => {
        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Aborted', 'AbortError')
        }
        if (cancelled()) throw new PluginStorageViewerLoadCancelled()
    }
    try {
        for (const descriptor of pageKeys) {
            throwIfCancelled()
            const value = await read(descriptor.key, signal)
            throwIfCancelled()
            const text = valueToPluginStorageViewerText(value)
            entries.push({
                ...descriptor,
                text,
                size: encoder.encode(text).byteLength,
                type: detectPluginStorageViewerType(value, text),
                editor: valueToPluginStorageViewerEditor(value),
            })
            onProgress?.(entries.length, pageKeys.length)
        }
        return { entries, page: boundedPage, pageCount }
    } catch (error) {
        // Drop every already-read body before propagating cancellation/errors.
        entries.length = 0
        throw error
    }
}
