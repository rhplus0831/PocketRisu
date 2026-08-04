# Gemini streaming signature saves are fire-and-forget

- Status: Open
- Severity: Warning
- Owner: model providers
- Source: [delta audit DA-11](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-11-gemini-streaming-thought-signature-saves-are-fire-and-forget-s)

Streaming Gemini paths append the inlay token before its thought-signature save
settles. A failed save leaves a dangling token and loses generation metadata on
later turns; the non-streaming path already waits correctly.

Await the signature save before appending its token and cover rejected writes
in streaming mode.
