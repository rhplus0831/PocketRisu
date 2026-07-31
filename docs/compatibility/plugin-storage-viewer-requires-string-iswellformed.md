# Plugin storage viewer requires String.prototype.isWellFormed

- Status: Fixed 2026-07-31
- Severity: Low
- Confidence: High

## Original difference

The project contains an isWellFormedUnicode fallback for runtimes that do not
implement the modern String API. The new paged save-storage viewer instead
calls String.prototype.isWellFormed() directly in nodeStorage.ts and
pluginSaveStorage.ts. main had a viewer UI, but not this paged path.

## Original compatibility impact

Firefox 114-118 and older embedded WebViews without isWellFormed() throw
TypeError on nonempty optimized save-storage pages. Ordinary inline pages work
unless an owner filter is supplied; local/IDB tabs are unaffected. The
configured Chrome 111 and Safari 16.4 targets already support the method, and
the build does not polyfill missing prototype methods.

## Implemented recommendation

Use the existing helper at client call sites; supported Node versions already
provide the method. Add viewer tests that delete String.prototype.isWellFormed
before importing the module and cover optimized, inline owner-filtered, and
unaffected tabs.

## Resolution

The mode-aware viewer and Node transport now route owner filters, owner facets,
entry owners, and streamed error messages through `isWellFormedUnicode()`.
Validation remains strict for unpaired surrogates, while Firefox 114–118 and
older embedded WebViews use the helper's portable UTF-16 scan instead of
throwing because a prototype method is absent.

The optimized viewer transport suite removes
`String.prototype.isWellFormed` before importing `nodeStorage.ts`, then covers
nonempty owner-bearing pages and malformed owner filters. Inline viewer
coverage also removes the method while loading an owner-filtered page. The
ordinary local and IndexedDB viewer paths remain independent of this API.
