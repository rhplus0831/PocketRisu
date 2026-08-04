# Callback bridge skips deep stream transfer and remote-class serialization

- Status: Open
- Owner: scripting and extensions
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Low
- Lens: L2, L4
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/plugins/apiV3/factory.ts:1479-1503` (callback arguments sanitize only `AbortSignal`), callback-return MessagePort pump and `CALLBACK_RETURN` fallback from `efe1001b`, `src/ts/plugins/apiV3/v3.svelte.ts` mutation-observer delivery
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

The original headline failure is gone: `efe1001b` (upstream #1308) rebuilt the
callback-return direction so a `ReadableStream` returned at the top level or
one level deep in a plain object bridges over a MessagePort pump, and when
`postMessage` still throws the guest posts a fallback `CALLBACK_RETURN` error.
A publication failure now rejects the host promise instead of leaving it
pending forever, so paid model output is no longer silently stranded.

What survives is a functional-degradation gap with loud failures. Streams
nested deeper than one plain-object level, or inside arrays, still do not
transfer in either direction — they now fail with a rejected promise rather
than a hang. Host-to-guest callback arguments still sanitize only
`AbortSignal`, so `REMOTE_REQUIRED` wrappers such as the `SafeClassArray`
passed by `SafeMutationObserver` arrive as stripped, non-functional plain
objects. No general callback timeout exists; unbounded pending requests are an
explicit contract with lifecycle-teardown rejection.

## Required fix and coverage

Share one recursive serializer and transferable collector across root calls
and both callback directions, including remote-class wrappers in callback
arguments.

Cover nested streams and remote wrappers in both callback directions.
