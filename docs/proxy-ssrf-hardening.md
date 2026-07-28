# `/proxy` and `/proxy2` SSRF — required production fix

**Status:** fixed 2026-07-28.
**Filed:** 2026-07-28, against `serve-prd` @ `30823737`.
**Severity:** high in hosted (PocketRisu Hub) deployments; low for standalone
self-hosters, where reaching the local network is a deliberate feature.

A stopgap has already shipped **on the hub side** (`pocketrisu-hub` commit
`f82bd94`) that removes the one critical target. That mitigation is not a fix
for this issue and does not close the class. See "Relationship to the hub
mitigation" below before deciding this is low priority.

---

## What shipped

`server/node/proxyTarget.cjs` now normalizes all general proxy targets to
HTTP(S), strips embedded credentials, rejects hosted-mode IP literals in
non-public ranges, and supplies an undici dispatcher whose DNS lookup hook
checks and pins every resolved address. Because that hook runs for each new
origin, hostname redirects are checked again before connecting. Undici also
skips DNS lookup for IP literals introduced by redirects, so the dispatcher's
final connector repeats the literal-address check before `net.connect`.
`/proxy`, `/proxy2`, and both fetch hops in `/hub-proxy` use the hardened
undici fetch only when `POCKETRISU_HUB_HOSTING` is enabled; standalone
requests retain the global Node fetch and their deliberate local-network
access.

The final `/hub-proxy` fix deliberately differs from the report's original
unconditional-`checkAuth` suggestion. Browser `<img>` Realm resources and the
hub-login `<iframe>` cannot attach `risu-auth`, so unconditional auth would
break those flows. Instead, `x-risu-node-path` is accepted only when it
resolves to the configured HTTPS hub origin. The normal hub path remains
unauthenticated and unchanged, while the arbitrary-target SSRF branch is
removed. The existing `X-Node-Server-Auth` authentication branch remains in
place.

Hosted mode also refuses `/proxy-stream-jobs` creation and its WebSocket
upgrade with `403 PROXY_TARGET_BLOCKED`; that feature intentionally targets
local-network services and has no valid backend inside a hosted tenant.

---

## The defect

`reverseProxyFunc` (`server/node/server.cjs:3274`) and `reverseProxyFunc_get`
(`:3379`) — bound to `/proxy` and `/proxy2` at `:3616`–`:3627` — pass the
caller-supplied URL straight to `fetch()` with no validation of any kind:

```js
// server/node/server.cjs:3323
originalResponse = await fetch(urlParam, {
    method: req.method,
    headers: header,
    body: requestBody,
    signal: timeout.signal
});
```

`urlParam` comes from the `risu-url` header or `?url=` (`:3279`). There is no
scheme check and no host check. The caller also controls the entire outbound
header set via `risu-header` (`:3291`), the method, and the body, and the
upstream response is streamed back to them — so this is a fully general,
bidirectional HTTP relay, not a blind one.

The codebase already has the right helpers and simply does not apply them
here. `sanitizeTargetUrl` (`:1928`) and `isLocalNetworkHost` (`:1892`) exist
and are used by the proxy-stream/job path, which validates its targets. The
unrestricted proxy path predates that work and was never brought in line.

`hubProxyFunc` (`:3518`, routed at `:3618` and `:3628`) is a **second instance
of the same defect and is worse**: it takes an arbitrary URL from the
`x-risu-node-path` header and has *no authentication at all* — `checkAuth`
runs only inside the `X-Node-Server-Auth` branch (`:3549`). Any fix must cover
both functions or it is incomplete.

## Why this matters in hosted deployments

Under PocketRisu Hub every tenant's instance runs on shared loopback
(`127.0.0.1:20000-20999`), alongside the hub itself and any other
root-installed service. `HOST=127.0.0.1` keeps instances off the public
internet, and Caddy `forward_auth` gates them — but a request *originating
inside* an instance bypasses that entire perimeter. Loopback is treated as a
trust boundary by everything on the box, and this endpoint punches through it.

The attacker is not necessarily a malicious tenant. Plugins receive the
proxy-backed `fetchNative` / `n` API (`src/ts/plugins/plugins.svelte.ts`), so
any user who installs a hostile plugin or character card hands over the same
capability without knowing it.

## Relationship to the hub mitigation

On 2026-07-28 the hub moved Caddy's admin API off `127.0.0.1:2019` onto a
`0700` unix socket, because that API is unauthenticated and `POST /load` there
rewrites the whole edge config. Verified from an instance uid afterwards:

```
$ runuser -u risu-rhplus0831 -- curl http://127.0.0.1:2019/config/
curl: (7) Failed to connect to 127.0.0.1 port 2019
```

**That closed one target, not the hole.** The relay is still fully functional
and still reaches every other loopback listener — the hub on `:7000`,
neighbouring tenants' instances, and anything a future ops change starts
listening on. It is defence in depth bought with a config change; the durable
fix belongs here, in the server, which is why this document exists.

## The fix

### Design constraint: do not break standalone self-hosters

