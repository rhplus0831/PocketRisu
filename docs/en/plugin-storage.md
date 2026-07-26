# Safe V3 plugin storage updates

V3 save-synced plugin storage can perform network and disk I/O. A rejected
read is not evidence that a key is absent. Never catch a read error, substitute
`null`, `{}`, or `[]`, and then write that fallback with `setItem()`; doing so
can replace a valid configuration, credential, index, ledger, or shard.

## Read outcomes

Use `readItem()` when a read is a prerequisite for a write. It resolves to one
of three explicit outcomes:

```ts
const read = await risuai.pluginStorage.readItem<MyConfig>('config');

if (read.status === 'failed') {
  // Keep the old durable value. Retry later only when appropriate.
  console.error(read.error.code, read.error.message);
  return;
}

if (read.status === 'missing') {
  // The authoritative store proved that no row existed at this revision.
} else {
  // This branch also includes a stored JSON null.
  console.log(read.value, read.revision);
}
```

The `failed` error preserves stable bridge-safe fields: `name`, `message`,
`status`, `code`, `retryAfter`, `retryable`, `commitOutcomeUnknown`, and
`operation`. A bridge failure is also converted to this result. Invalid plugin
code, such as a throwing `updateItem()` callback, still rejects normally.

`getItem()` remains available for compatibility, but it returns `null` for
both a missing key and a stored JSON null. `getWithRevision()` distinguishes
those states and rejects on failure; `readItem()` is the ergonomic form for
compound updates because it makes failure an explicit union member.

## Guarded writes

`setFromRead()` publishes only against the exact state returned by
`readItem()`:

```ts
const read = await risuai.pluginStorage.readItem<Credential>('credential');
if (read.status === 'failed') {
  // Abort before constructing any default or running a migration transform.
  console.error(read.error.code, read.error.message);
  return;
}

const next = read.status === 'value'
  ? rotateCredential(read.value)
  : createCredential();

const result = await risuai.pluginStorage.setFromRead(read, next);
if (result.status === 'failed') {
  // A failed prerequisite read is a guaranteed no-op. A write-stage failure
  // can have commitOutcomeUnknown=true and must be reconciled by reading again.
  return;
}
if (result.status === 'conflict') {
  // The row changed after the read. Re-read and recompute; do not force SET.
  return;
}
```

A `missing` read uses an absence CAS (`expectedRevision: null`). If another
row already exists—or appears before the write—the server returns a conflict
instead of overwriting it. Passing a `failed` read is a no-op.

For a single-key update, `updateItem()` performs the same pattern and does not
run its callback after a failed read:

```ts
const result = await risuai.pluginStorage.updateItem<Ledger, Ledger>(
  'ledger',
  read => read.status === 'missing'
    ? { entries: [] }
    : appendEntry(read.value),
);

if (result.status === 'conflict') {
  // Retry the whole update only if this callback is safe to run again.
}
```

For multi-key publication, call `getWithRevision()`/`readItem()` for every
prerequisite and pass every successful revision to `atomicBatch()`. Abort the
whole batch if any read failed. Use `expectedRevision: null` only after an
authoritative `missing` result, never as a catch fallback.

## Migration checklist

- Configuration and credential migrations: abort on `failed`; never write a
  blank/default schema after an unavailable read.
- Index, visibility, and ledger flushes: do not initialize an empty in-memory
  cache from `failed`; keep dirty state until a guarded write commits.
- Shards and buckets: distinguish `missing` from stored `null`, then publish
  the hydrated value with `setFromRead()` or a revision-bound atomic batch.
- On `conflict`, re-read and recompute. Do not fall back to unconditional
  `setItem()`.
- On a write failure with `commitOutcomeUnknown: true`, read the authoritative
  row again before retrying or updating local success counters.

These helpers protect plugins that adopt them. The host cannot infer whether
an unconditional legacy `setItem()` was derived from a swallowed read error,
so existing third-party plugins must migrate their compound update paths.
