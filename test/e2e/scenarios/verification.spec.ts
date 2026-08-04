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

test('PF-01: post-generation chat-row saves use projected deltas', async ({ page }, testInfo) => {
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

    // Imported E2E messages intentionally omit durable chatId values. Their
    // first save is therefore a legitimate full-row self-heal; establish its
    // acknowledged projected base before measuring the steady-state send.
    await chatInput(page).fill('PF-01 transition warm-up.')
    await chatInput(page).press('Enter')
    await expect(page.getByText('MOCKGEN').first()).toBeVisible({ timeout: 45_000 })
    await page.waitForTimeout(10_000)
    rowPosts.length = 0

    const generatedMessageCount = await page.getByText('MOCKGEN').count()
    await chatInput(page).fill('PF-01 verification probe.')
    await chatInput(page).press('Enter')
    await expect.poll(
      () => page.getByText('MOCKGEN').count(),
      { timeout: 45_000 },
    ).toBeGreaterThan(generatedMessageCount)
    await page.waitForTimeout(10_000)

    await testInfo.attach('pf01-row-posts', {
      body: JSON.stringify(rowPosts, null, 2), contentType: 'application/json',
    })
    console.log('PF-01 row POSTs:', JSON.stringify(rowPosts))

    expect(rowPosts.length).toBeGreaterThan(0)
    // PF-01 regression proof: post-generation saves use the chat-delta
    // content type, the encoded request bodies omit the runtime-only key,
    // and each delta stays within the runway's per-save ceiling (observed
    // 374-960 B; a bloated delta is a regression even with the right type).
    for (const post of rowPosts) {
      expect(post.contentType).toContain('chat-delta')
      expect(post.isStreaming).toBe('absent')
      expect(post.bytes).toBeLessThanOrEqual(64_000)
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
    const expectedWarmPath = template === 'medium'
      ? '/api/db/read-raw-for-boot'
      : '/api/db/read-cached'
    for (const phase of ['warm-boot', 'warm-boot-2']) {
      const byPath = cacheReport.phases[phase].byPath
      const warm = byPath[expectedWarmPath]
      sizes[`${phase}-rx`] = warm?.resBytes ?? -1
      sizes[`${phase}-tx`] = warm?.reqBytes ?? -1
      sizes[`${phase}-raw-count`] = byPath['/api/db/read-raw-for-boot']?.count ?? 0
      sizes[`${phase}-cached-count`] = byPath['/api/db/read-cached']?.count ?? 0
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
      for (const phase of ['warm-boot', 'warm-boot-2']) {
        expect(sizes[`${phase}-cached-count`]).toBe(0)
        expect(sizes[`${phase}-raw-count`]).toBe(1)
      }
      // Server ingest already persisted character normalization in the
      // template; measured raw-route steady state is 7,389 B including headers.
      expect(steadyTotal).toBeLessThanOrEqual(8_500)
    } else {
      for (const phase of ['warm-boot', 'warm-boot-2']) {
        expect(sizes[`${phase}-cached-count`]).toBe(1)
        expect(sizes[`${phase}-raw-count`]).toBe(0)
      }
      expect(steadyTotal).toBeLessThanOrEqual(64_000)
      expect(sizes['warm-boot-2-rx']).toBeLessThanOrEqual(sizes['raw-read-rx'] / 10)
    }
  } finally {
    await server.stop()
  }
})
}

test('PF-03/PF-04: imported xl boot has no character-default patch', async ({ page }, testInfo) => {
  const server = await launchServer(await prepareInstanceDir('xl'))
  const patches: Array<{ ops: number; bytes: number; topPaths: Record<string, number> }> = []
  try {
    await page.route('**/api/patch', async (route) => {
      if (route.request().method() === 'POST') {
        const raw = route.request().postData()
        const rawBytes = route.request().postDataBuffer()?.byteLength ?? 0
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
            const ops: Array<{ op: string; path: string }> = parsed.patch ?? parsed.operations ?? []
            const topPaths: Record<string, number> = {}
            for (const op of ops) {
              const top = '/' + (String(op.path ?? '').split('/')[1] ?? '')
              topPaths[top] = (topPaths[top] ?? 0) + 1
            }
            patches.push({ ops: ops.length, bytes: rawBytes, topPaths })
          } catch {
            patches.push({ ops: -1, bytes: rawBytes, topPaths: {} })
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
    // PF-04 measured 269 ops / 26,384 B, down from 3,870 / 292,736 B.
    expect(patches.reduce((sum, patch) => sum + patch.ops, 0)).toBeLessThanOrEqual(320)
    expect(patches.reduce((sum, patch) => sum + patch.bytes, 0)).toBeLessThanOrEqual(32_000)
    expect(patches.reduce((sum, patch) => sum + (patch.topPaths['/characters'] ?? 0), 0))
      .toBe(0)
  } finally {
    await server.stop()
  }
})
