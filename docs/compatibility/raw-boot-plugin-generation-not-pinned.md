# Raw boot does not pin the optimized plugin generation

- Status: Confirmed boot-path defect
- Severity: Medium
- Confidence: High

## Difference

The cached database read calls rememberSessionPluginStorageState(). The default
resource-cache-off path uses /api/db/read-raw-for-boot, which returns bytes but
does not pin the session's optimized publication.

Boot reconciliation then calls readPersistentJsonRow() without an explicit
generation. Server generation guards require either a generation header or a
session pin and return 409 with Read database.bin before reading authoritative
plugin storage rows.

## Compatibility impact

An optimized user starting a fresh session with the default cache setting can
receive false recovery/quarantine issues and boot repair cannot read the
current rows. The exposure also occurs with caching enabled whenever cached
boot read fails and falls back to raw boot. Runtime plugin calls normally carry
the generation, so this report does not claim a universal runtime outage.

## Recommendation

Pass the generation obtained after client-side database decoding explicitly
through reconciliation reads. Server-side pinning would require a separate
authoritative mechanism because the raw endpoint is intentionally decode-free
and the generation is inside database.bin. Add an integration test for
cache-off, optimized storage, fresh session, and a nonempty generation.
