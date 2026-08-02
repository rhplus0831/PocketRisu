import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'

const { readClientBuildStamp } = require('./buildStamp.cjs')
const tempRoots: string[] = []

afterAll(async () => {
  await Promise.allSettled(tempRoots.map(root => rm(root, { recursive: true, force: true })))
})

async function createTempRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'risu-build-stamp-'))
  tempRoots.push(rootDir)
  return rootDir
}

describe('client build stamp discovery', () => {
  test('reads the stamp and package version from the served dist directory', async () => {
    const rootDir = await createTempRoot()
    await mkdir(path.join(rootDir, 'dist'))
    await writeFile(path.join(rootDir, 'dist', 'build-stamp.json'), JSON.stringify({
      version: '1.9.0',
      stamp: `1.9.0-${'a'.repeat(64)}`,
      hash: 'a'.repeat(64),
    }))

    expect(readClientBuildStamp({ rootDir, log: { warn: vi.fn() } })).toEqual({
      version: '1.9.0',
      stamp: `1.9.0-${'a'.repeat(64)}`,
    })
  })

  test.each([
    ['missing', null],
    ['malformed', '{'],
    ['invalid', JSON.stringify({ version: '1.9.0', stamp: 'bad stamp' })],
  ])('fails open and logs once for a %s stamp file', async (_case, contents) => {
    const rootDir = await createTempRoot()
    await mkdir(path.join(rootDir, 'dist'))
    if (contents !== null) {
      await writeFile(path.join(rootDir, 'dist', 'build-stamp.json'), contents)
    }
    const warn = vi.fn()

    expect(readClientBuildStamp({ rootDir, log: { warn } })).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('Client build admission disabled')
  })
})
