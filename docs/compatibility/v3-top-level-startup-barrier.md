# V3 top-level completion became an application startup barrier

- Status: Confirmed regression
- Severity: High
- Confidence: High
- Introduced by: 99253152

## Difference

main launched a V3 plugin's async top-level body and treated executePluginV3()
as complete immediately. serve's guest awaits runner() before READY,
executePluginV3() awaits that readiness promise, loadV3PluginGeneration() waits
for every plugin, and bootstrap awaits loadPlugins().

The same wait holds the global plugin lifecycle queue. Commit 832d69bd only
lengthened the watchdog to 30 minutes.

## Compatibility impact

Historical plugins that register hooks/providers and then await a service loop,
user interaction, polling promise, or top-level LLM call now hold the whole app
at Loading Plugins. A never-settling body is terminated after 30 minutes and
its earlier registrations are removed; the enabled record remains, so the
stall repeats at every boot. Hot reloads are affected too.

## Reproduction

Use a V3 plugin whose body ends with await new Promise(() => {}) after
registering a hook. main reaches the UI and retains the registration. serve
blocks boot, then tears the generation down.

## Recommendation

Separate registration readiness from the plugin lifetime promise. Prefer an
explicit ready signal, observe late failures in the background, and keep
bootstrap waiting only for bounded readiness. Add boot and hot-reload tests for
long-lived and slow-but-successful top-level tasks.
