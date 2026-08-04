/**
 * Per-scenario network measurement. Tallies every finished request with
 * Playwright's `request.sizes()` (no body consumption, safe for streams) and
 * buckets entries into named phases via `phase()` marks. The report is the
 * audit's primary artifact: request counts and byte totals per phase, split
 * into API traffic and static assets.
 */
import type { Page, TestInfo } from '@playwright/test'

export interface NetEntry {
  phase: string
  method: string
  path: string
  status: number
  reqBytes: number
  resBytes: number
}

export interface PhaseSummary {
  requests: number
  apiRequests: number
  reqBytes: number
  resBytes: number
  apiReqBytes: number
  apiResBytes: number
  byPath: Record<string, { count: number; reqBytes: number; resBytes: number }>
}

export interface NetReport {
  entries: NetEntry[]
  phases: Record<string, PhaseSummary>
}

/** Collapse volatile path segments so grouping stays readable. */
function groupPath(rawPath: string): string {
  return rawPath
    .replace(/\/api\/chat-content\/[^/]+\/[^/?]+/, '/api/chat-content/:chaId/:idx')
    .replace(/\/api\/asset\/[0-9a-fA-F]+/, '/api/asset/:hex')
    .replace(/\/api\/model-jobs\/[^/?]+/, '/api/model-jobs/:id')
    .replace(/\?.*$/, '')
}

export class NetTrace {
  private entries: NetEntry[] = []
  private currentPhase = 'boot'
  private detach: (() => void) | null = null

  static start(page: Page): NetTrace {
    const trace = new NetTrace()
    const onFinished = async (request: import('@playwright/test').Request) => {
      try {
        const response = await request.response()
        const sizes = await request.sizes()
        const url = new URL(request.url())
        trace.entries.push({
          phase: trace.currentPhase,
          method: request.method(),
          path: url.pathname,
          status: response ? response.status() : 0,
          reqBytes: Math.max(0, sizes.requestBodySize) + Math.max(0, sizes.requestHeadersSize),
          resBytes: Math.max(0, sizes.responseBodySize) + Math.max(0, sizes.responseHeadersSize),
        })
      } catch { /* request torn down mid-flight; skip */ }
    }
    page.on('requestfinished', onFinished)
    trace.detach = () => { page.off('requestfinished', onFinished) }
    return trace
  }

  phase(label: string): void {
    this.currentPhase = label
  }

  report(): NetReport {
    const phases: Record<string, PhaseSummary> = {}
    for (const entry of this.entries) {
      const summary = (phases[entry.phase] ??= {
        requests: 0, apiRequests: 0, reqBytes: 0, resBytes: 0,
        apiReqBytes: 0, apiResBytes: 0, byPath: {},
      })
      summary.requests += 1
      summary.reqBytes += entry.reqBytes
      summary.resBytes += entry.resBytes
      const isApi = entry.path.startsWith('/api/') || entry.path.startsWith('/proxy2')
      if (isApi) {
        summary.apiRequests += 1
        summary.apiReqBytes += entry.reqBytes
        summary.apiResBytes += entry.resBytes
        const group = groupPath(entry.path)
        const bucket = (summary.byPath[group] ??= { count: 0, reqBytes: 0, resBytes: 0 })
        bucket.count += 1
        bucket.reqBytes += entry.reqBytes
        bucket.resBytes += entry.resBytes
      }
    }
    return { entries: this.entries, phases }
  }

  async attach(testInfo: TestInfo, name = 'net-trace'): Promise<NetReport> {
    this.detach?.()
    const report = this.report()
    const body = JSON.stringify(report, null, 2)
    await testInfo.attach(name, { body, contentType: 'application/json' })
    // Also persist to the test's output dir so passing runs keep their data.
    const { writeFile, mkdir } = await import('node:fs/promises')
    const path = await import('node:path')
    const outPath = testInfo.outputPath(`${name}.json`)
    await mkdir(path.dirname(outPath), { recursive: true })
    await writeFile(outPath, body, 'utf-8')
    return report
  }
}

/** Compact per-phase console line so budget drift is visible in list output. */
export function formatPhaseSummaries(report: NetReport): string {
  return Object.entries(report.phases)
    .map(([phase, s]) =>
      `${phase}: ${s.apiRequests} api req (${s.requests} total), ` +
      `api tx ${s.apiReqBytes} B, api rx ${s.apiResBytes} B`)
    .join('\n')
}
