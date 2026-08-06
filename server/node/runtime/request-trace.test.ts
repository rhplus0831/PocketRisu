import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import compression from 'compression'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import pkg from './request-trace.cjs'

const {
    DEFAULT_MAX_TRACES,
    TRACE_FILE_SUFFIX,
    createRequestTracer,
    isRequestTracingEnabled,
    isWebSocketUpgradeRequest,
} = pkg as {
    DEFAULT_MAX_TRACES: number
    TRACE_FILE_SUFFIX: string
    createRequestTracer: (options?: Record<string, unknown>) => {
        middleware: express.RequestHandler
        flush: () => Promise<void>
    }
    isRequestTracingEnabled: (env?: Record<string, string | undefined>) => boolean
    isWebSocketUpgradeRequest: (req: { headers?: Record<string, string> }) => boolean
}

let tmpDir: string
const servers: http.Server[] = []

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-trace-'))
})

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
        server.close(() => resolve())
    })))
    fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function listen(app: express.Express) {
    const server = http.createServer(app)
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    return server
}

async function request(
    server: http.Server,
    options: { method?: string; path: string; headers?: Record<string, string> },
    body?: string | Buffer,
) {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind to TCP')
    return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: address.port,
            method: options.method ?? 'GET',
            path: options.path,
            headers: options.headers,
        }, (res) => {
            const chunks: Buffer[] = []
            res.on('data', chunk => chunks.push(Buffer.from(chunk)))
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks),
            }))
        })
        req.once('error', reject)
        req.end(body)
    })
}

async function traceFiles(traceDir: string) {
    const names = await fsp.readdir(traceDir)
    return names.filter(name => name.endsWith(TRACE_FILE_SUFFIX)).sort()
}

describe('request trace configuration', () => {
    it('activates only for the exact true environment value', () => {
        expect(isRequestTracingEnabled({ TRACE_REQUEST_FOR_DEBUG: 'true' })).toBe(true)
        expect(isRequestTracingEnabled({ TRACE_REQUEST_FOR_DEBUG: 'TRUE' })).toBe(false)
        expect(isRequestTracingEnabled({ TRACE_REQUEST_FOR_DEBUG: '1' })).toBe(false)
        expect(isRequestTracingEnabled({})).toBe(false)
    })

    it('recognizes WebSocket and other HTTP upgrade attempts', () => {
        expect(isWebSocketUpgradeRequest({
            headers: { connection: 'keep-alive, Upgrade', upgrade: 'websocket' },
        })).toBe(true)
        expect(isWebSocketUpgradeRequest({ headers: { connection: 'keep-alive' } })).toBe(false)
    })
})

describe('request trace middleware', () => {
    it('writes one gzip-compressed request and response trace', async () => {
        const traceDir = path.join(tmpDir, 'trace')
        const tracer = createRequestTracer({ traceDir })
        const app = express()
        app.use(compression({ threshold: 0 }))
        app.use(tracer.middleware)
        app.use(express.json())
        app.post('/echo', (req, res) => {
            res.status(201).json({ accepted: req.body })
        })
        const server = await listen(app)
        const body = JSON.stringify({ message: 'hello' })

        const response = await request(server, {
            method: 'POST',
            path: '/echo?mode=debug',
            headers: {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body)),
                'accept-encoding': 'gzip',
            },
        }, body)
        expect(response.status).toBe(201)
        await tracer.flush()

        const files = await traceFiles(traceDir)
        expect(files).toHaveLength(1)
        const compressed = await fsp.readFile(path.join(traceDir, files[0]))
        expect([...compressed.subarray(0, 2)]).toEqual([0x1f, 0x8b])
        const trace = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'))
        expect(trace.request).toMatchObject({
            method: 'POST',
            url: '/echo?mode=debug',
            body: {
                encoding: 'json',
                data: { message: 'hello' },
            },
        })
        expect(trace.response.statusCode).toBe(201)
        expect(trace.response.headers['content-encoding']).toBe('gzip')
        expect(JSON.parse(trace.response.body.data)).toEqual({
            accepted: { message: 'hello' },
        })
    })

    it('does not trace incrementally written responses', async () => {
        const traceDir = path.join(tmpDir, 'trace')
        const tracer = createRequestTracer({ traceDir })
        const app = express()
        app.use(tracer.middleware)
        app.get('/stream', (_req, res) => {
            res.type('text/plain')
            res.write('first')
            res.end('second')
        })
        const server = await listen(app)

        const response = await request(server, { path: '/stream' })
        expect(response.body.toString()).toBe('firstsecond')
        await tracer.flush()
        expect(await traceFiles(traceDir)).toHaveLength(0)
    })

    it('does not trace directly consumed request streams', async () => {
        const traceDir = path.join(tmpDir, 'trace')
        const tracer = createRequestTracer({
            traceDir,
            isStreamingRequest: (req: express.Request) => req.path === '/upload',
        })
        const app = express()
        app.use(tracer.middleware)
        app.post('/upload', (req, res) => {
            let bytes = 0
            req.on('data', chunk => { bytes += chunk.length })
            req.on('end', () => res.json({ bytes }))
        })
        const server = await listen(app)

        const response = await request(server, {
            method: 'POST',
            path: '/upload',
            headers: { 'content-type': 'application/octet-stream' },
        }, Buffer.from('streamed body'))
        expect(JSON.parse(response.body.toString())).toEqual({ bytes: 13 })
        await tracer.flush()
        expect(await traceFiles(traceDir)).toHaveLength(0)
    })
})

describe('request trace retention', () => {
    it('keeps only the newest 500 trace files', async () => {
        expect(DEFAULT_MAX_TRACES).toBe(500)
        const traceDir = path.join(tmpDir, 'trace')
        await fsp.mkdir(traceDir, { recursive: true })
        const baseTimeSeconds = 1_700_000_000
        for (let index = 0; index <= DEFAULT_MAX_TRACES; index += 1) {
            const name = `existing-${String(index).padStart(3, '0')}${TRACE_FILE_SUFFIX}`
            const filePath = path.join(traceDir, name)
            await fsp.writeFile(filePath, zlib.gzipSync('{}'))
            await fsp.utimes(filePath, baseTimeSeconds + index, baseTimeSeconds + index)
        }

        const tracer = createRequestTracer({ traceDir })
        await tracer.flush()

        const files = await traceFiles(traceDir)
        expect(files).toHaveLength(DEFAULT_MAX_TRACES)
        expect(files).not.toContain(`existing-000${TRACE_FILE_SUFFIX}`)
        expect(files).toContain(`existing-500${TRACE_FILE_SUFFIX}`)
    })
})
