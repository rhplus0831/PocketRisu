export type RisuSaveRevisionBranch =
    | 'botPreset'
    | 'charactersStructural'
    | 'modulesStructural'
    | 'plugins'
    | 'pluginCustomStorage'

export interface RisuSaveDirtyRevisions {
    readonly rootKeys: ReadonlyMap<string, number>
    readonly characters: ReadonlyMap<string, number>
    readonly modules: ReadonlyMap<string, number>
    readonly botPreset: number | null
    readonly charactersStructural: number | null
    readonly modulesStructural: number | null
    readonly plugins: number | null
    readonly pluginCustomStorage: number | null
    isRootKeyTrusted(key: string): boolean
    isCharacterTrusted(chaId: string): boolean
    isModuleTrusted(moduleId: string): boolean
    isBranchTrusted(branch: RisuSaveRevisionBranch): boolean
}

interface OwnedDirtyRevisions extends RisuSaveDirtyRevisions {
    readonly owner: symbol
}

/**
 * Monotonic dirty revisions whose acknowledgement is independent from save
 * proposal creation. A captured revision remains dirty after discard, and a
 * commit clears only the exact revisions represented by that acknowledged
 * save; mutations that happened while it was in flight remain pending.
 */
export class DatabaseDirtyRevisionLedger {
    private readonly owner = Symbol('DatabaseDirtyRevisionLedger')
    private nextRevision = 0
    private readonly dirtyRootKeys = new Map<string, number>()
    private readonly dirtyCharacters = new Map<string, number>()
    private readonly dirtyModules = new Map<string, number>()
    private dirtyBotPreset: number | null = null
    private dirtyCharactersStructural: number | null = null
    private dirtyModulesStructural: number | null = null
    private dirtyPlugins: number | null = null
    private dirtyPluginCustomStorage: number | null = null

    private rootStructureTrusted = false
    private characterStructureTrusted = false
    private moduleStructureTrusted = false
    private readonly untrustedRootKeys = new Set<string>()
    private readonly untrustedCharacters = new Set<string>()
    private readonly untrustedModules = new Set<string>()
    private readonly trustedBranches = new Set<RisuSaveRevisionBranch>()

    private revision(): number {
        this.nextRevision += 1
        return this.nextRevision
    }

    markRootKey(key: string): void {
        this.dirtyRootKeys.set(key, this.revision())
    }

    markCharacter(chaId: string): void {
        if (chaId) this.dirtyCharacters.set(chaId, this.revision())
    }

    markModule(moduleId: string): void {
        if (moduleId) this.dirtyModules.set(moduleId, this.revision())
    }

    markBranch(branch: RisuSaveRevisionBranch): void {
        const revision = this.revision()
        if (branch === 'botPreset') this.dirtyBotPreset = revision
        else if (branch === 'charactersStructural') this.dirtyCharactersStructural = revision
        else if (branch === 'modulesStructural') this.dirtyModulesStructural = revision
        else if (branch === 'plugins') this.dirtyPlugins = revision
        else this.dirtyPluginCustomStorage = revision
    }

    trustRootStructure(trusted: boolean): void {
        this.rootStructureTrusted = trusted
    }

    trustCharacterStructure(trusted: boolean): void {
        this.characterStructureTrusted = trusted
    }

    trustModuleStructure(trusted: boolean): void {
        this.moduleStructureTrusted = trusted
    }

    trustRootKey(key: string, trusted: boolean): void {
        if (trusted) this.untrustedRootKeys.delete(key)
        else this.untrustedRootKeys.add(key)
    }

    trustCharacter(chaId: string, trusted: boolean): void {
        if (!chaId) return
        if (trusted) this.untrustedCharacters.delete(chaId)
        else this.untrustedCharacters.add(chaId)
    }

    trustModule(moduleId: string, trusted: boolean): void {
        if (!moduleId) return
        if (trusted) this.untrustedModules.delete(moduleId)
        else this.untrustedModules.add(moduleId)
    }

