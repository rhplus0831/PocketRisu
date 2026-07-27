// Asset keys are content-addressed (`assets/<hash>.<ext>`) and are written with
// no if-match header, so re-sending the same bytes to the same key is a no-op on
// the server — unlike database.bin, where an unconfirmed write actually matters.
// That makes asset writes safe to retry.
//
// A busy instance can stall long enough to fail a whole batch of concurrent
// saves at once, and the CharX importer aborts the entire character import if
// any single asset fails. Retrying here turns those blips back into successes.
//
// Deliberately dependency-free so it stays unit-testable without dragging in the
// app shell that globalApi.svelte.ts pulls along.

export const ASSET_SAVE_RETRY_DELAYS_MS = [500, 1500, 4000, 10000]

const defaultWait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Runs an idempotent asset write, retrying transient failures with jittered
 * backoff. A ConflictError is a stable disagreement about existing state, so
 * resending identical bytes cannot resolve it and it propagates immediately.
 */
export async function withAssetSaveRetry<T>(
    key: string,
    write: () => Promise<T>,
    delaysMs: readonly number[] = ASSET_SAVE_RETRY_DELAYS_MS,
    wait: (ms: number) => Promise<void> = defaultWait,
): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
        if (attempt > 0) {
            // Jitter: a character import saves ten assets at once, and without it
            // every one of them would retry in the same instant.
            const base = delaysMs[attempt - 1]
            await wait(base + Math.floor(Math.random() * base * 0.5))
        }
        try {
            return await write()
        } catch (error) {
            if (error instanceof Error && error.name === 'ConflictError') {
                throw error
            }
            lastError = error
        }
    }
    // Name the asset and keep the cause: the CharX importer only reports how many
    // assets failed, so without this the underlying reason is lost entirely.
    throw new Error(
        `Failed to save ${key} after ${delaysMs.length + 1} attempts`
        + `: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        { cause: lastError },
    )
}
