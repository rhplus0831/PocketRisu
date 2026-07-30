export type PluginEditHandler = (
    content: string,
) => string | null | undefined | Promise<string | null | undefined>

export async function applyPluginEditHandlers(
    handlers: Iterable<PluginEditHandler>,
    initialContent: string,
    options: {
        isolateErrors?: boolean
        onError?: (error: unknown) => void
    } = {},
): Promise<string> {
    let content = initialContent
    for (const handler of handlers) {
        try {
            const result = await handler(content)
            if (result !== null && result !== undefined) content = result
        } catch (error) {
            if (!options.isolateErrors) throw error
            options.onError?.(error)
        }
    }
    return content
}
