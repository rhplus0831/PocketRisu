# Serve pushes and releases are not gated by the test suites

- Status: Fixed (2026-08-05 remediation queue)
- Owner: operations and coverage
- Source: [2026-07 compatibility investigation](../../2026-07-compatibility/SOURCE-INDEX.md)
- Severity: Informational process risk (at fix time)
- Resolution: `f519771d` — a reusable `.github/workflows/tests.yml` runs
  svelte-check, the build, the client and server unit suites, and the
  compatibility suite; it triggers on pushes to `serve` and gates the release
  and docker-build build jobs via `needs`, so tagged releases cannot publish
  from an untested tree, while pr-check delegates to the same workflow. The
  compat run publishes junit/json report artifacts, and
  `scripts/check-compat-skips.mjs` fails the gate on any case skipped outside
  the known fixture-gated allowlist. Supported by `ee924ac6`, which removed
  the parallel-run flakes (spawn-port collision retry, atomic viewer-gate
  write with polled reads, 120 s hang-guard timeouts) so the gate is green
  when the code is.
- Regression coverage: the gate is itself the regression mechanism; the skip
  guard was exercised against real vitest JSON reports (pass, unexpected-skip,
  and empty-report paths), and a full 49-file compat run passed after the
  flake fixes.
- Canonical architecture: [STRUCTURE.md — Run and verify](../../../../STRUCTURE.md)

## Original risk (historical)

The CI gate applied only to pull requests into `main`; direct pushes to
`serve` — the branch this fork develops and deploys from — and the tag-driven
portable and Docker release workflows ran zero tests. Green release/package
workflows therefore provided no regression gate for the persistence and
interchange surfaces the audits examine, and the compat suite's
upstream-fixture cases silently skipped everywhere but a prepared local
machine, with nothing failing on unexpected skips.

## Original recommendation (historical)

Run all three suites (`pnpm test`, `pnpm test:server`, `pnpm test:compat`) in
the release and serve-push paths, publish reports, and fail on unexpected
skips of required cases.

## Boundary note

Providing or generating the upstream-backup fixture itself (so those five
cases run rather than being an allowed skip) remains the separate open
real-upstream-backup-fixture-skipped finding.
