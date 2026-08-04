# V2 storage assignments now always detach caller aliases

- Status: Open
- Owner: plugin storage
- Source: [2026-07 compatibility investigation](../../../../.archived-docs/findings/2026-07-compatibility/SOURCE-INDEX.md)
- Severity: Low
- Confidence: Medium
- Introduced by: d72af87c
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Difference

main and upstream assign caller objects directly into Svelte-backed
pluginCustomStorage. Visibility of later raw-reference mutations can depend on
whether that path has already been observed/cached. serve deterministically
detaches every V2 ingress: `8987ba8f` replaced the older JSON clone with
`cloneLegacyStorageValue`, a structured-clone-domain snapshot with
brand-checked `Date`/`Map`/`Set`/binary handling, cycle and sparse-array
support, guarded-proxy unwrapping, and accessor rejection. Current tests
describe this as intentional localStorage-like snapshot semantics
(`plugins.svelte.ts:1246-1256`).

If a plugin assigns an object and later mutates the retained reference, some
main/upstream timing paths can observe the mutation; serve always retains the
earlier snapshot. The migration guide does not promise caller-reference
identity, which lowers the severity, but existing code can still change
silently.

## Compatibility impact

Stateful plugins that retain a configuration or cache object can silently save
stale data; unlike a rejected rich value, there is no error to guide migration.
The same behavior applies to flattened custom keys and setDatabase variants.

## Recommendation

Either preserve the observable main timing cases or formally document the
detached-snapshot semantics in the migration guide. Test retained aliases
before and after observation, normal saves, and transition admission.
