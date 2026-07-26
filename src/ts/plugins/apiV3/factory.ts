import { safeStructuredClone } from "../../polyfill";

type MsgType =
    | 'CALL_ROOT'
    | 'CALL_INSTANCE'
    | 'INVOKE_CALLBACK'
    | 'CALLBACK_RETURN'
    | 'RESPONSE'
    | 'RELEASE_INSTANCE'
    | 'ABORT_SIGNAL'
    | 'EXEC_RESULT'
    | 'CANCEL_REQUEST';

export const PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS = 20_000;
export const PLUGIN_BRIDGE_INITIALIZATION_TIMEOUT_MS = 30_000;

const ABORTABLE_ROOT_METHODS = new Set([
    'getDatabase',
    'setDatabase',
    'setDatabaseLite',
    '_getPluginStorage',
    '_setPluginStorage',
    '_removePluginStorage',
    '_clearPluginStorage',
    '_keyPluginStorage',
    '_keysPluginStorage',
    '_lengthPluginStorage',
    '_setSafeLocalStorage',
    '_removeSafeLocalStorage',
    '_clearSafeLocalStorage',
]);

interface RpcMessage {
    type: MsgType;
    reqId?: string;
    id?: string;
    method?: string;
    args?: any[];
    result?: any;
    error?: V3BridgeErrorPayload | string;
    errorStack?: string;
    abortId?: string;
}

export interface V3BridgeErrorPayload {
    __type: 'ERROR';
    name: string;
    message: string;
    status?: number | null;
    code?: string | null;
    retryAfter?: number | null;
    retryable?: boolean;
    commitOutcomeUnknown?: boolean;
    operation?: string | null;
}

/** Self-contained because its source is also installed in the iframe guest. */
export function serializeV3BridgeError(error: unknown): V3BridgeErrorPayload {
    const source = error && typeof error === 'object'
        ? error as Record<string, unknown>
        : null;
    let message: string;
    if (typeof error === 'string') message = error;
    else if (typeof source?.message === 'string' && source.message.length > 0) message = source.message;
    else if (error !== undefined && error !== null && String(error) !== '[object Object]') message = String(error);
    else message = 'Execution error';

    const payload: V3BridgeErrorPayload = {
        __type: 'ERROR',
        name: typeof source?.name === 'string' && source.name.length > 0 ? source.name : 'Error',
        message,
    };
    const status = source?.status;
    const code = source?.code;
    const retryAfter = source?.retryAfter;
    const retryable = source?.retryable;
    const commitOutcomeUnknown = source?.commitOutcomeUnknown;
    const operation = source?.operation;
    if (typeof status === 'number') payload.status = status;
    else if (status === null) payload.status = null;
    if (typeof code === 'string') payload.code = code;
    else if (code === null) payload.code = null;
    if (typeof retryAfter === 'number') payload.retryAfter = retryAfter;
    else if (retryAfter === null) payload.retryAfter = null;
    if (typeof retryable === 'boolean') payload.retryable = retryable;
    if (typeof commitOutcomeUnknown === 'boolean') {
        payload.commitOutcomeUnknown = commitOutcomeUnknown;
    }
    if (typeof operation === 'string') payload.operation = operation;
    else if (operation === null) payload.operation = null;
    return payload;
}

/** Self-contained because its source is also installed in the iframe guest. */
export function deserializeV3BridgeError(input: unknown): Error {
    if (typeof input === 'string') return new Error(input);
    const source = input && typeof input === 'object'
        ? input as Record<string, unknown>
        : null;
    const message = typeof source?.message === 'string' && source.message.length > 0
        ? source.message
        : 'Execution error';
    const error = new Error(message) as Error & {
        status?: number | null;
        code?: string | null;
        retryAfter?: number | null;
        retryable?: boolean;
        commitOutcomeUnknown?: boolean;
        operation?: string | null;
    };
    const name = source?.name;
    const status = source?.status;
    const code = source?.code;
    const retryAfter = source?.retryAfter;
    const retryable = source?.retryable;
    const commitOutcomeUnknown = source?.commitOutcomeUnknown;
    const operation = source?.operation;
    if (typeof name === 'string' && name.length > 0) error.name = name;
    if (typeof status === 'number') error.status = status;
    else if (status === null) error.status = null;
    if (typeof code === 'string') error.code = code;
    else if (code === null) error.code = null;
    if (typeof retryAfter === 'number') error.retryAfter = retryAfter;
    else if (retryAfter === null) error.retryAfter = null;
    if (typeof retryable === 'boolean') error.retryable = retryable;
    if (typeof commitOutcomeUnknown === 'boolean') {
        error.commitOutcomeUnknown = commitOutcomeUnknown;
    }
    if (typeof operation === 'string') error.operation = operation;
    else if (operation === null) error.operation = null;
    return error;
}

type GuestControlMessage = {
    type: 'READY' | 'ERROR';
    error?: V3BridgeErrorPayload | string;
    errorStack?: string;
};

const unloadAuthorizedCallbacks = new WeakSet<Function>();

export function authorizeSandboxCallbackDuringTermination<T extends Function>(callback: T): T {
    unloadAuthorizedCallbacks.add(callback);
    return callback;
}

