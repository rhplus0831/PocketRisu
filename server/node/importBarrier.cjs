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

    async function acquire() {
        let releaseHold;
        const hold = new Promise((resolve) => {
            releaseHold = resolve;
        });
        const previous = tail;
        tail = previous.then(() => hold);
        await previous;

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
                await drainMutations();
            } catch (error) {
                release();
                throw error;
            }
        }
        return release;
    }

    // True from the moment a holder claims the barrier until it releases. Callers
    // must consult this from inside the drained mutation queue; checking it from
    // request scope alone races with an import that starts mid-request.
    function isHeld() {
        return heldCount > 0;
    }

    async function waitUntilIdle() {
        while (true) {
            const pending = tail;
            await pending;
            if (pending === tail) return;
        }
    }

    return { acquire, isHeld, waitUntilIdle };
}

module.exports = { createImportBarrier };
