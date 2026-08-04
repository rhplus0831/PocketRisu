'use strict';

const policy = require('../../shared/character-defaults-policy.json');

const CHARACTER_DEFAULTS_MARKER_KEY = 'migration/character-defaults-normalized';
const CHARACTER_DEFAULTS_MARKER_VALUE = Buffer.from('done', 'utf-8');

function freshDefault(value) {
    return Array.isArray(value) ? [...value] : value;
}

function fillNullish(target, defaults) {
    let changed = false;
    for (const [field, value] of Object.entries(defaults)) {
        if (target[field] === null || target[field] === undefined) {
            target[field] = freshDefault(value);
            changed = true;
        }
    }
    return changed;
}

function assignId(target, rule, makeId) {
    const current = target[rule.field];
    const missing = rule.missing === 'nullish'
        ? current === null || current === undefined
        : !current;
    if (!missing) return false;
    target[rule.field] = makeId();
    return true;
}

function fillCharacterDefaults(character) {
    let changed = fillNullish(character, policy.characterDefaults);
    if (character.type === 'character') {
        changed = fillNullish(character, policy.characterTypeDefaults) || changed;
    }
    return changed;
}

function applyDatabaseCharacterDefaults(dbObj, makeId) {
    let changed = false;
    if (Array.isArray(dbObj?.characters)) {
        for (const character of dbObj.characters) {
            if (!character || typeof character !== 'object') continue;
            if (assignId(character, policy.idAssignments.character, makeId)) changed = true;
            if (fillCharacterDefaults(character)) changed = true;
        }
    }
    if (Array.isArray(dbObj?.personas)) {
        for (const persona of dbObj.personas) {
            if (!persona || typeof persona !== 'object') continue;
            if (assignId(persona, policy.idAssignments.persona, makeId)) changed = true;
        }
    }
    if (Array.isArray(dbObj?.botPresets)) {
        for (const preset of dbObj.botPresets) {
            if (!preset || typeof preset !== 'object') continue;
            if (assignId(preset, policy.idAssignments.botPreset, makeId)) changed = true;
        }
    }
    return changed;
}

module.exports = {
    CHARACTER_DEFAULTS: policy.characterDefaults,
    CHARACTER_TYPE_DEFAULTS: policy.characterTypeDefaults,
    CHARACTER_ID_ASSIGNMENT: policy.idAssignments.character,
    PERSONA_ID_ASSIGNMENT: policy.idAssignments.persona,
    BOT_PRESET_ID_ASSIGNMENT: policy.idAssignments.botPreset,
    CHARACTER_DEFAULTS_MARKER_KEY,
    CHARACTER_DEFAULTS_MARKER_VALUE,
    fillCharacterDefaults,
    applyDatabaseCharacterDefaults,
};
