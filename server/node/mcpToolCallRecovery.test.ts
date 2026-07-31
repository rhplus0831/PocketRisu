import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const {
  collectMcpToolCallIds,
  mcpToolCallStorageKey,
  parseMcpToolCallSnapshotKey,
  parseMcpToolCallStorageKey,
  scanMcpToolCallIdsFromFile,
} = require('./mcpToolCallRecovery.cjs') as {
  collectMcpToolCallIds: (value: unknown) => Set<string>
  mcpToolCallStorageKey: (callId: string) => string | null
  parseMcpToolCallSnapshotKey: (suffix: string) => { callId: string } | null
  parseMcpToolCallStorageKey: (key: string) => { callId: string; suffix: string } | null
  scanMcpToolCallIdsFromFile: (filePath: string) => Promise<Set<string>>
}

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('MCP tool-call recovery helpers', () => {
  test('physical keys round-trip only canonical UTF-8 base64url ids', () => {
    const callId = '도구-call/1'
    const storageKey = mcpToolCallStorageKey(callId)!
    const parsed = parseMcpToolCallStorageKey(storageKey)!

    expect(parsed.callId).toBe(callId)
    expect(parseMcpToolCallSnapshotKey(parsed.suffix)?.callId).toBe(callId)
    expect(parseMcpToolCallStorageKey('cache/mcp-tool-calls/not+base64.json')).toBeNull()
    expect(parseMcpToolCallStorageKey('cache/mcp-tool-calls/../escape.json')).toBeNull()
    expect(parseMcpToolCallStorageKey('cache/other/Zm9v.json')).toBeNull()
  })

  test('collects complete markers recursively and ignores malformed text', () => {
    const ids = collectMcpToolCallIds({
      message: [{ data: '<tool_call>call-a\uf100lookup</tool_call>' }],
      swipes: ['before <tool_call>call-b\uf100search</tool_call> after'],
      malformed: '<tool_call>missing-close\uf100lookup',
    })
    expect([...ids].sort()).toEqual(['call-a', 'call-b'])
  })

  test('streaming scan retains markers split across file pages', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mcp-recovery-test-'))
    tempDirectories.push(directory)
    const filePath = path.join(directory, 'database.risudat')
    const marker = '<tool_call>call-cross-page\uf100lookup</tool_call>'
    await writeFile(filePath, Buffer.concat([
      Buffer.alloc(64 * 1024 - 5, 0x61),
      Buffer.from(marker, 'utf8'),
      Buffer.from('<tool_call>incomplete\uf100lookup', 'utf8'),
    ]))

    expect([...await scanMcpToolCallIdsFromFile(filePath)]).toEqual(['call-cross-page'])
  })
})
