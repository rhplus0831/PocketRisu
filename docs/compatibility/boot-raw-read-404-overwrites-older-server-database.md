# A new client can overwrite an older server database after a route 404

- Status: Fixed 2026-07-31
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

## Resolution

The session response now advertises `database.rawBootRead` and
`database.atomicCreate`. A client only calls the raw boot endpoint when that
capability is present; capability-free and older servers use `/api/read`, with
an uncached `/api/list` existence check before an empty body can mean missing.
An advertised raw endpoint now reports genuine absence as HTTP 204. Route 404s,
zero-byte raw successes, malformed lists, and an empty body for a listed key all
fail closed.

Fresh initialization no longer sends its seed through generic replacement on a
current server. `/api/db/create-if-absent` serializes with storage mutations,
checks the live key inside a SQLite transaction, returns one 201 winner and a
definitive non-mutating 409 to every loser, and publishes the committed ETag.
Bootstrap rereads the winner instead of installing its own seed after a race.
Legacy creation remains available only after repeated authenticated read/list
proof of absence.

Coverage includes current capability negotiation, empty/non-capability session
fallback, mixed-version legacy reads, fail-closed 404 and zero-byte ambiguity,
explicit 204 absence, legacy read/list creation proof, exact create
acknowledgements, concurrent real-server creation, ETag agreement, and byte-exact
preservation when a database already exists.
