# Sparse-array holes are densified in plugin-storage transitions and snapshots

- Status: Open
- Severity: Warning
- Owner: plugin storage
- Source: [delta audit DA-14](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-14-sparse-array-holes-densified-in-mode-transition-and-folded-snapshots-c-f2)

The transition transport's Packr encoding densifies sparse-array holes before
publication. Folded RisuSave transcoding also maps hole and `undefined` tags to
the same MessagePack value, so recovery copies lose occupancy identity even
when the live row was encoded correctly.

Use an explicit occupancy representation before Packr and a versioned
hole/`undefined` distinction in folded publications. Regression coverage must
exercise both live mode transitions and recovery snapshots.
