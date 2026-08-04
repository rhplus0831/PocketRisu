/**
 * Phase 3 verification scenarios for the performance audit. These capture
 * request *contents* (not just sizes) to prove or refute specific candidate
 * findings. After remediation they become the regression proofs (e.g. PF-01:
 * the second save of an exchange must use the delta content type).
 */
import { test, expect } from '@playwright/test'
import { bootAndLogin, chatInput, loginAfterReload, sidebarCharacter } from '../helpers/app.js'
import { startMockProvider } from '../helpers/mockProvider.js'
import { NetTrace } from '../helpers/netTrace.js'
import { launchServer, prepareInstanceDir } from '../helpers/server.js'

/** Find `key` in legacy-encoded MessagePack bytes and read the bool after it. */
function readMsgpackBoolAfterKey(body: Buffer, key: string): 'true' | 'false' | 'absent' | 'other' {
  const idx = body.indexOf(Buffer.from(key, 'utf-8'))
  if (idx < 0) return 'absent'
  const value = body[idx + key.length]
  if (value === 0xc3) return 'true'
  if (value === 0xc2) return 'false'
  return 'other'
}

test('PF-01: chat-row saves around a generation carry runtime streaming flags', async ({ page }, testInfo) => {
  const provider = await startMockProvider({ chunkCount: 24, chunkDelayMs: 250 })
  const server = await launchServer(await prepareInstanceDir('provider'))
  const rowPosts: Array<{ contentType: string; bytes: number; isStreaming: string }> = []
  try {
    await page.route('**/api/chat-content/**', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataBuffer()
        if (body) {
          rowPosts.push({
            contentType: route.request().headers()['content-type'] ?? '',
            bytes: body.byteLength,
            isStreaming: readMsgpackBoolAfterKey(body, 'isStreaming'),
          })
        }
      }
      await route.fallback()
    })

    await bootAndLogin(page, server.baseURL, { resourceCache: 'decline', keepProxyRoutes: true })
    await sidebarCharacter(page, 0).click()
    await expect(page.getByText('E2EMSG').first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2000)

    await chatInput(page).fill('PF-01 verification probe.')
    await chatInput(page).press('Enter')
    await expect(page.getByText('MOCKGEN').first()).toBeVisible({ timeout: 45_000 })
    await page.waitForTimeout(10_000)

    await testInfo.attach('pf01-row-posts', {
      body: JSON.stringify(rowPosts, null, 2), contentType: 'application/json',
    })
    console.log('PF-01 row POSTs:', JSON.stringify(rowPosts))

    expect(rowPosts.length).toBeGreaterThan(0)
    // Current behavior (finding CONFIRMED): every save is a full row carrying
    // the isStreaming key; no delta content type appears. When PF-01 is
    // fixed, flip these assertions: post-generation saves should be
    // application/vnd.pocketrisu.chat-delta+json.
    for (const post of rowPosts) {
      expect(post.contentType).not.toContain('chat-delta')
      expect(post.isStreaming).not.toBe('absent')
    }
  } finally {
    await server.stop()
    await provider.close()
  }
})