    trustBranch(branch: RisuSaveRevisionBranch, trusted: boolean): void {
        if (trusted) this.trustedBranches.add(branch)
        else this.trustedBranches.delete(branch)
    }

    capture(): RisuSaveDirtyRevisions {
        const owner = this.owner
        return {
            owner,
            rootKeys: new Map(this.dirtyRootKeys),
            characters: new Map(this.dirtyCharacters),
            modules: new Map(this.dirtyModules),
            botPreset: this.dirtyBotPreset,
            charactersStructural: this.dirtyCharactersStructural,
            modulesStructural: this.dirtyModulesStructural,
            plugins: this.dirtyPlugins,
            pluginCustomStorage: this.dirtyPluginCustomStorage,
            isRootKeyTrusted: (key) => (
                this.rootStructureTrusted && !this.untrustedRootKeys.has(key)
            ),
            isCharacterTrusted: (chaId) => (
                this.characterStructureTrusted && !this.untrustedCharacters.has(chaId)
            ),
            isModuleTrusted: (moduleId) => (
                this.moduleStructureTrusted && !this.untrustedModules.has(moduleId)
            ),
            isBranchTrusted: (branch) => this.trustedBranches.has(branch),
        } as OwnedDirtyRevisions
    }

    hasDirty(snapshot: RisuSaveDirtyRevisions = this.capture()): boolean {
        return snapshot.rootKeys.size > 0
            || snapshot.characters.size > 0
            || snapshot.modules.size > 0
            || snapshot.botPreset !== null
            || snapshot.charactersStructural !== null
            || snapshot.modulesStructural !== null
            || snapshot.plugins !== null
            || snapshot.pluginCustomStorage !== null
    }

    commit(snapshot: RisuSaveDirtyRevisions): void {
        const owned = this.assertOwned(snapshot)
        this.clearMatchingMap(this.dirtyRootKeys, owned.rootKeys)
        this.clearMatchingMap(this.dirtyCharacters, owned.characters)
        this.clearMatchingMap(this.dirtyModules, owned.modules)
        if (this.dirtyBotPreset === owned.botPreset) this.dirtyBotPreset = null
        if (this.dirtyCharactersStructural === owned.charactersStructural) {
            this.dirtyCharactersStructural = null
        }
        if (this.dirtyModulesStructural === owned.modulesStructural) this.dirtyModulesStructural = null
        if (this.dirtyPlugins === owned.plugins) this.dirtyPlugins = null
        if (this.dirtyPluginCustomStorage === owned.pluginCustomStorage) {
            this.dirtyPluginCustomStorage = null
        }
    }

    discard(snapshot: RisuSaveDirtyRevisions): void {
        this.assertOwned(snapshot)
    }

    private assertOwned(snapshot: RisuSaveDirtyRevisions): OwnedDirtyRevisions {
        const owned = snapshot as Partial<OwnedDirtyRevisions>
        if (owned.owner !== this.owner) {
            throw new Error('Cannot acknowledge foreign database dirty revisions')
        }
        return owned as OwnedDirtyRevisions
    }

    private clearMatchingMap(
        dirty: Map<string, number>,
        captured: ReadonlyMap<string, number>,
    ): void {
        for (const [key, revision] of captured) {
            if (dirty.get(key) === revision) dirty.delete(key)
        }
    }
}

export function hasRisuSaveDirtyRevisions(
    snapshot: RisuSaveDirtyRevisions | undefined,
): boolean {
    return !!snapshot && (
        snapshot.rootKeys.size > 0
        || snapshot.characters.size > 0
        || snapshot.modules.size > 0
        || snapshot.botPreset !== null
        || snapshot.charactersStructural !== null
        || snapshot.modulesStructural !== null
        || snapshot.plugins !== null
        || snapshot.pluginCustomStorage !== null
    )
}
