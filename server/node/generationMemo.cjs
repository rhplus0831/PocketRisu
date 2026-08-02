'use strict';

function createGenerationMemo() {
    const generations = new Map();
    const entries = new Map();
    let nextGeneration = 1;

    function bump(key) {
        if (!Number.isSafeInteger(nextGeneration)) {
            throw new RangeError('Generation memo exhausted its safe generation range');
        }
        // Process-wide uniqueness within this memo avoids an ABA collision if
        // a retired key is deleted, later reused, and an older async consumer
        // still holds its prior generation token.
        const generation = nextGeneration++;
        generations.set(key, generation);
        entries.delete(key);
        return generation;
    }

    function getOrCompute(key, name, compute) {
        const generation = generations.get(key) || 0;
        let entry = entries.get(key);
        if (!entry || entry.generation !== generation) {
            entry = { generation, values: new Map() };
            entries.set(key, entry);
        }
        if (!entry.values.has(name)) {
            entry.values.set(name, compute());
        }
        return entry.values.get(name);
    }

    function seed(key, name, value) {
        const generation = generations.get(key) || 0;
        let entry = entries.get(key);
        if (!entry || entry.generation !== generation) {
            entry = { generation, values: new Map() };
            entries.set(key, entry);
        }
        entry.values.set(name, value);
    }

    function deleteValue(key, name, expectedGeneration) {
        const generation = generations.get(key) || 0;
        if (expectedGeneration !== undefined && expectedGeneration !== generation) {
            return false;
        }
        const entry = entries.get(key);
        if (!entry || entry.generation !== generation) return false;
        return entry.values.delete(name);
    }

    function has(key, name) {
        const generation = generations.get(key) || 0;
        const entry = entries.get(key);
        return Boolean(entry
            && entry.generation === generation
            && entry.values.has(name));
    }

    function generation(key) {
        return generations.get(key) || 0;
    }

    function deleteKey(key, expectedGeneration) {
        const currentGeneration = generations.get(key) || 0;
        if (expectedGeneration !== undefined && expectedGeneration !== currentGeneration) {
            return false;
        }
        const hadGeneration = generations.delete(key);
        const hadEntry = entries.delete(key);
        return hadGeneration || hadEntry;
    }

    function retention() {
        let values = 0;
        for (const entry of entries.values()) values += entry.values.size;
        return {
            generations: generations.size,
            entries: entries.size,
            values,
        };
    }

    return {
        bump,
        getOrCompute,
        seed,
        deleteValue,
        deleteKey,
        has,
        generation,
        retention,
    };
}

module.exports = { createGenerationMemo };