function validateAsyncFunctionBody(source: string): void {
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    // Compile only. This enforces that plugin source remains an async function
    // body and cannot close the generated runner wrapper before srcdoc exists.
    new AsyncFunction(source);
}

/** Self-contained because its source is also installed in the iframe guest. */
export function createV3BridgeRequestRegistry(options: {
    requestTimeoutMs: number;
    serializeArgs: (args: any[]) => any[];
    collectTransferables: (message: any) => Transferable[];
    send: (message: any, transferables?: Transferable[]) => void;
    deserializeError: (error: unknown) => Error;
    deserializeResult: (result: unknown) => unknown;
}) {
    const requestGeneration = globalThis.crypto.randomUUID();
    let requestSequence = 0;
    const pendingRequests = new Map<string, {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    const rootMutations: Record<string, "write" | "remove"> = {
        _setPluginStorage: 'write',
        _removePluginStorage: 'remove',
        _clearPluginStorage: 'remove',
        setDatabase: 'write',
        setDatabaseLite: 'write',
        _setSafeLocalStorage: 'write',
        _removeSafeLocalStorage: 'remove',
        _clearSafeLocalStorage: 'remove',
    };
    const instanceMutations: Record<string, "write" | "remove"> = {
        setItem: 'write',
        removeItem: 'remove',
        clear: 'remove',
    };

    const mutationOperation = (type: string, method: string | undefined) => (
        type === 'CALL_ROOT'
            ? rootMutations[method ?? '']
            : type === 'CALL_INSTANCE'
                ? instanceMutations[method ?? '']
                : undefined
    );

    const sendRequest = (type: string, payload: any) => new Promise((resolve, reject) => {
        // A generation-unique prefix prevents a late response from an older
        // registry instance from matching a new request. The monotonic suffix
        // cannot collide within this registry, including after timeouts.
        const reqId = `${requestGeneration}:${requestSequence++}`;
        const timer = setTimeout(() => {
            if (!pendingRequests.delete(reqId)) return;
            try {
                options.send({ type: 'CANCEL_REQUEST', reqId });
            } catch {
                // Cancellation is advisory; the local request is already bounded.
            }
            const operation = mutationOperation(type, payload.method);
            const error = new Error(
                'Plugin bridge request timed out after ' + options.requestTimeoutMs + 'ms.',
            ) as Error & Record<string, unknown>;
            error.name = 'StorageError';
            error.code = operation ? 'COMMIT_OUTCOME_UNKNOWN' : 'STORAGE_TIMEOUT';
            error.retryable = !operation;
            error.commitOutcomeUnknown = !!operation;
            error.operation = operation || null;
            reject(error);
        }, options.requestTimeoutMs);
        pendingRequests.set(reqId, { resolve, reject, timer });

        try {
            const args = payload.args
                ? options.serializeArgs(payload.args)
                : payload.args;
            const message = { type, reqId, ...payload, args };
            const transferables = options.collectTransferables(message);
            options.send(message, transferables);
        } catch (error) {
            clearTimeout(timer);
            pendingRequests.delete(reqId);
            reject(error);
        }
    });

    const handleResponse = (data: any): boolean => {
        const request = data?.reqId ? pendingRequests.get(data.reqId) : undefined;
        if (!request) return false;
        pendingRequests.delete(data.reqId);
        clearTimeout(request.timer);
        if (data.error) request.reject(options.deserializeError(data.error));
        else request.resolve(options.deserializeResult(data.result));
        return true;
    };

    const cancelAll = (reason = new Error('Plugin bridge terminated.')) => {
        for (const [reqId, request] of pendingRequests) {
            clearTimeout(request.timer);
            request.reject(reason);
            try {
                options.send({ type: 'CANCEL_REQUEST', reqId });
            } catch {
                // The iframe may already be detached.
            }
        }
        pendingRequests.clear();
    };

    return {
        sendRequest,
        handleResponse,
        cancelAll,
        pendingCount: () => pendingRequests.size,
    };
}

interface RemoteRef {
    __type: 'REMOTE_REF';
    id: string;
}

interface CallbackRef {
    __type: 'CALLBACK_REF';
    id: string;
}

interface AbortSignalRef {
    __type: 'ABORT_SIGNAL_REF';
    abortId: string;
    aborted: boolean;
}

/**
 * Validate database-setter descriptors before postMessage structured cloning
 * can discard symbols/non-enumerables or evaluate accessors. Kept
 * self-contained because its compiled source is installed in the guest.
 */
export function validateV3DatabaseMutationForTransport(input: unknown): void {
    const assertTransportKey = (value: string): void => {
        for (let index = 0; index < value.length; index += 1) {
            const codeUnit = value.charCodeAt(index);
            if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
                const trailing = value.charCodeAt(index + 1);
                if (!(trailing >= 0xDC00 && trailing <= 0xDFFF)) {
                    throw new Error("Plugin storage keys must be well-formed Unicode.");
                }
                index += 1;
            } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
                throw new Error("Plugin storage keys must be well-formed Unicode.");
            }
        }
    };
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("V3 database updates require a DatabaseSubset object.");
    }
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string") {
            throw new TypeError("V3 database updates do not accept symbol keys.");
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !("value" in descriptor)) {
            throw new TypeError(`V3 database updates do not accept an accessor for ${key}.`);
        }
        if (!descriptor.enumerable) {
            throw new TypeError(`V3 database updates require an enumerable data property for ${key}.`);
        }
        if (key !== "pluginCustomStorage") continue;

        const storage = descriptor.value;
        if (storage === null || typeof storage !== "object" || Array.isArray(storage)) {
            throw new TypeError("pluginCustomStorage must be a JSON object when provided.");
        }
        const prototype = Reflect.getPrototypeOf(storage);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("pluginCustomStorage must be a plain JSON object.");
        }
        for (const storageKey of Reflect.ownKeys(storage)) {
            if (typeof storageKey !== "string") {
                throw new TypeError("pluginCustomStorage does not accept symbol keys.");
            }
            assertTransportKey(storageKey);
            const storageDescriptor = Reflect.getOwnPropertyDescriptor(storage, storageKey);
            if (!storageDescriptor || !("value" in storageDescriptor)) {
                throw new TypeError(
                    `pluginCustomStorage does not accept an accessor for ${storageKey}.`,
                );
            }
            if (!storageDescriptor.enumerable) {
                throw new TypeError(
                    `pluginCustomStorage requires an enumerable data property for ${storageKey}.`,
                );
            }
        }
    }
}


