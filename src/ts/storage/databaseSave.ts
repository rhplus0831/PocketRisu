export type DatabaseSaveOutcome =
    | { status: "committed" }
    | { status: "retry" }
    | { status: "failed"; error: unknown }
    | { status: "displaced" };

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
