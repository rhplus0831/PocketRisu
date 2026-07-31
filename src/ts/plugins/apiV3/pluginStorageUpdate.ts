import { abortReason, awaitWithAbort, forwardAbortSignal, throwIfAborted } from "../../storage/abort";
import { StorageError } from "../../storage/storageError";
import type {
    PluginSaveStorageAtomicBatchResult,
    PluginSaveStorageVersionedResult,
} from "../pluginSaveStorage";

export const PLUGIN_STORAGE_UPDATE_MAX_TIMEOUT_MS = 30 * 60_000;

export type PluginStorageUpdateTransform = (
    current: PluginSaveStorageVersionedResult,
    signal: AbortSignal,
) => unknown | Promise<unknown>;

export interface PluginStorageUpdateOptions {
    timeoutMs?: number;
}

type BarrierWaiter = {
    kind: "writer" | "migration";
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    cleanup?: () => void;
};

/**
 * A fair per-plugin writer/migration barrier. Ordinary writes may overlap, but
 * a migration is exclusive from its first versioned read through its final
 * CAS result. A queued migration also stops later writers from overtaking it.
 */
class PluginStorageMigrationBarrier {
    private activeWriters = 0;
    private migrationActive = false;
    private readonly waiters: BarrierWaiter[] = [];

    acquireWriter(signal?: AbortSignal | null): Promise<() => void> {
        return this.acquire("writer", signal);
    }

    acquireMigration(signal?: AbortSignal | null): Promise<() => void> {
        return this.acquire("migration", signal);
    }

    private acquire(
        kind: BarrierWaiter["kind"],
        signal?: AbortSignal | null,
    ): Promise<() => void> {
        throwIfAborted(signal);
        if (!this.migrationActive && this.waiters.length === 0
            && (kind === "writer" || this.activeWriters === 0)) {
            if (kind === "writer") this.activeWriters += 1;
            else this.migrationActive = true;
            return Promise.resolve(this.releaseFor(kind));
        }
        return new Promise((resolve, reject) => {
            const waiter: BarrierWaiter = { kind, resolve, reject };
            if (signal) {
                const onAbort = () => this.cancel(waiter, abortReason(signal));
                signal.addEventListener("abort", onAbort, { once: true });
                waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
            }
            this.waiters.push(waiter);
            this.drain();
        });
    }

    private cancel(waiter: BarrierWaiter, error: unknown): void {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.cleanup?.();
        waiter.reject(error);
        this.drain();
    }

    private releaseFor(kind: BarrierWaiter["kind"]): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (kind === "writer") this.activeWriters -= 1;
            else this.migrationActive = false;
            this.drain();
        };
    }

    private drain(): void {
        if (this.migrationActive || this.waiters.length === 0) return;
        const first = this.waiters[0];
        if (first.kind === "migration") {
            if (this.activeWriters !== 0) return;
            this.waiters.shift();
            first.cleanup?.();
            this.migrationActive = true;
            first.resolve(this.releaseFor("migration"));
            return;
        }
        while (this.waiters[0]?.kind === "writer") {
            const waiter = this.waiters.shift()!;
            waiter.cleanup?.();
            this.activeWriters += 1;
            waiter.resolve(this.releaseFor("writer"));
        }
    }
}

export interface PluginStorageUpdateDependencies {
    read(
        key: string,
        signal?: AbortSignal | null,
    ): Promise<PluginSaveStorageVersionedResult>;
    atomicSet(
        key: string,
        value: unknown,
        expectedRevision: string | null,
        signal?: AbortSignal | null,
    ): Promise<PluginSaveStorageAtomicBatchResult>;
}

/** Coordinates plugin-owned writes with cancellable, revision-safe updates. */
export class PluginStorageUpdateCoordinator {
    private readonly barrier = new PluginStorageMigrationBarrier();
    private readonly pendingPublications = new Set<Promise<void>>();

    constructor(private readonly dependencies: PluginStorageUpdateDependencies) {}

    /** Drain CAS requests whose caller already received an unknown outcome. */
    async drainPendingPublications(): Promise<void> {
        while (this.pendingPublications.size > 0) {
            await Promise.allSettled([...this.pendingPublications]);
        }
    }

    private trackPublication<T>(publication: Promise<T>): Promise<T> {
        let tracked!: Promise<void>;
        tracked = publication.then(
            () => undefined,
            () => undefined,
        ).finally(() => this.pendingPublications.delete(tracked));
        this.pendingPublications.add(tracked);
        return publication;
    }

