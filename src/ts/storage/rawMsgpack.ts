import { Packr, Unpackr } from 'msgpackr/index-no-eval'
import { createBoundedMsgpackEncoder } from './boundedMsgpack'

const packr = new Packr({
    useRecords: false,
    variableMapSize: true,
})
const encodeMsgpack = createBoundedMsgpackEncoder(packr)

const unpackr = new Unpackr({
    copyBuffers: true,
    int64AsType: 'number',
    useRecords: false,
})

export function encodeRawMsgpack(value: unknown): Uint8Array {
    return encodeMsgpack(value)
}

export function decodeRawMsgpack(value: Uint8Array): any {
    return unpackr.decode(value)
}
