# Remote plain-HTTP deployments no longer boot

- Status: Confirmed intentional breaking change
- Severity: High for affected deployments
- Confidence: High
- Introduced by: ee5b15db

## Difference

main booted from remote HTTP origins. serve checks window.isSecureContext in
bootstrap and renders a fatal overlay before authentication or storage
initialization. HTTPS and loopback remain allowed.

The server can inject an override only when
POCKETRISU_ALLOW_INSECURE_CONTEXT is 1 or true.

## Compatibility impact

Existing LAN deployments such as http://192.168.x.x:6001 stop functioning
immediately after upgrade. The change is security-motivated, but it requires
deployment migration rather than being source-compatible.

## Recommendation

The fatal overlay already explains HTTPS/Tailscale and the environment
override. Add pre-upgrade release-note discoverability and test remote HTTP,
loopback HTTP, HTTPS, and both accepted override values end to end.
