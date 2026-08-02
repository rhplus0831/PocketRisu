import { language } from 'src/lang'
import { alertNormal } from '../alert'
import {
    CLIENT_BUILD_HEADER,
    clientBuildStamp,
    withClientBuildHeader,
} from './clientBuild'

export const CLIENT_UPGRADE_REQUIRED_STATUS = 426
export const CLIENT_UPGRADE_REQUIRED_CODE = 'CLIENT_UPGRADE_REQUIRED'
export { CLIENT_BUILD_HEADER, clientBuildStamp, withClientBuildHeader }

const RELOAD_GUARD_KEY = 'risu-client-build-reload'

export interface ExpectedClientBuild {
    version: string
    stamp: string
}

export interface ClientUpgradeRequiredDetail {
    reason: 'server-upgrade'
    expectedBuild: ExpectedClientBuild
}

let hasUnsavedDirtyState = () => false
let reloadRequested = false

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

function armReloadGuard(expectedBuild: ExpectedClientBuild): 'armed' | 'already-armed' | 'unavailable' {
    try {
        const value = reloadGuardValue(expectedBuild)
        if (sessionStorage.getItem(RELOAD_GUARD_KEY) === value) return 'already-armed'
        sessionStorage.setItem(RELOAD_GUARD_KEY, value)
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

    const guard = armReloadGuard(expectedBuild)
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

    if (guard === 'already-armed' && reloadRequested) return 'reload'
    if (guard !== 'armed' || typeof globalThis.location?.reload !== 'function') {
        surfaceReloadFailure(expectedBuild)
        return 'blocked'
    }
    reloadRequested = true
    globalThis.location.reload()
    return 'reload'
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
        headers: withClientBuildHeader(init.headers),
    })
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
    if (options.preserveReloadGuard) return
    try {
        sessionStorage.removeItem(RELOAD_GUARD_KEY)
    } catch {
        // noop
    }
}
