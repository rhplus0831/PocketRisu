import { beforeEach, describe, expect, test, vi } from "vitest";

import { SandboxHost } from "./factory";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => { resolve = res; });
    return { promise, resolve };
}

function executeGeneratedGuest(iframe: HTMLIFrameElement) {
    const guestWindow = iframe.contentWindow;
    const scripts = [...(iframe.contentDocument?.querySelectorAll("script") ?? [])];
    if (!guestWindow || scripts.length !== 2) throw new Error("Generated V3 guest scripts are unavailable.");
    if (!(guestWindow as any).ImageBitmap) {
        (guestWindow as any).ImageBitmap = class ImageBitmap {};
    }
    if (!(guestWindow as any).MessageChannel) {
        (guestWindow as any).MessageChannel = MessageChannel;
    }
    const originalParent = Object.getOwnPropertyDescriptor(guestWindow, "parent");
    Object.defineProperty(guestWindow, "parent", {
        configurable: true,
        value: {
            postMessage(data: unknown) {
                window.dispatchEvent(new MessageEvent("message", {
                    data,
                    origin: "null",
                    source: guestWindow,
                }));
            },
        },
    });
    for (const script of scripts) {
        try {
            (guestWindow as any).eval(script.textContent ?? "");
        } catch (error) {
            guestWindow.dispatchEvent(new ErrorEvent("error", {
                error,
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }
    return () => {
        if (originalParent) Object.defineProperty(guestWindow, "parent", originalParent);
    };
}

function startupApi(overrides: Record<string, unknown> = {}) {
    return {
        _getPropertiesForInitialization: () => ({
            apiVersion: "3.0",
            list: ["apiVersion"],
        }),
        _getAliases: () => ({
            pluginStorage: { getItem: "_getPluginStorage" },
        }),
        _getPluginStorage: async () => null,
        addProvider: vi.fn(),
        ...overrides,
    };
}

function generationStorageApi() {
    const rows = new Map<string, { value: any; revision: string }>();
    let sequence = 1;
    let failMode: "before" | "after" | null = null;
    let readGate: Promise<void> | null = null;
    const signals: AbortSignal[] = [];
    let suppliedSignalCalls = 0;
    const nextRevision = () => `sha256:${(sequence++).toString(16).padStart(64, "0")}`;
    const api = startupApi({
        _getAliases: () => ({
            pluginStorage: {
                getItem: "_getPluginStorage",
                getWithRevision: "_getVersionedPluginStorage",
                atomicBatch: "_atomicBatchPluginStorage",
            },
        }),
        _getVersionedPluginStorage: async (
            key: string,
            suppliedOrRequestSignal?: AbortSignal,
            requestSignal?: AbortSignal,
        ) => {
            if (requestSignal) suppliedSignalCalls += 1;
            if (suppliedOrRequestSignal) signals.push(suppliedOrRequestSignal);
            if (requestSignal) signals.push(requestSignal);
            await readGate;
            const row = rows.get(key);
            return row
                ? { status: "value", value: structuredClone(row.value), revision: row.revision, generation: null }
                : { status: "missing", value: null, revision: null, generation: null };
        },
        _atomicBatchPluginStorage: async (
            operations: readonly any[],
            suppliedOrRequestSignal?: AbortSignal,
            requestSignal?: AbortSignal,
        ) => {
            if (requestSignal) suppliedSignalCalls += 1;
            if (suppliedOrRequestSignal) signals.push(suppliedOrRequestSignal);
            if (requestSignal) signals.push(requestSignal);
            for (const operation of operations) {
                if (!Object.prototype.hasOwnProperty.call(operation, "expectedRevision")) continue;
                const current = rows.get(operation.key)?.revision ?? null;
                if (current !== operation.expectedRevision) {
                    return {
                        committed: false,
                        conflicts: [{ key: operation.key, revision: current, generation: null }],
                    };
                }
            }
            if (failMode === "before") throw new Error("initial publication before commit");
            const staged = new Map(rows);
            const revisions = operations.map(operation => {
                if (operation.type === "set") {
                    const revision = nextRevision();
                    staged.set(operation.key, { value: structuredClone(operation.value), revision });
                    return { key: operation.key, revision };
                }
                staged.delete(operation.key);
                return { key: operation.key, revision: null };
            });
            rows.clear();
            for (const [key, row] of staged) rows.set(key, row);
            if (failMode === "after") throw new Error("initial publication after commit");
            return { committed: true, generation: crypto.randomUUID(), revisions };
        },
    });
    return {
        api,
        rows,
        signals,
        get suppliedSignalCalls() { return suppliedSignalCalls; },
        setFailMode(value: typeof failMode) { failMode = value; },
        setReadGate(value: Promise<void> | null) { readGate = value; },
    };
}

function stableJson(value: any): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => (
        `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
}

async function generationHash(value: any): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(stableJson(value)),
    ));
    return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

beforeEach(() => {
    document.body.replaceChildren();
});

describe("SandboxHost V3 startup lifecycle", () => {
    test("separates runner readiness from a long-lived top-level promise", async () => {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi());
        let lifetimeSettled = false;
        const lifetime = host.run(iframe, "await new Promise(() => {});")
            .then(() => null, error => error)
            .finally(() => { lifetimeSettled = true; });
        const restoreRelay = executeGeneratedGuest(iframe);

        await expect(host.readiness).resolves.toBeUndefined();
        expect(lifetimeSettled).toBe(false);
        expect(iframe.isConnected).toBe(true);

        host.terminate();
        await expect(lifetime).resolves.toMatchObject({
            message: "Plugin initialization was cancelled during teardown.",
        });
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("installs immutable-generation helpers on the public plugin storage API", async () => {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi());
        const startup = host.run(iframe, `
            globalThis.generationHelpers = [
                typeof risuai.pluginStorage.generations.publish,
                typeof risuai.pluginStorage.generations.load,
                typeof risuai.pluginStorage.generations.garbageCollect,
            ];
        `);
        const restoreRelay = executeGeneratedGuest(iframe);

        await expect(startup).resolves.toBeUndefined();
        expect((iframe.contentWindow as any).generationHelpers).toEqual([
            "function", "function", "function",
        ]);
        host.terminate();
        restoreRelay();
    });

    test("exposes legacy and explicit sorted plugin-storage enumeration", async () => {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi({
            _getAliases: () => ({
                pluginStorage: {
                    getItem: "_getPluginStorage",
                    keys: "_keysPluginStorage",
                    sortedKeys: "_sortedKeysPluginStorage",
                },
            }),
            _keysPluginStorage: async () => ["z", "a"],
            _sortedKeysPluginStorage: async () => ["a", "z"],
        }));
        const startup = host.run(iframe, `
            globalThis.enumerationOrders = {
                legacy: await risuai.pluginStorage.keys(),
                sorted: await risuai.pluginStorage.sortedKeys(),
            };
        `);
        const restoreRelay = executeGeneratedGuest(iframe);

        await expect(startup).resolves.toBeUndefined();
        expect((iframe.contentWindow as any).enumerationOrders).toEqual({
            legacy: ["z", "a"],
            sorted: ["a", "z"],
        });
        host.terminate();
        restoreRelay();
    });

    test("preserves falsey storage values and empty indexed keys across the guest bridge", async () => {
        const values = new Map<string, unknown>([
            ["false", false],
            ["zero", 0],
            ["empty", ""],
            ["nullable", null],
        ]);
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi({
            _getAliases: () => ({
                pluginStorage: {
                    getItem: "_getPluginStorage",
                    key: "_keyPluginStorage",
                },
                safeLocalStorage: {
                    getItem: "_getSafeLocalStorage",
                    key: "_keySafeLocalStorage",
                },
            }),
            _getPluginStorage: async (key: string) => (
                values.has(key) ? values.get(key) : null
            ),
            _keyPluginStorage: async (index: number) => index === 0 ? "" : null,
            _getSafeLocalStorage: async (key: string) => key === "empty" ? "" : null,
            _keySafeLocalStorage: async (index: number) => index === 0 ? "" : null,
        }));
        const startup = host.run(iframe, `
            globalThis.falseyStorageReads = [
                await risuai.pluginStorage.getItem('false'),
                await risuai.pluginStorage.getItem('zero'),
                await risuai.pluginStorage.getItem('empty'),
                await risuai.pluginStorage.getItem('nullable'),
                await risuai.pluginStorage.getItem('missing'),
                await risuai.safeLocalStorage.getItem('empty'),
                await risuai.safeLocalStorage.getItem('missing'),
            ];
            globalThis.emptyIndexedStorageKeys = [
                await risuai.pluginStorage.key(0),
                await risuai.pluginStorage.key(1),
                await risuai.safeLocalStorage.key(0),
                await risuai.safeLocalStorage.key(1),
            ];
        `);
        const restoreRelay = executeGeneratedGuest(iframe);

        await expect(startup).resolves.toBeUndefined();
        expect((iframe.contentWindow as any).falseyStorageReads).toEqual([
            false,
            0,
            "",
            null,
            null,
            "",
            null,
        ]);
        expect((iframe.contentWindow as any).emptyIndexedStorageKeys).toEqual([
            "",
            null,
            "",
            null,
        ]);
        host.terminate();
        restoreRelay();
    });

    test("normalizes local plugin storage values before crossing the guest bridge", async () => {
        const setItem = vi.fn(async () => undefined);
        const localStorage = {
            __classType: "REMOTE_REQUIRED" as const,
            __compatJsonStringifySetItem: true as const,
            setItem,
        };
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi({
            getLocalPluginStorage: () => localStorage,
        }));
        const startup = host.run(iframe, `
            const storage = await risuai.getLocalPluginStorage();
            let toJSONCalls = 0;
            const sparse = new Array(4);
            sparse[0] = 'first';
            sparse[2] = undefined;
            sparse[3] = Number.POSITIVE_INFINITY;
            const map = new Map([['entry', 'historically omitted']]);
            map.label = 'enumerable-own-property';
            await storage.setItem('compatibility-value', {
                date: new Date('2026-01-02T03:04:05.000Z'),
                custom: {
                    original: true,
                    toJSON() {
                        toJSONCalls += 1;
                        return { replaced: true };
                    },
                },
                sparse,
                map,
                set: new Set(['historically omitted']),
            });
            globalThis.localStorageToJSONCalls = toJSONCalls;
        `);
        const restoreRelay = executeGeneratedGuest(iframe);

        await startup;
        expect(setItem).toHaveBeenCalledWith("compatibility-value", {
            date: "2026-01-02T03:04:05.000Z",
            custom: { replaced: true },
            sparse: ["first", null, null, null],
            map: { label: "enumerable-own-property" },
            set: {},
        });
        expect((iframe.contentWindow as any).localStorageToJSONCalls).toBe(1);
        host.terminate();
        restoreRelay();
    });

    test("runs generation publish/load/GC with signals through the real guest bridge", async () => {
        const backend = generationStorageApi();
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(backend.api);
        const startup = host.run(iframe, `
            const signal = new AbortController().signal;
            const first = await risuai.pluginStorage.generations.publish({
                manifestKey: 'records/head', bodyKeyPrefix: 'records/immutable',
                bodies: [{ id: 'one', count: 1, value: { version: 1 } }],
                unloadSignal: signal,
            });
            await risuai.pluginStorage.generations.publish({
                manifestKey: 'records/head', bodyKeyPrefix: 'records/immutable',
                bodies: [{ id: 'two', count: 2, value: ['v2a', 'v2b'] }],
                unloadSignal: signal,
            });
            const third = await risuai.pluginStorage.generations.publish({
                manifestKey: 'records/head', bodyKeyPrefix: 'records/immutable',
                bodies: [{ id: 'three', count: 1, value: 'v3' }],
                unloadSignal: signal,
            });
            globalThis.realGenerationResult = {
                first,
                third,
                loaded: await risuai.pluginStorage.generations.load('records/head', signal),
                collected: await risuai.pluginStorage.generations.garbageCollect({
                    manifestKey: 'records/head', generation: first.current, unloadSignal: signal,
                }),
            };
        `);
        const restoreRelay = executeGeneratedGuest(iframe);
        try {
            await startup;
            const result = (iframe.contentWindow as any).realGenerationResult;
            expect(result.loaded).toMatchObject({
                status: "value",
                recoveredFromPrevious: false,
                value: { bodies: [{ id: "three", count: 1, value: "v3" }] },
            });
            expect(result.collected).toMatchObject({ committed: true, removed: true });
            expect(backend.rows.has(result.first.current.manifestKey)).toBe(false);
            expect(backend.rows.has(result.third.current.manifestKey)).toBe(true);
            expect(backend.suppliedSignalCalls).toBeGreaterThan(10);
            expect(backend.signals.every(signal => signal instanceof AbortSignal)).toBe(true);
        } finally {
            host.terminate();
            restoreRelay();
        }
    });

    test("real guest rejects repository transplants, lineage splices, unsafe GC input, and empty prefixes", async () => {
        const backend = generationStorageApi();
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(backend.api);
        const startup = host.run(iframe, `
            globalThis.alphaFirst = await risuai.pluginStorage.generations.publish({
                manifestKey: 'alpha/head', bodyKeyPrefix: 'alpha/immutable',
                bodies: [{ id: 'a1', count: 1, value: 'a1' }],
            });
            await risuai.pluginStorage.generations.publish({
                manifestKey: 'alpha/head', bodyKeyPrefix: 'alpha/immutable',
                bodies: [{ id: 'a2', count: 1, value: 'a2' }],
            });
            globalThis.alphaThird = await risuai.pluginStorage.generations.publish({
                manifestKey: 'alpha/head', bodyKeyPrefix: 'alpha/immutable',
                bodies: [{ id: 'a3', count: 1, value: 'a3' }],
            });
            globalThis.betaFirst = await risuai.pluginStorage.generations.publish({
                manifestKey: 'beta/head', bodyKeyPrefix: 'beta/immutable',
                bodies: [{ id: 'b1', count: 1, value: 'b1' }],
            });
        `);
        const restoreRelay = executeGeneratedGuest(iframe);
        try {
            await startup;
            const alphaFirst = (iframe.contentWindow as any).alphaFirst;
            const alphaThird = (iframe.contentWindow as any).alphaThird;
            const crossRepository = await host.executeInIframe(`
                try {
                    await risuai.pluginStorage.generations.garbageCollect({
                        manifestKey: 'beta/head', generation: globalThis.alphaFirst.current,
                    });
                    return 'accepted';
                } catch (error) { return error.code || error.message; }
            `);
            expect(crossRepository).toBe("PLUGIN_GENERATION_LINEAGE_INVALID");

            const alphaHead = backend.rows.get("alpha/head")!.value;
            backend.rows.set("beta/head", {
                value: structuredClone(alphaHead),
                revision: backend.rows.get("beta/head")!.revision,
            });
            expect(await host.executeInIframe(`
                try { await risuai.pluginStorage.generations.load('beta/head'); return 'accepted'; }
                catch (error) { return error.code || error.message; }
            `)).toBe("PLUGIN_GENERATION_LINEAGE_INVALID");

            const betaFirst = (iframe.contentWindow as any).betaFirst;
            backend.rows.set("beta/head", {
                value: structuredClone(alphaHead),
                revision: backend.rows.get("beta/head")!.revision,
            });
            const spliced = backend.rows.get("alpha/head")!.value;
            spliced.previous = structuredClone(alphaFirst.current);
            spliced.headHash = await generationHash({
                protocol: spliced.protocol,
                repository: spliced.repository,
                current: spliced.current,
                previous: spliced.previous,
            });
            expect(await host.executeInIframe(`
                try { await risuai.pluginStorage.generations.load('alpha/head'); return 'accepted'; }
                catch (error) { return error.code || error.message; }
            `)).toBe("PLUGIN_GENERATION_LINEAGE_INVALID");

            // Restore a valid alpha head for detachment checks.
            spliced.previous = structuredClone(alphaThird.previous);
            spliced.headHash = await generationHash({
                protocol: spliced.protocol,
                repository: spliced.repository,
                current: spliced.current,
                previous: spliced.previous,
            });
            const detached = await host.executeInIframe(`
                const ref = { ...globalThis.alphaFirst.current };
                const originalSignal = new AbortController().signal;
                const options = {
                    manifestKey: 'alpha/head', generation: ref, unloadSignal: originalSignal,
                };
                const pending = risuai.pluginStorage.generations.garbageCollect(options);
                Object.assign(ref, globalThis.alphaThird.current);
                options.manifestKey = 'mutated/head';
                options.unloadSignal = new AbortController().signal;
                return await pending;
            `);
            expect(detached).toMatchObject({ committed: true, removed: true });
            expect(backend.rows.has(alphaFirst.current.manifestKey)).toBe(false);
            expect(backend.rows.has(alphaThird.current.manifestKey)).toBe(true);

            expect(await host.executeInIframe(`
                let calls = 0;
                const ref = { ...globalThis.alphaThird.current };
                Object.defineProperty(ref, 'manifestHash', {
                    enumerable: true,
                    get() { calls += 1; return 'unsafe'; },
                });
                try {
                    await risuai.pluginStorage.generations.garbageCollect({
                        manifestKey: 'alpha/head', generation: ref,
                    });
                    return { accepted: true, calls };
                } catch (error) { return { accepted: false, calls }; }
            `)).toEqual({ accepted: false, calls: 0 });
            expect(await host.executeInIframe(`
                let calls = 0;
                const options = {
                    manifestKey: 'alpha/head',
                    generation: globalThis.alphaThird.current,
                };
                Object.defineProperty(options, 'unloadSignal', {
                    enumerable: true,
                    get() { calls += 1; return new AbortController().signal; },
                });
                try {
                    await risuai.pluginStorage.generations.garbageCollect(options);
                    return { accepted: true, calls };
                } catch (error) { return { accepted: false, calls }; }
            `)).toEqual({ accepted: false, calls: 0 });
            expect(await host.executeInIframe(`
                try {
                    await risuai.pluginStorage.generations.publish({
                        manifestKey: 'empty/head', bodyKeyPrefix: '/',
                        bodies: [{ id: 'x', count: 1, value: 'x' }],
                    });
                    return 'accepted';
                } catch (error) { return error.message; }
            `)).toContain("empty prefix");
            expect(betaFirst.current.repositoryHash).not.toBe(alphaFirst.current.repositoryHash);
        } finally {
            host.terminate();
            restoreRelay();
        }
    });

    test("real guest initial publication failure exposes only missing or complete state", async () => {
        const backend = generationStorageApi();
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(backend.api);
        const startup = host.run(iframe, "");
        const restoreRelay = executeGeneratedGuest(iframe);
        try {
            await startup;
            backend.setFailMode("before");
            await expect(host.executeInIframe(`
                return await risuai.pluginStorage.generations.publish({
                    manifestKey: 'initial/head', bodyKeyPrefix: 'initial/immutable',
                    bodies: [{ id: 'first', count: 1, value: 'complete' }],
                });
            `)).rejects.toThrow("before commit");
            expect(await host.executeInIframe(`
                return await risuai.pluginStorage.generations.load('initial/head');
            `)).toEqual({ status: "missing", value: null, revision: null });

            backend.setFailMode("after");
            await expect(host.executeInIframe(`
                return await risuai.pluginStorage.generations.publish({
                    manifestKey: 'initial/head', bodyKeyPrefix: 'initial/immutable',
                    bodies: [{ id: 'first', count: 1, value: 'complete' }],
                });
            `)).rejects.toThrow("after commit");
            expect(await host.executeInIframe(`
                return await risuai.pluginStorage.generations.load('initial/head');
            `)).toMatchObject({
                status: "value",
                value: { bodies: [{ id: "first", count: 1, value: "complete" }] },
            });
        } finally {
            backend.setFailMode(null);
            host.terminate();
            restoreRelay();
        }
    });

    test("teardown rejects a pending initialization and ignores its late continuation", async () => {
        const readStarted = deferred();
        const releaseRead = deferred();
        const addProvider = vi.fn();
        const api = startupApi({
            _getPluginStorage: async () => {
                readStarted.resolve();
                await releaseRead.promise;
                return { enabled: true };
            },
            addProvider,
        });
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(api);
        const startup = host.run(iframe, `
            await risuai.pluginStorage.getItem("startup-config");
            await risuai.addProvider("too-late", async () => ({ success: true, content: "late" }));
        `);
        const restoreRelay = executeGeneratedGuest(iframe);

        await readStarted.promise;
        const execution = host.executeInIframe("await new Promise(() => {});");
        host.terminate();
        await expect(startup).rejects.toThrow("cancelled during teardown");
        await expect(execution).rejects.toThrow("terminating");
        expect(iframe.isConnected).toBe(false);

        releaseRead.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(addProvider).not.toHaveBeenCalled();
        restoreRelay();
    });

    test("bridge initialization rejection reaches the host error handshake", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi({
            _getPropertiesForInitialization: async () => {
                throw new Error("bridge properties unavailable");
            },
        }));
        const startup = host.run(iframe, "globalThis.pluginBodyRan = true;");
        const restoreRelay = executeGeneratedGuest(iframe);

        await expect(startup).rejects.toThrow("bridge properties unavailable");
        expect((iframe.contentWindow as any).pluginBodyRan).not.toBe(true);
        host.terminate();
        restoreRelay();
        errorSpy.mockRestore();
    });

    test("host parsing rejects invalid async-body syntax before srcdoc installation", async () => {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi());
        const startup = host.run(iframe, "const broken = ;");

        await expect(startup).rejects.toThrow(/Unexpected token|broken/);
        expect(iframe.srcdoc).toBe("");
        expect(iframe.contentDocument?.querySelectorAll("script")).toHaveLength(0);
        host.terminate();
    });

    test("global spoof messages and invalid RPC senders cannot complete or enter startup", async () => {
        const addProvider = vi.fn();
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi({ addProvider }));
        const startup = host.run(iframe, "globalThis.pluginBodyRan = true;");
        let settled = false;
        void startup.then(() => { settled = true; });

        window.dispatchEvent(new MessageEvent("message", {
            data: { type: "READY", token: "guessed" },
            origin: "null",
            source: iframe.contentWindow,
        }));
        window.dispatchEvent(new MessageEvent("message", {
            data: { type: "CALL_ROOT", reqId: "wrong-source", method: "addProvider", args: [] },
            origin: "null",
            source: window,
        }));
        window.dispatchEvent(new MessageEvent("message", {
            data: { type: "CALL_ROOT", reqId: "wrong-origin", method: "addProvider", args: [] },
            origin: "https://attacker.invalid",
            source: iframe.contentWindow,
        }));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(settled).toBe(false);
        expect(addProvider).not.toHaveBeenCalled();

        const restoreRelay = executeGeneratedGuest(iframe);
        await startup;
        expect((iframe.contentWindow as any).pluginBodyRan).toBe(true);
        host.terminate();
        restoreRelay();
    });

    test("post-breakout held operations are rejected before a runner or READY can exist", async () => {
        const heldRPC = vi.fn(async () => null);
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        (iframe.contentWindow as any).heldRPC = heldRPC;
        const host = new SandboxHost(startupApi());
        const startup = host.run(iframe, `
            }); detached = (async () => { await heldRPC(); })(); (() => {
        `);

        await expect(startup).rejects.toBeInstanceOf(SyntaxError);
        expect(heldRPC).not.toHaveBeenCalled();
        expect((iframe.contentWindow as any).detached).toBeUndefined();
        expect(iframe.srcdoc).toBe("");
        expect(iframe.contentDocument?.querySelectorAll("script")).toHaveLength(0);
        host.terminate();
    });

    test("literal closing script text remains inside the generated plugin source", async () => {
        const recordLiteral = vi.fn();
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi({ recordLiteral }));
        const literal = "</script><script>globalThis.injectedByMarkup = true;</script>";
        const startup = host.run(iframe, `
            await risuai.recordLiteral(${JSON.stringify(literal)});
        `);

        expect(iframe.contentDocument?.querySelectorAll("script")).toHaveLength(2);
        const restoreRelay = executeGeneratedGuest(iframe);
        await startup;

        expect(recordLiteral).toHaveBeenCalledWith(literal);
        expect((iframe.contentWindow as any).injectedByMarkup).not.toBe(true);
        host.terminate();
        restoreRelay();
    });

    test("guest pagehide cancels host work without an elapsed-time deadline", async () => {
        const callStarted = deferred();
        let receivedSignal: AbortSignal | undefined;
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi({
            getDatabase: (_includeOnly: unknown, signal: AbortSignal) =>
                new Promise<never>((_resolve, reject) => {
                    receivedSignal = signal;
                    callStarted.resolve();
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                }),
        }));
        const completion = host.run(iframe, "await risuai.getDatabase();");
        const restoreRelay = executeGeneratedGuest(iframe);

        try {
            await host.readiness;
            await callStarted.promise;
            iframe.contentWindow!.dispatchEvent(new Event("pagehide"));

            await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
            await expect(completion).rejects.toThrow("page was unloaded");
        } finally {
            host.terminate();
            restoreRelay();
        }
    });

    test("termination aborts host AbortControllers created for guest calls", async () => {
        const callStarted = deferred();
        let receivedSignal: AbortSignal | undefined;
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(startupApi({
            waitForAbort: ({ signal }: { signal: AbortSignal }) => new Promise<void>(resolve => {
                receivedSignal = signal;
                callStarted.resolve();
                signal.addEventListener("abort", () => resolve(), { once: true });
            }),
        }));
        const startup = host.run(iframe, "globalThis.pluginBodyRan = true;");
        window.dispatchEvent(new MessageEvent("message", {
            data: {
                type: "CALL_ROOT",
                reqId: "pending-abort",
                method: "waitForAbort",
                args: [{
                    signal: {
                        __type: "ABORT_SIGNAL_REF",
                        abortId: "abort-during-teardown",
                        aborted: false,
                    },
                }],
            },
            origin: "null",
            source: iframe.contentWindow,
        }));

        await callStarted.promise;
        host.terminate();
        await expect(startup).rejects.toThrow("cancelled during teardown");
        expect(receivedSignal?.aborted).toBe(true);
    });
});

describe("V3 plugin storage safe update helpers", () => {
    function safeStorageApi(overrides: Record<string, unknown> = {}) {
        return startupApi({
            _getAliases: () => ({
                pluginStorage: {
                    getItem: "_getPluginStorage",
                    getWithRevision: "_getVersionedPluginStorage",
                    readItem: "_readPluginStorageResult",
                    setFromRead: "_setPluginStorageFromRead",
                    atomicBatch: "_atomicBatchPluginStorage",
                },
            }),
            _getVersionedPluginStorage: vi.fn(),
            _readPluginStorageResult: vi.fn(),
            _setPluginStorageFromRead: vi.fn(),
            _atomicBatchPluginStorage: vi.fn(),
            ...overrides,
        });
    }

    test("bridge read failures abort config, credential, index, ledger, and shard fallbacks", async () => {
        const keys = ["config", "credential", "index", "ledger", "shard"];
        const durable = new Map(keys.map(key => [key, { old: key }]));
        const setFromRead = vi.fn(async (read: any, value: unknown) => {
            durable.set(read.key, value as { old: string });
            return { status: "committed", generation: "unexpected", revision: `sha256:${"a".repeat(64)}` };
        });
        const recordResults = vi.fn();
        const api = safeStorageApi({
            _readPluginStorageResult: vi.fn(async (key: string) => {
                throw Object.assign(new Error(`temporary ${key} GET failure`), {
                    name: "StorageError",
                    status: 503,
                    code: "TEMPORARY_STORAGE_FAILURE",
                    retryAfter: 0,
                    retryable: true,
                    commitOutcomeUnknown: false,
                    operation: "read",
                });
            }),
            _setPluginStorageFromRead: setFromRead,
            recordResults,
        });
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(api);
        const startup = host.run(iframe, `
            const keys = ["config", "credential", "index", "ledger", "shard"];
            let transformations = 0;
            const results = [];
            for (const key of keys) {
                const read = await risuai.pluginStorage.readItem(key);
                if (read.status === "failed") {
                    results.push({ status: "failed", stage: "read", error: read.error });
                    continue;
                }
                transformations += 1;
                const fallback = key === "credential" ? "" : {};
                results.push(await risuai.pluginStorage.setFromRead(read, fallback));
            }
            await risuai.recordResults(results, transformations);
        `);
        const restoreRelay = executeGeneratedGuest(iframe);

        await startup;
        expect(recordResults).toHaveBeenCalledOnce();
        const [results, transformations] = recordResults.mock.calls[0];
        expect(transformations).toBe(0);
        expect(results).toHaveLength(keys.length);
        expect(results.every((result: any) => (
            result.status === "failed"
            && result.stage === "read"
            && result.error.code === "TEMPORARY_STORAGE_FAILURE"
            && result.error.operation === "read"
        ))).toBe(true);
        expect(setFromRead).not.toHaveBeenCalled();
        expect([...durable.entries()]).toEqual(keys.map(key => [key, { old: key }]));
        host.terminate();
        restoreRelay();
    });

    test("bridge helpers preserve missing versus stored null and bind both writes to CAS", async () => {
        const revision = `sha256:${"b".repeat(64)}`;
        const setFromRead = vi.fn(async () => ({
            status: "committed",
            generation: "new-generation",
            revision: `sha256:${"c".repeat(64)}`,
        }));
        const recordResults = vi.fn();
        const api = safeStorageApi({
            _readPluginStorageResult: vi.fn(async (key: string) => key === "missing"
                ? { status: "missing", key, value: null, revision: null, generation: null }
                : { status: "value", key, value: null, revision, generation: null }),
            _setPluginStorageFromRead: setFromRead,
            recordResults,
        });
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost(api);
        const startup = host.run(iframe, `
            const missing = await risuai.pluginStorage.readItem("missing");
            const nullable = await risuai.pluginStorage.readItem("nullable");
            const created = await risuai.pluginStorage.setFromRead(missing, { created: true });
            const replaced = await risuai.pluginStorage.setFromRead(nullable, { replaced: true });
            await risuai.recordResults({ missing, nullable, created, replaced });
        `);
        const restoreRelay = executeGeneratedGuest(iframe);

        await startup;
        expect(recordResults).toHaveBeenCalledWith(expect.objectContaining({
            missing: expect.objectContaining({ status: "missing", revision: null }),
            nullable: expect.objectContaining({ status: "value", value: null, revision }),
        }));
        expect(setFromRead).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ key: "missing", status: "missing", revision: null }),
            { created: true },
            expect.any(AbortSignal),
        );
        expect(setFromRead).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ key: "nullable", status: "value", revision }),
            { replaced: true },
            expect.any(AbortSignal),
        );
        host.terminate();
        restoreRelay();
    });
});
