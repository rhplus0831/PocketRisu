# E2E trace harness

Playwright scenarios that drive the real built app against real isolated
server instances, measuring API request counts and bytes per scenario phase.
Built for the [2026-08 performance audit](../../.archived-docs/findings/2026-08-performance-evidence/README.md); the
scenario reports are the audit's empirical baselines and later become budget
regression assertions.

## Run

```bash
pnpm build          # the server serves dist/ and enforces the build stamp
pnpm test:e2e
```

Chromium for Playwright must be installed once: `pnpm exec playwright install chromium`.

## Design

- **Isolation**: every test spawns `server/node/server.cjs` with `cwd` set to a
  private temp dir (the server roots everything at `process.cwd()`); `dist/` is
  symlinked in. No writer-lock contention between parallel workers.
- **Fixtures**: templates under `.templates/` (gitignored) are fully built
  instances — a backup produced by `helpers/seedData.ts` imported through the
  real API in `global-setup.ts`. Delete `.templates/` or change a spec string
  to rebuild.
- **Auth**: `save/__password` holds `sha256hex(plaintext)`; the UI fixture
  types the plaintext into the login dialog (`#alert-input`). Reloads reuse
  the session cookie and usually skip the prompt.
- **Hermetic**: server-side update checks are disabled (`RISU_UPDATE_CHECK`),
  and the page fences all non-localhost hosts plus `/proxy2` and
  `/hub-proxy` — external Realm/update traffic must never pollute budgets.
- **First-boot dialogs**: the resource-cache opt-in popup is answered
  explicitly per scenario (`resourceCache: 'enable' | 'decline'`); a version
  modal, if shown, is dismissed with "Later".
- **Measurement**: `helpers/netTrace.ts` tallies `request.sizes()` per phase;
  reports attach to each test and print one summary line per phase. During
  the audit budgets are recorded, not asserted.

## Known gaps (planned)

- Optimized-plugin-storage scenario: needs a fixture V3 plugin seeded into
  `db.plugins` plus the UI-driven optimized-mode transition (V3-only gated
  checkbox); inline-mode plugin traffic rides the ordinary DB save loop.
- UI-driven backup/export and destructive-import scenarios: SystemBackup
  flows sit behind chained confirm dialogs; map selectors before scripting.
- Generation length is short (≈3 s); a long-generation variant (>20 s) would
  exercise the mid-generation checkpoint saves.
