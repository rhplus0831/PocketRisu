/**
 * Browser-side boot/login helpers. The only gate between a fresh page and the
 * app is the password dialog (`#alert-input` inside the input ShDialog);
 * PocketRisu has no ToS/welcome flow. Localhost is a secure context, so the
 * WebCrypto boot gate never fires here.
 */
import { expect, type Page } from '@playwright/test'
import { E2E_PASSWORD } from './server.js'

export interface BootOptions {
  /**
   * Answer to the first-boot verified-resource-cache popup. 'decline' keeps
   * the cache-off baseline; 'enable' turns on the IndexedDB cache for
   * warm-boot scenarios. Every fresh browser context sees this popup once.
   */
  resourceCache?: 'enable' | 'decline'
  /**
   * Keep /proxy2 unfenced. Provider scenarios need it: local model targets
   * are relayed through the instance's proxy/WS-job paths.
   */
  keepProxyRoutes?: boolean
}

/**
 * Navigate to the instance, complete the password dialog, answer the
 * resource-cache opt-in popup, and wait until the app has finished booting.
 * The login prompt and the first-run set-password prompt share the same
 * input dialog and both accept Enter.
 */
export async function bootAndLogin(page: Page, baseURL: string, opts: BootOptions = {}): Promise<void> {
  // Fence off external traffic (Realm hub, update checks, fonts): scenario
  // measurements must cover only the PocketRisu instance, and CI-like runs
  // must not depend on outside networks. Realm/hub content also arrives via
  // the instance's /proxy2 relay, so that path is fenced too.
  await page.route(
    (url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
    (route) => route.abort(),
  )
  if (!opts.keepProxyRoutes) {
    await page.route('**/proxy2**', (route) => route.abort())
  }
  await page.route('**/hub-proxy/**', (route) => route.abort())
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
  const input = page.locator('#alert-input')
  await input.waitFor({ state: 'visible', timeout: 30_000 })
  await input.fill(E2E_PASSWORD)
  await input.press('Enter')

  const cacheChoice = opts.resourceCache === 'enable' ? 'Enable cache' : 'Not now'
  const cacheButton = page.getByRole('button', { name: cacheChoice })
  try {
    await cacheButton.waitFor({ state: 'visible', timeout: 15_000 })
    await cacheButton.click()
  } catch {
    // Popup already answered in this context (e.g. reload) — fine.
  }

  // Defensive: a version/changelog modal can still appear on synthetic DBs;
  // it has a "Later" action and must never block scenarios.
  const laterButton = page.getByRole('button', { name: 'Later' })
  try {
    await laterButton.waitFor({ state: 'visible', timeout: 2_000 })
    await laterButton.click()
  } catch { /* not shown */ }
  await waitForAppReady(page)
}

/**
 * Continue after a same-context reload (warm-boot scenarios). The seven-day
 * session cookie usually renews the JWT through /api/test_auth, so no dialog
 * appears; fill the password only if the prompt does show.
 */
export async function loginAfterReload(page: Page): Promise<void> {
  const input = page.locator('#alert-input')
  try {
    await input.waitFor({ state: 'visible', timeout: 5_000 })
    await input.fill(E2E_PASSWORD)
    await input.press('Enter')
  } catch { /* cookie-renewed session: no prompt */ }
  await waitForAppReady(page)
}

/**
 * The app is "ready" when the boot dialog chain is gone and the sidebar shell
 * has rendered (loadData() finished). Deliberately not network-idle-based:
 * background polling must not fail readiness — if an instance never goes
 * quiet, that is a scenario *measurement*, not a harness error.
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.locator('#alert-input')).toBeHidden({ timeout: 60_000 })
  await expect(page.locator('.character-list')).toBeVisible({ timeout: 60_000 })
}

/** Sidebar entry for a fixture character (`e2e-char-<n>` in the templates). */
export function sidebarCharacter(page: Page, index: number) {
  return page.locator(`.character-list [data-char-id="e2e-char-${index}"]`)
}

/** The chat composer textarea. */
export function chatInput(page: Page) {
  return page.locator('textarea.text-input-area')
}
