/// <reference lib="webworker" />

import { runPayloadCodecOperation } from './payloadCodecOperations'
import {
    serializeCodecError,
    type PayloadCodecWorkerRequest,
    type PayloadCodecWorkerResponse,
} from './payloadCodecWorkerProtocol'

const workerScope = self as unknown as DedicatedWorkerGlobalScope
let operationChain: Promise<void> = Promise.resolve()

function resultTransfers(result: Awaited<ReturnType<typeof runPayloadCodecOperation>>): Transferable[] {
    return result.kind === 'encode-chat' ? [result.bytes.buffer as ArrayBuffer] : []
}

workerScope.addEventListener('message', (event: MessageEvent<PayloadCodecWorkerRequest>) => {
    if (event.data?.type !== 'request') return
    const { id, operation } = event.data
    operationChain = operationChain.then(async () => {
        try {
            const result = await runPayloadCodecOperation(operation)
            const response: PayloadCodecWorkerResponse = { type: 'result', id, result }
            workerScope.postMessage(response, resultTransfers(result))
        } catch (error) {
            const response: PayloadCodecWorkerResponse = {
                type: 'error',
                id,
                error: serializeCodecError(error),
            }
            workerScope.postMessage(response)
        }
    })
})

workerScope.postMessage({ type: 'ready' } satisfies PayloadCodecWorkerResponse)
