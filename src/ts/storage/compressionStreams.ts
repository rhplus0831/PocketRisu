export async function ensureCompressionStreams(): Promise<void> {
    if (typeof globalThis.CompressionStream === 'undefined') {
        const { makeCompressionStream } = await import('compression-streams-polyfill/ponyfill')
        //@ts-expect-error polyfill CompressionStream type is incompatible with globalThis.CompressionStream
        globalThis.CompressionStream = makeCompressionStream(TransformStream)
    }
    if (typeof globalThis.DecompressionStream === 'undefined') {
        const { makeDecompressionStream } = await import('compression-streams-polyfill/ponyfill')
        //@ts-expect-error polyfill DecompressionStream type is incompatible with globalThis.DecompressionStream
        globalThis.DecompressionStream = makeDecompressionStream(TransformStream)
    }
}
