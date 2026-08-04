# Lua local-lore upserts are discarded in non-display trigger modes

- Status: Open
- Severity: Warning
- Owner: scripting and extensions
- Source: [delta audit DA-10](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-10-lua-upsertlocallorebook-edits-are-discarded-in-non-display-trigger-modes-s)

`upsertLocalLoreBook` mutates a cloned character, while non-display trigger
execution writes back only selected fields and omits `chats[].localLore`. The
call therefore silently no-ops in the modes scripts normally use, despite
working in display mode.

Write back through the live graph or include local lore in the guarded
writeback set, with coverage for every trigger mode.
