# Raw boot does not pin the optimized plugin generation

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High

## Original difference

The cached database read calls rememberSessionPluginStorageState(). The default
resource-cache-off path uses /api/db/read-raw-for-boot, which returns bytes but
does not pin the session's optimized publication.

Boot reconciliation then calls readPersistentJsonRow() without an explicit
generation. Server generation guards require either a generation header or a
session pin and return 409 with Read database.bin before reading authoritative
plugin storage rows.

## Original compatibility impact

An optimized user starting a fresh session with the default cache setting can
receive false recovery/quarantine issues and boot repair cannot read the
current rows. The exposure also occurs with caching enabled whenever cached
boot read fails and falls back to raw boot. Runtime plugin calls normally carry
the generation, so this report does not claim a universal runtime outage.

## Implemented recommendation

Pass the generation obtained after client-side database decoding explicitly
through reconciliation reads. Server-side pinning would require a separate
authoritative mechanism because the raw endpoint is intentionally decode-free
and the generation is inside database.bin. Add an integration test for
cache-off, optimized storage, fresh session, and a nonempty generation.

## Resolution

Boot reconciliation now takes `pluginStorageGeneration` from the decoded
database when optimized mode is selected and includes it in both cached value
reads and uncached owner-row reads. Inline-mode recovery deliberately omits a
stale generation field because external rows are not authoritative in that
mode.

Regression coverage verifies both sides of the routing boundary: optimized
raw-boot reconciliation pins every external row read to the decoded generation,
while disabled-mode recovery does not acquire an invalid optimized pin. The
isolated cache-off test seeds a generation-backed publication on a real server,
performs the decode-free boot read through `NodeStorage`, and completes real
reconciliation without recovery issues. Existing transport and server suites
continue to cover the lower-level generation header and guard semantics.
