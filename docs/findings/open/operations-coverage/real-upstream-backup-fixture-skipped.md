# Real upstream backup tests silently skip without a local fixture

- Status: Open
- Owner: operations and coverage
- Source: [2026-07 compatibility investigation](../../../../.archived-docs/findings/2026-07-compatibility/SOURCE-INDEX.md)
- Severity: Informational process risk
- Confidence: High

## Evidence

All five cases in test/compat/upstream-import.test.ts skip unless the ignored
test/fixtures/upstream/upstream-backup.bin exists. Synthetic fixtures still
run, but CI does not exercise an archive emitted by upstream RisuAI.

## Risk

Ordinary import mistakes can pass when only synthetic fixtures run. These tests
use ordinary export/import and would not catch the target=upstream header issue,
which requires a separate target-specific upstream decoder test.

## Recommendation

Commit a sanitized fixture or generate one deterministically from pinned
upstream behavior. Fail, rather than skip, when the required compatibility
fixture is absent.
