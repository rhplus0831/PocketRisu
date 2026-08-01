import { Packr, Unpackr } from 'msgpackr/index-no-eval'

const packr = new Packr({
    useRecords: false,
    variableMapSize: true,
})

const unpackr = new Unpackr({
    copyBuffers: true,
    int64AsType: 'number',
    useRecords: false,
})

export function encodeRawMsgpack(value: unknown): Uint8Array {
    return packr.encode(value)
}

export function decodeRawMsgpack(value: Uint8Array): any {
    return unpackr.decode(value)
}
