# Ill-formed legacy plugin keys can poison inline storage

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: fa2d0e98, 0da9d553, and 1b3a8233

## Difference

main accepted arbitrary JavaScript string keys, including lone UTF-16
surrogates. serve rejects ill-formed UTF-16. Inline V3 mutation and enumeration
validate the complete existing map, so one historical lone-surrogate key can
prevent writes/removals of unrelated valid keys and make keys() fail.

## Compatibility impact

Previously saved values become difficult to inspect or migrate through V3.
V3 clear works but destroys unrelated entries; while optimization is off, a V2
facade still accepts, enumerates, and can remove the malformed key. The
whole-map poisoning described here is scoped to V3 async storage and related
optimized transitions.

## Resolution

Plugin storage now gives ill-formed legacy keys a versioned physical encoding
based on their exact UTF-16 code units. Well-formed keys retain their existing
UTF-8/base64url names, while tagged legacy names round-trip distinctly from
each other and from the Unicode replacement character. Inline and V3
operations validate only the key they are acting on, so one historical key no
longer blocks unrelated reads, writes, removals, or enumeration.

Save, stream, and backup boundaries use a backward-compatible v2 escape
envelope for keys that MessagePack cannot represent losslessly. Readers still
accept the older v1 `__proto__` envelope, and optimized manifests, mutation
endpoints, transitions, viewer pages, full exports, partial exports, and fresh
imports all preserve the raw JavaScript key.

Regression coverage exercises multiple distinct lone surrogates alongside the
replacement character through inline V2/V3 access, optimized mutation,
externalization/internalization, viewer parsing, streamed saves, legacy-v1
decode, backup export, partial export, and destination restore.
