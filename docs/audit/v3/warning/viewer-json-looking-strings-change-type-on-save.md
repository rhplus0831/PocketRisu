# The storage viewer changes JSON-looking strings to another type on save

- Status: Open
- Severity: Medium
- Lens: L4, D6
- Area: Area 2 — client/plugin boundary
- Affected code: `src/lib/Setting/Pages/PluginStorageViewer.svelte:107`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:108`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:117`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:129`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:231`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:252`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:263`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:271`

## Risk

For JSON-backed stores, the viewer renders a stored string without JSON quotes,
pretty-prints it whenever it parses as JSON, and parses it again on save. Although
the entry retains its raw value, the save path does not preserve that original
type.

A serialized document string becomes an object or array; strings such as
`"false"`, `"42"`, and `"null"` become boolean, number, and null. A harmless
human edit can therefore break the plugin's schema, and actual null is also
indistinguishable from a missing V3 key.

## Required fix and coverage

Preserve the original type by default. Save edited text as text when the raw
value was a string, and expose parsing/type conversion as a separate confirmed
action with the stored type displayed.

Round-trip JSON-looking strings through every viewer backend.
