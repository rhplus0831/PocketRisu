/**
 * Chat scenarios — hydration cost of opening a large chat, and the save-loop
 * traffic caused by a user-shaped mutation. No model provider is configured:
 * sending fails upstream by design, which still exercises input handling and
 * the chat save loop (user message persists locally). A mock OpenAI-style
 * provider scenario is planned as a follow-up.
 */
import { test, expect } from '@playwright/test'
import { bootAndLogin, chatInput, sidebarCharacter } from '../helpers/app.js'
import { NetTrace, formatPhaseSummaries } from '../helpers/netTrace.js'
import { launchServer, prepareInstanceDir } from '../helpers/server.js'

test('open a large chat (hydration)', async ({ page }, testInfo) => {
  const server = await launchServer(await prepareInstanceDir('large-chat'))
  try {
    const trace = NetTrace.start(page)
    trace.phase('boot')
    await bootAndLogin(page, server.baseURL, { resourceCache: 'decline' })

    trace.phase('open-chat')
    await sidebarCharacter(page, 0).click()
    // Fixture message bodies contain this filler; visible text proves hydration.
    await expect(page.getByText('E2EMSG').first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2000)

    const report = await trace.attach(testInfo)
    console.log(formatPhaseSummaries(report))
    const open = report.phases['open-chat']
    expect(open.apiRequests).toBeGreaterThan(0)
  } finally {
    await server.stop()
  }
})

test('type a message and let the save loop persist it', async ({ page }, testInfo) => {
  const server = await launchServer(await prepareInstanceDir('large-chat'))
  try {
    const trace = NetTrace.start(page)
    trace.phase('boot')
    await bootAndLogin(page, server.baseURL, { resourceCache: 'decline' })

    trace.phase('open-chat')
    await sidebarCharacter(page, 0).click()
    await expect(page.getByText('E2EMSG').first()).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(2000)

    trace.phase('send-and-save')
    const input = chatInput(page)
    await input.fill('E2E probe message: measuring the save loop.')
    await input.press('Enter')
    // Provider-less send fails upstream; the user message still enters the
    // chat and the save loop persists it. Give the debounced save room.
    await page.waitForTimeout(8000)
    // Dismiss any provider-error alert so teardown is clean.
    const confirm = page.getByRole('button', { name: 'Confirm' })
    if (await confirm.isVisible().catch(() => false)) await confirm.click()

    const report = await trace.attach(testInfo)
    console.log(formatPhaseSummaries(report))
    const send = report.phases['send-and-save']
    expect(send.apiRequests).toBeGreaterThan(0)
  } finally {
    await server.stop()
  }
})
