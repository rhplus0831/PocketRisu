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
}

export class PluginStorageViewerLoadCancelled extends Error {
    constructor() {
        super('Plugin storage viewer load cancelled')
        this.name = 'PluginStorageViewerLoadCancelled'
    }
}

const encoder = new TextEncoder()

function valueToText(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === null || value === undefined) return ''
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function detectType(value: unknown, text: string): string {
    if (value === null) return 'object'
    if (value === undefined || text === '') return 'empty'
    if (Array.isArray(value)) return 'array'
    return typeof value
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
    cancelled = () => false,
    onProgress,
}: {
    keys: PluginStorageViewerKey[]
    page: number
    pageSize?: number
    read: (key: string) => unknown | Promise<unknown>
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
    try {
        for (const descriptor of pageKeys) {
            if (cancelled()) throw new PluginStorageViewerLoadCancelled()
            const value = await read(descriptor.key)
            if (cancelled()) throw new PluginStorageViewerLoadCancelled()
            const text = valueToText(value)
            entries.push({
                ...descriptor,
                text,
                size: encoder.encode(text).byteLength,
                type: detectType(value, text),
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
