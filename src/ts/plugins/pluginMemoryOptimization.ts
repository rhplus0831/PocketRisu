import type { RisuPlugin } from "./plugins.svelte";

type PluginVersion = RisuPlugin["version"];

let pluginStorageModeTransitionDepth = 0;

export function beginPluginStorageModeTransition(): () => void {
    pluginStorageModeTransitionDepth += 1;
    let finished = false;
    return () => {
        if (finished) return;
        finished = true;
        pluginStorageModeTransitionDepth -= 1;
    };
}

export function isPluginStorageModeTransitioning(): boolean {
    return pluginStorageModeTransitionDepth > 0;
}

export function isLegacyPluginVersion(version: PluginVersion): boolean {
    return version === 2 || version === "2.1";
}

export function hasEnabledLegacyPlugins(plugins: RisuPlugin[] | undefined): boolean {
    return (plugins ?? []).some((plugin) =>
        plugin.enabled && isLegacyPluginVersion(plugin.version)
    );
}

export function canOptimizePluginMemory(plugins: RisuPlugin[] | undefined): boolean {
    return !isPluginStorageModeTransitioning() && !hasEnabledLegacyPlugins(plugins);
}

export function shouldDisableImportedPlugin(
    version: PluginVersion,
    optimizePluginMemory: boolean | undefined,
): boolean {
    return isLegacyPluginVersion(version)
        && (optimizePluginMemory === true || isPluginStorageModeTransitioning());
}

export function canEnablePlugin(
    plugin: Pick<RisuPlugin, "version">,
    optimizePluginMemory: boolean | undefined,
): boolean {
    return !isLegacyPluginVersion(plugin.version)
        || (optimizePluginMemory !== true && !isPluginStorageModeTransitioning());
}
