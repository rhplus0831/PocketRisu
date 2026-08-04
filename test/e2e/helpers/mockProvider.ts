/**
 * Minimal OpenAI-compatible mock provider for generation scenarios. Accepts
 * POST on any path; `stream: true` bodies get an SSE `chat.completion.chunk`
 * sequence, others a single JSON completion. Fixed port (`MOCK_PROVIDER_PORT`)
 * so fixture templates can embed the URL; only provider scenarios bind it,
 * and Playwright runs one spec file per worker, so the port never races.
 */
import { createServer, type Server } from 'node:http'
import { MOCK_PROVIDER_PORT } from './seedData.js'

export interface MockProviderOptions {
  /** Number of SSE chunks per streamed completion. */
  chunkCount?: number
  /** Text of each chunk; final content is the concatenation. */
  chunkText?: string
  /** Delay between chunks in ms (controls generation duration). */
  chunkDelayMs?: number
}

export interface MockProvider {
  port: number
  /** Bodies of every completion request received, in order. */
  requests: unknown[]
  close: () => Promise<void>
}

export async function startMockProvider(opts: MockProviderOptions = {}): Promise<MockProvider> {
  const chunkCount = opts.chunkCount ?? 24
  const chunkText = opts.chunkText ?? 'MOCKGEN token. '
  const chunkDelayMs = opts.chunkDelayMs ?? 120
  const requests: unknown[] = []

  const server: Server = createServer((req, res) => {
    // The browser may call the provider cross-origin (direct classic path).
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', '*')
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    const bodyChunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(bodyChunks).toString('utf-8'))
      } catch { /* keep {} */ }
      requests.push(body)

      const usage = { prompt_tokens: 128, completion_tokens: chunkCount, total_tokens: 128 + chunkCount }
      if (body.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        let sent = 0
        const timer = setInterval(() => {
          if (sent < chunkCount) {
            const chunk = {
              id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 0,
              model: 'e2e-mock-model',
              choices: [{ index: 0, delta: sent === 0
                ? { role: 'assistant', content: chunkText }
                : { content: chunkText }, finish_reason: null }],
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            sent += 1
            return
          }
          clearInterval(timer)
          const finalChunk = {
            id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 0,
            model: 'e2e-mock-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage,
          }
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }, chunkDelayMs)
        res.on('close', () => clearInterval(timer))
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-e2e', object: 'chat.completion', created: 0,
          model: 'e2e-mock-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: chunkText.repeat(chunkCount) },
            finish_reason: 'stop',
          }],
          usage,
        }))
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(MOCK_PROVIDER_PORT, '127.0.0.1', () => resolve())
  })

  return {
    port: MOCK_PROVIDER_PORT,
    requests,
    close: () => new Promise((resolve) => { server.close(() => resolve()) }),
  }
}
