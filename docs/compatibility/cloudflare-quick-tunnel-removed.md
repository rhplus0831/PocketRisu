# Cloudflare Quick Tunnel UI and API were removed

- Status: Confirmed intentional breaking change
- Severity: High for affected deployments
- Confidence: High
- Introduced by: 985cf521

## Difference

serve removes the RemoteAccessSettings UI, settings route, server use of
cloudflared, legacy installer/Docker provisioning, QR dependency, and these
authenticated main endpoints. Portable release workflows still download and
package an unused cloudflared executable, so it is not absent from every
distribution.

- GET /api/tunnel/status
- POST /api/tunnel/start
- POST /api/tunnel/stop

The replacement documentation uses Tailscale.

## Compatibility impact

Old clients and automation receive 404, and deployments relying on the bundled
ephemeral public URL lose remote access after an update or container rebuild.
The impact compounds with the new secure-context gate, which also blocks direct
remote HTTP.

## Recommendation

Treat this as a migration, not a silent feature deletion: announce the
replacement, preserve a compatibility period or clear 410 response, and test
that every recovery mechanism named by the boot UI actually exists.
