# Custom hub proxy targets are now rejected

- Status: Accepted decision
- Owner: server backend
- Source: [2026-07 compatibility investigation](../../../.archived-docs/findings/2026-07-compatibility/SOURCE-INDEX.md)
- Severity: Medium
- Confidence: High

## Difference

main decoded x-risu-node-path and relayed arbitrary targets through /hub-proxy.
serve accepts only the hardcoded official https://sv.risuai.xyz origin in
server/node/proxyTarget.cjs; foreign/custom hub targets receive 403
PROXY_TARGET_BLOCKED.

Hosted mode adds stricter private/reserved target, redirect, streaming-job, and
WebSocket restrictions. Those hosted-only checks are not claimed as standalone
regressions here.

## Compatibility impact

Custom hub deployments and external clients that used /hub-proxy as a general
relay stop working even outside the ordinary official target.

## Recommendation

Document the allowed origin and migrate authenticated general-purpose traffic
to /proxy2. If custom hubs are supported, make the allowlist explicit and
configurable. Add an old-client compatibility response that explains the new
route rather than a generic 403.