for (const template of ['medium', 'xxl-desc'] as const) {
test(`PF-05: cached boot crossover (${template})`, async ({ browser }, testInfo) => {
  const server = await launchServer(await prepareInstanceDir(template))
  try {
    const sizes: Record<string, number> = {}

    // Reference: cache-declined cold boot → raw read size. Second context:
    // cache-enabled cold boot (seeds cache) + warm reload → cached read size.
    const rawContext = await browser.newContext()
    const rawPage = await rawContext.newPage()
    const rawTrace = NetTrace.start(rawPage)
    rawTrace.phase('raw-boot')
    await bootAndLogin(rawPage, server.baseURL, { resourceCache: 'decline' })
    await rawPage.waitForTimeout(4000)
    const rawReport = await rawTrace.attach(testInfo, 'net-trace-raw')
    sizes['raw-read-rx'] = rawReport.phases['raw-boot']
      .byPath['/api/db/read-raw-for-boot']?.resBytes ?? -1
    await rawContext.close()

    const cacheContext = await browser.newContext()
    const cachePage = await cacheContext.newPage()
    const cacheTrace = NetTrace.start(cachePage)
    cacheTrace.phase('seed-boot')
    await bootAndLogin(cachePage, server.baseURL, { resourceCache: 'enable' })
    await cachePage.waitForTimeout(5000)
    cacheTrace.phase('warm-boot')
    await cachePage.reload({ waitUntil: 'domcontentloaded' })
    await loginAfterReload(cachePage)
    await cachePage.waitForTimeout(4000)
    cacheTrace.phase('warm-boot-2')
    await cachePage.reload({ waitUntil: 'domcontentloaded' })
    await loginAfterReload(cachePage)
    await cachePage.waitForTimeout(4000)
    const cacheReport = await cacheTrace.attach(testInfo, 'net-trace-cached')
    for (const phase of ['warm-boot', 'warm-boot-2']) {
      const warm = cacheReport.phases[phase].byPath['/api/db/read-cached']
      sizes[`${phase}-rx`] = warm?.resBytes ?? -1
      sizes[`${phase}-tx`] = warm?.reqBytes ?? -1
    }
    await cacheContext.close()

    console.log(`PF-05 crossover (${template}):`, JSON.stringify(sizes))
    await testInfo.attach('pf05-sizes', {
      body: JSON.stringify(sizes, null, 2), contentType: 'application/json',
    })
    expect(sizes['raw-read-rx']).toBeGreaterThan(0)
    expect(sizes['warm-boot-rx']).toBeGreaterThan(0)
    // Steady-state cache effectiveness invariants (PF-05): once warm, the
    // cached read must stay cheap in absolute terms (small DB) and must beat
    // the raw read by a wide margin (large DB).
    const steadyTotal = sizes['warm-boot-2-rx'] + sizes['warm-boot-2-tx']
    if (template === 'medium') {
      expect(steadyTotal).toBeLessThanOrEqual(6_000)
    } else {
      expect(steadyTotal).toBeLessThanOrEqual(64_000)
      expect(sizes['warm-boot-2-rx']).toBeLessThanOrEqual(sizes['raw-read-rx'] / 10)
    }
  } finally {
    await server.stop()
  }
})
}

test('PF-03/PF-04: decompose the first-boot normalization patches', async ({ page }, testInfo) => {
  const server = await launchServer(await prepareInstanceDir('xl'))
  const patches: Array<{ ops: number; bytes: number; topPaths: Record<string, number> }> = []
  try {
    await page.route('**/api/patch', async (route) => {
      if (route.request().method() === 'POST') {
        const raw = route.request().postData()
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
            const ops: Array<{ op: string; path: string }> = parsed.patch ?? parsed.operations ?? []
            const topPaths: Record<string, number> = {}
            for (const op of ops) {
              const top = '/' + (String(op.path ?? '').split('/')[1] ?? '')
              topPaths[top] = (topPaths[top] ?? 0) + 1
            }
            patches.push({ ops: ops.length, bytes: raw.length, topPaths })
          } catch {
            patches.push({ ops: -1, bytes: raw.length, topPaths: {} })
          }
        }
      }
      await route.fallback()
    })

    await bootAndLogin(page, server.baseURL, { resourceCache: 'decline' })
    await page.waitForTimeout(6000)

    await testInfo.attach('boot-patches', {
      body: JSON.stringify(patches, null, 2), contentType: 'application/json',
    })
    console.log('boot patches:', JSON.stringify(patches.map(p => ({
      ops: p.ops, bytes: p.bytes,
      top: Object.entries(p.topPaths).sort((a, b) => b[1] - a[1]).slice(0, 5),
    }))))
    expect(patches.length).toBeGreaterThan(0)
  } finally {
    await server.stop()
  }
})
