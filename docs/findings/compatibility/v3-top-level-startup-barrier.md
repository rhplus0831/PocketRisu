# V3 top-level completion became an application startup barrier

- Status: Fixed 2026-07-29
- Severity: High
- Confidence: High
- Introduced by: 99253152

## Original difference

main launched a V3 plugin's async top-level body and treated executePluginV3()
as complete immediately. serve's guest awaited runner() before READY,
executePluginV3() awaited that readiness promise, loadV3PluginGeneration()
waited for every plugin, and bootstrap awaited loadPlugins().

The same wait holds the global plugin lifecycle queue. Commit 832d69bd only
lengthened the watchdog to 30 minutes.

## Original compatibility impact

Historical plugins that registered hooks/providers and then awaited a service
loop, user interaction, polling promise, or top-level LLM call held the whole
app at Loading Plugins. A never-settling body was terminated after 30 minutes
and its earlier registrations were removed; the enabled record remained, so
the stall repeated at every boot. Hot reloads were affected too.

## Reproduction

Use a V3 plugin whose body ends with await new Promise(() => {}) after
registering a hook. main reaches the UI and retains the registration. serve
blocks boot, then tears the generation down.

## Implemented recommendation

Separate registration readiness from the plugin lifetime promise. Prefer an
explicit ready signal, observe late failures in the background, and keep
bootstrap waiting only for bounded readiness. Add boot and hot-reload tests for
long-lived and slow-but-successful top-level tasks.

## Resolution

The guest control protocol now reports `READY` after the bridge has initialized
and launched the plugin body, then reports `COMPLETE` or `ERROR` separately for
the remaining top-level lifetime. `SandboxHost.run()` retains the lifetime
promise while `SandboxHost.readiness` exposes the bounded startup handshake.
`executePluginV3()` waits only for readiness, observes late failures in the
background under the lifecycle lock, and tears down their registrations without
blocking bootstrap or a reload.

Regression coverage now verifies long-lived top-level service work, lifecycle
queue release, hot reload during a long-lived task, slow successful work, and
late-failure cleanup.
