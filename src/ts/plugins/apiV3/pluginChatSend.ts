import type { Chat } from '../../storage/database.svelte'
import type { ChatSendTarget } from '../../process/chatSendTarget'
import type { ChatSendTransaction } from '../../process/chatSendState'

type InputHook = (content: string) => string | null | undefined | Promise<string | null | undefined>

export interface PluginChatSendDependencies {
    getPermission: () => Promise<boolean>
    isGenerationActive: () => boolean
    getActiveTransaction: () => ChatSendTransaction | null
    getDefaultTarget: () => ChatSendTarget
    resolveTarget: (target: ChatSendTarget) => { chat: Chat } | null
    isPluginModelActive: () => boolean
    runGeneration: (
        target: ChatSendTarget,
        transaction: ChatSendTransaction | null,
    ) => Promise<unknown>
    releaseGeneration: () => void
    now?: () => number
}

export interface PluginChatSendController {
    wrapInputHook: <T extends InputHook>(hook: T) => T
    sendChat: (message: string) => Promise<boolean>
}

/**
 * Scope V3 sendChat compatibility to the plugin's own awaited input handler.
 * The depth is deliberately per plugin API instance: an unrelated plugin
 * cannot borrow another plugin's child-turn authority while a hook is pending.
 */
export function createPluginChatSendController(
    dependencies: PluginChatSendDependencies,
): PluginChatSendController {
    let inputHookDepth = 0

    function wrapInputHook<T extends InputHook>(hook: T): T {
        return (async (content: string) => {
            inputHookDepth += 1
            try {
                return await hook(content)
            } finally {
                inputHookDepth -= 1
            }
        }) as T
    }

    async function sendChat(message: string): Promise<boolean> {
        if (!await dependencies.getPermission()) return false

        if (typeof message !== 'string') {
            throw new Error('Message must be a string')
        }
        if (dependencies.isGenerationActive()) {
            throw new Error('A chat is already in progress')
        }

        const transaction = dependencies.getActiveTransaction()
        if (transaction && inputHookDepth === 0) {
            throw new Error('A chat is already in progress')
        }
        if (dependencies.isPluginModelActive()) {
            throw new Error('Sending chat with plugin-based model is currently blocked')
        }

        const target = transaction?.target ?? dependencies.getDefaultTarget()
        const resolvedTarget = dependencies.resolveTarget(target)
        if (!resolvedTarget) {
            throw new Error('No active chat found')
        }

        if (message) {
            resolvedTarget.chat.message.push({
                role: 'user',
                data: message,
                time: (dependencies.now ?? Date.now)(),
            })
        }

        try {
            await dependencies.runGeneration(target, transaction)
        } finally {
            dependencies.releaseGeneration()
        }
        return true
    }

    return { wrapInputHook, sendChat }
}
