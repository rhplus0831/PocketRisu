export const SCRIPT_BULK_CHAT_BACKUP_REASON = 'script-bulk-chat'

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
