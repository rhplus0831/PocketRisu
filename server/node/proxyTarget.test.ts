import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { fetch as undiciFetch } from 'undici'
import pkg from './proxyTarget.cjs'

const {
    assertProxyTargetAllowed,
    createProxyDispatcher,
    isBlockedProxyAddress,
    isProxyTargetBlockedError,
    normalizeProxyTargetUrl,
    resolveHubProxyTarget,
} = pkg as any

const openServers = new Set<http.Server>()
const openDispatchers = new Set<any>()

async function listen(handler: http.RequestListener): Promise<{ server: http.Server, port: number }> {
    const server = http.createServer(handler)
    openServers.add(server)
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    return { server, port: (server.address() as AddressInfo).port }
}

function dispatcher(options?: { isAddressBlocked?: (address: string) => boolean }) {
    const created = createProxyDispatcher(options)
    openDispatchers.add(created)
    return created
}

afterEach(async () => {
    await Promise.all([...openDispatchers].map(async (item) => {
        openDispatchers.delete(item)
        await item.close()
    }))
    await Promise.all([...openServers].map(async (server) => {
        openServers.delete(server)
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }))
})

describe('hosted proxy target validation', () => {
    it.each([
        'http://127.0.0.1:7000/',
        'http://[::1]:7000/',
        'http://2130706433/',
        'http://0177.0.0.1/',
        'http://127.1/',
        'http://[::ffff:127.0.0.1]/',
        'http://10.0.0.1/',
        'http://172.16.0.1/',
        'http://192.168.0.1/',
        'http://169.254.169.254/',
        'http://100.64.0.1/',
        'http://0.0.0.0/',
        'http://[fd00::1]/',
        'http://[fe80::1]/',
    ])('rejects non-public literal %s', (url) => {
        expect(() => assertProxyTargetAllowed(url, { enforceInternalBlock: true }))
            .toThrowError(expect.objectContaining({ code: 'PROXY_TARGET_BLOCKED' }))
    })

    it.each([
        'file:///etc/passwd',
        'ftp://example.com/resource',
        'data:text/plain,hello',
    ])('rejects non-HTTP scheme %s', (url) => {
        expect(() => assertProxyTargetAllowed(url, { enforceInternalBlock: true }))
            .toThrowError(expect.objectContaining({ code: 'PROXY_TARGET_BLOCKED' }))
    })

    it('strips credentials and returns the caller-supplied hardened dispatcher', () => {
        const suppliedDispatcher = {}
        expect(assertProxyTargetAllowed('https://user:secret@example.com/path', {
            enforceInternalBlock: true,
            dispatcher: suppliedDispatcher,
        })).toEqual({
            url: 'https://example.com/path',
            dispatcher: suppliedDispatcher,
        })
    })

    it('rejects malformed DNS hostnames and numeric final labels', () => {
        expect(() => assertProxyTargetAllowed('http://bad_host.example/', { enforceInternalBlock: true }))
            .toThrowError(expect.objectContaining({ code: 'PROXY_TARGET_BLOCKED' }))
        expect(() => assertProxyTargetAllowed('http://example.123/', { enforceInternalBlock: true }))
            .toThrowError(expect.objectContaining({ code: 'PROXY_TARGET_BLOCKED' }))
    })

    it('blocks a hostname that resolves to loopback at connect time', async () => {
        let requests = 0
        const { port } = await listen((_req, res) => {
            requests += 1
            res.end('should not be reached')
        })
        const hardenedDispatcher = dispatcher()
        const target = assertProxyTargetAllowed(`http://localhost:${port}/`, {
            enforceInternalBlock: true,
            dispatcher: hardenedDispatcher,
        })

        let thrown: unknown
        try {
            await undiciFetch(target.url, { dispatcher: target.dispatcher })
        } catch (error) {
            thrown = error
        }

        expect(thrown).toBeDefined()
        expect(isProxyTargetBlockedError(thrown)).toBe(true)
        expect(requests).toBe(0)
    })

    it('revalidates each redirect hop through the lookup hook', async () => {
        let reachedSecondServer = 0
        const { port: secondPort } = await listen((_req, res) => {
            reachedSecondServer += 1
            res.end('second server reached')
        })

        let blockRedirect = false
        const { port: firstPort } = await listen((_req, res) => {
            blockRedirect = true
            res.writeHead(302, { location: `http://localhost:${secondPort}/target` })
            res.end()
        })
        const firstUrl = `http://localhost:${firstPort}/redir`
        const hardenedDispatcher = dispatcher({
            isAddressBlocked: (address) => blockRedirect && isBlockedProxyAddress(address),
        })

        let thrown: unknown
        try {
            await undiciFetch(firstUrl, { dispatcher: hardenedDispatcher })
        } catch (error) {
            thrown = error
        }
        expect(isProxyTargetBlockedError(thrown)).toBe(true)
        expect(reachedSecondServer).toBe(0)

        const permissiveDispatcher = dispatcher({ isAddressBlocked: () => false })
        const response = await undiciFetch(firstUrl, { dispatcher: permissiveDispatcher })
        expect(await response.text()).toBe('second server reached')
        expect(reachedSecondServer).toBe(1)
    })

    it('blocks an IP literal introduced by a redirect even though net.connect skips lookup', async () => {
        let reachedSecondServer = 0
        const { port: secondPort } = await listen((_req, res) => {
            reachedSecondServer += 1
            res.end('literal redirect reached')
        })

        let blockRedirect = false
        const { port: firstPort } = await listen((_req, res) => {
            blockRedirect = true
            res.writeHead(302, { location: `http://127.0.0.1:${secondPort}/target` })
            res.end()
        })
        const hardenedDispatcher = dispatcher({
            isAddressBlocked: (address) => blockRedirect && isBlockedProxyAddress(address),
        })

        let thrown: unknown
        try {
            await undiciFetch(`http://localhost:${firstPort}/redir`, { dispatcher: hardenedDispatcher })
        } catch (error) {
            thrown = error
        }

        expect(isProxyTargetBlockedError(thrown)).toBe(true)
        expect(reachedSecondServer).toBe(0)
    })
})