const GUEST_BRIDGE_SCRIPT = `
await (async function() {
    const requestTimeoutMs = ${PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS};
    const callbackRegistry = new Map();
    const callbackIdByFunction = new WeakMap();
    const proxyRefRegistry = new Map();
    const abortControllers = new Map();
    const bridgeGeneration = globalThis.crypto.randomUUID();
    let nextBridgeId = 0;
    const allocateBridgeId = (prefix) => prefix + bridgeGeneration + ':' + nextBridgeId++;
    const validateDatabaseMutationForTransport = ${validateV3DatabaseMutationForTransport.toString()};
    const serializeBridgeError = ${serializeV3BridgeError.toString()};
    const deserializeBridgeError = ${deserializeV3BridgeError.toString()};
    const createRequestRegistry = ${createV3BridgeRequestRegistry.toString()};

    function serializeArg(arg) {
        if (typeof arg === 'function') {
            const existingId = callbackIdByFunction.get(arg);
            if (existingId) {
                return { __type: 'CALLBACK_REF', id: existingId };
            }
            const id = allocateBridgeId('cb_');
            callbackRegistry.set(id, arg);
            callbackIdByFunction.set(arg, id);
            return { __type: 'CALLBACK_REF', id: id };
        }
        if (arg && typeof arg === 'object') {
            const refId = proxyRefRegistry.get(arg);
            if (refId) {
                return { __type: 'REMOTE_REF', id: refId };
            }
            if (arg.constructor === Object) {
                let out = null;
                for (const [key, val] of Object.entries(arg)) {
                    if (val instanceof AbortSignal) {
                        if (!out) out = { ...arg };
                        const abortId = allocateBridgeId('abort_');

                        if (!val.aborted) {
                            val.addEventListener('abort', () => {
                                send({ type: 'ABORT_SIGNAL', abortId });
                            }, { once: true });
                        }

                        out[key] = { __type: 'ABORT_SIGNAL_REF', abortId, aborted: val.aborted };
                    }
                }
                if (out) return out;
            }
        }
        return arg;
    }

    function deserializeResult(val) {
        if (val && typeof val === 'object' && val.__type === 'REMOTE_REF') {
            const proxy = new Proxy({}, {
                get: (target, prop) => {
                    if (prop === 'then') return undefined;
                    if (prop === 'release') {
                        return () => send({ type: 'RELEASE_INSTANCE', id: val.id });
                    }
                    return (...args) => sendRequest('CALL_INSTANCE', {
                        id: val.id,
                        method: prop,
                        args: args
                    });
                }
            });
            // Store the mapping so we can serialize it back
            proxyRefRegistry.set(proxy, val.id);
            return proxy;
        }
        if (val && typeof val === 'object' && val.__type === 'CALLBACK_STREAMS') {
            //specialType, one of
            // - Response
            // - none
            const specialType = val.__specialType;
            if (specialType === 'Response') {
                return new Response(val.value, val.init);
            }
            return val.value;
        }
        return val;
    }

    function collectTransferables(obj, transferables = []) {
        if (!obj || typeof obj !== 'object') return transferables;

        if (obj instanceof ArrayBuffer ||
            obj instanceof MessagePort ||
            (typeof ImageBitmap !== 'undefined' && obj instanceof ImageBitmap) ||
            (typeof OffscreenCanvas !== 'undefined' && obj instanceof OffscreenCanvas)) {
            transferables.push(obj);
        }
        else if (ArrayBuffer.isView(obj) && obj.buffer instanceof ArrayBuffer) {
            transferables.push(obj.buffer);
        }
        else if (Array.isArray(obj)) {
            obj.forEach(item => collectTransferables(item, transferables));
        }
        else if (obj.constructor === Object) {
            Object.values(obj).forEach(value => collectTransferables(value, transferables));
        }

        return transferables;
    }

    function send(payload, transferables = []) {
        window.parent.postMessage(payload, '*', transferables);
    }

    const requestRegistry = createRequestRegistry({
        requestTimeoutMs,
        serializeArgs: (args) => args.map(serializeArg),
        collectTransferables,
        send,
        deserializeError: deserializeBridgeError,
        deserializeResult,
    });

    function sendRequest(type, payload) {
        if (type === 'CALL_ROOT'
            && (payload.method === 'setDatabase' || payload.method === 'setDatabaseLite')) {
            try {
                validateDatabaseMutationForTransport(payload.args?.[0]);
            } catch (error) {
                return Promise.reject(error);
            }
        }
        return requestRegistry.sendRequest(type, payload);
    }

    
    
    
    window.addEventListener('message', async (event) => {
        const data = event.data;
        if (!data) return;


        if (data.type === 'RESPONSE' && data.reqId) {
            requestRegistry.handleResponse(data);
        }

        else if (data.type === 'EXECUTE_CODE' && data.reqId) {
            const response = { type: 'EXEC_RESULT', reqId: data.reqId };
            try {
                const result = await eval('(async () => {' + data.code + '})()');
                response.result = result;
            } catch (e) {
                response.error = serializeBridgeError(e);
            }
            send(response);
        }

        else if (data.type === 'ABORT_SIGNAL' && data.abortId) {
            const controller = abortControllers.get(data.abortId);
            if (controller) {
                controller.abort();
                abortControllers.delete(data.abortId);
            }
        }

        else if (data.type === 'INVOKE_CALLBACK' && data.id) {
            const fn = callbackRegistry.get(data.id);
            const response = { type: 'CALLBACK_RETURN', reqId: data.reqId };
            const usedAbortIds = [];

            try {
                if (!fn) throw new Error("Callback not found or released");
                const deserializedArgs = (data.args || []).map(function(a) {
                    if (a && typeof a === 'object' && a.__type === 'ABORT_SIGNAL_REF') {
                        const controller = new AbortController();
                        abortControllers.set(a.abortId, controller);
                        usedAbortIds.push(a.abortId);
                        if (a.aborted) { controller.abort(); }
                        return controller.signal;
                    }
                    return a;
                });
                const result = await fn(...deserializedArgs);
                response.result = result;
            } catch (e) {
                response.error = serializeBridgeError(e);
            }
            // Clean up abort controllers after callback completes
            for (const id of usedAbortIds) {
                abortControllers.delete(id);
            }
            const transferables = collectTransferables(response);
            send(response, transferables);
        }
    });





    const propertyCache = new Map();

    window.risuai = new Proxy({}, {
        get: (target, prop) => {
            if (propertyCache.has(prop)) {
                return propertyCache.get(prop);
            }
            return (...args) => sendRequest('CALL_ROOT', { method: prop, args: args });
        }
    });
    window.Risuai = window.risuai;

    try {
        // Initialize cached properties
        const propsToInit = await window.risuai._getPropertiesForInitialization();
        console.log('Initializing risuai properties:', JSON.stringify(propsToInit.list));
        for (let i = 0; i < propsToInit.list.length; i++) {
            const key = propsToInit.list[i];
            const value = propsToInit[key];
            propertyCache.set(key, value);
        }

        // Initialize aliases
        const aliases = await window.risuai._getAliases();
        const aliasKeys = Object.keys(aliases);
        for (let i = 0; i < aliasKeys.length; i++) {
            const aliasKey = aliasKeys[i];
            const childrens = Object.keys(aliases[aliasKey]);
            const aliasObj = {};
            for (let j = 0; j < childrens.length; j++) {
                const childKey = childrens[j];
                aliasObj[childKey] = risuai[aliases[aliasKey][childKey]];
            }
            propertyCache.set(aliasKey, aliasObj);
        }

        // Initialize helper functions defined in the guest

        propertyCache.set('unwarpSafeArray', async (safeArray) => {
            const length = await safeArray.length();
            const result = [];
            for (let i = 0; i < length; i++) {
                const item = await safeArray.at(i);
                result.push(item);
            }
            return result;
        });
    } catch (e) {
        console.error('Failed to initialize risuai properties:', e);
        throw e;
    }

    window.initOldApiGlobal = () => {
        const keys = risuai._getOldKeys()
        for(const key of keys){
            window[key] = risuai[key];
        }
    }

    Object.freeze(window.postMessage);
})();
`;

