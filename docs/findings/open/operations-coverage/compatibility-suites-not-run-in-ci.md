# Serve pushes and releases are not gated by the test suites

- Status: Open
- Owner: operations and coverage
- Source: [2026-07 compatibility investigation](../../../../.archived-docs/findings/2026-07-compatibility/SOURCE-INDEX.md)
- Severity: Informational process risk
- Confidence: High
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Evidence

The original "no workflow invokes any suite" claim is no longer true: commit
`97634b0c` added `.github/workflows/pr-check.yml`, and `pnpm test` now chains
the client and server suites. The narrowed gap is real, though. The CI gate
applies only to pull requests into `main`; direct pushes to `serve` — the
branch this fork develops and deploys from — and the tag-driven portable and
Docker release workflows run zero tests. The compat suite's upstream-fixture
cases also always skip in CI because `test/fixtures/` is gitignored, and
nothing fails on unexpected skips.

## Risk

Green release/package workflows still provide no regression gate for the
persistence and interchange surfaces the audits examine, and fixture-dependent
compatibility cases silently skip everywhere but a prepared local machine.

## Recommendation

Run all three suites (`pnpm test`, `pnpm test:server`, `pnpm test:compat`) in
the release and serve-push paths, publish reports, and fail on unexpected
skips of required cases.
