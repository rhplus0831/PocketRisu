import { writable } from "svelte/store";

export type PluginStorageRecoveryIssueCode =
    | "invalid-encoded-key"
    | "invalid-json"
    | "unsupported-json"
    | "conflicting-copies"
    | "read-failed"
    | "list-failed"
    | "write-failed"
    | "remove-failed"
    | "persist-failed";

export interface PluginStorageRecoveryIssue {
    /** Machine-readable category. Deliberately excludes exception messages. */
    code: PluginStorageRecoveryIssueCode;
    /** Full encoded KV key, or a non-secret prefix when listing itself failed. */
    encodedKey: string;
}

export interface PluginStorageRecoveryState {
    direction: "externalize" | "internalize";
    issues: PluginStorageRecoveryIssue[];
}

/**
 * Boot reconciliation recovery state shown in Settings -> Plugins.
 *
 * Never put decoded plugin keys, row values, or caught exception messages in
 * this store. It is both the UI model and the diagnostics boundary.
 */
export const pluginStorageRecoveryStore = writable<PluginStorageRecoveryState | null>(null);

export function setPluginStorageRecoveryState(
    state: PluginStorageRecoveryState | null,
): void {
    pluginStorageRecoveryStore.set(state);
}

export function createPluginStorageRecoveryDiagnostic(
    state: PluginStorageRecoveryState,
): string {
    return JSON.stringify({
        direction: state.direction,
        issues: state.issues.map(({ code, encodedKey }) => ({ code, encodedKey })),
    }, null, 2);
}
