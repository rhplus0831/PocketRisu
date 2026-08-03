import { withClientBuildHeader } from "../storage/clientBuild";

const DIAGNOSTIC_EVENT_CAP = 2_000;
const DIAGNOSTIC_FLUSH_DELAY_MS = 2_000;
const DIAGNOSTIC_DESCRIPTION_MAX_BYTES = 60 * 1024;
const diagnosticEncoder = new TextEncoder();

/**
 * Diagnostics stay dormant unless the server injects the tracing flag into the
 * served page (TRACE_REQUEST_FOR_DEBUG=true) or a build bakes it in via
 * VITE_PLUGIN_STORAGE_DIAG=true. Evaluated per call so tests can toggle it.
 */
export function pluginStorageDiagnosticsEnabled(): boolean {
    try {
        if ((globalThis as { __PLUGIN_STORAGE_DIAG__?: unknown })
            .__PLUGIN_STORAGE_DIAG__ === true) {
            return true;
        }
    } catch {
        // Ignore host environments without a readable global.
    }
    try {
        return import.meta.env?.VITE_PLUGIN_STORAGE_DIAG === "true";
    } catch {
        return false;
    }
}

export type PluginStorageDiagnosticValue = string | number | boolean | null | undefined;

export interface PluginStorageDiagnosticEvent {
    seq: number;
    t: number;
    kind: string;
    [field: string]: PluginStorageDiagnosticValue;
}

const events: PluginStorageDiagnosticEvent[] = [];
let sequence = 0;
let flushedThroughSequence = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight = false;
let databaseIds = new WeakMap<object, number>();
let nextDatabaseId = 1;
let lastObservedDatabaseId: number | null = null;

function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushPluginStorageDiagnostics();
    }, DIAGNOSTIC_FLUSH_DELAY_MS);
    if (typeof flushTimer === "object" && "unref" in flushTimer) {
        (flushTimer as ReturnType<typeof setTimeout> & { unref(): void }).unref();
    }
}

export function recordPluginStorageDiagnostic(
    kind: string,
    fields: Record<string, PluginStorageDiagnosticValue> = {},
): PluginStorageDiagnosticEvent {
    const event: PluginStorageDiagnosticEvent = {
        ...fields,
        seq: ++sequence,
        t: Date.now(),
        kind,
    };
    if (!pluginStorageDiagnosticsEnabled()) return event;
    try {
        events.push(event);
        if (events.length > DIAGNOSTIC_EVENT_CAP) {
            const removed = events.splice(0, events.length - DIAGNOSTIC_EVENT_CAP);
            const newestRemoved = removed.at(-1)?.seq;
            if (newestRemoved !== undefined && newestRemoved > flushedThroughSequence) {
                flushedThroughSequence = newestRemoved;
            }
        }
        scheduleFlush();
    } catch {
        // Diagnostics must never change plugin-storage behavior.
    }
    return event;
}

export function pluginStorageDiagnosticDbId(database: object): number {
    if (!pluginStorageDiagnosticsEnabled()) return 0;
    try {
        let id = databaseIds.get(database);
        if (id === undefined) {
            id = nextDatabaseId++;
            databaseIds.set(database, id);
        }
        if (id !== lastObservedDatabaseId) {
            recordPluginStorageDiagnostic("db-changed", {
                oldDbId: lastObservedDatabaseId,
                newDbId: id,
            });
            lastObservedDatabaseId = id;
        }
        return id;
    } catch {
        return 0;
    }
}

function chunkEvents(
    pending: PluginStorageDiagnosticEvent[],
): PluginStorageDiagnosticEvent[][] {
    const chunks: PluginStorageDiagnosticEvent[][] = [];
    let chunk: PluginStorageDiagnosticEvent[] = [];
    for (const event of pending) {
        const candidate = [...chunk, event];
        if (chunk.length > 0
            && diagnosticEncoder.encode(JSON.stringify(candidate)).byteLength
                > DIAGNOSTIC_DESCRIPTION_MAX_BYTES) {
            chunks.push(chunk);
            chunk = [event];
        } else {
            chunk = candidate;
        }
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
}

export async function flushPluginStorageDiagnostics(): Promise<void> {
    if (!pluginStorageDiagnosticsEnabled()) return;
    if (flushInFlight) return;
    const pending = events.filter(event => event.seq > flushedThroughSequence);
    if (pending.length === 0) return;
    flushInFlight = true;
    const capturedThroughSequence = pending.at(-1)!.seq;
    // Captured events are dropped even if authentication or transport fails.
    flushedThroughSequence = capturedThroughSequence;
    try {
        const chunks = chunkEvents(pending);
        const { forageStorage } = await import("../globalApi.svelte");
        const auth = await forageStorage.createAuth();
        for (const chunk of chunks) {
            const timestamp = Date.now();
            await fetch("/api/logs", {
                method: "POST",
                headers: withClientBuildHeader({
                    "Content-Type": "application/json",
                    "risu-auth": auth,
                }),
                body: JSON.stringify([{
                    message: "plugin-storage-diag",
                    source: "plugin-storage-diag",
                    level: "info",
                    timestamp,
                    description: JSON.stringify(chunk),
                }]),
                keepalive: true,
            });
        }
    } catch {
        // Temporary diagnostics are best-effort and never retry failed chunks.
    } finally {
        flushInFlight = false;
        if (events.some(event => event.seq > flushedThroughSequence)) scheduleFlush();
    }
}

function flushOnPageExit(): void {
    void flushPluginStorageDiagnostics();
}

if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushOnPageExit();
    });
}
if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushOnPageExit);
}

export function getPluginStorageDiagnosticEventsForTest(): PluginStorageDiagnosticEvent[] {
    return events.map(event => ({ ...event }));
}

export function resetPluginStorageDiagnosticsForTest(): void {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    events.splice(0);
    sequence = 0;
    flushedThroughSequence = 0;
    flushInFlight = false;
    databaseIds = new WeakMap<object, number>();
    nextDatabaseId = 1;
    lastObservedDatabaseId = null;
}
