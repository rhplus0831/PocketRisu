# Upstream-target export can emit a PocketRisu-only magic version byte

- Status: Confirmed interoperability regression
- Severity: High
- Confidence: High

## Difference

serve folds optimized plugin rows when target=upstream. If
pluginCustomStorage or pluginStorageMeta owns a __proto__ key, the encoder uses
PocketRisu's escape envelope and legacy magic/version byte 10.

Current upstream RisuAI recognizes only the legacy 7/8/9 and RISUSAVE block
headers. It does not decode version byte 10. Existing compatibility tests decode the
result with PocketRisu's decoder, masking the target mismatch.

## Compatibility impact

An archive explicitly labeled and named for upstream can fail to open in
upstream RisuAI based on one legal plugin storage key.

## Recommendation

Make target selection choose an encoder supported by that target. For upstream,
use a 7/8/9-compatible data representation or reject the exceptional key with a
clear migration message before export. Test the bytes with the actual pinned
upstream decoder, not PocketRisu's decoder.
