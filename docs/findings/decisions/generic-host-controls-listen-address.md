# The generic HOST environment variable now changes server binding

- Status: Accepted decision
- Owner: server backend
- Source: [2026-07 compatibility investigation](../../../.archived-docs/findings/2026-07-compatibility/SOURCE-INDEX.md)
- Severity: Medium
- Confidence: High
- Introduced by: a14ca04e

## Difference

main called server.listen(port) and ignored HOST. serve calls
server.listen(port, process.env.HOST || undefined). This is an intentional,
documented bind option; the compatibility risk is limited to deployments that
already supplied the generic variable.

## Compatibility impact

An existing process manager or PaaS that sets the generic HOST variable for
another purpose can make PocketRisu loopback-only, bind the wrong interface, or
fail startup with EADDRNOTAVAIL after upgrade. Behavior remains unchanged when
HOST is unset.

## Recommendation

Prefer a namespaced POCKETRISU_HOST setting, warn when consuming legacy HOST,
and document bind examples. Test unset, 0.0.0.0, localhost, and a nonlocal DNS
value.