The naive fix — reject private and loopback targets outright — would break a
legitimate, supported use case. Standalone users deliberately proxy to local
inference backends, and the codebase says so explicitly at `:1902`:

> keep server-side validation aligned with the client helper for
> Node/self-hosted deployments where single-label LAN or Docker DNS names like
> "litellm" / "ollama" are valid local targets

So the restriction must be **conditional on hosted mode**, not global. Use the
existing flag `HUB_HOSTING_MODE` (`:133`, from `POCKETRISU_HUB_HOSTING`), which
is already the established gate for "this instance is a hosted tenant" and is
set by `pocketrisu@.service`. It is used the same way for server backups at
`:5071` and elsewhere.

The policy, then:

| Mode | Target on local network / loopback | Public target |
|---|---|---|
| `HUB_HOSTING_MODE` on | reject | allow |
| standalone (default) | allow (unchanged) | allow |

This is a no-op for every existing self-hosted user and closes the class for
hosted tenants.

### Three things the implementation must get right

A check that only inspects the URL string is **not sufficient**. All three of
the following are required; skipping any one leaves a working bypass.

**1. Validate the resolved address, not the hostname.**
`isLocalNetworkHost` matches on the hostname string. An attacker registers a
public DNS name with an `A` record of `127.0.0.1` (or uses a public service
that provides one) and sails straight through a string check. The validation
must happen against the IP actually connected to. In practice that means a
custom `undici` dispatcher whose `connect` step rejects the peer address, or
resolving first and pinning the connection to the vetted IP. Resolve-then-fetch
without pinning is still vulnerable to DNS rebinding between the check and the
connect.

**2. Re-validate on every redirect hop.**
`reverseProxyFunc` does not pass a `redirect` option, so `fetch` defaults to
`'follow'` — an attacker points at a public URL they control that `302`s to
`http://127.0.0.1:.../`, and target validation on the initial URL never sees
it. Either set `redirect: 'manual'` and handle hops explicitly with validation
per hop, or validate inside the connect hook from (1), which catches every hop
for free. Note `hubProxyFunc` already uses `redirect: 'manual'` at `:3562` and
`:3582`; the `/proxy` path does not.

**3. Restrict the scheme.**
There is currently no scheme check. Constrain to `http:` and `https:`, matching
`sanitizeTargetUrl` at `:1934`, and strip embedded credentials as it does at
`:1940`.

### Suggested shape

Add one helper next to the existing validators around `:1928` — something like
`assertProxyTargetAllowed(url)` — that applies scheme, credential-stripping,
and (when `HUB_HOSTING_MODE`) the resolved-address rejection, and returns a
dispatcher for the pinned/validated connection. Then apply it at all three
call sites: `reverseProxyFunc` (`:3323`), `reverseProxyFunc_get` (`:3379`
body), and `hubProxyFunc` (`:3562`).

Do **not** reuse `sanitizeTargetUrl` unmodified — it *requires* a local host
(`:1937`), which is the exact inverse of what is needed here. It is the
allowlist for the local-network feature; this needs the complement, and the
comment at `docs/structure/server-backend.md:349` warns against conflating
the two trust models.

Reject with `403` and a distinct error string so the failure is diagnosable in
tenant reports rather than looking like an upstream network error.

### Separately: authenticate `hubProxyFunc`

`hubProxyFunc` should require `checkAuth` unconditionally, not only on the
`X-Node-Server-Auth` branch. Worth confirming against the client callers first
— `/hub-proxy` is used for RisuAI Hub traffic and some callers may not be
sending `risu-auth` today, so this may need a client-side change landed
alongside it.

## How to verify

Server unit tests live at `server/node/**/*.test.ts` (see
`vitest.config.server.ts:9`) and run with:

```bash
pnpm test:server
```

Cover at minimum, with `POCKETRISU_HUB_HOSTING=1`:

- direct loopback literal — `http://127.0.0.1:7000/`, `http://[::1]:7000/`
- decimal/octal/IPv4-mapped encodings — `http://2130706433/`,
  `http://[::ffff:127.0.0.1]/`
- **hostname resolving to loopback** — the case a string check fails
- **public URL that redirects to loopback** — the case per-hop validation fails
- non-http scheme — `file:///etc/passwd`
- private ranges — `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `169.254.169.254`
- and with the flag **off**, that `http://localhost:11434/` (Ollama) still
  works — the standalone regression guard

## Deployment

Once fixed, this ships through the normal hosted release path: build a release
from `serve` via `/admin/releases` (root helper `risu-build-release`), then
roll it out. Release names are `v<pkgver>-<sha>`. Because the fix only tightens
behaviour when `POCKETRISU_HUB_HOSTING=1`, it can go out as part of a routine
default-release update rather than an emergency push — the hub-side mitigation
holds the critical target closed in the meantime.

Once this lands, the hub's `CLAUDE.md` note about the admin API can be
downgraded from "load-bearing security control" to "defence in depth". Leave
the unix socket in place regardless.
