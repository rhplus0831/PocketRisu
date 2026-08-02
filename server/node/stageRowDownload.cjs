'use strict';

const fs = require('fs/promises');

/**
 * Bind validation and response streaming to one read-only descriptor so a
 * staged row is never pre-read for hashing and then reopened for delivery.
 */
async function openStageRowDownload(filePath, expectedSize, options = {}) {
    const openFile = options.openFile ?? fs.open;
    const handle = await openFile(filePath, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== expectedSize) {
            await handle.close();
            return null;
        }
        let closed = false;
        return {
            size: stat.size,
            stream: handle.createReadStream({ autoClose: false }),
            close: async () => {
                if (closed) return;
                closed = true;
                await handle.close();
            },
        };
    } catch (error) {
        await handle.close().catch(() => {});
        throw error;
    }
}

module.exports = { openStageRowDownload };
