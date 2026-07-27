'use strict';

const { validateJsonFileStreaming } = require('./importSpool.cjs');

(async () => {
    const [, , filePath, sizeRaw, maxBytesRaw] = process.argv;
    const size = Number(sizeRaw);
    const maxBytes = Number(maxBytesRaw);
    if (!filePath || !Number.isSafeInteger(size) || size < 0
        || !Number.isSafeInteger(maxBytes) || maxBytes < size) {
        process.exitCode = 2;
        return;
    }
    try {
        await validateJsonFileStreaming(filePath, { size, maxBytes });
    } catch {
        process.exitCode = 2;
    }
})();
