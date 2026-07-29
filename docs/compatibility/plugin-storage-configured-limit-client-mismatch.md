# The optimized-storage server value limit is hardcoded in the client

- Status: Confirmed configuration-contract mismatch
- Severity: Medium
- Confidence: High

## Difference

The optimized-storage server reads POCKETRISU_PLUGIN_VALUE_MAX_BYTES and
documents it as a configurable per-value limit. The optimized browser path
hardcodes 128 MiB in src/ts/storage/pluginStorageLimits.ts and rejects during
preparePersistentJson() before sending a request. main directly assigned
pluginCustomStorage values without an explicit per-value limit.

## Compatibility impact

Raising the server limit to 256 MiB does not permit a 129 MiB normal browser
write to optimized storage. Operators can believe they expanded capacity while
the client retains the old ceiling. Ordinary inline setItem and database writes
bypass this preflight, but versioned, batch, rewrite, and update operations
enforce it in either mode. When the server is configured lower, it reports the
correct limit, but missing capability preflight wastes the rejected upload.

## Recommendation

Negotiate limits as an authenticated capability and validate against the
server-advertised value. If the variable is only intended to lower the built-in
cap, document and enforce that direction explicitly. Test unequal client and
server limits.
