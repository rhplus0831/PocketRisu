import { afterEach, describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { Buffer as NodeBuffer } from "node:buffer";
import http from "node:http";
import path from "node:path";
import utilsPkg from "../../../server/node/utils.cjs";
import { spawnServer, type ServerHandle } from "../../../test/compat/helpers/spawnServer";

const bootState = vi.hoisted(() => ({
    database: null as any,
    storage: null as any,
}));

vi.mock("../storage/database.svelte", () => ({
    getDatabase: () => bootState.database,
    normalizeChat: (chat: unknown) => chat,
}));

vi.mock("../globalApi.svelte", () => ({
    forageStorage: {
        Init: vi.fn(async () => undefined),
        getItem: (...args: any[]) => bootState.storage.getItem(...args),
        getItemCached: (...args: any[]) => bootState.storage.getItemCached(...args),
        keys: (...args: any[]) => bootState.storage.keys(...args),
    },
    requestImmediateSave: vi.fn(async () => ({ status: "committed" })),
}));

vi.mock("../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => "unused-in-raw-boot-reconciliation"),
}));

vi.mock("../storage/resourceCache", () => ({
    applyOwnedResourceCacheMutations: vi.fn(async () => undefined),
    getManifestHashes: vi.fn(async () => []),
    getVerifiedManifestSnapshot: vi.fn(async () => null),
    getVerifiedCachedBytes: vi.fn(async () => null),
    invalidateResourceCachePrefix: vi.fn(async () => undefined),
    invalidateResourceCacheManifest: vi.fn(async () => undefined),
    isResourceCacheEnabled: () => false,
    isSha256Hex: (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
    persistResourceCacheManifests: vi.fn(async () => undefined),
    sha256Bytes: vi.fn(async () => "a".repeat(64)),
    sha256OwnedBytes: vi.fn(async () => "a".repeat(64)),
    settleBestEffortResourceCache: async <T>(operation: Promise<T>, fallback: T) => {
        try {
            return await operation;
        } catch {
            return fallback;
        }
    },
    storeBytes: vi.fn(async () => undefined),
    storeOwnedBytesWithKnownHash: vi.fn(async () => undefined),
    touchResourceCacheManifest: vi.fn(async () => undefined),
}));

vi.mock("../alert", () => ({
    alertInput: vi.fn(),
    notifyError: vi.fn(),
    waitAlert: vi.fn(),
}));

vi.mock("src/lang", () => ({ language: {} }));

const GENERATION = "123e4567-e89b-42d3-a456-426614174000";
const VALUE_KEY = "pluginsave/c2VsZWN0ZWQ.json";
const MANIFEST_KEY = "plugin-storage/manifest.json";
const DATABASE_KEY = "database/database.bin";
const { decodeRisuSave, encodeRisuSaveLegacy } = utilsPkg as {
    decodeRisuSave: (value: Uint8Array) => Promise<any>;
    encodeRisuSaveLegacy: (value: unknown) => Uint8Array;
};
const DATABASE_BYTES = new Uint8Array(encodeRisuSaveLegacy({
    characters: [],
    optimizePluginMemory: true,
    pluginStorageGeneration: GENERATION,
    pluginCustomStorage: {},
}));
const DECODED_DATABASE = await decodeRisuSave(DATABASE_BYTES);

const { NodeStorage } = await import("../storage/nodeStorage");

function seedOptimizedPublication(saveDir: string): void {
    const sqlite = new Database(path.join(saveDir, "risuai.db"));
    sqlite.exec(`
        CREATE TABLE kv (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    const insert = sqlite.prepare(
        "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)",
    );
    insert.run(DATABASE_KEY, DATABASE_BYTES, 1);
    insert.run(VALUE_KEY, new TextEncoder().encode(JSON.stringify({ selected: true })), 2);
    insert.run(MANIFEST_KEY, new TextEncoder().encode(JSON.stringify({
        version: 1,
        generation: GENERATION,
        valueKeys: [VALUE_KEY],
        metaKeys: [],
    })), 3);
    sqlite.close();
}

async function login(server: ServerHandle): Promise<string> {
    const response = await nodeFetch(`http://127.0.0.1:${server.port}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: server.password }),
    });
    if (!response.ok) throw new Error(`Login failed: ${await response.text()}`);
    return (await response.json() as { token: string }).token;
}

