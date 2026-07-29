# A new client can overwrite an older server database after a route 404

- Status: Confirmed mixed-version data-loss regression
- Severity: Critical
- Confidence: High
- Introduced by: 78c0e07f

## Difference

serve's default boot path calls /api/db/read-raw-for-boot. main has no such
route. NodeStorage.readRawDatabaseForBoot() treats every 404 as a missing
database and returns null. Bootstrap interprets null as a fresh installation
and immediately writes an encoded empty object.

main's /api/write accepts the unversioned replacement, so a new frontend served
against an old backend can overwrite a valid database.

## Exposure

Mixed deployments can occur during rolling upgrades, rollback with a stale
browser tab or CDN asset, or any frontend/backend version mismatch. Enabling
the resource cache does not help: /api/db/read-cached also fails against main
and falls back to the same raw route.

## Reproduction

Serve current frontend assets with a main-shaped backend that implements
/api/read and /api/write but not the raw route. Boot once and observe the
existing database replaced by a decodable empty database; corrupt-save recovery
does not activate.

## Recommendation

Negotiate server capabilities or fall back to legacy /api/read when the route
is unsupported. Only create a database after an authenticated, explicit
DATABASE_NOT_FOUND result that cannot be confused with a missing endpoint.
Test a real mixed-version server and assert no write occurs on ambiguity.
