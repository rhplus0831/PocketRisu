export const SCRIPT_BULK_CHAT_BACKUP_REASON = 'script-bulk-chat'

const DESTRUCTIVE_EFFECT_TYPES = new Set([
    'cutchat',
    'v2CutChat',
    'v2DeleteLorebookByIndex',
])

const DESTRUCTIVE_LUA_API = /\b(?:cutChat|removeChat|setFullChat)\s*\(/

type TriggerLike = {
    effect?: Array<{
        type?: unknown
        code?: unknown
        value?: unknown
        valueType?: unknown
    }>
}

export interface DestructiveScriptCapabilityOwner {
    destructiveAccess?: boolean
    trigger?: unknown
    triggerscript?: unknown
}

export function mergeEmbeddedModuleDestructiveAccess(
    target: DestructiveScriptCapabilityOwner,
    embeddedModule: DestructiveScriptCapabilityOwner,
): void {
    target.destructiveAccess = target.destructiveAccess === true
        || embeddedModule.destructiveAccess === true
}

/** Split the command pipeline while preserving the `|||` multisend delimiter. */
export function splitScriptCommandPipeline(command: string): string[] {
    const commands: string[] = []
    let lastIndex = 0
    let quoteDepth = false
    for (let index = 0; index < command.length; index++) {
        if (command[index] === '"') {
            quoteDepth = !quoteDepth
            continue
        }
        if (!quoteDepth && command.startsWith('|||', index)) {
            index += 2
            continue
        }
        if (!quoteDepth && command[index] === '|') {
            commands.push(command.slice(lastIndex, index))
            lastIndex = index + 1
        }
    }
    commands.push(command.slice(lastIndex))
    return commands
}

export function isDestructiveScriptCommand(commandName: string, arg: string): boolean {
    if (commandName === 'cut' || commandName === 'del') return true
    if (commandName !== 'multisend') return false
    return arg.split('|||')[0]?.trim() === 'clear'
}

export function literalScriptCommandsRequireDestructiveAccess(command: string): boolean {
    return splitScriptCommandPipeline(command).some(segment => {
        const sliced = segment.trim().replace(/^\//, '').split(' ').filter(Boolean)
        const commandName = sliced[0] ?? ''
        const arg = sliced.slice(1)
            .filter(value => !value.includes('='))
            .join(' ')
        return isDestructiveScriptCommand(commandName, arg)
    })
}

function triggerList(owner: DestructiveScriptCapabilityOwner): TriggerLike[] {
    const candidate = Array.isArray(owner.triggerscript)
        ? owner.triggerscript
        : owner.trigger
    return Array.isArray(candidate) ? candidate as TriggerLike[] : []
}

/**
 * Detect imported trigger surfaces that can remove lore or replace/cut the
 * message array. Runtime checks remain authoritative; this scan only decides
 * whether import must ask for the separate destructive capability.
 */
export function triggersRequireDestructiveAccess(triggers: unknown): boolean {
    if (!Array.isArray(triggers)) return false
    return (triggers as TriggerLike[]).some(trigger =>
        Array.isArray(trigger?.effect) && trigger.effect.some(effect => {
            if (DESTRUCTIVE_EFFECT_TYPES.has(String(effect?.type ?? ''))) return true
            if (effect?.type === 'command' && typeof effect.value === 'string') {
                return literalScriptCommandsRequireDestructiveAccess(effect.value)
            }
            if (effect?.type === 'v2Command'
                && effect.valueType === 'value'
                && typeof effect.value === 'string') {
                return literalScriptCommandsRequireDestructiveAccess(effect.value)
            }
            return effect?.type === 'triggerlua'
                && typeof effect.code === 'string'
                && DESTRUCTIVE_LUA_API.test(effect.code)
        }),
    )
}

export function importedContentRequiresDestructiveAccess(
    owner: DestructiveScriptCapabilityOwner,
): boolean {
    return owner.destructiveAccess === true
        || triggersRequireDestructiveAccess(triggerList(owner))
}

/**
 * Imported grants are never trusted directly. The caller must obtain an
 * explicit decision, after which only the destructive capability is granted.
 */
export async function authorizeImportedDestructiveAccess(
    owner: DestructiveScriptCapabilityOwner,
    confirm: () => Promise<boolean>,
): Promise<boolean> {
    const required = importedContentRequiresDestructiveAccess(owner)
    owner.destructiveAccess = false
    if (!required) return true
    if (!await confirm()) return false
    owner.destructiveAccess = true
    return true
}
