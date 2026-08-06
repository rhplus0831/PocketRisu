import { describe, expect, test, vi } from 'vitest'
import {
    authorizeImportedDestructiveAccess,
    importedContentRequiresDestructiveAccess,
    isDestructiveScriptCommand,
    literalScriptCommandsRequireDestructiveAccess,
    mergeEmbeddedModuleDestructiveAccess,
    triggersRequireDestructiveAccess,
} from './scriptCapabilities'

function trigger(type: string, code?: string) {
    return { effect: [{ type, ...(code === undefined ? {} : { code }) }] }
}

describe('destructive script capability import consent', () => {
    test.each(['cutchat', 'v2CutChat', 'v2DeleteLorebookByIndex'])(
        'detects %s as destructive',
        type => expect(triggersRequireDestructiveAccess([trigger(type)])).toBe(true),
    )

    test.each(['cutChat', 'removeChat', 'setFullChat'])(
        'detects the Lua %s API',
        api => expect(triggersRequireDestructiveAccess([
            trigger('triggerlua', `function onInput(id) ${api}(id, 0, 1) end`),
        ])).toBe(true),
    )

    test.each([
        '/cut 1-3',
        '/del 2',
        '/pass ignored | /cut message-id',
        '/multisend clear|||replacement',
    ])('detects literal destructive trigger command %s', command => {
        expect(literalScriptCommandsRequireDestructiveAccess(command)).toBe(true)
        expect(triggersRequireDestructiveAccess([{
            effect: [{ type: 'command', value: command }],
        }])).toBe(true)
        expect(triggersRequireDestructiveAccess([{
            effect: [{ type: 'v2Command', valueType: 'value', value: command }],
        }])).toBe(true)
    })

    test('does not statically grant a dynamic V2 command value', () => {
        expect(triggersRequireDestructiveAccess([{
            effect: [{ type: 'v2Command', valueType: 'var', value: 'commandName' }],
        }])).toBe(false)
    })

    test('classifies runtime command variants after argument expansion', () => {
        expect(isDestructiveScriptCommand('cut', 'message-id')).toBe(true)
        expect(isDestructiveScriptCommand('del', '1')).toBe(true)
        expect(isDestructiveScriptCommand('multisend', 'clear|||replacement')).toBe(true)
        expect(isDestructiveScriptCommand('multisend', 'append|||replacement')).toBe(false)
        expect(isDestructiveScriptCommand('send', 'clear')).toBe(false)
    })

    test('does not classify ordinary chat edits or unrelated Lua APIs', () => {
        expect(triggersRequireDestructiveAccess([
            trigger('modifychat'),
            trigger('triggerlua', 'function onInput(id) setChat(id, 0, "safe") end'),
        ])).toBe(false)
    })

    test('requires a decision for either detected effects or a declared imported grant', () => {
        expect(importedContentRequiresDestructiveAccess({
            trigger: [trigger('v2CutChat')],
        })).toBe(true)
        expect(importedContentRequiresDestructiveAccess({
            destructiveAccess: true,
            trigger: [],
        })).toBe(true)
    })

    test('propagates a declared embedded-module grant for dynamically aliased Lua', async () => {
        const cardExtension: {
            destructiveAccess?: boolean
            triggerscript: ReturnType<typeof trigger>[]
        } = {
            triggerscript: [trigger(
                'triggerlua',
                'function onInput(id) local destructive = _G["cut" .. "Chat"]; destructive(id, 0, 1) end',
            )],
        }
        expect(triggersRequireDestructiveAccess(cardExtension.triggerscript)).toBe(false)

        mergeEmbeddedModuleDestructiveAccess(cardExtension, { destructiveAccess: true })
        const confirm = vi.fn(async () => true)
        await expect(authorizeImportedDestructiveAccess(cardExtension, confirm)).resolves.toBe(true)
        expect(confirm).toHaveBeenCalledOnce()
        expect(cardExtension.destructiveAccess).toBe(true)
    })

    test('does not propagate malformed truthy embedded-module grants', () => {
        const cardExtension = {} as { destructiveAccess?: unknown }
        mergeEmbeddedModuleDestructiveAccess(
            cardExtension as any,
            { destructiveAccess: 'false' as any },
        )
        expect(cardExtension.destructiveAccess).toBe(false)
    })

    test('grants only destructive access after consent', async () => {
        const owner = {
            lowLevelAccess: false,
            trigger: [trigger('v2CutChat')],
        }
        const confirm = vi.fn(async () => true)

        await expect(authorizeImportedDestructiveAccess(owner, confirm)).resolves.toBe(true)
        expect(owner).toMatchObject({
            lowLevelAccess: false,
            destructiveAccess: true,
        })
        expect(confirm).toHaveBeenCalledOnce()
    })

    test('fails closed on rejection and strips an unconfirmed imported grant', async () => {
        const owner = {
            destructiveAccess: true,
            trigger: [trigger('v2CutChat')],
        }

        await expect(authorizeImportedDestructiveAccess(owner, async () => false))
            .resolves.toBe(false)
        expect(owner.destructiveAccess).toBe(false)
    })

    test('does not prompt for content without destructive effects', async () => {
        const owner = { trigger: [trigger('v2ModifyChat')] }
        const confirm = vi.fn(async () => true)

        await expect(authorizeImportedDestructiveAccess(owner, confirm)).resolves.toBe(true)
        expect(confirm).not.toHaveBeenCalled()
        expect(owner).toMatchObject({ destructiveAccess: false })
    })
})
