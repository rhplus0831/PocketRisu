# Historical documentation archive

This tree preserves completed audits, fixed findings, superseded source reports,
and point-in-time design evidence. Archived material is intentionally not the
current work queue; verify every claim against current code before reuse.

## Findings programs

- [2026-07 data-loss audit](findings/2026-07-data-loss-audit/README.md)
- [2026-07 main-to-serve compatibility investigation](findings/2026-07-compatibility/README.md)
- [2026-07 unified work-priority snapshot](findings/2026-07-unified-work-index.md)
- [2026-08 delta audit](findings/2026-08-delta-audit/README.md)
- [2026-08 performance evidence](findings/2026-08-performance-evidence/README.md)

## Earlier programs and standalone reports

- [v1 serve-branch data-loss audit](v1/serve-branch-data-loss-audit.md)
- [`v2/`](v2/) — retained fatal and warning reports from the second audit wave.
- [Plugin optimization issue index](plugin-organize/README.md)
- [MessagePack performance work index](performance/WORK-INDEX.md)
- [Plugin-storage mutation outcomes](plugin-storage-mutation-outcomes.md)
- [Proxy SSRF hardening](proxy-ssrf-hardening.md)

Paths in this tree are historical interfaces. When a report must move again,
update every inbound link in the same change and run `pnpm check:docs`.
