// Client-side WebSocket bridge for the server tokenizer service.
//
// The browser tokeniser is fine for short text but gets slow once a chat has
// many messages. This module forwards tokenisation requests to the server over
// a persistent WebSocket so the cost is paid off-thread (and once per cache
// miss instead of once per page load when models would otherwise be downloaded
// to the browser).
//
// On any failure (connect error, timeout, send error, server error) the
// individual request rejects and the calling code falls back to the in-browser
// tokenizer. We also enter a short cooldown after a connection failure so we
// don't busy-loop reconnecting on every keystroke.

import { isNodeServer } from "./platform"
import { forageStorage } from "./globalApi.svelte"

export type RemoteTokenizeResult = {
    count: number
    tokens?: number[]
}

const REQUEST_TIMEOUT_MS = 5_000
const RECONNECT_COOLDOWN_MS = 30_000
const MAX_PENDING = 1024

type PendingEntry = {
    resolve: (value: RemoteTokenizeResult) => void
    reject: (reason: unknown) => void
    timer: ReturnType<typeof setTimeout>
}

let ws: WebSocket | null = null
let connectPromise: Promise<WebSocket> | null = null
let cooldownUntil = 0
let nextRequestId = 1
const pending = new Map<number, PendingEntry>()

let lastFailureLoggedAt = 0
function logFailureOnce(message: string, error?: unknown) {
    const now = Date.now()
    // Throttle to once per cooldown window so a long offline streak doesn't
    // flood the console.
    if (now - lastFailureLoggedAt < RECONNECT_COOLDOWN_MS) return
    lastFailureLoggedAt = now
    if (error !== undefined) {
        console.warn(`[Tokenizer WS] ${message}; falling back to local tokenizer.`, error)
    } else {
        console.warn(`[Tokenizer WS] ${message}; falling back to local tokenizer.`)
    }
}

function failAllPending(reason: unknown) {
    for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(reason)
    }
    pending.clear()
}

function isRemoteTokenizerAvailable(): boolean {
    // Currently only the bundled Node server exposes /ws/tokenize.
    return isNodeServer && typeof WebSocket !== 'undefined' && typeof location !== 'undefined'
}

async function connect(): Promise<WebSocket> {
    if (ws && ws.readyState === WebSocket.OPEN) return ws
    if (connectPromise) return connectPromise

    connectPromise = (async () => {
        const auth = await forageStorage.createAuth()
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = `${wsProtocol}//${location.host}/ws/tokenize?risu-auth=${encodeURIComponent(auth)}`
        const socket = new WebSocket(url)

        return await new Promise<WebSocket>((resolve, reject) => {
            const onOpen = () => {
                socket.removeEventListener('open', onOpen)
                socket.removeEventListener('error', onError)
                socket.removeEventListener('close', onCloseDuringConnect)
                lastFailureLoggedAt = 0 // allow next failure to log
                socket.addEventListener('message', handleMessage)
                socket.addEventListener('close', handleClose)
                socket.addEventListener('error', handleError)
                ws = socket
                resolve(socket)
            }
            const onError = (event: Event) => {
                socket.removeEventListener('open', onOpen)
                socket.removeEventListener('error', onError)
                socket.removeEventListener('close', onCloseDuringConnect)
                reject(event)
            }
            const onCloseDuringConnect = () => {
                socket.removeEventListener('open', onOpen)
                socket.removeEventListener('error', onError)
                socket.removeEventListener('close', onCloseDuringConnect)
                reject(new Error('WebSocket closed before opening'))
            }
            socket.addEventListener('open', onOpen)
            socket.addEventListener('error', onError)
            socket.addEventListener('close', onCloseDuringConnect)
        })
    })().catch((err) => {
        cooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS
        logFailureOnce('Failed to connect to tokenizer service', err)
        throw err
    }).finally(() => {
        connectPromise = null
    })

    return connectPromise
}

function handleMessage(event: MessageEvent) {
    let data: any
    try {
        data = JSON.parse(typeof event.data === 'string' ? event.data : '')
    } catch {
        return
    }
    if (!data || typeof data.id !== 'number') return
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    clearTimeout(entry.timer)
    if (data.error) {
        entry.reject(new Error(String(data.error)))
        return
    }
    if (typeof data.count !== 'number') {
        entry.reject(new Error('Malformed response'))
        return
    }
    entry.resolve({ count: data.count, tokens: data.tokens })
}

function handleClose() {
    const closedSocket = ws
    ws = null
    failAllPending(new Error('Tokenizer WebSocket closed'))
    if (closedSocket) {
        // Don't immediately reconnect — let cooldown logic drive retries on
        // the next request.
        cooldownUntil = Math.max(cooldownUntil, Date.now() + 1_000)
    }
}

function handleError(event: Event) {
    logFailureOnce('Tokenizer WebSocket error', event)
}

export async function tokenizeViaServer(
    text: string,
    tokenizerKey: string,
    options: { includeTokens?: boolean } = {}
): Promise<RemoteTokenizeResult> {
    if (!isRemoteTokenizerAvailable()) {
        throw new Error('Remote tokenizer not available')
    }
    if (cooldownUntil > Date.now()) {
        throw new Error('Tokenizer service in cooldown')
    }
    if (pending.size >= MAX_PENDING) {
        throw new Error('Too many pending tokenizer requests')
    }

    const socket = await connect()

    return await new Promise<RemoteTokenizeResult>((resolve, reject) => {
        const id = nextRequestId++
        const timer = setTimeout(() => {
            if (pending.delete(id)) {
                reject(new Error('Tokenizer request timed out'))
            }
        }, REQUEST_TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer })
        try {
            socket.send(JSON.stringify({
                id,
                text,
                tokenizer: tokenizerKey,
                includeTokens: !!options.includeTokens,
            }))
        } catch (err) {
            pending.delete(id)
            clearTimeout(timer)
            reject(err)
        }
    })
}

export async function tokenizeCountViaServer(
    text: string,
    tokenizerKey: string
): Promise<number | null> {
    try {
        const result = await tokenizeViaServer(text, tokenizerKey)
        return result.count
    } catch {
        return null
    }
}
