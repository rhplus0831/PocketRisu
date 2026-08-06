# Inlay filename mapping is not injective

- Status: Fixed (2026-08-06 remediation queue)
- Owner: media and translation
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Lens: D4, D6
- Area: Area 7 — server file stores
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the
  [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — physical inlays now use a versioned
  `.inlay-objects-v1` namespace with disjoint payload and sidecar directories.
  Logical IDs and normalized extensions are represented by reversible lowercase
  UTF-8 hex split into bounded path components, so dotted IDs, reserved metadata
  suffixes, extensions, case folding, and multibyte values cannot alias one physical
  target or exceed a filesystem component limit. The accepted ID/extension tuple is
  bounded by the historical 255-byte legacy payload and sidecar filename envelope,
  counted in UTF-8 bytes and checked before path creation or import-entry staging.
  Every buffered, spooled,
  synchronous, import-staging, sidecar-only, deletion, listing, backup, and
  compression path uses the same codec and exact-entry collision checks.
  Backup payloads retain the legacy logical name for dot-free extensions and use
  an injective `inlay_v2/<id hex>--<extension hex>` name for dotted extensions;
  duplicate planned archive names fail before publication. Transport hex is accepted
  only when it is even-length, exact, and round-trips through UTF-8, preventing byte
  aliases across storage APIs and direct `/api/asset/:hexKey` URLs. Physical byte
  accounting recursively includes retained crash-orphan files.
  Canonical files take precedence, while deployed root-level files remain
  readable and are canonicalized at startup. Compatibility lookup parses
  candidates and requires exact logical-ID equality; recursive sidecar evidence
  disambiguates legacy `x.meta`/`json` payloads, and a missing sidecar can no
  longer make `x` read or delete `x.y`.
- Regression coverage: `test/compat/inlay-filename-mapping.test.ts` covers
  canonical dotted and `.meta` IDs, sidecar-only updates/removal, deletion
  aliases, missing-sidecar prefix sharing, evidenced legacy `.meta.json`
  payloads, list identity, ambiguous archive tuples, dotted-extension restore,
  exact-limit and over-limit ID/extension tuples (including multibyte byte counting and
  rejection without path side effects), strict storage/direct-asset transport-hex
  rejection, logical backup names, import preflight/round trip, and startup
  canonicalization.
  `test/compat/inlay-publication-atomicity.test.ts` retains staged-failure,
  compression-failure, and process-kill publication coverage with canonical physical
  paths and counts both the committed payload and retained crash orphan;
  `test/compat/inlay-kv-backup-fallback.test.ts` retains KV migration and backup
  fallback coverage under the new representation. `server/node/backupEntryFormat.test.ts`
  covers duplicate planned archive-entry rejection.
- Canonical architecture: [media inlay storage edges](../../../../docs/structure/media-translation.md#rendering-and-server-storage-edges)
  and [backup and recovery](../../../../docs/structure/backup-recovery.md)

## Original risk (historical)

Inlay IDs could contain dots, while payloads mapped to `<id>.<ext>` and
sidecars to `<id>.meta.json`. Payload ID `x.meta` with extension `json`
therefore aliased the sidecar for ID `x`. When a sidecar was missing,
resolution also took the first `startsWith(`${id}.`)` entry rather than
requiring an exact parsed ID.

Writing explorer metadata or deleting `inlay_info/x` could overwrite or unlink
the unrelated `x.meta` JSON payload. A prefix fallback for `x` could likewise
select `x.y.png` or even a sidecar, and destructive helpers could unlink that
ambiguous result.

## Original required fix and coverage (historical)

Encode IDs injectively or restrict them to a canonical UUID grammar and reserve
the sidecar suffix. Reject collisions before writes; parse candidates and
require exact ID equality for lookup and deletion. Test dotted IDs, reserved
suffixes, missing sidecars, and deletion aliases.
