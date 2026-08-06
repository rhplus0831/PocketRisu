#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
    deduplicateAssetDirectories,
} = require('../server/node/assets/assetDedup.cjs');

function usage() {
    console.error('usage: dedup-assets.sh <assets-dir> [<assets-dir> ...]');
    console.error('example: dedup-assets.sh /srv/pocketrisu/*/save/assets');
}

async function main() {
    const assetDirs = process.argv.slice(2);
    if (assetDirs.length < 1) {
        usage();
        process.exitCode = 2;
        return;
    }

    const crashAt = process.env.NODE_ENV === 'test'
        ? String(process.env.POCKETRISU_TEST_ASSET_DEDUP_CRASH_AT ?? '')
        : '';
    const stageDir = process.env.NODE_ENV === 'test'
        ? String(process.env.POCKETRISU_TEST_ASSET_DEDUP_STAGE_DIR ?? '')
        : '';
    const testLockTimeout = process.env.NODE_ENV === 'test'
        ? Number(process.env.POCKETRISU_TEST_ASSET_DEDUP_LOCK_TIMEOUT_MS ?? 30_000)
        : 30_000;
    const onStage = (stage) => {
        if (stageDir) {
            fs.mkdirSync(stageDir, { recursive: true });
            fs.writeFileSync(path.join(stageDir, stage), String(process.pid), 'utf8');
        }
        if (stage === crashAt) process.kill(process.pid, 'SIGKILL');
    };

    const result = await deduplicateAssetDirectories(assetDirs, {
        onStage,
        lockTimeoutMs: Number.isFinite(testLockTimeout) ? testLockTimeout : 30_000,
    });
    if (result.directories < 2) {
        console.error('[dedup-assets] fewer than two distinct existing asset directories — nothing to dedup.');
        return;
    }
    console.log(
        `[dedup-assets] scanned ${result.scanned} asset(s) in ${result.directories} directorie(s); `
        + `published ${result.linked} hardlink(s); recovered ${result.recovered} interrupted temp name(s).`,
    );
}

main().catch((error) => {
    console.error(`[dedup-assets] ${error?.message || error}`);
    process.exitCode = error?.code === 'ASSET_MAINTENANCE_LOCKED' ? 4 : 1;
});
