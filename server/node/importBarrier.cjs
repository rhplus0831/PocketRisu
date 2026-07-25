'use strict';

function createImportBarrier() {
    let tail = Promise.resolve();

    async function acquire() {
        let releaseHold;
        const hold = new Promise((resolve) => {
            releaseHold = resolve;
        });
        const previous = tail;
        tail = previous.then(() => hold);
        await previous;

        let released = false;
        return () => {
            if (released) return;
            released = true;
            releaseHold();
        };
    }

    async function waitUntilIdle() {
        while (true) {
            const pending = tail;
            await pending;
            if (pending === tail) return;
        }
    }

    return { acquire, waitUntilIdle };
}

module.exports = { createImportBarrier };