    async runWriter<T>(
        operation: () => Promise<T>,
        signal?: AbortSignal | null,
    ): Promise<T> {
        const release = await this.barrier.acquireWriter(signal);
        try {
            throwIfAborted(signal);
            return await operation();
        } finally {
            release();
        }
    }

    async updateItem(
        key: string,
        transform: PluginStorageUpdateTransform,
        options: PluginStorageUpdateOptions | null | undefined,
        signals: readonly (AbortSignal | null | undefined)[] = [],
    ): Promise<PluginSaveStorageAtomicBatchResult> {
        if (typeof key !== "string") {
            throw new TypeError("pluginStorage.updateItem requires a string key.");
        }
        if (typeof transform !== "function") {
            throw new TypeError("pluginStorage.updateItem requires a transform function.");
        }
        if (options !== undefined && options !== null
            && (typeof options !== "object" || Array.isArray(options))) {
            throw new TypeError("pluginStorage.updateItem options must be an object.");
        }
        const optionKeys = options ? Object.keys(options) : [];
        if (optionKeys.some(option => option !== "timeoutMs")) {
            throw new TypeError("pluginStorage.updateItem options contain an unsupported field.");
        }
        const timeoutMs = options?.timeoutMs;
        if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs)
            || timeoutMs < 1
            || timeoutMs > PLUGIN_STORAGE_UPDATE_MAX_TIMEOUT_MS)) {
            throw new RangeError(
                `pluginStorage.updateItem timeoutMs must be an integer from 1-${PLUGIN_STORAGE_UPDATE_MAX_TIMEOUT_MS}.`,
            );
        }

        const controller = new AbortController();
        const stopForwarding = signals.map(signal => forwardAbortSignal(signal, controller));
        const timer = timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                controller.abort(new StorageError(
                    `Plugin storage update timed out after ${timeoutMs}ms.`,
                    {
                        code: "STORAGE_TIMEOUT",
                        operation: "update",
                        retryable: true,
                        commitOutcomeUnknown: false,
                    },
                ));
            }, timeoutMs);

        try {
            const signal = controller.signal;
            const release = await this.barrier.acquireMigration(signal);
            let publication: Promise<PluginSaveStorageAtomicBatchResult> | undefined;
            try {
                throwIfAborted(signal);
                const initial = await awaitWithAbort(
                    this.dependencies.read(key, signal),
                    signal,
                );
                const transformed = await awaitWithAbort(
                    Promise.resolve(transform(initial, signal)),
                    signal,
                );
                throwIfAborted(signal);

                // Re-read at the publication boundary. This avoids even
                // submitting a stale transform when another instance wrote
                // during an expensive callback. The server CAS remains the
                // final authority for a write racing this re-read.
                const current = await awaitWithAbort(
                    this.dependencies.read(key, signal),
                    signal,
                );
                throwIfAborted(signal);
                if (current.revision !== initial.revision) {
                    return {
                        committed: false,
                        conflicts: [{
                            key,
                            revision: current.revision,
                            generation: current.generation,
                        }],
                    };
                }

                // Cancellation before this call is known not committed. Once
                // admitted, do not abort the CAS transport: the server may
                // already have committed, and teardown must drain its exact
                // outcome separately even if this caller's deadline wins.
                publication = this.trackPublication(
                    this.dependencies.atomicSet(
                        key,
                        transformed,
                        initial.revision,
                        undefined,
                    ),
                );
                try {
                    return await awaitWithAbort(publication, signal);
                } catch (error) {
                    if (!signal.aborted) throw error;
                    throw new StorageError(
                        "Plugin storage update was cancelled after CAS publication began; it may have committed.",
                        {
                            code: "COMMIT_OUTCOME_UNKNOWN",
                            operation: "update",
                            retryable: false,
                            commitOutcomeUnknown: true,
                            cause: error,
                        },
                    );
                }
            } finally {
                if (publication) {
                    // An expired caller must not reopen the writer barrier
                    // while its non-cancellable CAS is still in flight. The
                    // CAS revision protects cross-instance races; this lock
                    // also preserves the complete local migration interval.
                    void publication.then(release, release);
                } else {
                    release();
                }
            }
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            for (const stop of stopForwarding) stop();
        }
    }
}
