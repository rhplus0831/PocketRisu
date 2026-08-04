/**
 * Boot scenarios — the audit's request/byte baselines for application
 * startup, now guarded by the budget ceilings in helpers/budgets.ts.
 */
import { test, expect } from '@playwright/test'
import { bootAndLogin, loginAfterReload } from '../helpers/app.js'
import { assertPhaseBudget } from '../helpers/budgets.js'
import { NetTrace, formatPhaseSummaries } from '../helpers/netTrace.js'
import { launchServer, prepareInstanceDir } from '../helpers/server.js'

test('two fresh-context cold boots – is the boot patch one-time?', async ({ browser }, testInfo) => {
  const server = await launchServer(await prepareInstanceDir('medium'))
  try {
    const reports: Record<string, number> = {}
    for (const label of ['first-cold-boot', 'second-cold-boot']) {
      const context = await browser.newContext()
      const page = await context.newPage()
      const trace = NetTrace.start(page)
      trace.phase(label)
      await bootAndLogin(page, server.baseURL, { resourceCache: 'decline' })
      await page.waitForTimeout(4000)
      const report = await trace.attach(testInfo, `net-trace-${label}`)
      console.log(formatPhaseSummaries(report))
      const patch = report.phases[label].byPath['/api/patch']
      reports[label] = patch ? patch.reqBytes : 0
      await context.close()
    }
    console.log(`boot patch bytes: first=${reports['first-cold-boot']} second=${reports['second-cold-boot']}`)
    // PF-04 invariant: normalization must stay one-time per instance.
    expect(reports['second-cold-boot']).toBe(0)
  } finally {
    await server.stop()
  }
})

test('cold boot – first run on an empty instance', async ({ page }, testInfo) => {
  const server = await launchServer(await prepareInstanceDir())
  try {
    const trace = NetTrace.start(page)
    trace.phase('first-run-boot')
    await bootAndLogin(page, server.baseURL)
    await page.waitForTimeout(2000)
    const report = await trace.attach(testInfo)
    console.log(formatPhaseSummaries(report))
    expect(report.phases['first-run-boot'].apiRequests).toBeGreaterThan(0)
    assertPhaseBudget(report, 'first-run-boot')
  } finally {
    await server.stop()
  }
})

test('cold boot – medium instance, resource cache declined', async ({ page }, testInfo) => {
  const server = await launchServer(await prepareInstanceDir('medium'))
  try {
    const trace = NetTrace.start(page)
    trace.phase('cold-boot')
    await bootAndLogin(page, server.baseURL, { resourceCache: 'decline' })
    await page.waitForTimeout(2000)
    const report = await trace.attach(testInfo)
    console.log(formatPhaseSummaries(report))
    expect(report.phases['cold-boot'].apiRequests).toBeGreaterThan(0)
    assertPhaseBudget(report, 'cold-boot')
  } finally {
    await server.stop()
  }
})

test('cold boot – xl instance (300 characters), boot scaling', async ({ page }, testInfo) => {
  const server = await launchServer(await prepareInstanceDir('xl'))
  try {
    const trace = NetTrace.start(page)
    trace.phase('xl-cold-boot')
    await bootAndLogin(page, server.baseURL, { resourceCache: 'decline' })
    await page.waitForTimeout(2000)
    const report = await trace.attach(testInfo)
    console.log(formatPhaseSummaries(report))
    expect(report.phases['xl-cold-boot'].apiRequests).toBeGreaterThan(0)
    assertPhaseBudget(report, 'xl-cold-boot')
  } finally {
    await server.stop()
  }
})

test('warm boot – resource cache enabled, second boot from cache', async ({ page }, testInfo) => {
  const server = await launchServer(await prepareInstanceDir('medium'))
  try {
    const trace = NetTrace.start(page)
    trace.phase('cold-boot-cache-on')
    await bootAndLogin(page, server.baseURL, { resourceCache: 'enable' })
    await page.waitForTimeout(3000)

    trace.phase('warm-boot')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await loginAfterReload(page)
    await page.waitForTimeout(2000)

    const report = await trace.attach(testInfo)
    console.log(formatPhaseSummaries(report))
    const cold = report.phases['cold-boot-cache-on']
    const warm = report.phases['warm-boot']
    expect(warm.apiRequests).toBeGreaterThan(0)
    assertPhaseBudget(report, 'cold-boot-cache-on')
    assertPhaseBudget(report, 'warm-boot')
    // The verified cache should shrink boot bytes; record the ratio either way.
    console.log(`warm/cold api rx ratio: ${(warm.apiResBytes / cold.apiResBytes).toFixed(3)}`)
  } finally {
    await server.stop()
  }
})
