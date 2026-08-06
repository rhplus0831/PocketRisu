'use strict';

const fs = require('fs');
const path = require('path');
const {
    finalizeRecoveryPathStateLockHandoffSync,
} = require('../server/node/recoveryPathMarkers.cjs');

function waitAtFinalizerTestGate(stage) {
    if (process.env.NODE_ENV !== 'test') return;
    const configured = String(
        process.env.POCKETRISU_TEST_WINDOWS_FINALIZER_GATE_DIR || '',
    ).trim();
    if (!configured) return;
    const gateDir = path.resolve(configured);
    let selectedStage;
    try { selectedStage = fs.readFileSync(path.join(gateDir, 'stage'), 'utf8').trim(); }
    catch { return; }
    if (selectedStage !== stage || !fs.existsSync(path.join(gateDir, 'hold'))) return;
    fs.writeFileSync(path.join(gateDir, 'entered'), stage);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (fs.existsSync(path.join(gateDir, 'hold'))
        && !fs.existsSync(path.join(gateDir, 'release'))) {
        Atomics.wait(sleeper, 0, 0, 10);
    }
}

const handoffPath = String(process.argv[2] || '').trim();
if (!handoffPath) {
    process.stderr.write('Recovery-path lock finalizer requires a handoff path.\n');
    process.exit(2);
}

try {
    // The batch/post-restart work has completed before this process starts.
    // Keep the inherited logical ownership live through this final gate, then
    // verify the token and release exactly once.
    waitAtFinalizerTestGate('windows-finalizer-before-release');
    finalizeRecoveryPathStateLockHandoffSync(path.resolve(handoffPath));
} catch (error) {
    process.stderr.write(`Recovery-path lock finalization failed: ${error?.message || error}\n`);
    process.exit(1);
}
