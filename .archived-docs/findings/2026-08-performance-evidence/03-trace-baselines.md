# E2E trace baselines

Captured 2026-08-04 against `7ddb8aca` with the harness in `test/e2e/`
(`pnpm build` + `pnpm test:e2e`). Second capture: fixture bodies are now
seeded pseudo-random printable ASCII, so gzip can no longer flatter chat-row
byte measurements. Numbers are API traffic only; `tx` = request bytes
(uncompressed on the wire), `rx` = response bytes (server gzip applies).

| Scenario / phase | API req | tx | rx |
|---|---|---|---|
| First run, empty instance (`first-run-boot`) | 34 | 225,348 B | 12,010 B |
| Cold boot, medium, cache declined (`cold-boot`) | 15 | 40,022 B | 6,200 B |
| Cold boot, xl 300 characters (`xl-cold-boot`) | 15 | **301,882 B** | 8,997 B |
| Cold boot, medium, cache on, first visit (`cold-boot-cache-on`) | 16 | 40,760 B | 6,725 B |
| Warm boot, cache enabled, reload (`warm-boot`) | 13 | 8,638 B | 11,513 B |
| Open large chat (`open-chat`) | 3 | 3,797 B | 297,922 B |
| Type one message, provider-less (`send-and-save`) | 11 | 871,563 B | 3,756 B |
| Send with mock streaming provider (`send-generate-save`) | 10 | 872,451 B | 3,422 B |

Fixtures: medium = 10 ch × 3 chats × 30 msg × ~200 B; large-chat/provider =
3 ch × 2 chats × 400 msg × ~1,000 B (encoded row ≈ 430 KB); xl = 300 ch ×
2 chats × 20 msg × ~300 B. Provider template adds a classic `reverse_proxy`
OpenAI-compatible config aimed at the fixed-port mock (`helpers/mockProvider.ts`).

## Endpoint-level evidence (second capture; per-path reports now persist)

- **A5 → one giant boot `/api/patch`, CONFIRMED one-time.** The xl cold
  boot's 302 KB upload is a single `/api/patch` of 293,607 B. The
  two-fresh-context scenario proves it: first boot patch = 31,747 B (medium),
  second boot patch = 0. The first client boot after an import/restore fills
  database defaults, marks branches dirty, and uploads a DB-scaled
  normalization patch. On a production-sized DB every restore/migration pays
  this once — potentially megabytes — and it also inflates every cold-boot
  measurement made on fresh instances. (Side observation: the post-
  normalization DB is larger — second-boot download rose 6.7→12.2 KB.)
- **A3 → up to two full-row `/api/chat-content` POSTs per exchange.** Good
  case: one 427,371 B row POST + one 1.1 KB stub `/api/patch`. Bad case
  (timing-dependent): a user-message row save fires during generation and a
  second full-row save follows completion → ~872 KB. The delta content type
  never appeared in any capture. Suspect: `chat.lastDate` (and possibly
  `scriptstate`) mutate on every send — non-message changes disqualify the
  message-append delta, so the optimized path can never engage for ordinary
  sends.
- **A2 → segmented read-cached envelope ≈ 2× the raw read at small size.**
  Warm `read-cached` response: 6,703 B vs ~3,642 B for the raw boot read;
  plus an extra `/api/list` (4 vs 3) and hash-advertisement upload.
- Boot makes 3–4 `/api/list` calls (distinct prefixes) — minor W1 candidate.
- `/api/request-logs` uploads ~12 KB per exchange (request-body capture) —
  bounded, but worth a look at batch cadence.

## Anomalies (Phase 2 seeds, unverified)

- **A1 — First run uploads ~225 KB / 34 API requests on an empty instance**
  (vs 15 requests on an established one). Identify the writers.
- **A2 — Verified resource cache costs more than it saves at small DB size**:
  warm boot rx 11,513 B vs cold 6,725 B (ratio 1.71) plus 8.6 KB of hash
  advertisements tx. Find the per-segment overhead and the size crossover.
- **A3 — One chat exchange uploads ~872 KB (≈ 2× the encoded row), confirmed
  with a real streaming generation.** The operation-log delta path does not
  apply to the ordinary send, and volume indicates two full-row writes
  (checkpoint + final?). Establish which delta precondition fails and whether
  both writes are necessary.
- **A4 — Hydration is request-lean** (3 requests, one row) and boot appears to
  pre-hydrate the selected chat. Confirm nothing beyond the active chat
  hydrates at boot on larger fixtures.
- **A5 — Cold-boot upload scales with database size**: 40 KB (10 characters)
  → 302 KB (300 characters) transmitted at every cold boot with nothing
  dirty. Same shape as A1. Suspect: a boot-path full-database write
  (defaults/migration fill → save) instead of a no-op. The warm reload
  uploads only 8.6 KB, so the cost is specific to fresh-context boots.

## Harness coverage status

Closed this round: incompressible bodies (gap 4), xl boot-scaling fixture
(gap 5), mock OpenAI-compatible SSE provider + real generation scenario
(gap 1). Still open, deliberately deferred: optimized-plugin-storage scenario
(needs a fixture V3 plugin plus the UI-driven optimized-mode transition) and
UI-driven backup/export + import scenarios (multi-dialog flows); both are
specified in `test/e2e/readme.md` as follow-ups and are not blockers for the
Phase 2 lens work, which has static coverage of those subsystems.
