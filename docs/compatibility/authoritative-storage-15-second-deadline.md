# Authoritative storage still has a 15-second deadline

- Status: Confirmed regression
- Severity: High
- Confidence: High
- Introduced by: fa2d0e98
- Related fix: 832d69bd

## Difference

main performed NodeStorage network I/O without a general wall-clock deadline.
serve wraps authoritative operations in runBoundedAuthoritativeStorageOperation
with AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS = 15,000 in
src/ts/storage/nodeStorage.ts.

Commit 832d69bd raised the V3 bridge and plugin-storage update deadlines to 30
minutes, but did not change this lower transport deadline. Explicit bounded
callers keep the timer through response-body consumption. The fallback
authFetch wrapper clears its timer when fetch returns response headers. Hashing
is also inside the bound for optimized mutate/batch paths; staged-transition
upload computes its expected hash before entering the bounded operation.

## Compatibility impact

Slow but valid plugin storage reads, mutations, batches, transitions, asset and
default storage operations, chat saves, and backup preparation can still fail
after 15 seconds. Inlay scans/deletes use a separate two-minute bound. Legal
128 MiB plugin values can exceed the 15-second deadline on ordinary networks. A
dispatched mutation may be reported as
COMMIT_OUTCOME_UNKNOWN. Separately, bare POST callers such as
/api/chat-content, /api/assets/bulk-write, and cleanup execution are wrapped as
reads and can surface a retryable STORAGE_TIMEOUT after a possible commit.

This is the closest remaining sibling of the reported 20-second plugin
regression: the outer plugin RPC now waits, but its storage work does not.

## Reproduction

Delay /api/plugin-storage/mutate acknowledgement for setItem(), a cold-cache
value read for getItem(), or GET /api/plugin-storage/manifest for keys() by 16
seconds. main's inline equivalents complete; serve aborts near 15 seconds.

## Recommendation

Use operation-aware, progress/idle-based limits and preserve post-dispatch
unknown-outcome classification. Add a test that stays pending after 20,001 ms
without importing the production timeout constant, plus throttled large-value
and delayed-acknowledgement integration cases.
