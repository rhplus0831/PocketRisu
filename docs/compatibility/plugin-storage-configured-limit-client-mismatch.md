# The optimized-storage server value limit is hardcoded in the client

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High

## Original difference

The optimized-storage server read POCKETRISU_PLUGIN_VALUE_MAX_BYTES and
documented it as a configurable per-value limit. The optimized browser path
hardcoded 128 MiB in src/ts/storage/pluginStorageLimits.ts and rejected during
preparePersistentJson() before sending a request. main directly assigned
pluginCustomStorage values without an explicit per-value limit.

## Original compatibility impact

Raising the server limit to 256 MiB did not permit a 129 MiB normal browser
write to optimized storage. Operators could believe they expanded capacity while
the client retained the old ceiling. Ordinary inline setItem and database writes
bypassed this preflight, but versioned, batch, rewrite, and update operations
enforced it in either mode. When the server was configured lower, it reported the
correct limit, but missing capability preflight wasted the rejected upload.

## Resolution

The authenticated `/api/session` response now advertises the authoritative
`pluginStorage.maxValueBytes`. The browser validates ordinary, versioned,
batch, legacy transaction, and staged-transition writes at the authenticated
transport boundary before dispatching a value body. The historical 128 MiB
ceiling remains only as the fallback for servers that do not advertise the
generic capability; the existing framed-batch capability is also accepted as a
compatibility source.

Serialization no longer rejects against a compile-time value ceiling. Tests
cover lowering and raising the negotiated browser limit, configured server
advertisement, framed batches, and real-server capacity enforcement.