describe('standalone proxy target validation', () => {
    it.each([
        'http://localhost:11434/',
        'http://192.168.1.50:1234/',
        'http://ollama:11434/',
    ])('allows local target %s without a dispatcher', (url) => {
        expect(assertProxyTargetAllowed(url, { enforceInternalBlock: false })).toEqual({
            url: normalizeProxyTargetUrl(url),
            dispatcher: undefined,
        })
    })

    it('still rejects non-HTTP schemes', () => {
        expect(() => assertProxyTargetAllowed('file:///etc/passwd', { enforceInternalBlock: false }))
            .toThrowError(expect.objectContaining({ code: 'PROXY_TARGET_BLOCKED' }))
    })
})

describe('proxy address classification', () => {
    it.each([
        '192.0.0.1',
        '192.0.2.1',
        '198.18.0.1',
        '224.0.0.1',
        '240.0.0.1',
        '255.255.255.255',
        '::',
        '::1',
        'ff02::1',
        'fe80::1%eth0',
        '64:ff9b::7f00:1',
        'not-an-address',
    ])('blocks %s', (address) => {
        expect(isBlockedProxyAddress(address)).toBe(true)
    })

    it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public address %s', (address) => {
        expect(isBlockedProxyAddress(address)).toBe(false)
    })

    it('recognizes a blocked connector code one level deeper in a fetch cause chain', () => {
        const error = new Error('fetch failed', {
            cause: new Error('connection failed', {
                cause: Object.assign(new Error('blocked'), { code: 'ERR_PROXY_TARGET_BLOCKED' }),
            }),
        })
        expect(isProxyTargetBlockedError(error)).toBe(true)
    })
})

describe('hub proxy target resolution', () => {
    const hubURL = 'https://sv.risuai.xyz'

    it('accepts a path header on the configured HTTPS hub origin', () => {
        expect(resolveHubProxyTarget({
            pathHeader: encodeURIComponent('https://sv.risuai.xyz/resource/icon.png'),
            originalUrl: '/hub-proxy/ignored',
            hubURL,
        })).toBe('https://sv.risuai.xyz/resource/icon.png')
    })

    it.each(['http://127.0.0.1:7000/', 'https://evil.example/'])('rejects foreign header target %s', (pathHeader) => {
        expect(() => resolveHubProxyTarget({
            pathHeader,
            originalUrl: '/hub-proxy/ignored',
            hubURL,
        })).toThrowError(expect.objectContaining({ code: 'PROXY_TARGET_BLOCKED' }))
    })

    it('keeps the default hub URL plus request path behavior', () => {
        expect(resolveHubProxyTarget({
            pathHeader: undefined,
            originalUrl: '/hub-proxy/resource/icon.png?size=2',
            hubURL,
        })).toBe('https://sv.risuai.xyz/resource/icon.png?size=2')
    })
})
