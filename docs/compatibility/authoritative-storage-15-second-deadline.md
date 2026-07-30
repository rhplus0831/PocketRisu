# Authoritative storage still has a 15-second deadline

- Status: Fixed 2026-07-30
- Severity: High
- Confidence: High
- Introduced by: fa2d0e98
- Related fix: 832d69bd

## Original difference

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

## Original compatibility impact

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

## Original reproduction

Delay /api/plugin-storage/mutate acknowledgement for setItem(), a cold-cache
value read for getItem(), or GET /api/plugin-storage/manifest for keys() by 16
seconds. main's inline equivalents complete; serve aborts near 15 seconds.

## Implemented recommendation

Replace the universal deadline with a small operation-aware policy while
retaining a short fallback bound for unclassified control calls. Metadata
receives two minutes; known-size payloads receive one minute of setup plus
transfer time at a conservative 128 KiB/s floor, capped at 25 minutes;
unknown-size payloads and long server jobs receive the 25-minute ceiling.
Request serialization and hashing happen before the transport timer starts.

Mutations must also be identified explicitly. Once dispatched, chat saves,
bulk asset writes, cleanup, and other authoritative mutations remain
commit-outcome unknown until their acknowledgement body is consumed and
validated.

## Resolution

NodeStorage now applies the operation-aware policy across plugin storage,
default KV, database, asset, chat, migration, and backup paths. The 15-second
constant remains as the unclassified auth-fetch fallback; explicitly classified
requests, including their authentication phase, use the owning operation's
budget. Legal 128 MiB values receive about 18 minutes rather than 15 seconds,
while every category still has a finite upper bound below the V3 bridge's
30-minute ceiling.

The former bare POST callers now use explicit mutation bounds and preserve
post-dispatch ambiguity through strict acknowledgement parsing, so a timeout
cannot be mislabeled as a safely retryable read failure after a possible
commit. Focused coverage keeps a valid write pending after 20,001 ms without
referencing a production timeout constant, verifies long local hashing does not
consume the transport budget, and retains stalled/malformed acknowledgement
classification tests.

This minimal policy intentionally does not make PocketRisu fully unbounded like
the two original applications. Extremely slow transfers below the throughput
floor and jobs exceeding 25 minutes can still time out. Those cases remain an
explicit limitation of the minimal fix and can be revisited with progress- or
idle-based cancellation if they become practical failures.
