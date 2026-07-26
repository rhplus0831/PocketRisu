export type DatabaseSaveOutcome =
    | { status: "committed" }
    | { status: "retry" }
    | { status: "failed"; error: unknown }
    | { status: "displaced" };

let databaseSavesBlockedUntilReload: unknown = null;
let databaseSavePauseDepth = 0;
let databaseSaveResumePromise: Promise<void> = Promise.resolve();
let resumePausedDatabaseSaves: (() => void) | null = null;

/** Temporarily defer ordinary saves while a server-side transition is staged. */
export function beginDatabaseSavePause(): () => void {
    if (databaseSavePauseDepth === 0) {
        databaseSaveResumePromise = new Promise<void>(resolve => {
            resumePausedDatabaseSaves = resolve;
        });
    }
    databaseSavePauseDepth += 1;
    let resumed = false;
    return () => {
        if (resumed) return;
        resumed = true;
        databaseSavePauseDepth -= 1;
        if (databaseSavePauseDepth === 0) {
            resumePausedDatabaseSaves?.();
            resumePausedDatabaseSaves = null;
        }
    };
}

/**
 * Stop all later database publications after an atomic server mutation whose
 * outcome cannot be resolved. A reload is the only safe way to recover the
 * authoritative mode/generation before another save is attempted.
 */
export function blockDatabaseSavesUntilReload(error: unknown): void {
    databaseSavesBlockedUntilReload = error || new Error(
        "Database saves are blocked until reload because a commit outcome is unknown.",
    );
}

export function requireCommittedDatabaseSave(
    outcome: DatabaseSaveOutcome,
    operation: string,
): void {
    if (outcome.status === "committed") return;

    if (outcome.status === "failed") {
        const detail = outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error);
        throw new Error(`${operation} was not durably committed: ${detail}`);
    }

    throw new Error(`${operation} was not durably committed: ${outcome.status}`);
}

/**
 * Owns the single in-flight database save. Ordinary requests may share the
 * active result, but durability-sensitive requests wait and execute their own
 * save so an older write can never acknowledge a newer snapshot.
 */
export class DatabaseSaveCoordinator {
    private inFlight: Promise<DatabaseSaveOutcome> | null = null;

    async run(
        save: () => Promise<DatabaseSaveOutcome>,
        options: { queueAfterInFlight?: boolean } = {},
    ): Promise<DatabaseSaveOutcome> {
        if (databaseSavesBlockedUntilReload) {
            return { status: "failed", error: databaseSavesBlockedUntilReload };
        }
        if (databaseSavePauseDepth > 0) {
            await databaseSaveResumePromise;
            return this.run(save, options);
        }
        const activeSave = this.inFlight;
        if (activeSave) {
            if (!options.queueAfterInFlight) return activeSave;

            // This request needs its own acknowledgement. The active save's
            // outcome (including an unexpected rejection) cannot satisfy it.
            try {
                await activeSave;
            } catch {
                // Continue with the requested follow-up save.
            }
            return this.run(save, options);
        }

        const currentSave = Promise.resolve().then(save);
        this.inFlight = currentSave;
        try {
            return await currentSave;
        } finally {
            if (this.inFlight === currentSave) this.inFlight = null;
        }
    }
}
