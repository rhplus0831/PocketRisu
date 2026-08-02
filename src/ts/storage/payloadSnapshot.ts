import rfdc from 'rfdc'

const cloneWithCircularReferences = rfdc({ circles: true })

/** Snapshot live reactive payloads without importing the app-wide DOM polyfills. */
export function snapshotPayload<T>(value: T): T {
    try {
        return structuredClone(value)
    } catch {
        return cloneWithCircularReferences(value)
    }
}
