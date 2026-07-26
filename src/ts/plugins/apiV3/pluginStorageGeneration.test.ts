import { describe, expect, test } from "vitest";
import { snapshotV3PluginStorageBatchForTransport } from "./factory";
import { createPluginStorageGenerationHelpers } from "./pluginStorageGeneration";

type Row = { value: unknown; revision: string };
type Operation =
    | { type: "set"; key: string; value: unknown; expectedRevision?: string | null }
    | { type: "remove"; key: string; expectedRevision?: string | null };

const uuid = (sequence: number) => `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
const revision = (sequence: number) => `sha256:${sequence.toString(16).padStart(64, "0")}`;

function stableStringify(value: any): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => (
        `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
}

async function hashValue(value: any): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(stableStringify(value)),
    ));
    return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

class MemoryAtomicStorage {
    rows = new Map<string, Row>();
    sequence = 1;
    failAt: string | null = null;
    snapshots: { boundary: string; rows: Map<string, Row> }[] = [];
    readFailureKey: string | null = null;
    readGate: Promise<void> | null = null;
    readSignals: (AbortSignal | undefined)[] = [];
    batchSignals: (AbortSignal | undefined)[] = [];

    cloneRows(source = this.rows): Map<string, Row> {
        return new Map([...source].map(([key, row]) => [
            key,
            { value: structuredClone(row.value), revision: row.revision },
        ]));
    }

    async getWithRevision(key: string, signal?: AbortSignal) {
        this.readSignals.push(signal);
        await this.readGate;
        if (key === this.readFailureKey) throw new Error("transient read failure");
        const row = this.rows.get(key);
        return row
            ? { status: "value" as const, value: structuredClone(row.value), revision: row.revision, generation: null }
            : { status: "missing" as const, value: null, revision: null, generation: null };
    }

    boundary(name: string, committedRows = this.rows): void {
        this.snapshots.push({ boundary: name, rows: this.cloneRows(committedRows) });
        if (this.failAt === name) throw new Error(`injected:${name}`);
    }

    async atomicBatch(operations: readonly Operation[], signal?: AbortSignal) {
        this.batchSignals.push(signal);
        for (const operation of operations) {
            if (!Object.prototype.hasOwnProperty.call(operation, "expectedRevision")) continue;
            const current = this.rows.get(operation.key)?.revision ?? null;
            if (current !== operation.expectedRevision) {
                return {
                    committed: false as const,
                    conflicts: [{ key: operation.key, revision: current, generation: null }],
                };
            }
        }
        const staged = this.cloneRows();
        for (let index = 0; index < operations.length; index += 1) {
            const operation = operations[index];
            const kind = index === operations.length - 1
                ? "head"
                : index === operations.length - 2
                    ? "manifest"
                    : `body-${index}`;
            this.boundary(`${kind}:before-value`);
            if (operation.type === "set") {
                staged.set(operation.key, {
                    value: structuredClone(operation.value),
                    revision: revision(this.sequence++),
                });
            } else {
                staged.delete(operation.key);
            }
            this.boundary(`${kind}:after-value`);
            this.boundary(`${kind}:after-owner`);
        }
        this.boundary("before-commit");
        this.rows = staged;
        this.boundary("after-commit-before-ack", this.rows);
        return {
            committed: true as const,
            generation: uuid(this.sequence++),
            revisions: operations.map(operation => ({
                key: operation.key,
                revision: this.rows.get(operation.key)?.revision ?? null,
            })),
        };
    }
}

function helpers(storage: MemoryAtomicStorage, firstUuid: number) {
    let nextUuid = firstUuid;
    return createPluginStorageGenerationHelpers(
        storage,
        snapshotV3PluginStorageBatchForTransport,
        {
            randomUUID: () => uuid(nextUuid++) as `${string}-${string}-${string}-${string}-${string}`,
            subtle: globalThis.crypto.subtle,
        },
    );
}

const firstBodies = [
    { id: "left", count: 2, value: ["old-a", "old-b"] },
    { id: "right", count: 1, value: { text: "old-c" } },
];
const secondBodies = [
    { id: "left", count: 1, value: ["new-a"] },
    { id: "right", count: 2, value: { text: "new-b", extra: "new-c" } },
];

