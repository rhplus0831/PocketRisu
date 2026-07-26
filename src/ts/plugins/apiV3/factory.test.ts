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

beforeEach(() => {
    document.body.replaceChildren();
});

describe("SandboxHost V3 startup lifecycle", () => {
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
                results.push(await risuai.pluginStorage.updateItem(key, () => {
                    transformations += 1;
                    return key === "credential" ? "" : {};
                }));
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