const GUEST_RUNNER_REGISTRATION = '__RISU_REGISTER_PLUGIN_RUNNER__';

function escapeInlineScriptSource(source: string): string {
    // HTML's script-data parser terminates on a literal </script regardless of
    // whether JavaScript sees it inside a string, template, regex, or comment.
    // Escaping the slash preserves the JavaScript value while keeping the
    // generated wrapper intact.
    return source.replace(/<\/script/gi, '<\\/script');
}

function createGuestRuntimeScript(controlToken: string): string {
    return `
(() => {
    const hostWindow = window.parent;
    const controlChannel = new MessageChannel();
    const controlPort = controlChannel.port1;
    const serializeBridgeError = ${serializeV3BridgeError.toString()};
    let runnerResolve;
    const runnerPromise = new Promise(resolve => { runnerResolve = resolve; });
    let sourceError;
    let reported = false;

    controlPort.start?.();
    hostWindow.postMessage({
        type: 'RISU_PLUGIN_CONTROL_INIT',
        token: ${JSON.stringify(controlToken)},
        port: controlChannel.port2,
    }, '*', [controlChannel.port2]);

    const errorDetails = (error) => ({
        error: serializeBridgeError(error),
        errorStack: error instanceof Error && typeof error.stack === 'string'
            ? error.stack
            : undefined,
    });
    const report = (message) => {
        if (reported) return;
        reported = true;
        controlPort.postMessage(message);
    };
    const sourceErrorHandler = (event) => {
        sourceError = event.error || new Error(event.message || 'Plugin source failed to parse.');
        report({ type: 'ERROR', ...errorDetails(sourceError) });
    };
    window.addEventListener('error', sourceErrorHandler);

    Object.defineProperty(window, '${GUEST_RUNNER_REGISTRATION}', {
        configurable: true,
        value: (runner) => {
            delete window.${GUEST_RUNNER_REGISTRATION};
            runnerResolve(runner);
        },
    });

    (async () => {
        try {
            if (sourceError) throw sourceError;
            ${GUEST_BRIDGE_SCRIPT}
            if (sourceError) throw sourceError;
            const runner = await runnerPromise;
            if (typeof runner !== 'function') throw new Error('Plugin runner is unavailable.');
            await runner();
            report({ type: 'READY' });
        } catch (error) {
            report({ type: 'ERROR', ...errorDetails(error) });
        } finally {
            window.removeEventListener('error', sourceErrorHandler);
        }
    })();
})();
`;
}

