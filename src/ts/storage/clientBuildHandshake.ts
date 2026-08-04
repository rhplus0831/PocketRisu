import { language } from 'src/lang'
import { alertNormal } from '../alert'
import {
    CLIENT_BUILD_HEADER,
    clientBuildStamp,
    withClientBuildHeader,
} from './clientBuild'

export const CLIENT_UPGRADE_REQUIRED_STATUS = 426
export const CLIENT_UPGRADE_REQUIRED_CODE = 'CLIENT_UPGRADE_REQUIRED'
export const WRITER_EPOCH_HEADER = 'x-writer-epoch'
export { CLIENT_BUILD_HEADER, clientBuildStamp, withClientBuildHeader }

const RELOAD_GUARD_KEY = 'risu-client-build-reload'
const WRITER_EPOCH_RELOAD_GUARD_KEY = 'risu-writer-epoch-reload'

export interface ExpectedClientBuild {
    version: string
    stamp: string
}

export type ClientUpgradeRequiredDetail = {
    reason: 'server-upgrade'
    expectedBuild: ExpectedClientBuild
} | {
    reason: 'server-restart'
    writerEpoch: string
}

let hasUnsavedDirtyState = () => false
let reloadRequested = false
let acceptedWriterEpoch: string | null = null
let writerEpochInvalidated = false

export function setClientBuildDirtyStateProbe(probe: () => boolean): void {
    hasUnsavedDirtyState = probe
}

function parseExpectedBuild(value: unknown): ExpectedClientBuild | null {
    if (!value || typeof value !== 'object') return null
    const candidate = value as { version?: unknown; stamp?: unknown }
    if (typeof candidate.version !== 'string' || candidate.version.length === 0) return null
    if (typeof candidate.stamp !== 'string' || candidate.stamp.length === 0) return null
    return { version: candidate.version, stamp: candidate.stamp }
}

function reloadGuardValue(expectedBuild: ExpectedClientBuild): string {
    return JSON.stringify({
        client: clientBuildStamp,
        server: expectedBuild.stamp,
    })
}

function armReloadGuard(
    key: string,
    value: string,
): 'armed' | 'already-armed' | 'unavailable' {
    try {
        if (sessionStorage.getItem(key) === value) return 'already-armed'
        sessionStorage.setItem(key, value)
        return 'armed'
    } catch {
        return 'unavailable'
    }
}

function surfaceReloadFailure(expectedBuild: ExpectedClientBuild): void {
    surfaceUpgradeMessage(
        `${language.clientUpgradeReloadFailed}\n\n`
        + `Client: ${clientBuildStamp}\nServer: ${expectedBuild.stamp}`,
    )
}

function surfaceUpgradeMessage(message: string): void {
    alertNormal(message)
}

/**
 * Handle a server/client build mismatch without losing local edits. Clean
 * pages reload once; dirty pages enter the existing writer-recovery flow.
 */
export function handleClientUpgradeRequired(
    expectedBuildValue: unknown,
): 'reload' | 'recovery' | 'blocked' {
    const expectedBuild = parseExpectedBuild(expectedBuildValue)
    if (!expectedBuild) {
        surfaceUpgradeMessage(language.clientUpgradeInvalidResponse)
        return 'blocked'
    }

    const guard = armReloadGuard(RELOAD_GUARD_KEY, reloadGuardValue(expectedBuild))
    let dirty = true
    try {
        dirty = hasUnsavedDirtyState()
    } catch {
        // If dirty-state inspection itself fails, preserve the page rather
        // than risking silent loss through an automatic reload.
    }
    if (dirty) {
        window.dispatchEvent(new CustomEvent<ClientUpgradeRequiredDetail>(
            'risu-session-deactivated',
            {
                detail: {
                    reason: 'server-upgrade',
                    expectedBuild,
                },
            },
        ))
        return 'recovery'
    }

    if (reloadRequested) return 'reload'
    if (guard !== 'armed' || typeof globalThis.location?.reload !== 'function') {
        surfaceReloadFailure(expectedBuild)
        return 'blocked'
    }
    reloadRequested = true
    globalThis.location.reload()
    return 'reload'
}

function parseWriterEpoch(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= 256
        ? value
        : null
}

/**
 * A changed server-process epoch invalidates the page's boot-time storage
 * baseline. Reuse the build-upgrade safety split: clean pages reload, while
 * dirty or indeterminate pages enter the existing frozen recovery flow.
 */
