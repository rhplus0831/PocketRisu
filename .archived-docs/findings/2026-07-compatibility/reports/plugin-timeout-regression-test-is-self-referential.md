# Plugin timeout tests did not protect the compatibility boundary

- Status: Fixed 2026-07-31
- Severity: High process risk
- Confidence: High
- Related fix: 832d69bd

## Original evidence

Factory availability tests import PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS and advance
fake time by that same value. Reverting the constant from 30 minutes to 20
seconds would change the test's expectation in lockstep and still pass.
Storage tests usually provide explicit test deadlines, and there is no
long-running runLLMModel boundary test. Production update deadlines are also
untested because update tests inject shorter values.

## Original risk

The exact regression named in the request can be reintroduced without a red
test. The suite verifies internal consistency, not the compatibility
requirement.

## Implemented recommendation

Assert an independent minimum: a call remains pending after 20,001 ms and
resolves when a later response arrives. Cover runLLMModel, storage, initialization,
cancellation, and late host completion without importing the constant under
test. An optimized-storage call cannot currently satisfy that generic assertion
because the independent authoritative layer fails at 15 seconds; test the
layers separately and make the conflict explicit.

## Resolution

The global bridge and initialization deadlines were removed. Availability
tests now advance past a literal 30-minute former boundary without importing a
production timer, assert that root and remote-instance requests remain pending,
and complete both with late responses. Separate tests cover slow initialization,
late structured storage errors, page-disappearance cancellation, and injected
model/chat cancellation. The storage-update suite independently verifies that
the default transform remains live past the former boundary while explicit
short deadlines retain their pre-/post-publication classifications.
