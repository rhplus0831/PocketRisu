import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const createAuth = vi.hoisted(() => vi.fn(async () => "diagnostic-auth"));
vi.mock("../globalApi.svelte", () => ({ forageStorage: { createAuth } }));

import {
    flushPluginStorageDiagnostics,
    getPluginStorageDiagnosticEventsForTest,
    pluginStorageDiagnosticDbId,
    recordPluginStorageDiagnostic,
    resetPluginStorageDiagnosticsForTest,
} from "./pluginStorageDiagnostics";

describe("plugin storage diagnostics buffer", () => {
    beforeEach(() => {
        (globalThis as { __PLUGIN_STORAGE_DIAG__?: unknown }).__PLUGIN_STORAGE_DIAG__ = true;
        resetPluginStorageDiagnosticsForTest();
        createAuth.mockClear();
    });
    afterEach(() => {
        delete (globalThis as { __PLUGIN_STORAGE_DIAG__?: unknown }).__PLUGIN_STORAGE_DIAG__;
        resetPluginStorageDiagnosticsForTest();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    test("record and dbId are dormant without the server or build flag", () => {
        delete (globalThis as { __PLUGIN_STORAGE_DIAG__?: unknown }).__PLUGIN_STORAGE_DIAG__;
        recordPluginStorageDiagnostic("sample", { index: 1 });
        expect(pluginStorageDiagnosticDbId({})).toBe(0);
        expect(getPluginStorageDiagnosticEventsForTest()).toEqual([]);
    });

    test("retains the newest 2,000 JSON-safe sequenced events", () => {
        vi.spyOn(Date, "now").mockReturnValue(123_456);
        for (let index = 0; index < 2_005; index++) {
            recordPluginStorageDiagnostic("sample", { index });
        }

        const events = getPluginStorageDiagnosticEventsForTest();
        expect(events).toHaveLength(2_000);
        expect(events[0]).toEqual({
            seq: 6,
            t: 123_456,
            kind: "sample",
            index: 5,
        });
        expect(events.at(-1)).toEqual({
            seq: 2_005,
            t: 123_456,
            kind: "sample",
            index: 2_004,
        });
    });

    test("assigns stable weak database ids and records identity churn", () => {
        const first = {};
        const second = {};

        expect(pluginStorageDiagnosticDbId(first)).toBe(1);
        expect(pluginStorageDiagnosticDbId(first)).toBe(1);
        expect(pluginStorageDiagnosticDbId(second)).toBe(2);

        expect(getPluginStorageDiagnosticEventsForTest().filter(event => (
            event.kind === "db-changed"
        ))).toEqual([
            expect.objectContaining({ oldDbId: null, newDbId: 1 }),
            expect.objectContaining({ oldDbId: 1, newDbId: 2 }),
        ]);
    });

    test("flushes one authenticated log entry with the event chunk in its description", async () => {
        const fetchMock = vi.fn(async (
            _input: RequestInfo | URL,
            _init?: RequestInit,
        ) => new Response(null, { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        recordPluginStorageDiagnostic("state-read", {
            caller: "keys-freshness",
            dbId: 1,
        });

        await flushPluginStorageDiagnostics();

        expect(createAuth).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0][0]).toBe("/api/logs");
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get("risu-auth")).toBe("diagnostic-auth");
        const body = JSON.parse(String(init.body));
        expect(body).toHaveLength(1);
        expect(body[0]).toMatchObject({
            message: "plugin-storage-diag",
            source: "plugin-storage-diag",
            level: "info",
        });
        expect(JSON.parse(body[0].description)).toEqual([
            expect.objectContaining({
                seq: 1,
                kind: "state-read",
                caller: "keys-freshness",
                dbId: 1,
            }),
        ]);
    });
});
