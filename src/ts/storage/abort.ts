export function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal | null): void {
    if (signal?.aborted) throw abortReason(signal);
}

/** Race work that cannot consume a signal (for example, a UI prompt). */
export function awaitWithAbort<T>(
    operation: PromiseLike<T>,
    signal?: AbortSignal | null,
): Promise<T> {
    if (!signal) return Promise.resolve(operation);
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(operation).then(resolve, reject).finally(() => {
            signal.removeEventListener("abort", onAbort);
        });
    });
}

/** Forward one caller's cancellation into an operation-owned controller. */
export function forwardAbortSignal(
    signal: AbortSignal | null | undefined,
    controller: AbortController,
): () => void {
    if (!signal) return () => undefined;
    const onAbort = () => controller.abort(abortReason(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
}