export class SandboxHost {
    private iframe: HTMLIFrameElement;
    private apiFactory: any;
    private nonce = crypto.randomUUID();
    private controlToken = crypto.randomUUID();
    private csp = `connect-src 'none'; script-src 'nonce-${this.nonce}' 'wasm-unsafe-eval'; frame-src 'none'; object-src 'none'; style-src * 'unsafe-inline'; default-src 'none'; img-src * data: blob:; font-src * data: blob:; media-src * data: blob:; base-uri 'none';`;

    private instanceRegistry = new Map<string, any>();
    private abortControllers = new Map<string, AbortController>();
    private activeRequestControllers = new Map<string, AbortController>();
    private cancelledRequestControllers = new WeakSet<AbortController>();
    private callbackWrapperCache = new Map<string, Function>();

    private pendingCallbacks = new Map<string, { resolve: Function, reject: Function }>();
    private pendingExecutions = new Map<string, { resolve: Function, reject: Function }>();
    private messageHandler?: (event: MessageEvent) => void;
    private controlPort?: MessagePort;
    private resolveInitialization?: () => void;
    private rejectInitialization?: (reason: unknown) => void;
    private initializationSettled = false;
    private initializationTimer?: ReturnType<typeof setTimeout>;
    private readonly idGeneration = crypto.randomUUID();
    private nextId = 0;
    private started = false;
    private terminating = false;
    private terminated = false;

    constructor(apiFactory: any) {
        this.apiFactory = apiFactory;
    }

    private allocateId(prefix: string): string {
        return `${prefix}${this.idGeneration}:${this.nextId++}`;
    }

    public executeInIframe(code: string): Promise<any> {
        if (this.terminating || this.terminated) {
            return Promise.reject(new Error("Plugin sandbox is terminating."));
        }
        if (!this.started || !this.iframe) {
            return Promise.reject(new Error("Plugin sandbox has not started."));
        }
        return new Promise((resolve, reject) => {
            const reqId = this.allocateId('exec_');
            this.pendingExecutions.set(reqId, { resolve, reject });

            this.iframe.contentWindow?.postMessage({
                type: 'EXECUTE_CODE',
                reqId,
                code
            }, '*');
        });
    }

    private collectTransferables(obj: any, transferables: Transferable[] = []): Transferable[] {
        if (!obj || typeof obj !== 'object') return transferables;

        if (obj instanceof ArrayBuffer ||
            obj instanceof MessagePort ||
            (typeof ImageBitmap !== 'undefined' && obj instanceof ImageBitmap) ||
            obj instanceof ReadableStream ||
            obj instanceof WritableStream ||
            obj instanceof TransformStream ||
            (typeof OffscreenCanvas !== 'undefined' && obj instanceof OffscreenCanvas)) {
            transferables.push(obj);
        }
        else if (ArrayBuffer.isView(obj) && obj.buffer instanceof ArrayBuffer) {
            transferables.push(obj.buffer);
        }
        else if (Array.isArray(obj)) {
            obj.forEach(item => this.collectTransferables(item, transferables));
        }
        else if (obj.constructor === Object) {
            Object.values(obj).forEach(value => this.collectTransferables(value, transferables));
        }

        return transferables;
    }


