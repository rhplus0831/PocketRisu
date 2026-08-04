# 2026-08 findings revalidation register

On 2026-08-05 every finding then open or deferred in `docs/findings/open/`
(49 total) was revalidated against pinned commit `57b7ea41` by two independent
tracks — Codex (xhigh) and Claude subagents — working from identical briefs,
per-finding evidence packets, and archived source reports, blind to each
other's output. Verdicts were reconciled per finding; every disagreement got a
targeted third examination, and every closure required both tracks to name the
same resolving commit, direct verification of the fix in current code, and
existing regression coverage.

## Outcome

| Verdict | Count | Action taken |
|---|---|---|
| Confirmed as written | 34 | Revalidation stamp added; two reports gained scope addenda |
| Confirmed, report modified | 11 | Reports rewritten around the current failure path |
| Fixed | 4 | Archived below with resolution commits |
| Obsolete / undecidable | 0 | — |

The catalog therefore went from 47 open + 2 deferred to 44 open + 1 deferred.

## Fixed findings

| Finding | Resolution | Coverage |
|---|---|---|
| [Pre-tracking baseline capture omits six save domains](fixed/pre-tracking-baseline-capture-still-omits-six-save-domains.md) | `e2ca4ddd` startup equality preflight across all six domains | `chatPersistStage.test.ts`, boot E2E zero-patch-bytes; no all-six-domain matrix |
| [Direct flush callers bypass automatic-snapshot serialization](fixed/direct-flush-callers-bypass-automatic-snapshot-serialization.md) | `3e758f9a` pinned-source snapshot assembly | `test/compat/snapshot-spool.test.ts` |
| [HTML chat round trip rejects the default empty note](fixed/html-chat-round-trip-rejects-the-default-empty-note.md) | `b399bd31` shared shape-based chat import | `src/ts/chatImport.test.ts` |
| [Non-canonical hex path headers split the patch cache](fixed/noncanonical-hex-path-splits-the-patch-cache.md) | `e23b744c` canonical storage key identity | `test/compat/database-write-atomicity.test.ts` |

## Severity changes

Downgraded to Low, each on a verified narrowing: character-package inlay
remap (`dad24f6f` reference-guarded deletion removed the deletion escalation),
interrupted inlay migration (`5ef61ed2` removed payload loss; metadata-only
residue), upstream-compatible backup (the "no warning" premise was wrong —
the confirm shipped with the feature in `5e461a0d`), and the callback bridge
(`efe1001b` removed the permanent-hang path). `whole-chat-patches` kept High:
the `x-client-build` gate is friction, not a barrier.

## Notable corrections found by revalidation

- Several resolving commits predate the mechanical audit watermark
  (`5ef61ed2`), proving packet commit-windows alone cannot close findings.
- Gemini signature persistence (DA-11) is disconnected end to end — the
  reported fire-and-forget branch is dormant, not live.
- DA-12 widened: the draft-blind dirty probe now also gates the writer-epoch
  auto-reload (`7dd00712`), adding server restarts as a loss trigger.
- DA-16's missing primitive now exists (`7dd00712` writer epochs) but was
  never bound to plugin-recovery tokens — a direct remediation lead.

## Method notes

Both tracks covered 49/49 findings with valid structured verdicts; 42 verdicts
agreed exactly, and all 7 disagreements were open-status-preserving (no track
ever disputed whether a finding should stay open, only how its report should
read — except jdupes, an epistemic dispute resolved as confirmed with a
runtime-verification caveat recorded in the report). The repository tree hash
was byte-identical before and after the pass.
