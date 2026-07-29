# Plugin timeout tests do not protect the 20-second compatibility floor

- Status: Confirmed coverage gap
- Severity: High process risk
- Confidence: High
- Related fix: 832d69bd

## Evidence

Factory availability tests import PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS and advance
fake time by that same value. Reverting the constant from 30 minutes to 20
seconds would change the test's expectation in lockstep and still pass.
Storage tests usually provide explicit test deadlines, and there is no
long-running runLLMModel boundary test. Production update deadlines are also
untested because update tests inject shorter values.

## Risk

The exact regression named in the request can be reintroduced without a red
test. The suite verifies internal consistency, not the compatibility
requirement.

## Recommendation

Assert an independent minimum: a call remains pending after 20,001 ms and
resolves when a later response arrives. Cover runLLMModel, storage, initialization,
cancellation, and late host completion without importing the constant under
test. An optimized-storage call cannot currently satisfy that generic assertion
because the independent authoritative layer fails at 15 seconds; test the
layers separately and make the conflict explicit.