export function handleWriterEpochChange(
    writerEpochValue: unknown,
): 'reload' | 'recovery' | 'blocked' {
    const writerEpoch = parseWriterEpoch(writerEpochValue)
    if (!writerEpoch) return 'blocked'

    const guard = armReloadGuard(WRITER_EPOCH_RELOAD_GUARD_KEY, writerEpoch)
    let dirty = true
    try {
        dirty = hasUnsavedDirtyState()
    } catch {
        // Preserve the page when dirty-state inspection is unavailable.
    }
    if (dirty) {
        window.dispatchEvent(new CustomEvent<ClientUpgradeRequiredDetail>(
            'risu-session-deactivated',
            {
                detail: {
                    reason: 'server-restart',
                    writerEpoch,
                },
            },
        ))
        return 'recovery'
    }

    if (reloadRequested) return 'reload'
    if (guard !== 'armed' || typeof globalThis.location?.reload !== 'function') {
        surfaceUpgradeMessage(language.clientUpgradeReloadFailed)
        return 'blocked'
    }
    reloadRequested = true
    globalThis.location.reload()
    return 'reload'
}

/** Observe an optional server epoch. Returns true only for an epoch change. */
export function observeWriterEpoch(writerEpochValue: unknown): boolean {
    const writerEpoch = parseWriterEpoch(writerEpochValue)
    if (!writerEpoch) return false
    if (acceptedWriterEpoch === null) {
        acceptedWriterEpoch = writerEpoch
        return false
    }
    if (writerEpoch === acceptedWriterEpoch) return false
    if (!writerEpochInvalidated) {
        writerEpochInvalidated = true
        handleWriterEpochChange(writerEpoch)
    }
    return true
}

export function observeWriterEpochResponse(
    response: Response,
    bodyWriterEpoch?: unknown,
): boolean {
    const headerEpoch = parseWriterEpoch(response.headers.get(WRITER_EPOCH_HEADER))
    return observeWriterEpoch(headerEpoch ?? bodyWriterEpoch)
}

export function handleWriterEpochXhr(xhr: XMLHttpRequest): boolean {
    // Minimal XHR-compatible shims (including embedded webviews) may omit
    // response-header access. That is the same compatibility path as a server
    // that does not advertise epochs yet.
    if (typeof xhr.getResponseHeader !== 'function') return false
    return observeWriterEpoch(xhr.getResponseHeader(WRITER_EPOCH_HEADER))
}

export function withWriterEpochHeader(init?: HeadersInit): Headers {
    const headers = new Headers(init)
    if (acceptedWriterEpoch !== null) {
        headers.set(WRITER_EPOCH_HEADER, acceptedWriterEpoch)
    }
    return headers
}

export function acceptMatchingClientBuild(expectedBuildValue: unknown): void {
    const expectedBuild = parseExpectedBuild(expectedBuildValue)
    if (!expectedBuild || expectedBuild.stamp !== clientBuildStamp) return
    try {
        sessionStorage.removeItem(RELOAD_GUARD_KEY)
    } catch {
        // A blocked storage API does not affect an already matching client.
    }
}

export async function handleClientBuildResponse(response: Response): Promise<void> {
    if (response.status !== CLIENT_UPGRADE_REQUIRED_STATUS) return
    const body = await response.clone().json().catch(() => null) as {
        code?: unknown
        expectedBuild?: unknown
    } | null
    if (body?.code !== CLIENT_UPGRADE_REQUIRED_CODE) return
    handleClientUpgradeRequired(body.expectedBuild)
}

export function handleClientBuildXhr(xhr: XMLHttpRequest): void {
    if (xhr.status !== CLIENT_UPGRADE_REQUIRED_STATUS) return
    try {
        const body = JSON.parse(xhr.responseText) as {
            code?: unknown
            expectedBuild?: unknown
        }
        if (body?.code === CLIENT_UPGRADE_REQUIRED_CODE) {
            handleClientUpgradeRequired(body.expectedBuild)
        }
    } catch {
        surfaceUpgradeMessage(language.clientUpgradeInvalidResponse)
    }
}

export async function clientBuildFetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
): Promise<Response> {
    const response = await fetch(input, {
        ...init,
        headers: withWriterEpochHeader(withClientBuildHeader(init.headers)),
    })
    observeWriterEpochResponse(response)
    if (response.status === CLIENT_UPGRADE_REQUIRED_STATUS) {
        await handleClientBuildResponse(response)
    }
    return response
}

/** Test-only reset for the process-global dirty-state probe. */
export function resetClientBuildHandshakeForTests(options: {
    preserveReloadGuard?: boolean
} = {}): void {
    hasUnsavedDirtyState = () => false
    reloadRequested = false
    acceptedWriterEpoch = null
    writerEpochInvalidated = false
    if (options.preserveReloadGuard) return
    try {
        sessionStorage.removeItem(RELOAD_GUARD_KEY)
        sessionStorage.removeItem(WRITER_EPOCH_RELOAD_GUARD_KEY)
    } catch {
        // noop
    }
}
