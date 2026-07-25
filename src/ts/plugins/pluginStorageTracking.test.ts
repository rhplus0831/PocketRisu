import { describe, expect, test } from "vitest";
import { capturePreTrackingPluginStorageChanges } from "./pluginStorageTracking";

describe("bootstrap plugin storage tracking", () => {
    test("queues a never-optimized inline plugin write made before the save effects start", () => {
        const tracker = { pluginCustomStorage: false };
        const persisted: {
            pluginCustomStorage: Record<string, unknown>;
            pluginStorageMeta: Record<string, { plugin: string; updatedAt: number }>;
        } = {
            pluginCustomStorage: { existing: { count: 1 } },
            pluginStorageMeta: {
                existing: { plugin: "Test", updatedAt: 1 },
            },
        };
        const current = structuredClone(persisted);
        current.pluginCustomStorage.startup = { count: 2 };
        current.pluginStorageMeta.startup = { plugin: "Startup Plugin", updatedAt: 2 };

        expect(capturePreTrackingPluginStorageChanges(tracker, current, persisted)).toBe(true);
        expect(tracker.pluginCustomStorage).toBe(true);
    });

    test("queues a sidecar-only startup update even when the value is unchanged", () => {
        const tracker = { pluginCustomStorage: false };
        const persisted = {
            pluginCustomStorage: { existing: "same" },
            pluginStorageMeta: {
                existing: { plugin: "Test", updatedAt: 1 },
            },
        };
        const current = structuredClone(persisted);
        current.pluginStorageMeta.existing.updatedAt = 2;

        expect(capturePreTrackingPluginStorageChanges(tracker, current, persisted)).toBe(true);
        expect(tracker.pluginCustomStorage).toBe(true);
    });

    test("does not schedule a save for equivalent missing and empty maps", () => {
        const tracker = { pluginCustomStorage: false };

        expect(capturePreTrackingPluginStorageChanges(
            tracker,
            { pluginCustomStorage: {} },
            {},
        )).toBe(false);
        expect(tracker.pluginCustomStorage).toBe(false);
    });
});
