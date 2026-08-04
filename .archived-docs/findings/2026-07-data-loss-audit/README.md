# 2026-07 data-loss audit archive

The source-specific [priority index](PRIORITY-INDEX.md) covered 60 reports. This
archive retains the 25 reports that were marked fixed when the findings catalog
was reorganized on 2026-08-05, plus the three data-loss-lens source reports that
were superseded by merged canonical findings.

Unresolved reports moved to [`docs/findings/open/`](../../../docs/findings/open/)
and are now indexed by owning subsystem. The accepted DB-only snapshot scope
moved to [`decisions/`](../../../docs/findings/decisions/).

## Consolidated completed work

| Resolution family | Representative fixes | Durable record |
|---|---|---|
| Durable chat targeting | Send-input and reroll settlement now bind durable character/chat IDs across awaits. | [Send-input race](reports/send-input-race-replaces-another-chats-history.md), [reroll settlement](reports/reroll-failure-restores-into-the-current-chat.md), canonical [chat pipeline](../../../docs/structure/chat-pipeline.md) |
| Authoritative decoding and migration | Strict block decoding and transactional migration markers prevent partial state from becoming authoritative. | [Strict decoding](reports/partial-block-decode-becomes-authoritative.md), [migration marker](reports/legacy-kv-migration-marker-can-outlive-the-wal-commit.md), canonical [client storage](../../../docs/structure/client-storage.md) |
| Recovery-history correctness | Chat deletion pre-images, version caps, and global eviction order were made explicit and regression-tested. | [Deletion pre-image](reports/chat-deletion-has-no-preimage-history.md), [version cap](reports/chat-version-cap-collapses-from-125-to-100.md), [global eviction](reports/global-chat-budget-evicts-newer-bundles-before-older-loose-versions.md) |
| Asset/inlay publication safety | Boot GC ownership, publication races, orphan classification, and replacement ordering were hardened. | [Plugin-owned assets](reports/boot-asset-gc-deletes-plugin-owned-assets.md), [publication race](reports/boot-asset-gc-races-concurrent-publication.md), [orphan scan](reports/inlay-orphan-scan-classifies-referenced-inlays-as-deletable.md), [replacement](reports/inlay-replacement-unlinks-before-publish.md) |

The remaining fixed reports stay separate because their mechanisms and
regression boundaries are distinct.
