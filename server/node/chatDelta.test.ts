import { describe, expect, it } from 'vitest'
import chatDeltaPkg from './chatDelta.cjs'

const {
    ChatDeltaValidationError,
    applyValidatedChatDelta,
    validateChatDeltaPayload,
} = chatDeltaPkg as any

const hash = (digit: string) => digit.repeat(64)

describe('chat delta wire schema', () => {
    it('normalizes the bounded append/whole-message-replace subset', () => {
        const payload = validateChatDeltaPayload({
            version: 1,
            baseHash: hash('a'),
            resultHash: hash('b'),
            resultSize: 123,
            patch: [
                { op: 'replace', path: '/message/0', value: { data: 'edited' } },
                { op: 'add', path: '/message/-', value: { data: 'new' } },
            ],
        }, { baseMessageCount: 1, maxResultBytes: 1024 })

        expect(payload).toMatchObject({
            baseHash: hash('a'),
            resultHash: hash('b'),
            resultSize: 123,
            messageCount: 2,
            patchBytes: Buffer.byteLength(payload.patchJson),
        })
        expect(applyValidatedChatDelta(
            { id: 'chat', message: [{ data: 'old' }] },
            payload.patch,
        )).toEqual({
            id: 'chat',
            message: [{ data: 'edited' }, { data: 'new' }],
        })
    })

    it.each([
        ['unknown envelope field', {
            version: 1, baseHash: hash('a'), resultHash: hash('b'), resultSize: 1,
            patch: [{ op: 'add', path: '/message/-', value: null }], extra: true,
        }],
        ['uppercase digest', {
            version: 1, baseHash: hash('A'), resultHash: hash('b'), resultSize: 1,
            patch: [{ op: 'add', path: '/message/-', value: null }],
        }],
        ['non-message path', {
            version: 1, baseHash: hash('a'), resultHash: hash('b'), resultSize: 1,
            patch: [{ op: 'replace', path: '/name', value: 'changed' }],
        }],
        ['remove operation', {
            version: 1, baseHash: hash('a'), resultHash: hash('b'), resultSize: 1,
            patch: [{ op: 'remove', path: '/message/0', value: null }],
        }],
        ['prototype key', {
            version: 1, baseHash: hash('a'), resultHash: hash('b'), resultSize: 1,
            patch: [{
                op: 'add',
                path: '/message/-',
                value: JSON.parse('{"constructor":"blocked"}'),
            }],
        }],
    ])('rejects %s fail-closed', (_label, payload) => {
        expect(() => validateChatDeltaPayload(payload, { baseMessageCount: 1 }))
            .toThrow(ChatDeltaValidationError)
    })

    it('enforces operation, patch-byte, and logical-row bounds', () => {
        const payload = {
            version: 1,
            baseHash: hash('a'),
            resultHash: hash('b'),
            resultSize: 100,
            patch: [{ op: 'add', path: '/message/-', value: { data: 'payload' } }],
        }
        expect(() => validateChatDeltaPayload(payload, {
            baseMessageCount: 0,
            maxOperations: 0,
        })).toThrow(/operation count/)
        expect(() => validateChatDeltaPayload(payload, {
            baseMessageCount: 0,
            maxBytes: 1,
        })).toThrow(/patch limit/)
        expect(() => validateChatDeltaPayload(payload, {
            baseMessageCount: 0,
            maxResultBytes: 99,
        })).toThrow(/row limit/)
    })
})