async function nodeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const body = init.body == null
        ? null
        : typeof init.body === "string"
            ? NodeBuffer.from(init.body)
            : NodeBuffer.from(init.body as unknown as Uint8Array);
    const headers = new Headers(init.headers);
    if (body && !headers.has("content-length")) {
        headers.set("content-length", String(body.length));
    }
    return await new Promise<Response>((resolve, reject) => {
        const request = http.request(url, {
            method: init.method ?? "GET",
            headers: Object.fromEntries(headers.entries()),
        }, response => {
            const chunks: NodeBuffer[] = [];
            response.on("data", chunk => chunks.push(NodeBuffer.from(chunk)));
            response.once("end", () => resolve(new Response(NodeBuffer.concat(chunks), {
                status: response.statusCode ?? 500,
                statusText: response.statusMessage,
                headers: response.headers as Record<string, string>,
            })));
            response.once("error", reject);
        });
        request.once("error", reject);
        const abort = () => request.destroy(new DOMException("Aborted", "AbortError"));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
        request.once("close", () => init.signal?.removeEventListener("abort", abort));
        if (body) request.end(body);
        else request.end();
    });
}

afterEach(() => {
    bootState.database = null;
    bootState.storage = null;
    vi.unstubAllGlobals();
});

describe("raw boot optimized plugin reconciliation", () => {
    test("reconciles on the server without downloading optimized row bodies", async () => {
        const server = await spawnServer({
            seedSave: async saveDir => seedOptimizedPublication(saveDir),
            env: { POCKETRISU_BACKUP_INTERVAL_MS: "3600000" },
        });
        try {
            const token = await login(server);
            const requests: Array<{ path: string; generation: string | null }> = [];
            vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = new URL(String(input), `http://127.0.0.1:${server.port}`);
                const headers = new Headers(init?.headers);
                requests.push({
                    path: url.pathname,
                    generation: headers.get("x-plugin-storage-generation"),
                });
                return await nodeFetch(url, init);
            }));

            const storage = new NodeStorage();
            storage.authChecked = true;
            (NodeStorage as any).sessionInitialized = false;
            (NodeStorage as any).sessionPending = null;
            (NodeStorage as any).databaseStorageCapabilities = {
                rawBootRead: false,
                atomicCreate: false,
            };
            vi.spyOn(storage, "createAuth").mockResolvedValue(token);
            bootState.storage = storage;

            const databaseRead = await storage.readDatabaseForBoot();
            expect(databaseRead.kind).toBe("bytes");
            if (databaseRead.kind !== "bytes") throw new Error("Expected a raw cache-off boot read");
            expect(new Uint8Array(databaseRead.bytes!)).toEqual(DATABASE_BYTES);
            bootState.database = structuredClone(DECODED_DATABASE);

            await expect(storage.reconcileOptimizedPluginStorageForBoot()).resolves.toMatchObject({
                success: true,
                direction: "none",
                values: 0,
                meta: 0,
                issues: [],
                databaseChanged: false,
                storageChanged: false,
            });
            expect(requests).toContainEqual({
                path: "/api/session",
                generation: null,
            });
            expect(requests).toContainEqual({
                path: "/api/db/read-raw-for-boot",
                generation: null,
            });
            expect(requests).toContainEqual({
                path: "/api/plugin-storage/reconcile-boot",
                generation: null,
            });
            expect(requests).not.toContainEqual({
                path: "/api/read",
                generation: GENERATION,
            });
        } finally {
            await server.cleanup();
        }
    }, 30_000);
});
