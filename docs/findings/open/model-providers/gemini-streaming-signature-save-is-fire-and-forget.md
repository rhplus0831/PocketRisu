# Gemini cross-turn signature persistence is disconnected

- Status: Open
- Severity: Warning
- Owner: model providers
- Source: [delta audit DA-11](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-11-gemini-streaming-thought-signature-saves-are-fire-and-forget-s)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

Revalidation found the reported branch is dormant: nothing in the pipeline
supplies the optional `saveSignatures` request argument
(`src/ts/process/request/request.ts:99`), `db.saveSignatures` defaults to
false with no settings UI to enable it, and `saveInlayedSignature` has no
other callers. Enabling the persisted database setting therefore captures no
new classic-path signatures at all, and native ModelPreset Gemini keeps
signatures only transiently for the in-request provider echo/tool loop —
no persistent signature marker is published for later chat turns.

Two defects follow. Current: Gemini thought-signature persistence across turns
is disconnected end to end, losing generation metadata fidelity. Latent: the
classic streaming branches (`src/ts/process/request/google.ts:703`, `:755`,
`:1294`) still append the inlay token synchronously while the signature save
promise is detached and uncaught — the original fire-and-forget race plus an
unhandled-rejection hazard — which becomes live the moment the gate is wired.

If cross-turn signature persistence is wanted, wire the gate (UI or request
argument), await the signature save before appending its token, handle
rejected writes, and cover streaming mode; otherwise remove the dormant
setting and branch.
