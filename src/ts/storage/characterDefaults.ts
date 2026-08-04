import policy from "../../../shared/character-defaults-policy.json";

type MutableRecord = Record<string, any>;
type IdFactory = () => string;
type MissingRule = "falsy" | "nullish";

interface IdAssignmentRule {
    field: string;
    missing: MissingRule;
}

export const CHARACTER_DEFAULTS = policy.characterDefaults;
export const CHARACTER_TYPE_DEFAULTS = policy.characterTypeDefaults;
export const CHARACTER_ID_ASSIGNMENT = policy.idAssignments.character as IdAssignmentRule;
export const PERSONA_ID_ASSIGNMENT = policy.idAssignments.persona as IdAssignmentRule;
export const BOT_PRESET_ID_ASSIGNMENT = policy.idAssignments.botPreset as IdAssignmentRule;

function freshDefault(value: unknown): unknown {
    return Array.isArray(value) ? [...value] : value;
}

function fillNullish(target: MutableRecord, defaults: MutableRecord): void {
    for (const [field, value] of Object.entries(defaults)) {
        if (target[field] === null || target[field] === undefined) {
            target[field] = freshDefault(value);
        }
    }
}

function assignId(
    target: MutableRecord,
    rule: IdAssignmentRule,
    makeId: IdFactory,
): boolean {
    const current = target[rule.field];
    const missing = rule.missing === "nullish"
        ? current === null || current === undefined
        : !current;
    if (!missing) return false;
    target[rule.field] = makeId();
    return true;
}

export function fillCharacterDefaults(character: MutableRecord): void {
    fillNullish(character, CHARACTER_DEFAULTS);
    if (character.type === "character") {
        fillNullish(character, CHARACTER_TYPE_DEFAULTS);
    }
}

export function assignCharacterId(character: MutableRecord, makeId: IdFactory): boolean {
    return assignId(character, CHARACTER_ID_ASSIGNMENT, makeId);
}

export function assignPersonaId(persona: MutableRecord, makeId: IdFactory): boolean {
    return assignId(persona, PERSONA_ID_ASSIGNMENT, makeId);
}

export function assignBotPresetId(preset: MutableRecord, makeId: IdFactory): boolean {
    return assignId(preset, BOT_PRESET_ID_ASSIGNMENT, makeId);
}
