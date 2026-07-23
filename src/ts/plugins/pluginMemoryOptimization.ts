import type { RisuPlugin } from "./plugins.svelte";

type PluginVersion = RisuPlugin["version"];

export function isLegacyPluginVersion(version: PluginVersion): boolean {
    return version === 2 || version === "2.1";
}

export function hasEnabledLegacyPlugins(plugins: RisuPlugin[] | undefined): boolean {
    return (plugins ?? []).some((plugin) =>
        plugin.enabled && isLegacyPluginVersion(plugin.version)
    );
}

export function canOptimizePluginMemory(plugins: RisuPlugin[] | undefined): boolean {
    return !hasEnabledLegacyPlugins(plugins);
}

export function shouldDisableImportedPlugin(
    version: PluginVersion,
    optimizePluginMemory: boolean | undefined,
): boolean {
    return optimizePluginMemory === true && isLegacyPluginVersion(version);
}

export function canEnablePlugin(
    plugin: Pick<RisuPlugin, "version">,
    optimizePluginMemory: boolean | undefined,
): boolean {
    return optimizePluginMemory !== true || !isLegacyPluginVersion(plugin.version);
}
