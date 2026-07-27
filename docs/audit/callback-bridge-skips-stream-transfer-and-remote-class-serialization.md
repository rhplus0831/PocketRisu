# Callback bridge skips stream transfer and remote-class serialization

- Status: Open
- Severity: Medium
- Lens: L2, L4
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/plugins/apiV3/factory.ts:118`, `src/ts/plugins/apiV3/factory.ts:196`, `src/ts/plugins/apiV3/factory.ts:213`, `src/ts/plugins/apiV3/factory.ts:222`, `src/ts/plugins/apiV3/factory.ts:414`, `src/ts/plugins/apiV3/factory.ts:422`, `src/ts/plugins/apiV3/risuai.d.ts:1137`, `src/ts/plugins/apiV3/v3.svelte.ts:400`, `src/ts/plugins/apiV3/v3.svelte.ts:440`, `src/ts/plugins/apiV3/v3.svelte.ts:474`, `src/ts/plugins/apiV3/v3.svelte.ts:803`

## Risk

The guest callback path lacks the root bridge's recursive stream-transfer and
remote-class serialization. A valid provider callback can return a nested
`ReadableStream`; `postMessage` then throws `DataCloneError` outside the callback
catch, sends no error response, and leaves the host promise pending forever.

In the opposite direction, callback arguments sanitize only `AbortSignal` and
do not serialize `REMOTE_REQUIRED` wrappers. Mutation observers consequently
receive a stripped plain object instead of a functional `SafeClassArray`.
Already-produced or paid model output can be stranded behind the hung promise.

## Required fix and coverage

Share one recursive serializer and transferable collector across root calls and
both callback directions. Convert publication failure into a serializable error,
clear the pending request, and add a callback timeout.

Cover nested streams and remote wrappers in both callback directions.
