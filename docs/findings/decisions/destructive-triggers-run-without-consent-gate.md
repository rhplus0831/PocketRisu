# Destructive trigger operations run without a PocketRisu consent gate

- Status: Accepted decision
- Owner: scripting and extensions
- Source: [2026-08 remediation finding](../../../.archived-docs/findings/2026-08-remediation/fixed/card-triggers-can-bulk-delete-history-without-consent.md)
- Severity: Medium compatibility impact
- Decision date: 2026-08-07
- Relevant commit: `b355b2a8`

## Decision

Character and module trigger operations that cut or replace chat history or delete a
lorebook entry execute without a PocketRisu-only consent capability. This includes
trigger commands `/cut`, `/del`, and `/multisend clear`; V1/V2 cut and V2 lore-deletion
effects; and Lua `cutChat`, `removeChat`, and `setFullChat` APIs.

Imports do not scan or prompt for these operations. Character and module interchange
does not emit the removed capability, incoming declarations are ignored, and existing
persisted declarations have no runtime meaning.

## Rationale

Upstream RisuAI has no equivalent consent gate. Applying the PocketRisu-only gate to
existing imported cards retroactively and silently disabled behavior their authors and
users expected. That compatibility break is worse than retaining the established
upstream execution semantics while the proposal has not been accepted upstream.

The capability should be proposed to upstream RisuAI first. PocketRisu should re-adopt
it only if upstream accepts the behavior and provides a compatible rollout contract for
existing cards and modules.

## Retained safety machinery

This decision does not withdraw the rest of `b355b2a8`. Trigger results still publish
through durable character/chat targets with stale-source rejection. Nested sends retain
generation-ownership scoping. Actual bulk chat mutations still propagate the
`destructiveChatMutation` marker and queue the forced, required `script-bulk-chat`
pre-image reason before durable publication. Server-side destructive-reason
classification and capture-failure handling remain unchanged.