describe("V3 immutable plugin-storage generations", () => {
    test("initial publication exposes only missing or the complete first generation", async () => {
        const boundaries = [
            "body-0:before-value", "body-0:after-value", "body-0:after-owner",
            "body-1:before-value", "body-1:after-value", "body-1:after-owner",
            "manifest:before-value", "manifest:after-value", "manifest:after-owner",
            "head:before-value", "head:after-value", "head:after-owner",
            "before-commit", "after-commit-before-ack",
        ];
        for (const failAt of boundaries) {
            const storage = new MemoryAtomicStorage();
            storage.failAt = failAt;
            await expect(helpers(storage, 1).publish({
                manifestKey: "records/head",
                bodyKeyPrefix: "records/immutable",
                bodies: firstBodies,
            })).rejects.toThrow(`injected:${failAt}`);
            const loaded = await helpers(storage, 100).load("records/head");
            if (failAt === "after-commit-before-ack") {
                expect(loaded).toMatchObject({
                    status: "value",
                    value: { bodies: firstBodies, totalCount: 3 },
                });
            } else {
                expect(loaded).toEqual({ status: "missing", value: null, revision: null });
            }
            for (const snapshot of storage.snapshots) {
                const snapshotStorage = new MemoryAtomicStorage();
                snapshotStorage.rows = snapshot.rows;
                const snapshotLoaded = await helpers(snapshotStorage, 200).load("records/head");
                expect(snapshotLoaded.status).toBe(
                    snapshot.boundary === "after-commit-before-ack" ? "value" : "missing",
                );
            }
        }
    });

    test("every body/owner/manifest/head midpoint and restart loads only old or new", async () => {
        const boundaries = [
            "body-0:before-value", "body-0:after-value", "body-0:after-owner",
            "body-1:before-value", "body-1:after-value", "body-1:after-owner",
            "manifest:before-value", "manifest:after-value", "manifest:after-owner",
            "head:before-value", "head:after-value", "head:after-owner",
            "before-commit", "after-commit-before-ack",
        ];
        for (const failAt of boundaries) {
            const storage = new MemoryAtomicStorage();
            await helpers(storage, 1).publish({
                manifestKey: "records/head",
                bodyKeyPrefix: "records/immutable",
                bodies: firstBodies,
            });
            storage.failAt = failAt;
            storage.snapshots = [];
            await expect(helpers(storage, 2).publish({
                manifestKey: "records/head",
                bodyKeyPrefix: "records/immutable",
                bodies: secondBodies,
            })).rejects.toThrow(`injected:${failAt}`);

            const restarted = helpers(storage, 100);
            const loaded = await restarted.load("records/head");
            expect(loaded.status).toBe("value");
            if (loaded.status !== "value") throw new Error("generation unexpectedly missing");
            expect(loaded.value.bodies).toEqual(
                failAt === "after-commit-before-ack" ? secondBodies : firstBodies,
            );

            for (const snapshot of storage.snapshots) {
                const snapshotStorage = new MemoryAtomicStorage();
                snapshotStorage.rows = snapshot.rows;
                const snapshotLoaded = await helpers(snapshotStorage, 200).load("records/head");
                expect(snapshotLoaded.status).toBe("value");
                if (snapshotLoaded.status !== "value") throw new Error("snapshot generation missing");
                expect(snapshotLoaded.value.bodies).toEqual(
                    snapshot.boundary === "after-commit-before-ack" ? secondBodies : firstBodies,
                );
            }
        }
    });

    test.each([
        ["generation", (body: any) => { body.generation = uuid(999); }],
        ["hash", (body: any) => { body.value = { silently: "mixed" }; }],
        ["count", (body: any) => { body.count += 1; }],
        ["identity", (body: any) => { body.id = "other"; }],
    ])("rejects a mixed %s body and recovers the complete prior generation", async (_name, mutate) => {
        const storage = new MemoryAtomicStorage();
        const api = helpers(storage, 1);
        const oldPublish = await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: firstBodies,
        });
        if (!oldPublish.committed) throw new Error("old publish conflicted");
        await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: secondBodies,
        });
        const head = storage.rows.get("records/head")!.value as any;
        const manifest = storage.rows.get(head.current.manifestKey)!.value as any;
        const mixedRow = storage.rows.get(manifest.entries[0].key)!;
        mutate(mixedRow.value);

        const loaded = await helpers(storage, 100).load("records/head");
        expect(loaded).toMatchObject({
            status: "value",
            recoveredFromPrevious: true,
            value: { generation: oldPublish.current.generation, bodies: firstBodies, totalCount: 3 },
        });
    });

    test.each(["missing", "hash", "count", "generation", "shape"])(
        "falls back to the exact complete previous generation for %s current-manifest corruption",
        async corruption => {
            const storage = new MemoryAtomicStorage();
            const api = helpers(storage, 1);
            const previous = await api.publish({
                manifestKey: "records/head",
                bodyKeyPrefix: "records/immutable",
                bodies: firstBodies,
            });
            if (!previous.committed) throw new Error("previous publish conflicted");
            await api.publish({
                manifestKey: "records/head",
                bodyKeyPrefix: "records/immutable",
                bodies: secondBodies,
            });
            const head = storage.rows.get("records/head")!.value as any;
            const manifestKey = head.current.manifestKey;
            if (corruption === "missing") {
                storage.rows.delete(manifestKey);
            } else {
                const manifest = storage.rows.get(manifestKey)!.value as any;
                if (corruption === "hash") manifest.entries[0].id = "hash-tampered";
                else if (corruption === "count") manifest.totalCount += 1;
                else if (corruption === "generation") manifest.generation = uuid(999);
                else manifest.unexpected = true;
            }

            expect(await helpers(storage, 100).load("records/head")).toMatchObject({
                status: "value",
                recoveredFromPrevious: true,
                value: {
                    generation: previous.current.generation,
                    bodies: firstBodies,
                    totalCount: 3,
                },
            });
        },
    );

    test("CAS prevents concurrent publication and GC retains current and previous", async () => {
        const storage = new MemoryAtomicStorage();
        const api = helpers(storage, 1);
        const first = await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: firstBodies,
        });
        if (!first.committed) throw new Error("first publish conflicted");
        const staleRevision = storage.rows.get("records/head")!.revision;
        const second = await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: secondBodies,
        });
        if (!second.committed) throw new Error("second publish conflicted");

        const conflict = await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: firstBodies,
            expectedRevision: staleRevision,
        });
        expect(conflict.committed).toBe(false);
        await expect(api.garbageCollect({
            manifestKey: "records/head",
            generation: first.current,
        })).rejects.toThrow("current and previous");
        expect((await api.load("records/head"))).toMatchObject({
            status: "value",
            recoveredFromPrevious: false,
            value: { bodies: secondBodies },
        });
    });

    test("a transient current-body read failure rejects instead of selecting stale data", async () => {
        const storage = new MemoryAtomicStorage();
        const api = helpers(storage, 1);
        await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: firstBodies,
        });
        await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: secondBodies,
        });
        const head = storage.rows.get("records/head")!.value as any;
        const manifest = storage.rows.get(head.current.manifestKey)!.value as any;
        storage.readFailureKey = manifest.entries[0].key;

        await expect(api.load("records/head")).rejects.toThrow("transient read failure");
    });

    test("a transient current-manifest read failure rejects instead of selecting stale data", async () => {
        const storage = new MemoryAtomicStorage();
        const api = helpers(storage, 1);
        await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: firstBodies,
        });
        await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: secondBodies,
        });
        const head = storage.rows.get("records/head")!.value as any;
        storage.readFailureKey = head.current.manifestKey;

        await expect(api.load("records/head")).rejects.toThrow("transient read failure");
    });

    test("publication retains the last fully verified fallback when current bodies are corrupt", async () => {
        const storage = new MemoryAtomicStorage();
        const api = helpers(storage, 1);
        const first = await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: firstBodies,
        });
        if (!first.committed) throw new Error("first publish conflicted");
        const second = await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: secondBodies,
        });
        if (!second.committed) throw new Error("second publish conflicted");

        const secondManifest = storage.rows.get(second.current.manifestKey)!.value as any;
        const secondBody = storage.rows.get(secondManifest.entries[0].key)!.value as any;
        secondBody.value = { silently: "corrupt-second-generation" };
        expect(await api.load("records/head")).toMatchObject({
            status: "value",
            recoveredFromPrevious: true,
            value: { generation: first.current.generation, bodies: firstBodies },
        });

        const thirdBodies = [{ id: "third", count: 1, value: "newest" }];
        const third = await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: thirdBodies,
        });
        if (!third.committed) throw new Error("third publish conflicted");
        expect(third.previous).toEqual(first.current);

        await expect(api.garbageCollect({
            manifestKey: "records/head",
            generation: first.current,
        })).rejects.toThrow("current and previous");
        await expect(api.garbageCollect({
            manifestKey: "records/head",
            generation: second.current,
        })).rejects.toThrow("verified lineage");

        const thirdManifest = storage.rows.get(third.current.manifestKey)!.value as any;
        const thirdBody = storage.rows.get(thirdManifest.entries[0].key)!.value as any;
        thirdBody.value = "corrupt-third-generation";
        expect(await api.load("records/head")).toMatchObject({
            status: "value",
            recoveredFromPrevious: true,
            value: {
                generation: first.current.generation,
                bodies: firstBodies,
                totalCount: 3,
            },
        });
    });

    test("publication rejects transient validation failures without replacing the head", async () => {
        const storage = new MemoryAtomicStorage();
        const api = helpers(storage, 1);
        await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: firstBodies,
        });
        const second = await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: secondBodies,
        });
        if (!second.committed) throw new Error("second publish conflicted");
        const secondManifest = storage.rows.get(second.current.manifestKey)!.value as any;
        storage.readFailureKey = secondManifest.entries[0].key;
        const headBeforePublish = structuredClone(storage.rows.get("records/head"));

        await expect(api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: [{ id: "third", count: 1, value: "newest" }],
        })).rejects.toThrow("transient read failure");
        expect(storage.rows.get("records/head")).toEqual(headBeforePublish);
    });

    test("snapshots the publication plan before I/O and never invokes accessors", async () => {
        const storage = new MemoryAtomicStorage();
        let release!: () => void;
        storage.readGate = new Promise(resolve => { release = resolve; });
        const mutable = { id: "only", count: 1, value: { text: "original" } };
        const publication = helpers(storage, 1).publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: [mutable],
        });
        mutable.value.text = "changed-after-call";
        release();
        storage.readGate = null;
        await publication;
        expect(await helpers(storage, 10).load("records/head")).toMatchObject({
            status: "value",
            value: { bodies: [{ id: "only", count: 1, value: { text: "original" } }] },
        });

        let getterCalls = 0;
        const accessorBody = Object.defineProperty({ id: "bad", count: 1 }, "value", {
            enumerable: true,
            get() {
                getterCalls += 1;
                return "unsafe";
            },
        });
        await expect(helpers(storage, 20).publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: [accessorBody as any],
        })).rejects.toThrow("enumerable data property");
        expect(getterCalls).toBe(0);
    });

    test("binds heads and retired generations to one exact repository lineage", async () => {
        const storage = new MemoryAtomicStorage();
        const api = helpers(storage, 1);
        const first = await api.publish({
            manifestKey: "alpha/head",
            bodyKeyPrefix: "alpha/immutable",
            bodies: firstBodies,
        });
        if (!first.committed) throw new Error("first publish conflicted");
        await api.publish({
            manifestKey: "alpha/head",
            bodyKeyPrefix: "alpha/immutable",
            bodies: secondBodies,
        });
        await api.publish({
            manifestKey: "alpha/head",
            bodyKeyPrefix: "alpha/immutable",
            bodies: [{ id: "third", count: 1, value: "alpha-three" }],
        });
        const betaFirst = await api.publish({
            manifestKey: "beta/head",
            bodyKeyPrefix: "beta/immutable",
            bodies: [{ id: "beta", count: 1, value: "beta-one" }],
        });
        if (!betaFirst.committed) throw new Error("beta publish conflicted");

        const before = storage.cloneRows();
        await expect(api.garbageCollect({
            manifestKey: "beta/head",
            generation: first.current,
        })).rejects.toThrow("another repository");
        expect(storage.rows).toEqual(before);

        // A byte-valid head cannot be transplanted under another repository key.
        storage.rows.set("beta/head", structuredClone(storage.rows.get("alpha/head")!));
        await expect(api.load("beta/head")).rejects.toMatchObject({
            code: "PLUGIN_GENERATION_LINEAGE_INVALID",
        });
        storage.rows.set("beta/head", before.get("beta/head")!);

        // Even with a recomputed head hash, splicing an unrelated prior ref is
        // rejected before a current-body failure could trigger fallback.
        const alphaHeadRow = storage.rows.get("alpha/head")!;
        const alphaHead = alphaHeadRow.value as any;
        alphaHead.previous = first.current;
        alphaHead.headHash = await hashValue({
            protocol: alphaHead.protocol,
            repository: alphaHead.repository,
            current: alphaHead.current,
            previous: alphaHead.previous,
        });
        await expect(api.load("alpha/head")).rejects.toMatchObject({
            code: "PLUGIN_GENERATION_LINEAGE_INVALID",
        });
    });

    test("garbage collection snapshots inputs, proves lineage, and forwards its signal", async () => {
        const storage = new MemoryAtomicStorage();
        const api = helpers(storage, 1);
        const first = await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: firstBodies,
        });
        if (!first.committed) throw new Error("first publish conflicted");
        await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: secondBodies,
        });
        const third = await api.publish({
            manifestKey: "records/head",
            bodyKeyPrefix: "records/immutable",
            bodies: [{ id: "third", count: 1, value: "newest" }],
        });
        if (!third.committed) throw new Error("third publish conflicted");

        let release!: () => void;
        storage.readGate = new Promise(resolve => { release = resolve; });
        const reference = { ...first.current };
        const controller = new AbortController();
        const gcOptions = {
            manifestKey: "records/head",
            generation: reference,
            unloadSignal: controller.signal,
        };
        const collection = api.garbageCollect(gcOptions);
        Object.assign(reference, third.current);
        gcOptions.manifestKey = "mutated/head";
        gcOptions.unloadSignal = new AbortController().signal;
        release();
        storage.readGate = null;
        await expect(collection).resolves.toMatchObject({ committed: true, removed: true });
        expect(storage.rows.has(first.current.manifestKey)).toBe(false);
        expect(storage.rows.has(third.current.manifestKey)).toBe(true);
        expect(storage.readSignals.slice(-4).every(signal => signal === controller.signal)).toBe(true);
        expect(storage.batchSignals.at(-1)).toBe(controller.signal);

        let getterCalls = 0;
        const accessorReference = { ...third.current };
        Object.defineProperty(accessorReference, "manifestHash", {
            enumerable: true,
            get() {
                getterCalls += 1;
                return third.current.manifestHash;
            },
        });
        await expect(api.garbageCollect({
            manifestKey: "records/head",
            generation: accessorReference,
        })).rejects.toThrow("enumerable data property");
        expect(getterCalls).toBe(0);

        const accessorOptions = {
            manifestKey: "records/head",
            generation: third.current,
        } as Record<string, unknown>;
        Object.defineProperty(accessorOptions, "unloadSignal", {
            enumerable: true,
            get() {
                getterCalls += 1;
                return controller.signal;
            },
        });
        await expect(api.garbageCollect(accessorOptions as any))
            .rejects.toThrow("enumerable data property");
        expect(getterCalls).toBe(0);
    });

    test.each(["/", "////"])("rejects normalized-empty body prefix %s", async prefix => {
        const storage = new MemoryAtomicStorage();
        await expect(helpers(storage, 1).publish({
            manifestKey: "records/head",
            bodyKeyPrefix: prefix,
            bodies: firstBodies,
        })).rejects.toThrow("empty prefix");
        expect(storage.rows.size).toBe(0);
    });
});
