# Findings catalog

This directory contains the current findings backlog, accepted compatibility
decisions, and active audit/remediation programs. It is a work catalog, not the
canonical architecture guide: start with [`STRUCTURE.md`](../../STRUCTURE.md)
when changing code, then use a finding as point-in-time evidence to revalidate.

## Where to start

- [Current work index](WORK-INDEX.md) — every open or deferred finding,
  grouped by the subsystem that owns the fix.
- [Remediation queue](REMEDIATION-QUEUE.md) — hand-maintained execution order
  for working the backlog one item at a time.
- [`open/`](open/) — one canonical report per unique work item. Related failure
  families remain separate when they require different fixes or regression
  proofs.
- [`decisions/`](decisions/) — deliberate compatibility changes and accepted
  product limitations; these are not defects waiting for implementation.
- [`programs/`](programs/) — live cross-cutting audit or remediation work whose
  track structure is more useful than individual findings.
- [Historical archive](../../.archived-docs/README.md) — completed programs,
  fixed reports, source-specific indexes, and superseded duplicate reports.

## Metadata contract

Every file under `open/` begins with parseable `Status`, `Owner`, and `Source`
metadata. Valid active statuses are `Open` and `Deferred`; its immediate parent
directory must match the owner. Decision records use `Accepted decision`.

`WORK-INDEX.md` is derived from those headers and must not be edited as an
independent status source. Run:

```bash
pnpm check:docs
```

The check also validates local Markdown targets and anchors across the main
documentation, findings, archive, and E2E documentation. To inspect the exact
generated index content, run `node scripts/check-docs.mjs --print-index`.

## Lifecycle

1. File new work under the owning `open/<subsystem>/` directory and link its
   audit or investigation source.
2. Merge reports only when they describe the same failure path and share one
   fix and verification boundary. Otherwise create a thematic parent in the
   work tracker rather than erasing distinct evidence.
3. When fixed, record the resolution commit, regression coverage, and canonical
   architecture link in a dated archive register; then move the detailed report
   into that archive.
4. When a whole audit finishes, extract unresolved items into `open/` before
   archiving the program evidence.
