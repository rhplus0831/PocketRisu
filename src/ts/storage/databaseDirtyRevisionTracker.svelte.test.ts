import { flushSync } from 'svelte'
import { describe, expect, test, vi } from 'vitest'
import { DatabaseDirtyRevisionLedger } from './databaseDirtyRevisions'
import { watchDatabaseDirtyRevisions } from './databaseDirtyRevisionTracker.svelte'

function makeDatabase() {
    return {
        username: 'initial',
        temperature: 70,
        characters: [
            {
                chaId: 'char-a',
                name: 'A',
                desc: 'initial-a',
                chats: [{
                    id: 'chat-a',
                    name: 'Chat A',
                    message: [{ role: 'user', data: 'hello' }],
                    modules: ['module-a'],
                }],
            },
            {
                chaId: 'char-b',
                name: 'B',
                desc: 'initial-b',
                chats: [],
            },
        ],
        botPresets: [{ id: 'preset-a', name: 'Preset A' }],
        modules: [
            { id: 'module-a', name: 'Module A', lorebook: [{ content: 'a' }] },
            { id: 'module-b', name: 'Module B', lorebook: [{ content: 'b' }] },
        ],
        plugins: [{ id: 'plugin-a', enabled: true }],
        pluginCustomStorage: { 'plugin-a': { value: 1 } },
        pluginStorageMeta: { generation: 1 },
    }
}

function createHarness() {
    const state = $state({ db: makeDatabase() })
    const callbacks = {
        rootKey: vi.fn(),
        character: vi.fn(),
        botPreset: vi.fn(),
        module: vi.fn(),
        plugins: vi.fn(),
        pluginCustomStorage: vi.fn(),
    }
    const tracker = watchDatabaseDirtyRevisions({
        getDatabase: () => state.db,
        onDirty: callbacks,
    })
    flushSync()
    return { state, callbacks, tracker }
}

describe('DatabaseDirtyRevisionLedger acknowledgement lifecycle', () => {
    test('discard retains dirty revisions and commit clears only acknowledged revisions', () => {
        const ledger = new DatabaseDirtyRevisionLedger()
        ledger.markCharacter('char-a')
        const failed = ledger.capture()
        ledger.discard(failed)
        expect(ledger.capture().characters.has('char-a')).toBe(true)

        ledger.markCharacter('char-a')
        const acknowledgedOlderAttempt = ledger.capture()
        ledger.markCharacter('char-a')
        ledger.commit(acknowledgedOlderAttempt)
        expect(ledger.capture().characters.has('char-a')).toBe(true)

        const latest = ledger.capture()
        ledger.commit(latest)
        expect(ledger.hasDirty()).toBe(false)
    })

    test('rejects a foreign acknowledgement token', () => {
        const first = new DatabaseDirtyRevisionLedger()
        const second = new DatabaseDirtyRevisionLedger()
        expect(() => first.commit(second.capture())).toThrow(/foreign database dirty revisions/)
    })
})

describe('watchDatabaseDirtyRevisions state-layer coverage', () => {
    test('reactive UI-path mutation dirties only the touched character projection', () => {
        const harness = createHarness()
        harness.state.db.characters[1].desc = 'edited through a bound UI proxy'
        flushSync()

        const revisions = harness.tracker.ledger.capture()
        expect([...revisions.characters.keys()]).toEqual(['char-b'])
        expect(revisions.rootKeys.size).toBe(0)
        expect(harness.callbacks.character).toHaveBeenCalledWith('char-b')
        harness.tracker.stop()
    })

    test('chat bodies stay out of database.bin revisions but stub metadata is covered', () => {
        const harness = createHarness()
        harness.state.db.characters[0].chats[0].message[0].data = 'row-only edit'
        flushSync()
        expect(harness.tracker.ledger.capture().characters.size).toBe(0)

        harness.state.db.characters[0].chats[0].name = 'persisted stub name'
        flushSync()
        expect([...harness.tracker.ledger.capture().characters.keys()]).toEqual(['char-a'])
        harness.tracker.stop()
    })

    test('programmatic store replacement marks the replaced character', () => {
        const harness = createHarness()
        harness.state.db.characters[1] = {
            ...harness.state.db.characters[1],
            desc: 'programmatic helper replacement',
        }
        flushSync()

        expect([...harness.tracker.ledger.capture().characters.keys()]).toEqual(['char-b'])
        harness.tracker.stop()
    })

    test('root keys and equality-cached collection branches retain precise identities', () => {
        const harness = createHarness()
        harness.state.db.temperature = 71
        harness.state.db.modules[1].lorebook[0].content = 'module edit'
        harness.state.db.botPresets[0].name = 'Preset edit'
        harness.state.db.plugins[0].enabled = false
        harness.state.db.pluginCustomStorage['plugin-a'].value = 2
        flushSync()

        const revisions = harness.tracker.ledger.capture()
        expect([...revisions.rootKeys.keys()]).toEqual(['temperature'])
        expect([...revisions.modules.keys()]).toEqual(['module-b'])
        expect(revisions.botPreset).not.toBeNull()
        expect(revisions.plugins).not.toBeNull()
        expect(revisions.pluginCustomStorage).not.toBeNull()
        harness.tracker.stop()
    })

    test('plugin-driven proxy mutations mark plugin and character branches', () => {
        const harness = createHarness()
        harness.state.db.plugins.push({ id: 'plugin-b', enabled: true })
        harness.state.db.characters[0].desc = 'plugin API character mutation'
        flushSync()

        const revisions = harness.tracker.ledger.capture()
        expect(revisions.plugins).not.toBeNull()
        expect([...revisions.characters.keys()]).toEqual(['char-a'])
        harness.tracker.stop()
    })

    test.each([
        ['import/restore replacement'],
        ['conflict-rebase replacement'],
    ])('%s conservatively dirties every replaced persistence branch', () => {
        const harness = createHarness()
        const replacement = structuredClone(makeDatabase())
        replacement.username = 'authoritative replacement'
        replacement.characters[0].desc = 'overlaid local branch'
        harness.state.db = replacement
        flushSync()

        const revisions = harness.tracker.ledger.capture()
        expect(revisions.rootKeys.has('username')).toBe(true)
        expect(revisions.characters.has('char-a')).toBe(true)
        expect(revisions.characters.has('char-b')).toBe(true)
        expect(revisions.botPreset).not.toBeNull()
        expect(revisions.modules.size).toBe(2)
        expect(revisions.plugins).not.toBeNull()
        expect(revisions.pluginCustomStorage).not.toBeNull()
        harness.tracker.stop()
    })
})
