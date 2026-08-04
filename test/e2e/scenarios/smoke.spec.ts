/**
 * Harness smoke test: boots a real instance from the medium template, logs in
 * through the UI dialog, and captures a screenshot plus a DOM survey. Used to
 * validate the fixture pipeline and to ground scenario selectors in the real
 * rendered shell.
 */
import { test } from '@playwright/test'
import { bootAndLogin } from '../helpers/app.js'
import { NetTrace, formatPhaseSummaries } from '../helpers/netTrace.js'
import { launchServer, prepareInstanceDir } from '../helpers/server.js'

test('boots a medium instance and logs in', async ({ page }, testInfo) => {
  const dir = await prepareInstanceDir('medium')
  const server = await launchServer(dir)
  try {
    const trace = NetTrace.start(page)
    await bootAndLogin(page, server.baseURL)
    await page.waitForTimeout(3000)

    await page.screenshot({ path: testInfo.outputPath('after-login.png'), fullPage: true })
    const survey = await page.evaluate(() => ({
      title: document.title,
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 40)
        .map(b => (b.textContent ?? '').trim() || b.getAttribute('aria-label') || b.className.slice(0, 60)),
      testids: Array.from(document.querySelectorAll('[data-testid]')).slice(0, 60)
        .map(el => el.getAttribute('data-testid')),
      sidebarText: (document.querySelector('aside, nav, [class*=side]') as HTMLElement | null)
        ?.innerText?.slice(0, 600) ?? null,
    }))
    await testInfo.attach('dom-survey', {
      body: JSON.stringify(survey, null, 2), contentType: 'application/json',
    })
    const report = await trace.attach(testInfo)
    console.log(formatPhaseSummaries(report))
  } finally {
    await server.stop()
  }
})
