# External dedup can strand or overwrite a live asset

- Status: Open
- Owner: media and translation
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D5
- Area: Area 7 — server file stores
- Affected code: `scripts/dedup-assets.sh:18-19`, `scripts/dedup-assets.sh:44-55`, `server/node/assetStore.cjs:25-76`, `server/node/assetStore.cjs:117-160`

## Risk

The dedup script claims live-server safety but delegates pathname replacement to
uncoordinated external tools. The preferred `jdupes -L` renames the destination
aside, creates the hardlink at the original name, and only then deletes the old
file. A crash between rename and link leaves the canonical asset path absent.

Neither dedup branch joins the storage mutation queue or import journal. A server
asset publication or whole-directory import swap between comparison and action
can make the tool replace a new inode selected under an old pathname. The
fallback also does not exclude PocketRisu `.tmp-*` files.

## Required fix and coverage

Require a maintenance lock shared with all instances and imports, or stop every
server. Publish link-to-temp via atomic rename with immediate inode/content
revalidation; exclude all server/tool temp names and recover interrupted names.

Crash-inject each publication step and race dedup against writes and import swaps.