    private serialize(val: any): any {
        if (
            val &&
            (typeof val === 'object' || typeof val === 'function') &&
            val.__classType === 'REMOTE_REQUIRED'
        ) {
            if (val === null) return null;
            if (Array.isArray(val)) return val;


            const id = this.allocateId('ref_');
            this.instanceRegistry.set(id, val);
            return { __type: 'REMOTE_REF', id } as RemoteRef;
        }

        if(val instanceof Response) {
            return {
                __type: 'CALLBACK_STREAMS',
                __specialType: 'Response',
                value: val.body,
                init: {
                    status: val.status,
                    statusText: val.statusText,
                    headers: Array.from(val.headers.entries())
                }
            };
        }

        if(
            val instanceof ReadableStream
            || val instanceof WritableStream
            || val instanceof TransformStream
        ) {
            return {
                __type: 'CALLBACK_STREAMS',
                __specialType: 'none',
                value: val
            };
        }
        return val;
    }


    private deserializeArgs(args: any[], usedAbortIds?: string[]) {
        return args.map(arg => {
            if (arg && arg.__type === 'CALLBACK_REF') {
                const cbRef = arg as CallbackRef;

                const cached = this.callbackWrapperCache.get(cbRef.id);
                if (cached) return cached;

                const wrapper = async (...innerArgs: any[]) => {
                    if (this.terminated
                        || (this.terminating && !unloadAuthorizedCallbacks.has(wrapper))) {
                        throw new Error("Plugin sandbox is terminating; callback invocation was rejected.");
                    }
                    return new Promise((resolve, reject) => {
                        const reqId = this.allocateId('cb_req_');
                        this.pendingCallbacks.set(reqId, { resolve, reject });

                        // AbortSignal cannot be structured-cloned for postMessage.
                        // Convert to a serializable ref and forward abort events
                        // via a separate ABORT_SIGNAL message.
                        const sanitizedArgs = innerArgs.map(arg => {
                            if (arg instanceof AbortSignal) {
                                const abortId = this.allocateId('abort_');
                                const ref: AbortSignalRef = {
                                    __type: 'ABORT_SIGNAL_REF',
                                    abortId,
                                    aborted: arg.aborted
                                };
                                if (!arg.aborted) {
                                    arg.addEventListener('abort', () => {
                                        try {
                                            this.iframe.contentWindow?.postMessage({
                                                type: 'ABORT_SIGNAL',
                                                abortId
                                            } as RpcMessage, '*');
                                        } catch (_) { /* iframe already removed */ }
                                    }, { once: true });
                                }
                                return ref;
                            }
                            return arg;
                        });

                        const message = {
                            type: 'INVOKE_CALLBACK',
                            id: cbRef.id,
                            reqId,
                            args: sanitizedArgs
                        };
                        const transferables = this.collectTransferables(message);
                        this.iframe.contentWindow?.postMessage(message, '*', transferables);
                    });
                };
                this.callbackWrapperCache.set(cbRef.id, wrapper);
                return wrapper;
            }
            if (arg && arg.__type === 'REMOTE_REF') {
                const remoteRef = arg as RemoteRef;
                const instance = this.instanceRegistry.get(remoteRef.id);
                if (instance) {
                    return instance;
                }
            }
            if (arg && typeof arg === 'object' && arg.constructor === Object) {
                let out: any = null;
                for (const [key, val] of Object.entries<any>(arg)) {
                    if (val && val.__type === 'ABORT_SIGNAL_REF') {
                        if (!out) out = { ...arg };
                        const abortRef = val as AbortSignalRef, controller = new AbortController();

                        if (abortRef.aborted) controller.abort();
                        else this.abortControllers.set(abortRef.abortId, controller);

                        usedAbortIds?.push(abortRef.abortId);
                        out[key] = controller.signal;
                    }
                }
                if (out) return out;
            }
            return arg;
        });
    }

    private settleInitialization(error?: unknown) {
        if (this.initializationSettled) return;
        this.initializationSettled = true;
        if (this.initializationTimer !== undefined) {
            clearTimeout(this.initializationTimer);
            this.initializationTimer = undefined;
        }
        const resolve = this.resolveInitialization;
        const reject = this.rejectInitialization;
        this.resolveInitialization = undefined;
        this.rejectInitialization = undefined;
        if (error === undefined) resolve?.();
        else reject?.(error);
    }

    public beginTermination() {
        if (this.terminating || this.terminated) return;
        this.terminating = true;
        this.settleInitialization(
            new Error("Plugin initialization was cancelled during teardown."),
        );
        // Let an operation that was already admitted finish during the bounded
        // unload grace period. Its rejection/success lets guest code leave the
        // startup await and observe that all later registrations are closed.
        this.detachRemoteState(false);
    }

