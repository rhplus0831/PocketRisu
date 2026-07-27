# Safe V3 plugin-storage mutations

`risuai.pluginStorage.setItem()` and `removeItem()` reject when persistence is
not acknowledged. Do not catch those rejections and resolve normally: optimized
save storage is remote and durable, so doing that can make a plugin cache, dirty
flag, reset dialog, or success counter disagree with the authoritative row.

For maintenance and UI workflows, use `setItemWithOutcome()`,
`removeItemWithOutcome()`, or `removeItemConfirmed()`. They report one of:

- `committed`: the exact request was acknowledged, or
  `removeItemConfirmed()` observed the requested absence during its fresh
  versioned read. Its `mutationOutcome` field distinguishes those cases.
- `not-committed`: the host has a definitive refusal, such as a known import
  barrier. A bounded retry is allowed only when
  `retryable === true` and still fits the operation's deadline.
- `unknown`: the request may have committed (for example, its response was
  lost), or the desired removal could not be confirmed. Never replay an
  unknown mutation. Re-read authoritative state and reconcile the plugin's
  cache or ask the user to retry after inspection.

## Cache and dirty-state workflow

Snapshot the intended value before starting the request. Publish it to a local
cache only after `committed`. Keep the prior cache for `not-committed`. For
`unknown`, evict the affected cache entry and use `getWithRevision()` to attach
the current authoritative value.

```ts
const next = structuredClone(state.config);
const result = await risuai.pluginStorage.setItemWithOutcome("config", next);

if (result.outcome === "committed") {
  configCache.set("config", next);
  configDirty = false;
} else if (result.outcome === "not-committed") {
  // The old authoritative value is unchanged. Preserve the dirty edit.
  showSaveError(result.message);
} else {
  // Do not retry: the SET may already have committed.
  configCache.delete("config");
  const current = await risuai.pluginStorage.getWithRevision("config");
  attachAuthoritativeConfig(current);
  showSaveOutcomeUnknown(result.message);
}
```

Do not clear a dirty deletion when `removeItem()` merely stops throwing in a
plugin wrapper. Confirm the postcondition instead:

```ts
const result = await risuai.pluginStorage.removeItemConfirmed(key);
if (result.outcome === "committed") {
  rowCache.delete(key);
  dirtyDeletes.delete(key);
} else {
  // A present `authoritative` field means a value remained or reattached.
  // Keep the deletion dirty and re-read before rebuilding the cache.
  rowCache.delete(key);
  reportDeleteFailure(key, result);
}
```

`removeItemConfirmed()` sends one REMOVE only. After every result except a
definitive `not-committed`, it performs a fresh versioned read and succeeds
only when that read proves absence; it never replays the mutation. A present
row or failed read remains unsuccessful. In particular, transport/session
statuses classified as an unknown commit outcome are not safe-retry evidence.

## Reset and cleanup counters

Counters and UI success messages must derive from confirmed outcomes rather
than attempted promises:

```ts
let removed = 0;
const failures: Array<{ key: string; outcome: PluginStorageConfirmedRemoveOutcome }> = [];

for (const key of keysToReset) {
  const outcome = await risuai.pluginStorage.removeItemConfirmed(key);
  if (outcome.outcome === "committed") {
    removed += 1;
  } else {
    failures.push({ key, outcome });
  }
}

showResetResult({ removed, failed: failures.length, failures });
```

If multiple keys form one logical generation, use `getWithRevision()` plus
`atomicBatch()` instead. A loop of individually confirmed removals does not
make the group atomic.
