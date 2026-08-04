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
row already exists—or appears before the write—the host returns a conflict
instead of overwriting it. Passing a `failed` read is a no-op.

Guarded/versioned replacement values must be strict detached JSON in both inline
and optimized modes. A versioned read can expose a legacy structured-clone value
from inline storage so the plugin can guardedly remove it or transform it into
JSON. The legacy basic inline `getItem()`/`setItem()` path can retain such rich
values, but code intended to survive mode changes should use JSON-safe data
consistently.

On current servers, optimized guarded writes negotiate a streamed framed
transport and accept one value up to the same configured per-value limit as
`setItem()`. The host validates lengths, hashes, and JSON before attempting the
atomic publication. An older server that does not advertise framed batches uses
the legacy JSON transport and may reject batches whose encoded request exceeds
16 MiB; split records when supporting that older server generation.

For a single-key update, `updateItem()` uses the host's fair migration barrier,
performs an initial versioned read plus a final pre-publication re-read, and
does not run its callback when the initial read rejects. The callback receives
the current `missing | value` snapshot and the operation's `AbortSignal`:

```ts
const result = await risuai.pluginStorage.updateItem(
  'ledger',
  (current, signal) => {
    signal.throwIfAborted();
    return current.status === 'missing'
      ? { entries: [] }
      : appendEntry(current.value);
  },
  { timeoutMs: 10_000 },
);

if (!result.committed) {
  // A concurrent writer won. Re-read before retrying a pure transform.
}
```

Unlike `readItem()`, a failed `updateItem()` read rejects because no explicit
`failed` union is returned from this migration API. Cancellation after its CAS
has been submitted rejects with `commitOutcomeUnknown: true`; re-read before
retrying. Use `readItem()` plus `setFromRead()` when the caller needs failures
as values or must decide whether to construct a fallback before transforming.

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

For ambiguous mutation outcomes, see [Safe V3 plugin-storage mutations](../../.archived-docs/plugin-storage-mutation-outcomes.md). For multi-row publication and generation rules, see the [plugin-storage architecture](../../docs/structure/plugin-storage.md#immutable-generations).