    public run(container: HTMLElement|HTMLIFrameElement, userCode: string): Promise<void> {
        if (this.started) {
            return Promise.reject(new Error("SandboxHost.run() may only be called once."));
        }
        if (this.terminating || this.terminated) {
            return Promise.reject(new Error("Plugin sandbox was terminated before startup."));
        }
        // Retain an explicitly supplied iframe so terminate() can remove it if
        // validation fails. No document content is installed before validation.
        if (container instanceof HTMLIFrameElement) {
            this.iframe = container;
        }
        try {
            validateAsyncFunctionBody(userCode);
        } catch (error) {
            return Promise.reject(error);
        }
        this.started = true;

        if(container instanceof HTMLIFrameElement) {
            this.iframe = container;
        } else {
            this.iframe = document.createElement('iframe');
            container.appendChild(this.iframe);
        }

        this.iframe.style.width = "100%";
        this.iframe.style.height = "100%";
        this.iframe.style.border = "none";

        this.iframe.style.backgroundColor = "transparent";
        this.iframe.setAttribute('allowTransparency', 'true');

        this.iframe.sandbox.add('allow-scripts');
        this.iframe.sandbox.add('allow-modals')
        this.iframe.sandbox.add('allow-downloads')

        this.iframe.setAttribute('csp', this.csp);

        const initialization = new Promise<void>((resolve, reject) => {
            this.resolveInitialization = resolve;
            this.rejectInitialization = reject;
        });
        this.initializationTimer = setTimeout(() => {
            const error = new Error(
                `Plugin initialization timed out after ${PLUGIN_BRIDGE_INITIALIZATION_TIMEOUT_MS}ms.`,
            ) as Error & Record<string, unknown>;
            error.name = "PluginInitializationTimeoutError";
            error.code = "PLUGIN_INITIALIZATION_TIMEOUT";
            error.retryable = false;
            error.commitOutcomeUnknown = false;
            error.operation = "initialization";
            this.settleInitialization(error);
            // Close new RPC/registration traffic immediately. The owning V3
            // lifecycle catches the rejection, runs registered cleanup and
            // bounded unload callbacks, then performs final iframe removal.
            this.beginTermination();
        }, PLUGIN_BRIDGE_INITIALIZATION_TIMEOUT_MS);

        const messageHandler = async (event: MessageEvent) => {
            // sandboxed srcdoc without allow-same-origin has an opaque origin,
            // serialized as "null". Source alone is insufficient because an
            // unrelated same-frame message must not enter the RPC dispatcher.
            if (event.source !== this.iframe.contentWindow || event.origin !== 'null') return;
            const rawData = event.data;
            if (!rawData || typeof rawData !== 'object') return;
            if (rawData?.type === 'RISU_PLUGIN_CONTROL_INIT') {
                const transferredPort = event.ports?.[0] || rawData.port;
                if (rawData.token !== this.controlToken
                    || this.controlPort
                    || !transferredPort
                    || typeof transferredPort.postMessage !== 'function') {
                    return;
                }
                if (this.terminating || this.terminated) {
                    transferredPort.close?.();
                    return;
                }
                this.controlPort = transferredPort;
                this.controlPort.onmessage = (controlEvent: MessageEvent<GuestControlMessage>) => {
                    if (this.terminating || this.terminated || this.initializationSettled) return;
                    const controlData = controlEvent.data;
                    if (controlData?.type === 'READY') {
                        this.settleInitialization();
                    } else if (controlData?.type === 'ERROR') {
                        const error = controlData.error === undefined
                            ? new Error("Plugin initialization failed.")
                            : deserializeV3BridgeError(controlData.error);
                        if (controlData.errorStack) error.stack = controlData.errorStack;
                        this.settleInitialization(error);
                    }
                };
                this.controlPort.start();
                return;
            }

            const data = rawData as RpcMessage;

            if (data.type === 'EXEC_RESULT' && data.reqId) {
                const pending = this.pendingExecutions.get(data.reqId);
                if (pending) {
                    this.pendingExecutions.delete(data.reqId);
                    if (data.error) pending.reject(deserializeV3BridgeError(data.error));
                    else pending.resolve(data.result);
                }
                return;
            }

            if (data.type === 'CANCEL_REQUEST' && data.reqId) {
                const controller = this.activeRequestControllers.get(data.reqId);
                if (controller) {
                    this.activeRequestControllers.delete(data.reqId);
                    this.cancelledRequestControllers.add(controller);
                    controller.abort(new DOMException(
                        'Plugin bridge request was cancelled.',
                        'AbortError',
                    ));
                }
                return;
            }


            if (data.type === 'CALLBACK_RETURN') {
                const req = this.pendingCallbacks.get(data.reqId!);
                if (req) {
                    if (data.error) req.reject(deserializeV3BridgeError(data.error));
                    else req.resolve(data.result);
                    this.pendingCallbacks.delete(data.reqId!);
                }
                return;
            }

            if (data.type === 'ABORT_SIGNAL') {
                const controller = this.abortControllers.get(data.abortId!);
                if (controller) {
                    controller.abort();
                    this.abortControllers.delete(data.abortId!);
                }
                return;
            }


            if (data.type === 'RELEASE_INSTANCE') {
                this.instanceRegistry.delete(data.id!);
                return;
            }


            if (data.type === 'CALL_ROOT' || data.type === 'CALL_INSTANCE') {
                const response: RpcMessage = { type: 'RESPONSE', reqId: data.reqId };
                const usedAbortIds: string[] = [];
                const requestController = new AbortController();
                if (data.reqId) {
                    this.activeRequestControllers.set(data.reqId, requestController);
                }

                try {
                    if (this.terminating || this.terminated) {
                        throw new Error("Plugin sandbox is terminating; RPC invocation was rejected.");
                    }

                    const args = this.deserializeArgs(data.args || [], usedAbortIds);
                    let result: any;


                    if (data.type === 'CALL_ROOT') {
                        const fn = this.apiFactory[data.method!];
                        if (typeof fn !== 'function') throw new Error(`API method ${data.method} not found`);
                        if (ABORTABLE_ROOT_METHODS.has(data.method!)) {
                            // getDatabase() has an optional includeOnly argument;
                            // preserve its default before appending the signal.
                            if (data.method === 'getDatabase' && args.length === 0) {
                                args.push(undefined);
                            }
                            args.push(requestController.signal);
                        }
                        result = await fn(...args);
                    } else {
                        const instance = this.instanceRegistry.get(data.id!);
                        if (!instance) throw new Error("Instance not found or released");
                        if (typeof instance[data.method!] !== 'function') throw new Error(`Method ${data.method} missing on instance`);
                        if (instance.__requestAbortMethods?.has?.(data.method!)) {
                            args.push(requestController.signal);
                        }
                        result = await instance[data.method!](...args);
                    }


                    // WebKit on iOS fails when Response.body (ReadableStream)
                    // is transferred through postMessage. Pre-read into an
                    // ArrayBuffer (preserves binary data) and send that instead.
                    const isWebKit = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium/.test(navigator.userAgent);
                    if (isWebKit && result instanceof Response && result.body) {
                        try {
                            const buf = await result.arrayBuffer();
                            response.result = {
                                __type: 'CALLBACK_STREAMS',
                                __specialType: 'Response',
                                value: buf,
                                init: {
                                    status: result.status,
                                    statusText: result.statusText,
                                    headers: Array.from(result.headers.entries())
                                }
                            };
                        } catch (_) {
                            response.result = this.serialize(result);
                        }
                    } else {
                        response.result = this.serialize(result);
                    }

                } catch (err: any) {
                    response.error = serializeV3BridgeError(err);
                } finally {
                    if (data.reqId
                        && this.activeRequestControllers.get(data.reqId) === requestController) {
                        this.activeRequestControllers.delete(data.reqId);
                    }
                    for (const id of usedAbortIds) this.abortControllers.delete(id);
                }

                // The guest has already rejected and removed a cancelled
                // request. Do not emit a stale response after abort cleanup.
                if (this.terminated
                    || this.cancelledRequestControllers.has(requestController)) return;
                const transferables = this.collectTransferables(response);
                console.log("Original request:", data);
                console.log('Original response:', response, transferables);
                try {
                    this.iframe.contentWindow?.postMessage(response, '*', transferables);
                } catch (error) {
                    // Reactive $state proxies reject structured cloning. When
                    // nothing needs to be transferred, a plain deep copy of the
                    // response is equivalent — retry with that before failing.
                    if ((error as Error)?.name === 'DataCloneError' && transferables.length === 0) {
                        try {
                            this.iframe.contentWindow?.postMessage(safeStructuredClone(response), '*');
                            return;
                        } catch (retryError) {
                            error = retryError;
                        }
                    }
                    this.iframe.contentWindow?.postMessage({
                        type: 'RESPONSE',
                        reqId: data.reqId,
                        error: 'Failed to post message to iframe: ' + (error as Error).message
                    }, '*');
                    console.error('Failed to post message to iframe:', error);
                }
            }
        };

        this.messageHandler = messageHandler;
        window.addEventListener('message', messageHandler);

        const runtimeScript = createGuestRuntimeScript(this.controlToken);
        const escapedUserCode = escapeInlineScriptSource(userCode);
        const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="${this.csp}" id="csp-meta">
      </head>
      <body>
        <style>
            body {
                background-color: transparent;
            }
        </style>
        <script nonce="${this.nonce}">
            document.querySelector('meta#csp-meta')?.remove();
            ${runtimeScript}
        </script>
        <script nonce="${this.nonce}">
            window.${GUEST_RUNNER_REGISTRATION}(async () => {
                ${escapedUserCode}
            });
        </script>
      </body>
      </html>
    `;

        this.iframe.srcdoc = html;

        return initialization;
    }

    private detachRemoteState(abortActiveRequests = true) {
        const terminationError = new Error("Plugin sandbox is terminating.");
        for (const request of this.pendingCallbacks.values()) {
            request.reject(terminationError);
        }
        for (const request of this.pendingExecutions.values()) {
            request.reject(terminationError);
        }
        for (const controller of this.abortControllers.values()) {
            controller.abort();
        }
        this.instanceRegistry.clear();
        this.pendingCallbacks.clear();
        this.pendingExecutions.clear();
        if (abortActiveRequests) {
            for (const controller of this.activeRequestControllers.values()) {
                controller.abort();
            }
            this.activeRequestControllers.clear();
        }
        this.abortControllers.clear();
        this.callbackWrapperCache.clear();
    }

    public terminate() {
        if (this.terminated) return;
        this.beginTermination();
        this.terminated = true;
        if (this.messageHandler) {
            window.removeEventListener('message', this.messageHandler);
            this.messageHandler = undefined;
        }
        this.controlPort?.close();
        this.controlPort = undefined;
        if (this.iframe) {
            this.iframe.remove();
        }
        this.detachRemoteState();
    }
}
