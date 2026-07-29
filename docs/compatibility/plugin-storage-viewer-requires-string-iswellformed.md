# Plugin storage viewer requires String.prototype.isWellFormed

- Status: Confirmed browser-compatibility risk
- Severity: Low
- Confidence: High

## Difference

The project contains an isWellFormedUnicode fallback for runtimes that do not
implement the modern String API. The new paged save-storage viewer instead
calls String.prototype.isWellFormed() directly in nodeStorage.ts and
pluginSaveStorage.ts. main had a viewer UI, but not this paged path.

## Compatibility impact

Firefox 114-118 and older embedded WebViews without isWellFormed() throw
TypeError on nonempty optimized save-storage pages. Ordinary inline pages work
unless an owner filter is supplied; local/IDB tabs are unaffected. The
configured Chrome 111 and Safari 16.4 targets already support the method, and
the build does not polyfill missing prototype methods.

## Recommendation

Use the existing helper at client call sites; supported Node versions already
provide the method. Add viewer tests that delete String.prototype.isWellFormed
before importing the module and cover optimized, inline owner-filtered, and
unaffected tabs.
