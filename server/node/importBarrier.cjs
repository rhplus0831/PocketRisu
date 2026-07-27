'use strict';

/**
 * Serializes imports against each other, against list-delta reads, and against
 * every storage mutation.
 *
 * Imports hold one raw SQLite transaction open across long asynchronous work
 * (streamed decompression, msgpack walking, filesystem publication). Because the
 * server owns a single writable better-sqlite3 connection, any statement issued
 * during that window silently joins the import transaction — so an endpoint could
 * acknowledge a write with HTTP 200 and then have it discarded by the import's
 * ROLLBACK.
 *
 * `acquire()` therefore claims the hold *before* draining, so mutations split
 * cleanly into two sets: those already queued ahead of the drain (which complete
 * and commit before the import opens its transaction) and those that arrive
 * afterwards (which observe `isHeld()` and are rejected as retryable instead of
 * joining the transaction). `drainMutations` must enqueue onto the same serial
 * queue the mutations use, otherwise that FIFO boundary does not exist.
 */
function createImportBarrier({ drainMutations = null } = {}) {
    let tail = Promise.resolve();
    let heldCount = 0;

    function abortReason(signal) {
        if (signal?.reason !== undefined) return signal.reason;
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        return error;
    }

    function waitForTurn(pending, signal) {
        if (!signal) return pending;
        if (signal.aborted) return Promise.reject(abortReason(signal));
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (operation) => (value) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                operation(value);
            };
            const resolveOnce = finish(resolve);
            const rejectOnce = finish(reject);
            const onAbort = () => rejectOnce(abortReason(signal));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) {
                onAbort();
                return;
            }
            pending.then(resolveOnce, rejectOnce);
        });
    }

    async function acquire(signal = null) {
        if (signal?.aborted) throw abortReason(signal);
        let releaseHold;
        const hold = new Promise((resolve) => {
            releaseHold = resolve;
        });
        const previous = tail;
        tail = previous.then(() => hold);
        try {
            await waitForTurn(previous, signal);
        } catch (error) {
            // Remove this abandoned turn from the tail. It remains ordered
            // behind `previous`, but resolves immediately when that holder
            // releases so later imports are not wedged behind a dead request.
            releaseHold();
            throw error;
        }
        if (signal?.aborted) {
            releaseHold();
            throw abortReason(signal);
        }

        heldCount += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            heldCount -= 1;
            releaseHold();
        };

        if (drainMutations) {
            try {
                // The FIFO drain cannot itself be abandoned: releasing the hold
                // before it completes would allow the next import to open a raw
                // transaction alongside an older mutation. Observe cancellation
                // immediately after the drain and refuse to return a live hold.
                await drainMutations();
                if (signal?.aborted) throw abortReason(signal);
            } catch (error) {
                release();
                throw error;
            }
        } else if (signal?.aborted) {
            release();
            throw abortReason(signal);
        }
        return release;
    }

    // True from the moment a holder claims the barrier until it releases. Callers
    // must consult this from inside the drained mutation queue; checking it from
    // request scope alone races with an import that starts mid-request.
    function isHeld() {
        return heldCount > 0;
    }

    async function waitUntilIdle(signal = null) {
        while (true) {
            if (signal?.aborted) throw abortReason(signal);
            const pending = tail;
            if (!signal) {
                await pending;
            } else {
                await new Promise((resolve, reject) => {
                    let settled = false;
                    const finish = (operation) => (value) => {
                        if (settled) return;
                        settled = true;
                        signal.removeEventListener('abort', onAbort);
                        operation(value);
                    };
                    const resolveOnce = finish(resolve);
                    const rejectOnce = finish(reject);
                    const onAbort = () => rejectOnce(abortReason(signal));
                    signal.addEventListener('abort', onAbort, { once: true });
                    if (signal.aborted) {
                        onAbort();
                        return;
                    }
                    pending.then(resolveOnce, rejectOnce);
                });
            }
            if (pending === tail) return;
        }
    }

    return { acquire, isHeld, waitUntilIdle };
}

module.exports = { createImportBarrier };
