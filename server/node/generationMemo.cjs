'use strict';

function createGenerationMemo() {
    const generations = new Map();
    const entries = new Map();

    function bump(key) {
        const generation = (generations.get(key) || 0) + 1;
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

    return { bump, getOrCompute, seed, deleteValue, has, generation };
}

module.exports = { createGenerationMemo };
