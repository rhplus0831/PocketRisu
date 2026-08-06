import { describe, expect, test } from 'vitest'
import { splitScriptCommandPipeline } from './scriptCapabilities'

describe('script command pipeline splitting', () => {
    test('preserves the multisend field delimiter', () => {
        expect(splitScriptCommandPipeline('/multisend clear|||first|||second | /pass done'))
            .toEqual(['/multisend clear|||first|||second ', ' /pass done'])
    })

    test('does not split quoted pipes', () => {
        expect(splitScriptCommandPipeline('/pass "one|two" | /pass three'))
            .toEqual(['/pass "one|two" ', ' /pass three'])
    })
})
