# V2 storage assignments now always detach caller aliases

- Status: Confirmed implementation change with timing-dependent impact
- Severity: Low
- Confidence: Medium
- Introduced by: d72af87c

## Difference

main and upstream assign caller objects directly into Svelte-backed
pluginCustomStorage. Visibility of later raw-reference mutations can depend on
whether that path has already been observed/cached. serve deterministically
deep-copies V2 ingress through cloneLegacyStorageJson(), so the alias is always
detached.

If a plugin assigns an object and later mutates the retained reference, some
main/upstream timing paths can observe the mutation. serve always retains the
earlier snapshot. The migration guide does not promise caller-reference
identity, which lowers the severity, but existing code can still change
silently.

## Compatibility impact

Stateful plugins that retain a configuration or cache object can silently save
stale data; unlike a rejected rich value, there is no error to guide migration.
The same behavior applies to flattened custom keys and setDatabase variants.

## Recommendation

Either preserve the observable main timing cases or formally document detached
snapshot semantics with migration guidance. Test retained aliases before and
after observation, normal saves, and transition admission.
