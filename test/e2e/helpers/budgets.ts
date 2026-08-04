/**
 * Per-phase network budgets — the audit's regression net.
 *
 * Values are ceilings with ~30-40% headroom over the 2026-08-04 baselines
 * (docs/findings/perf-audit/03-trace-baselines.md, commit 12e90fa9), so they
 * catch structural regressions (a new N+1 loop, a lost cache, an extra full
 * write) without flaking on run-to-run noise. When a remediation track lands
 * (PF-01/02 send deltas, PF-03/04 boot normalization, PF-05 size-aware cache),
 * tighten the corresponding ceiling to lock in the win.
 *
 * Only stable metrics are budgeted: API request counts and request (upload)
 * bytes. Response bytes are gzip-dependent and asserted only where a specific
 * finding demands it (inline in the scenario).
 */
import { expect } from '@playwright/test'
import type { NetReport } from './netTrace.js'

export interface PhaseBudget {
  maxApiRequests: number
  maxApiTxBytes: number
}

export const PHASE_BUDGETS: Record<string, PhaseBudget> = {
  // Baseline 34 req / 225 KB — seven defaults-fill patch/read cycles (PF-03).
  'first-run-boot': { maxApiRequests: 45, maxApiTxBytes: 320_000 },
  // Baseline 15 req / 40 KB — includes the one-time normalization patch (PF-04).
  'cold-boot': { maxApiRequests: 22, maxApiTxBytes: 64_000 },
  'cold-boot-cache-on': { maxApiRequests: 24, maxApiTxBytes: 64_000 },
  // Baseline 15 req / 302 KB — normalization patch scales with characters (PF-04).
  'xl-cold-boot': { maxApiRequests: 22, maxApiTxBytes: 420_000 },
  // T3 measured 13 req / 8.5 KB after the small-DB raw bypass.
  'warm-boot': { maxApiRequests: 18, maxApiTxBytes: 12_000 },
  // Baseline 3 req / 3.8 KB — hydration of one chat row.
  'open-chat': { maxApiRequests: 8, maxApiTxBytes: 16_000 },
  // Baseline up to ~872 KB: full-row checkpoint + final saves (PF-01/PF-02).
  'send-and-save': { maxApiRequests: 18, maxApiTxBytes: 1_100_000 },
  'send-generate-save': { maxApiRequests: 16, maxApiTxBytes: 1_100_000 },
}

export function assertPhaseBudget(report: NetReport, phase: string): void {
  const budget = PHASE_BUDGETS[phase]
  const summary = report.phases[phase]
  expect(summary, `phase ${phase} missing from trace`).toBeTruthy()
  expect(budget, `no budget defined for phase ${phase}`).toBeTruthy()
  expect
    .soft(summary.apiRequests, `${phase}: API request count over budget`)
    .toBeLessThanOrEqual(budget.maxApiRequests)
  expect
    .soft(summary.apiReqBytes, `${phase}: API upload bytes over budget`)
    .toBeLessThanOrEqual(budget.maxApiTxBytes)
}
