# Compatibility and server suites are not run in CI

- Status: Open
- Owner: operations and coverage
- Source: [2026-07 compatibility investigation](../../../../.archived-docs/findings/2026-07-compatibility/SOURCE-INDEX.md)
- Severity: Informational process risk
- Confidence: High

## Evidence

vitest.config.ts limits pnpm test to src/**/*.test.ts. The server and
compatibility suites require pnpm test:server and pnpm test:compat. Current
release/build workflows do not invoke any of the three commands. This workflow
gap is identical on main and serve; it is recorded as audit context, not a
branch regression.

At this HEAD the suites pass independently:

- Client: 99 files, 1,625 passed, 3 skipped.
- Server: 25 files, 344 passed.
- Compatibility: 35 files passed, 1 skipped; 281 tests passed, 5 skipped.

## Risk

Green build/package workflows provide no regression gate for the surfaces this
audit examines. Many current tests intentionally codify new bounds without
comparing the former contract.

## Recommendation

Add one required CI job running all three commands with pnpm, publish reports,
and fail releases if any required suite is skipped unexpectedly.
