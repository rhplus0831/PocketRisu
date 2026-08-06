'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_MAX_WORKERS = 2;
const configuredWorkers = Number(process.env.POCKETRISU_CHUNK_WORKERS);
const maxWorkers = Number.isSafeInteger(configuredWorkers)
    && configuredWorkers >= 1
    && configuredWorkers <= 4
    ? configuredWorkers
    : DEFAULT_MAX_WORKERS;
const workerPath = path.join(__dirname, 'chunkPlanWorker.cjs');

let activeWorkers = 0;
const waiters = [];
const metrics = {
    started: 0,
    completed: 0,
    failed: 0,
    queued: 0,
    active: 0,
    maxActive: 0,
    maxWindowBytes: 0,
    cdcPasses: 0,
    logicalDigestPasses: 0,
};

function acquireWorkerTurn() {
    if (activeWorkers < maxWorkers) {
        activeWorkers++;
        metrics.active = activeWorkers;
        metrics.maxActive = Math.max(metrics.maxActive, activeWorkers);
        return Promise.resolve();
    }
    metrics.queued++;
    return new Promise((resolve) => waiters.push(resolve)).then(() => {
        activeWorkers++;
        metrics.active = activeWorkers;
        metrics.maxActive = Math.max(metrics.maxActive, activeWorkers);
    });
}

function releaseWorkerTurn() {
    activeWorkers--;
    metrics.active = activeWorkers;
    waiters.shift()?.();
}

function runWorker(filePath, { forceFailure = false } = {}) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(workerPath, {
            workerData: { filePath, forceFailure },
        });
        let settled = false;
        const finish = (error, plan) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(plan);
        };
        worker.once('message', (message) => {
            if (message?.ok) finish(null, message.plan);
            else {
                const error = new Error(message?.error || 'Chunk-plan worker failed');
                if (message?.code) error.code = message.code;
                finish(error);
            }
        });
        worker.once('error', (error) => finish(error));
        worker.once('exit', (code) => {
            if (code !== 0) finish(new Error(`Chunk-plan worker exited with code ${code}`));
            else finish(new Error('Chunk-plan worker exited without a result'));
        });
    });
}

async function prepareFileChunkPlan(filePath, options = {}) {
    await acquireWorkerTurn();
    metrics.started++;
    try {
        const plan = await runWorker(filePath, options);
        metrics.completed++;
        metrics.maxWindowBytes = Math.max(metrics.maxWindowBytes, plan.maxWindowBytes ?? 0);
        metrics.cdcPasses += plan.cdcPasses ?? 0;
        metrics.logicalDigestPasses += plan.logicalDigestPasses ?? 0;
        return plan;
    } catch (error) {
        metrics.failed++;
        throw error;
    } finally {
        releaseWorkerTurn();
    }
}

function chunkPlanMetrics() {
    return { maxWorkers, ...metrics };
}

function resetChunkPlanMetricsForTests() {
    if (activeWorkers !== 0 || waiters.length !== 0) {
        throw new Error('Cannot reset chunk-plan metrics while workers are active');
    }
    for (const key of Object.keys(metrics)) metrics[key] = 0;
}

module.exports = {
    DEFAULT_MAX_WORKERS,
    prepareFileChunkPlan,
    chunkPlanMetrics,
    resetChunkPlanMetricsForTests,
};
