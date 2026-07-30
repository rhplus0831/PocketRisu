import type { RisuPlugin } from "./plugins.svelte";

type PluginVersion = RisuPlugin["version"];

let pluginStorageModeTransitionDepth = 0;
let pluginStorageModeTransitionLatched = false;
let pluginLifecycleQueue: Promise<unknown> = Promise.resolve();
let activePluginLifecycleLease: PluginLifecycleLease | undefined;

export interface PluginLifecycleLease {
    readonly id: symbol;
}

function invokePluginLifecycleOperation<T>(
    operation: (lease: PluginLifecycleLease) => Promise<T>,
    lease: PluginLifecycleLease,
): Promise<T> {
    return Promise.resolve(operation(lease));
}

/**
 * Serialize plugin load/unload work with storage-mode transitions. A transition
 * must not snapshot inline V2 storage until every earlier unload callback has
 * completed or its bounded generation grace has expired, while later reloads
 * must not start until reconciliation finishes.
 */
export function withPluginLifecycleLock<T>(
    operation: (lease: PluginLifecycleLease) => Promise<T>,
    lease?: PluginLifecycleLease,
): Promise<T> {
    if (lease && activePluginLifecycleLease === lease) {
        return invokePluginLifecycleOperation(operation, lease);
    }

    const queuedLease: PluginLifecycleLease = {
        id: Symbol("plugin-lifecycle"),
    };
    const execute = async () => {
        activePluginLifecycleLease = queuedLease;
        try {
            return await invokePluginLifecycleOperation(operation, queuedLease);
        } finally {
            activePluginLifecycleLease = undefined;
        }
    };
    const run = pluginLifecycleQueue.then(execute, execute);
    pluginLifecycleQueue = run.then(() => undefined, () => undefined);
    return run;
}

/** Wait for all lifecycle work that was queued before this call. */
export async function waitForPluginLifecycleIdle(): Promise<void> {
    await pluginLifecycleQueue;
}

export function beginPluginStorageModeTransition(): () => void {
    pluginStorageModeTransitionDepth += 1;
    let finished = false;
    return () => {
        if (finished) return;
        finished = true;
        pluginStorageModeTransitionDepth -= 1;
    };
}

/** Keep synchronous legacy access disabled until a reload can re-read truth. */
export function latchPluginStorageModeTransitionUntilReload(): void {
    pluginStorageModeTransitionLatched = true;
}

export function isPluginStorageModeTransitioning(): boolean {
    return pluginStorageModeTransitionDepth > 0 || pluginStorageModeTransitionLatched;
}

export function isLegacyPluginVersion(version: PluginVersion): boolean {
    return version === 2 || version === "2.1";
}

export function hasEnabledLegacyPlugins(plugins: RisuPlugin[] | undefined): boolean {
    return (plugins ?? []).some((plugin) =>
        plugin.enabled && isLegacyPluginVersion(plugin.version)
    );
}

/**
 * Optimized storage is the authoritative policy for an invalid persisted
 * combination. Legacy plugins are powered off visibly instead of remaining
 * marked enabled while their code is silently skipped.
 */
export function disableEnabledLegacyPluginsForOptimizedMemory(
    plugins: RisuPlugin[] | undefined,
    optimizePluginMemory: boolean | undefined,
): string[] {
    if (optimizePluginMemory !== true) return [];

    const disabled: string[] = [];
    for (const plugin of plugins ?? []) {
        if (!plugin.enabled || !isLegacyPluginVersion(plugin.version)) continue;
        plugin.enabled = false;
        disabled.push(
            plugin.displayName?.trim()
            || plugin.name?.trim()
            || "Unnamed plugin",
        );
    }
    return disabled;
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
