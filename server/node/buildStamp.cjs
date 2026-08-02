'use strict';

const path = require('path');
const { readFileSync } = require('fs');

const CLIENT_BUILD_STAMP_FILE = 'build-stamp.json';
const SAFE_STAMP_PATTERN = /^[A-Za-z0-9._:+-]{1,256}$/;

function readClientBuildStamp({ rootDir = process.cwd(), log = console } = {}) {
    const stampPath = path.join(rootDir, 'dist', CLIENT_BUILD_STAMP_FILE);
    try {
        const parsed = JSON.parse(readFileSync(stampPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object'
            || typeof parsed.version !== 'string'
            || parsed.version.length === 0
            || parsed.version.length > 128
            || typeof parsed.stamp !== 'string'
            || !SAFE_STAMP_PATTERN.test(parsed.stamp)) {
            throw new Error('stamp file has an invalid shape');
        }
        return Object.freeze({
            version: parsed.version,
            stamp: parsed.stamp,
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn(
            `[Build] Client build admission disabled: could not read ${stampPath} (${reason})`,
        );
        return null;
    }
}

module.exports = {
    CLIENT_BUILD_STAMP_FILE,
    readClientBuildStamp,
};
