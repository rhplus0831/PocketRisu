/**
 * Generation scenarios against the mock OpenAI-compatible provider. The
 * `provider` template's classic model config targets the fixed mock port, so
 * a real send streams SSE chunks end to end: prompt assembly, transport,
 * cumulative snapshots, output transforms, and the post-generation save loop.
 */
import { test, expect } from '@playwright/test'
import { bootAndLogin, chatInput, sidebarCharacter } from '../helpers/app.js'
import { startMockProvider } from '../helpers/mockProvider.js'
import { NetTrace, formatPhaseSummaries } from '../helpers/netTrace.js'
import { launchServer, prepareInstanceDir } from '../helpers/server.js'

test('send a message with a streaming mock provider', async ({ page }, testInfo) => {
  const provider = await startMockProvider({ chunkCount: 24, chunkDelayMs: 120 })
  const server = await launchServer(await prepareInstanceDir('provider'))
  try {
    const trace = NetTrace.start(page)
    trace.phase('boot')
    await bootAndLogin(page, server.baseURL, { resourceCache: 'decline', keepProxyRoutes: true })

    trace.phase('open-chat')
    await sidebarCharacter(page, 0).click()
    await expect(page.getByText('E2EMSG').first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2000)

    trace.phase('send-generate-save')
    const input = chatInput(page)
    await input.fill('E2E generation probe.')
    await input.press('Enter')
    // The streamed reply must render (24 chunks × 120 ms ≈ 3 s generation).
    await expect(page.getByText('MOCKGEN').first()).toBeVisible({ timeout: 45_000 })
    // Let the post-generation save loop and snapshot scheduling settle.
    await page.waitForTimeout(10_000)

    const report = await trace.attach(testInfo)
    console.log(formatPhaseSummaries(report))
    expect(provider.requests.length).toBeGreaterThan(0)
    const phase = report.phases['send-generate-save']
    expect(phase.apiRequests).toBeGreaterThan(0)
  } finally {
    await server.stop()
    await provider.close()
  }
})
