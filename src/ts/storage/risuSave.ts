import { Unpackr } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { createBotPresetTemplate, getDatabase, type Database } from "./database.svelte";
import { forageStorage } from "../globalApi.svelte";
import { chatToStub } from "./chatStorage";
import { hasPluginStorageRecordValue } from '../plugins/pluginStorageRecord';
import {
    magicCompressedHeader,
    magicHeader,
    magicPluginStorageCompressedHeader,
    magicPluginStorageHeader,
    magicPluginStorageStreamHeader,
    magicStreamCompressedHeader,
    normalizeJSON,
    restoreLegacyPluginStorageKeys,
    encodeRisuSaveCompressionStream,
    encodeRisuSaveLegacy,
} from "./legacyRisuSaveCodec";
import {
    applyRisuSaveBotPresetDefault,
    decodeStrictRisuSaveBlocks,
    magicRisuSaveHeader,
    RisuSaveBlockIntegrityError,
    RisuSaveType,
} from "./strictRisuSaveCodec";
import { ensureCompressionStreams } from "./compressionStreams";
import type { RisuSaveDirtyRevisions, RisuSaveRevisionBranch } from "./databaseDirtyRevisions";

export { encodeRisuSaveCompressionStream, encodeRisuSaveLegacy, normalizeJSON };
export { RisuSaveBlockIntegrityError } from './strictRisuSaveCodec';

const unpackr = new Unpackr({
    copyBuffers:true,
    int64AsType: 'number',
    useRecords:false
})

const patchByteEncoder = new TextEncoder();
export const CHARACTER_PATCH_MAX_OPERATIONS = 32_768;
export const CHARACTER_PATCH_MAX_BYTES = 8 * 1024 * 1024;


// NodeOnly: server cannot resolve remote blocks, always disable
const disableRemoteSaving = () => true
const checkedRemoteExistence = new Set<string>();

export type toSaveType = {
    character: string[];
    chat: [string, string][];
    root: boolean;
    botPreset: boolean;
    modules: boolean;
    plugins: boolean;
    pluginCustomStorage: boolean;
}

export type RisuSaveWorkEvent = {
    codec: 'encoder' | 'patcher'
    branch: 'root' | 'character' | 'botPreset' | 'module' | 'plugins' | 'pluginCustomStorage'
    identity: string
    work: 'json-equality' | 'json-encode'
}

export interface RisuSaveCodecOptions {
    /** Test/env-gated dual run: trusted clean revisions are checked against JSON equality. */
    verifyDirtyRevisions?: boolean
    onWork?: (event: RisuSaveWorkEvent) => void
}

function defaultDirtyRevisionVerification(): boolean {
    return import.meta.env.MODE === 'test'
        || import.meta.env.VITE_RISU_SAVE_VERIFY_DIRTY_REVISIONS === 'true'
}

function revisionDivergence(
    codec: 'encoder' | 'patcher',
    branch: string,
): Error {
    return new Error(
        `RisuSave dirty revision divergence: ${codec} ${branch} revision says clean but JSON equality says dirty`,
    )
}

function isRevisionBranchDirty(
    revisions: RisuSaveDirtyRevisions | undefined,
    branch: RisuSaveRevisionBranch,
): boolean {
    if (!revisions) return false
    if (branch === 'botPreset') return revisions.botPreset !== null
    if (branch === 'charactersStructural') return revisions.charactersStructural !== null
    if (branch === 'modulesStructural') return revisions.modulesStructural !== null
    if (branch === 'plugins') return revisions.plugins !== null
    return revisions.pluginCustomStorage !== null
}

type EncodeBlockArg = {
    compression:boolean
    data:string
    type:RisuSaveType
    name:string
    cache?:boolean
    skipRemoteSaving?:boolean
}

type EncodeBlockOption = {
    remote: 'none'|'prefer'|'force'
}

type RisuSaveCachedBlock = {type: RisuSaveType, data: string, name: string};
type RisuSaveCacheGeneration = {
    owner: symbol;
    blocks: ReadonlyMap<string, RisuSaveCachedBlock>;
};

// At most one completed encoder generation is available to the permissive
// recovery decoder. Encoder instances build their maps privately and publish
// an immutable snapshot only after init()/set() completes.
let risuSaveCacheGeneration: RisuSaveCacheGeneration|null = null;

export type RisuSaveDecodeOptions = {
    strictBlockIntegrity?: boolean;
};

function blockIntegrityError(message: string, cause?: unknown): RisuSaveBlockIntegrityError {
    return new RisuSaveBlockIntegrityError(
        message,
        cause === undefined ? undefined : { cause },
    );
}

function isKnownJsonRisuSaveType(type: RisuSaveType): boolean {
    return Number.isInteger(type)
        && type >= RisuSaveType.CONFIG
        && type <= RisuSaveType.PLUGIN_STORAGE;
}

export class RisuSaveEncoder {

    private blocks: { [key: string]: Uint8Array } = {};
    private compression: boolean = false;
    // Per-character change detection: the exact JSON we last encoded. A plain
    // string comparison is a native memcmp — ~3x faster than the previous
    // normalizeJSON + calculateHash walk — and the string is reused as the
    // encode payload, so changed characters aren't stringified twice.
    // In-memory only (rebuilt by init()), so the representation is free to
    // differ from the patcher's protocol-level calculateHash.
    private characterJsons: { [key: string]: string } = {};
    private baselineJsons = {
        root: '{}',
        preset: '[]',
        modules: '[]',
        plugins: '[]',
        pluginStorage: '{}',
    };
    private normalizedBaseline: Database | null = null;
    private lastDirectory: string[] = [];
    private readonly cacheGenerationOwner = Symbol('RisuSaveEncoder cache generation');
    private readonly cachedBlocks = new Map<string, RisuSaveCachedBlock>();
    private readonly verifyDirtyRevisions: boolean;
    private readonly onWork?: (event: RisuSaveWorkEvent) => void;

    constructor(options: RisuSaveCodecOptions = {}) {
        this.verifyDirtyRevisions = options.verifyDirtyRevisions
            ?? defaultDirtyRevisionVerification();
        this.onWork = options.onWork;
    }

    private recordWork(
        branch: RisuSaveWorkEvent['branch'],
        identity: string,
        work: RisuSaveWorkEvent['work'],
    ): void {
        this.onWork?.({ codec: 'encoder', branch, identity, work });
    }

    private invalidatePublishedCache(){
        if(risuSaveCacheGeneration?.owner === this.cacheGenerationOwner){
            risuSaveCacheGeneration = null;
        }
    }

    private publishCacheGeneration(){
        risuSaveCacheGeneration = {
            owner: this.cacheGenerationOwner,
            blocks: new Map(this.cachedBlocks),
        };
    }

    async init(data:Database,arg:{
        compression?: boolean,
        skipRemoteSavingOnCharacters?: boolean
    } = {}){
        // Cached recovery blocks are valid only for the lifetime of this
        // encoder generation. A replacement encoder must not inherit blocks
        // from the database (or account/import state) that preceded it.
        this.invalidatePublishedCache();
        this.cachedBlocks.clear();
        this.blocks = {};
        this.characterJsons = {};
        this.normalizedBaseline = null;
        this.lastDirectory = [];
        this.baselineJsons = {
            root: '{}',
            preset: '[]',
            modules: '[]',
            plugins: '[]',
            pluginStorage: '{}',
        };
        const {
            compression = false,
            skipRemoteSavingOnCharacters = true
        } = arg;
        this.compression = compression;
        let obj:Record<any,any> = {}
        let keys = Object.keys(data)
        for(const key of keys){
            if(
                key !== 'characters' && key !== 'botPresets' && key !== 'modules' &&
                key !== 'plugins' && key !== 'pluginCustomStorage'
            ){
                obj[key] = data[key]
            }
        }
        // Reserve the first block slot now, then fill it after every directory
        // member exists. Assignment preserves insertion order, keeping root
        // first without encoding an incomplete directory.
        this.blocks['root'] = new Uint8Array();
        this.baselineJsons.preset = JSON.stringify(data.botPresets);
        this.blocks['preset'] = await this.encodeBlock({
            compression,
            data: this.baselineJsons.preset,
            type: RisuSaveType.BOTPRESET,
            name: 'preset'
        });
        this.baselineJsons.modules = JSON.stringify(data.modules);
        this.blocks['modules'] = await this.encodeBlock({
            compression,
            data: this.baselineJsons.modules,
            type: RisuSaveType.MODULES,
            name: 'modules'
        });
        this.baselineJsons.plugins = JSON.stringify(data.plugins);
        this.blocks['plugins'] = await this.encodeBlock({
            compression,
            data: this.baselineJsons.plugins,
            type: RisuSaveType.PLUGINS,
            name: 'plugins'
        });
        // In optimized mode the reconciler keeps this object empty; retaining
        // the normal block keeps the save format compatible without pulling
        // any pluginsave/ KV values back into client memory.
        this.baselineJsons.pluginStorage = JSON.stringify(data.pluginCustomStorage);
        this.blocks['pluginStorage'] = await this.encodeBlock({
            compression,
            data: this.baselineJsons.pluginStorage,
            type: RisuSaveType.PLUGIN_STORAGE,
            name: 'pluginStorage'
        });
        for( const character of data.characters) {
            // Replace chats with stubs for database.bin — full chat data lives server-side
            const charForEncode = { ...character, chats: character.chats.map(c => chatToStub(c)) }
            // Raw stringify (no normalize fallback): a circular ref must fail the
            // save loudly, exactly as before, rather than silently persist a
            // lossy copy. This string doubles as the encode payload.
            const charJson = JSON.stringify(charForEncode)
            this.blocks[character.chaId] = await this.encodeBlock({
                compression,
                data: charJson,
                type: RisuSaveType.CHARACTER_WITH_CHAT,
                name: character.chaId,
                skipRemoteSaving: skipRemoteSavingOnCharacters
            }, {
                remote: 'prefer'
            });
            this.characterJsons[character.chaId] = charJson
        }
        this.blocks['config'] = await this.encodeBlock({
            compression,
            data: JSON.stringify({
                version: 1
            }),
            type: RisuSaveType.CONFIG,
            name: "config"
        })
        this.lastDirectory = Object.keys(this.blocks).filter(key => key !== 'root');
        obj.__directory = this.lastDirectory;
        this.baselineJsons.root = JSON.stringify(obj);
        this.blocks['root'] = await this.encodeBlock({
            compression,
            data: this.baselineJsons.root,
            type: RisuSaveType.ROOT,
            name: 'root',
            // The root is required to discover the directory and therefore
            // can never itself be recovered through that directory.
            cache: false,
        });
        this.publishCacheGeneration();
    }

    async set(
        data: Database,
        toSave: toSaveType,
        revisions?: RisuSaveDirtyRevisions,
    ){
        this.invalidatePublishedCache();
        this.normalizedBaseline = null;

        const savedId = new Set<string>();
        for(const character of data.characters) {
            if (!character?.chaId) {
                continue
            }
            const chaId = character.chaId
            savedId.add(chaId)
            const index = toSave.character.indexOf(chaId);
            const revisionDirty = revisions?.characters.has(chaId) === true;
            const trustedClean = !!revisions
                && !revisionDirty
                && revisions.isCharacterTrusted(chaId);
            if (trustedClean && index === -1 && this.blocks[chaId]) {
                if (this.verifyDirtyRevisions) {
                    const charForVerify = {
                        ...character,
                        chats: character.chats.map(c => chatToStub(c)),
                    }
                    this.recordWork('character', chaId, 'json-equality')
                    const currentJson = JSON.stringify(charForVerify)
                    if (this.characterJsons[chaId] !== currentJson) {
                        throw revisionDivergence('encoder', `character:${chaId}`)
                    }
                }
                continue
            }
            // Compare against the stub-replaced character so hydration (stub →
            // full chat) doesn't read as a change of the character itself.
            // Raw stringify (see init): circular refs fail the save loudly.
            const charForEncode = { ...character, chats: character.chats.map(c => chatToStub(c)) }
            this.recordWork('character', chaId, revisionDirty || index !== -1 ? 'json-encode' : 'json-equality')
            const charJson = JSON.stringify(charForEncode)
            const hasChanged = this.characterJsons[chaId] !== charJson

            if (index !== -1 || hasChanged || !this.blocks[chaId]) {
                this.blocks[character.chaId] = await this.encodeBlock({
                    compression: this.compression,
                    data: charJson,
                    type: RisuSaveType.CHARACTER_WITH_CHAT,
                    name: character.chaId
                }, {
                    remote: 'prefer'
                });
                this.characterJsons[chaId] = charJson
                if (index !== -1) {
                    toSave.character.splice(index, 1);
                }
            }
        }
        if(toSave.character.length > 0){
            console.log(`Deleting character data: ${toSave.character.join(', ')}`);
            //probably deleted characters
            for(const chaId of toSave.character){
                if(!savedId.has(chaId)){
                    delete this.blocks[chaId];
                    delete this.characterJsons[chaId];
                    this.cachedBlocks.delete(`risuSaveBlock_${chaId}`);
                }
            }
        }

        // Ensure stale character blocks are always removed even when deletion wasn't tracked in toSave.
        // This prevents deleted characters from being resurrected after full-write fallback.
        const currentCharacterIds = new Set<string>((data.characters ?? []).map((character) => character?.chaId).filter(Boolean));
        for (const key of Object.keys(this.blocks)) {
            if (key === 'root' || key === 'preset' || key === 'modules' || key === 'config'
                || key === 'plugins' || key === 'pluginStorage') {
                continue;
            }
            if (!currentCharacterIds.has(key)) {
                delete this.blocks[key];
                delete this.characterJsons[key];
                this.cachedBlocks.delete(`risuSaveBlock_${key}`);
            }
        }

        const botPresetDirty = toSave.botPreset
            || isRevisionBranchDirty(revisions, 'botPreset')
            || (!!revisions && !revisions.isBranchTrusted('botPreset'))
        if(botPresetDirty){
            this.recordWork('botPreset', 'botPresets', 'json-encode')
            this.baselineJsons.preset = JSON.stringify(data.botPresets);
            this.blocks['preset'] = await this.encodeBlock({
                compression: this.compression,
                data: this.baselineJsons.preset,
                type: RisuSaveType.BOTPRESET,
                name: 'preset'
            });
        }
        const modulesDirty = toSave.modules
            || (revisions?.modules.size ?? 0) > 0
            || isRevisionBranchDirty(revisions, 'modulesStructural')
            || (!!revisions && (
                !revisions.isBranchTrusted('modulesStructural')
                || (data.modules ?? []).some((module: any) => (
                    typeof module?.id !== 'string'
                    || !revisions.isModuleTrusted(module.id)
                ))
            ))
        if(modulesDirty){
            this.recordWork('module', 'modules', 'json-encode')
            this.baselineJsons.modules = JSON.stringify(data.modules);
            this.blocks['modules'] = await this.encodeBlock({
                compression: this.compression,
                data: this.baselineJsons.modules,
                type: RisuSaveType.MODULES,
                name: 'modules'
            });
        }

        const pluginStorageDirty = toSave.pluginCustomStorage
            || isRevisionBranchDirty(revisions, 'pluginCustomStorage')
            || (!!revisions && !revisions.isBranchTrusted('pluginCustomStorage'))
        if(pluginStorageDirty){
            // Mode transitions mark this block dirty so externalization writes
            // an empty block and internalization writes the restored inline map.
            this.recordWork('pluginCustomStorage', 'pluginCustomStorage', 'json-encode')
            this.baselineJsons.pluginStorage = JSON.stringify(data.pluginCustomStorage);
            this.blocks['pluginStorage'] = await this.encodeBlock({
                compression: this.compression,
                data: this.baselineJsons.pluginStorage,
                type: RisuSaveType.PLUGIN_STORAGE,
                name: 'pluginStorage'
            });
        }

        const pluginsDirty = toSave.plugins
            || isRevisionBranchDirty(revisions, 'plugins')
            || (!!revisions && !revisions.isBranchTrusted('plugins'))
        if(pluginsDirty){
            this.recordWork('plugins', 'plugins', 'json-encode')
            this.baselineJsons.plugins = JSON.stringify(data.plugins);
            this.blocks['plugins'] = await this.encodeBlock({
                compression: this.compression,
                data: this.baselineJsons.plugins,
                type: RisuSaveType.PLUGINS,
                name: 'plugins'
            });
        }

        const nextDirectory = Object.keys(this.blocks).filter(key => key !== 'root');
        const directoryChanged = nextDirectory.length !== this.lastDirectory.length
            || nextDirectory.some((key, index) => key !== this.lastDirectory[index]);
        const rootKeys = Object.keys(data).filter(key => (
            key !== 'characters' && key !== 'botPresets' && key !== 'modules'
            && key !== 'plugins' && key !== 'pluginCustomStorage'
        ));
        const baselineRoot = JSON.parse(this.baselineJsons.root) as Record<string, unknown>;
        const baselineRootKeys = Object.keys(baselineRoot).filter(key => key !== '__directory');
        const allRootKeys = new Set([...rootKeys, ...baselineRootKeys]);
        const rootTrusted = !!revisions
            && [...allRootKeys].every(key => revisions.isRootKeyTrusted(key));
        const rootRevisionDirty = !!revisions && revisions.rootKeys.size > 0;
        const rebuildRoot = directoryChanged
            || rootRevisionDirty
            || !revisions
            || !rootTrusted;

        if (rebuildRoot) {
            const obj: Record<string, any> = {}
            for (const key of rootKeys) obj[key] = data[key]
            obj.__directory = nextDirectory
            this.recordWork('root', 'root', 'json-encode')
            this.baselineJsons.root = JSON.stringify(obj);
            this.blocks['root'] = await this.encodeBlock({
                compression: this.compression,
                data: this.baselineJsons.root,
                type: RisuSaveType.ROOT,
                name: 'root',
                cache: false,
            });
            this.lastDirectory = nextDirectory;
        } else if (this.verifyDirtyRevisions) {
            const obj: Record<string, any> = {}
            for (const key of rootKeys) obj[key] = data[key]
            obj.__directory = nextDirectory
            this.recordWork('root', 'root', 'json-equality')
            if (JSON.stringify(obj) !== this.baselineJsons.root) {
                throw revisionDivergence('encoder', 'root')
            }
        }

        if (revisions && this.verifyDirtyRevisions) {
            const verifyCleanBlock = (
                branch: RisuSaveRevisionBranch,
                workBranch: RisuSaveWorkEvent['branch'],
                identity: string,
                current: unknown,
                baseline: string,
                dirty: boolean,
            ) => {
                if (dirty || !revisions.isBranchTrusted(branch)) return
                this.recordWork(workBranch, identity, 'json-equality')
                if (JSON.stringify(current) !== baseline) {
                    throw revisionDivergence('encoder', identity)
                }
            }
            verifyCleanBlock('botPreset', 'botPreset', 'botPresets', data.botPresets, this.baselineJsons.preset, !!botPresetDirty)
            verifyCleanBlock('plugins', 'plugins', 'plugins', data.plugins, this.baselineJsons.plugins, !!pluginsDirty)
            verifyCleanBlock(
                'pluginCustomStorage',
                'pluginCustomStorage',
                'pluginCustomStorage',
                data.pluginCustomStorage,
                this.baselineJsons.pluginStorage,
                !!pluginStorageDirty,
            )
            if (!modulesDirty && revisions.isBranchTrusted('modulesStructural')) {
                this.recordWork('module', 'modules', 'json-equality')
                if (JSON.stringify(data.modules) !== this.baselineJsons.modules) {
                    throw revisionDivergence('encoder', 'modules')
                }
            }
        }
        this.publishCacheGeneration();
    }

    encode(arg:{
        compression?: boolean
    } = {}){
        if(!this.blocks['config']){
            return null
        }
        let totalLength = 0
        for(const key in this.blocks){
            totalLength += this.blocks[key].length;
        }
        totalLength += magicRisuSaveHeader.length;
        const arrayBuf = new ArrayBuffer(totalLength);
        const view = new Uint8Array(arrayBuf);
        let offset = 0;
        view.set(magicRisuSaveHeader, offset);
        offset += magicRisuSaveHeader.length;
        for(const key in this.blocks){
            view.set(this.blocks[key], offset);
            offset += this.blocks[key].length;
        }
        this.normalizedBaseline = this.buildNormalizedBaseline();
        console.log(Object.keys(this.blocks).length, 'blocks encoded');
        return arrayBuf;
    }

    private buildNormalizedBaseline(): Database {
        const root = JSON.parse(this.baselineJsons.root) as Record<string, unknown>;
        const baseline: Record<string, any> = {};
        for (const key in root) {
            if (!key.startsWith('__')) baseline[key] = root[key];
        }
        baseline.characters = [];
        for (const key of Object.keys(this.blocks)) {
            if (key === 'root' || key === 'preset' || key === 'modules'
                || key === 'plugins' || key === 'pluginStorage' || key === 'config') {
                continue;
            }
            const characterJson = this.characterJsons[key];
            if (characterJson !== undefined) baseline.characters.push(JSON.parse(characterJson));
        }
        baseline.botPresets = JSON.parse(this.baselineJsons.preset);
        baseline.modules = JSON.parse(this.baselineJsons.modules);
        baseline.plugins = JSON.parse(this.baselineJsons.plugins);
        baseline.pluginCustomStorage = JSON.parse(this.baselineJsons.pluginStorage);
        if (!Array.isArray(baseline.botPresets) || baseline.botPresets.length === 0) {
            baseline.botPresets = [createBotPresetTemplate()];
            baseline.botPresetsId = 0;
        }
        return baseline as Database;
    }

    /** Transfer the exact graph represented by the most recent encode(). */
    takeNormalizedBaseline(): Database {
        if (!this.normalizedBaseline) {
            throw new Error('RisuSave encoder has no assembled normalized baseline');
        }
        const baseline = this.normalizedBaseline;
        this.normalizedBaseline = null;
        return baseline;
    }

    discardNormalizedBaseline(): void {
        this.normalizedBaseline = null;
    }

    /** Drop every payload reference before a replacement encoder is built. */
    retire(): void {
        this.invalidatePublishedCache();
        this.blocks = {};
        this.characterJsons = {};
        this.cachedBlocks.clear();
        this.normalizedBaseline = null;
        this.lastDirectory = [];
        this.baselineJsons = {
            root: '{}',
            preset: '[]',
            modules: '[]',
            plugins: '[]',
            pluginStorage: '{}',
        };
    }

    async encodeBlock(arg:EncodeBlockArg, option:EncodeBlockOption = { remote: 'none' }){
        if(
            option.remote === 'force' ||
            (option.remote === 'prefer' && !disableRemoteSaving())
        ){
            return await this.encodeRemoteBlock(arg);
        }
        return await this.encodeRawBlock(arg);
    }

    async encodeRawBlock(arg:EncodeBlockArg){
        let databuf: Uint8Array;
        const cacheBlock = arg.cache ?? true;
        if(arg.compression){
            await ensureCompressionStreams();
            const cs = new CompressionStream('gzip');
            const writer = cs.writable.getWriter();
            writer.write(new TextEncoder().encode(arg.data));
            writer.close();
            const compressedData = await new Response(cs.readable).arrayBuffer();
            databuf = (new Uint8Array(compressedData));
        }
        else{
            databuf = (new TextEncoder().encode(arg.data));
        }
        const nameBuf = new TextEncoder().encode(arg.name);
        const lengthBuf = new ArrayBuffer(4);
        new Uint32Array(lengthBuf)[0] = databuf.length;
        const arrayBuf = new ArrayBuffer(2 + 1 + nameBuf.length + 4 + databuf.length);
        const buf = new Uint8Array(arrayBuf);
        buf.set(new Uint8Array([arg.type, arg.compression ? 1 : 0]), 0);
        buf.set(new Uint8Array([nameBuf.length]), 2);
        buf.set(nameBuf, 3);
        buf.set(new Uint8Array(lengthBuf), 3 + nameBuf.length);
        buf.set(databuf, 7 + nameBuf.length);
        this.invalidatePublishedCache();
        const cacheKey = `risuSaveBlock_${arg.name}`;
        if(cacheBlock){
            this.cachedBlocks.set(cacheKey, {
                type: arg.type,
                data: arg.data,
                name: arg.name,
            });
        }
        else{
            // Opting out must also evict an entry left by an earlier encode
            // in the same generation; merely skipping set() would leave stale
            // data available to the recovery decoder.
            this.cachedBlocks.delete(cacheKey);
        }
        return buf;
    }

    async encodeRemoteBlock(arg:EncodeBlockArg){
        console.log(`Encoding remote block: ${arg.name}`);
        const encoded = new TextEncoder().encode(arg.data);
        const fileName = `remotes/${arg.name}.local.bin`

        if(arg.skipRemoteSaving && checkedRemoteExistence.has(arg.name) === false){
            let fileExists = false;
            const stored = await forageStorage.keys();
            if(stored.includes(fileName)){
                fileExists = true;
            }
            if(!fileExists){
                console.log(`Remote file ${fileName} does not exist, disabling skipRemoteSaving for this block.`);
                arg.skipRemoteSaving = false;
            }
            checkedRemoteExistence.add(arg.name);
        }

        if(!arg.skipRemoteSaving){
            await forageStorage.setItem(fileName, encoded);
        }
        return await this.encodeBlock({
            compression: false,
            data: JSON.stringify({
                v: 1,
                type: arg.type,
                name: arg.name,
            }),
            type: RisuSaveType.REMOTE,
            name: arg.name
        });
    }
}

export class RisuSaveDecoder {
    private blocks: {
        name: string;
        type: RisuSaveType;
        compression: boolean;
        content: string;
    }[] = []

    private async decodeStrict(data: Uint8Array): Promise<Database> {
        if (import.meta.env.DEV) {
            console.log('Decoding authoritative RisuSave data');
        }
        const db = applyRisuSaveBotPresetDefault(
            await decodeStrictRisuSaveBlocks(data, {
                readRemoteBlock: async (fileName) => {
                    const stored = await forageStorage.getItem(fileName)
                    return stored ? stored as Uint8Array : null
                },
            }),
            createBotPresetTemplate,
        ) as Database;
        if (import.meta.env.DEV) {
            console.log('Decoded authoritative RisuSave data', db);
        }
        return db;
    }

    async decode(data: Uint8Array, options: RisuSaveDecodeOptions = {}): Promise<Database> {
        if (options.strictBlockIntegrity === true) {
            return this.decodeStrict(data);
        }
        const recoveryBlocks = risuSaveCacheGeneration?.blocks ?? null;
        console.log('Decoding RisuSave data');
        let offset = magicRisuSaveHeader.length;
        //@ts-expect-error Database has required fields, but we initialize empty and populate incrementally during decode
        let db:Database = {}
        const loadedBlocks = new Set<string>();
        while (offset < data.length) {
            try {
                if (offset + 7 > data.length) {
                    throw blockIntegrityError(`Truncated RisuSave block header at byte ${offset}`);
                }
                const type = data[offset];
                const compressionFlag = data[offset + 1];
                if (compressionFlag !== 0 && compressionFlag !== 1) {
                    throw blockIntegrityError(`Invalid RisuSave compression flag at byte ${offset + 1}`);
                }
                const compression = compressionFlag === 1;
                offset += 2;

                const nameLength = data[offset];
                offset += 1;
                if (offset + nameLength + 4 > data.length) {
                    throw blockIntegrityError(`Truncated RisuSave block name at byte ${offset}`);
                }
                const name = new TextDecoder('utf-8')
                    .decode(data.subarray(offset, offset + nameLength));
                offset += nameLength;

                const newArrayBuf = new ArrayBuffer(4);
                const lengthSubUint8Buf = data.slice(offset, offset + 4);
                new Uint8Array(newArrayBuf).set(lengthSubUint8Buf);
                const length = new Uint32Array(newArrayBuf)[0];
                offset += 4;

                if (offset + length > data.length) {
                    throw blockIntegrityError(`Truncated RisuSave block body at byte ${offset}`);
                }
                let blockData = data.subarray(offset, offset + length);
                offset += length;

                if (compression) {
                    //decode using DecompressionStream
                    await ensureCompressionStreams();
                    const cs = new DecompressionStream('gzip');
                    const writer = cs.writable.getWriter();
                    writer.write(blockData as any);
                    writer.close();
                    const buf = await new Response(cs.readable).arrayBuffer();
                    blockData = new Uint8Array(buf);
                }

                loadedBlocks.add(name);
                this.blocks.push({
                    name,
                    type,
                    compression,
                    content: new TextDecoder('utf-8').decode(blockData)
                })   
            } catch (error) {
                if (error instanceof RisuSaveBlockIntegrityError) {
                    break;
                }
                continue
            }
        }
        if (import.meta.env.DEV) {
            console.log('blocks',this.blocks)
        }
        const directory = new Set<string>();
        let rootBlocks = 0;
        for(let i = 0; i < this.blocks.length; i++){
            const key = i;
            try {
            switch(this.blocks[key].type){
                case RisuSaveType.ROOT:{
                    const rootData = JSON.parse(this.blocks[key].content);
                    rootBlocks++;
                    for(const rootKey in rootData){
                        if(!db[rootKey] && !rootKey.startsWith('__')){
                            db[rootKey] = rootData[rootKey];
                        }
                        if(rootKey === '__directory'){
                            const rootDirectory = rootData[rootKey];
                            if (!Array.isArray(rootDirectory)
                                || rootDirectory.some(dirKey => typeof dirKey !== 'string')) {
                                break;
                            }
                            console.log('RisuSave directory:', rootDirectory);
                            for(const dirKey of rootDirectory){
                                directory.add(dirKey);
                                if(!loadedBlocks.has(dirKey)){
                                    try {
                                        console.log(`Loading directory block ${dirKey} from cache`);
                                        const dirData:{
                                            type:RisuSaveType
                                            data:string
                                            name:string
                                        } = recoveryBlocks?.get(`risuSaveBlock_${dirKey}`) ?? null;

                                        if(dirData){
                                            this.blocks.push({
                                                name: dirData.name,
                                                type: dirData.type,
                                                compression: false,
                                                content: dirData.data
                                            });
                                            loadedBlocks.add(dirKey);
                                        }
                                    } catch (error) {
                                        console.error(`Error loading directory block ${dirKey}:`, error);
                                    }
                                }
                            }
                        }
                    }
                    break;
                }
                case RisuSaveType.CHARACTER_WITH_CHAT:
                case RisuSaveType.CHARACTER_WITHOUT_CHAT:{
                    db.characters ??= [];
                    const character = JSON.parse(this.blocks[key].content);
                    db.characters.push(character);
                    break
                }
                case RisuSaveType.BOTPRESET:{
                    db.botPresets = JSON.parse(this.blocks[key].content);
                    break;
                }
                case RisuSaveType.MODULES:{
                    db.modules = JSON.parse(this.blocks[key].content);
                    break;
                }
                case RisuSaveType.CONFIG:{
                    //ignore for now
                    break;
                }
                case RisuSaveType.PLUGINS:{
                    db.plugins = JSON.parse(this.blocks[key].content);
                    break;
                }
                case RisuSaveType.LOADOUTS:{
                    // Loadout feature removed; ignore any legacy blocks from older backups.
                    break;
                }
                case RisuSaveType.PLUGIN_STORAGE:{
                    db.pluginCustomStorage = JSON.parse(this.blocks[key].content);
                    break;
                }
                case RisuSaveType.REMOTE:{
                    const remoteInfo:{
                        v:number
                        type:RisuSaveType
                        name:string
                    } = JSON.parse(this.blocks[key].content);
                    const fileName = `remotes/${remoteInfo.name}.local.bin`
                    let remoteData:Uint8Array|null = null
                    const stored = await forageStorage.getItem(fileName);
                    if(stored){
                        remoteData = stored as Uint8Array;
                    }

                    if(!remoteData){
                        const message = `Remote file ${fileName} not found.`;
                        console.warn(message);
                        break;
                    }
                    const decoded = new TextDecoder('utf-8').decode(remoteData)

                    //add to blocks for further processing
                    this.blocks.push({
                        name: remoteInfo.name,
                        type: remoteInfo.type,
                        compression: false,
                        content: decoded
                    });
                    loadedBlocks.add(remoteInfo.name);
                    break;
                }
                case RisuSaveType.ROOT_COMPONENT:{
                    const componentData:{
                        data:any
                        key:string
                    } = JSON.parse(this.blocks[key].content);
                    db[componentData.key] = componentData.data;
                    break;
                }
                default:{
                    console.warn(`Not Implemented RisuSaveType: ${this.blocks[key].type} for ${this.blocks[key].name}`);
                }
            }
            } catch (error) {
                console.error(`Error processing block ${this.blocks[key].name}:`, error);

                if(this.blocks[key].type === RisuSaveType.ROOT){
                    throw new Error('Failed to decode root block, cannot proceed with decoding RisuSave data');
                }
            }
        }
        //to fix botpreset bugs
        if(!Array.isArray(db.botPresets) || db.botPresets.length === 0){
            db.botPresets = [createBotPresetTemplate()]
            db.botPresetsId = 0
        }
        if (import.meta.env.DEV) {
            console.log('Decoded RisuSave data', db);
        }
        return db;
    }
}

export async function decodeRisuSave(data:Uint8Array, options: RisuSaveDecodeOptions = {}){
    try {
        const header = checkHeader(data)
        switch(header){
            case "plugin-compressed":
                data = data.slice(magicPluginStorageCompressedHeader.length)
                return restoreLegacyPluginStorageKeys(unpackr.decode(fflate.decompressSync(data)))
            case "compressed":
                data = data.slice(magicCompressedHeader.length)
                return unpackr.decode(fflate.decompressSync(data))
            case "plugin-raw":
                data = data.slice(magicPluginStorageHeader.length)
                return restoreLegacyPluginStorageKeys(unpackr.decode(data))
            case "raw":
                data = data.slice(magicHeader.length)
                return unpackr.decode(data)
            case "plugin-stream":{
                await ensureCompressionStreams()
                data = data.slice(magicPluginStorageStreamHeader.length)
                const cs = new DecompressionStream('gzip');
                const writer = cs.writable.getWriter();
                writer.write(data as any);
                writer.close();
                const buf = await new Response(cs.readable).arrayBuffer()
                return restoreLegacyPluginStorageKeys(unpackr.decode(new Uint8Array(buf)))
            }
            case "stream":{
                await ensureCompressionStreams()
                data = data.slice(magicStreamCompressedHeader.length)
                const cs = new DecompressionStream('gzip');
                const writer = cs.writable.getWriter();
                writer.write(data as any);
                writer.close();
                const buf = await new Response(cs.readable).arrayBuffer()
                return unpackr.decode(new Uint8Array(buf))
            }
            case "risusave":{
                const decoder = new RisuSaveDecoder();
                return await decoder.decode(data, options);
            }
        }
        return unpackr.decode(data)
    }
    catch (error) {
        if (error instanceof RisuSaveBlockIntegrityError) throw error;
        console.error('Error decoding RisuSave data:', error);
        try {
            console.log('risudecode')
            const risuSaveHeader = new Uint8Array(Buffer.from("\u0000\u0000RISU",'utf-8'))
            const realData = data.subarray(risuSaveHeader.length)
            const dec = unpackr.decode(realData)
            return dec
        } catch (error) {
            const buf = Buffer.from(fflate.decompressSync(Buffer.from(data)))
            try {
                return JSON.parse(buf.toString('utf-8'))
            } catch (error) {
                return unpackr.decode(buf)
            }
        }
    }
}

export function decodeAuthoritativeRisuSave(data: Uint8Array): Promise<Database> {
    return decodeRisuSave(data, { strictBlockIntegrity: true });
}

function checkHeader(data: Uint8Array) {

    let header:'none'|'compressed'|'raw'|'stream'|'risusave'|'plugin-raw'|'plugin-compressed'|'plugin-stream' = 'raw'

    if (data.length >= magicRisuSaveHeader.length
        && magicRisuSaveHeader.every((byte, index) => data[index] === byte)) {
        return 'risusave';
    }

    if (data.length < magicHeader.length) {
      return false;
    }
  
    for (let i = 0; i < magicHeader.length; i++) {
      if (data[i] !== magicHeader[i]) {
        header = 'none'
        break
      }
    }

    if(header === 'none'){
        header = 'compressed'
        for (let i = 0; i < magicCompressedHeader.length; i++) {
            if (data[i] !== magicCompressedHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'stream'
        for (let i = 0; i < magicStreamCompressedHeader.length; i++) {
            if (data[i] !== magicStreamCompressedHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'plugin-raw'
        for (let i = 0; i < magicPluginStorageHeader.length; i++) {
            if (data[i] !== magicPluginStorageHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'plugin-compressed'
        for (let i = 0; i < magicPluginStorageCompressedHeader.length; i++) {
            if (data[i] !== magicPluginStorageCompressedHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'plugin-stream'
        for (let i = 0; i < magicPluginStorageStreamHeader.length; i++) {
            if (data[i] !== magicPluginStorageStreamHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'risusave'
        for (let i = 0; i < magicRisuSaveHeader.length; i++) {
            if (data[i] !== magicRisuSaveHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    // All bytes matched
    return header;
}

// --- Hash & normalization utilities for patch-based sync ---

const PRIME_MULTIPLIER = 31;

const SEED_OBJECT = 17;
const SEED_ARRAY = 19;
const SEED_STRING = 23;
const SEED_NUMBER = 29;
const SEED_BOOLEAN = 31;
const SEED_NULL = 37;

export function calculateHash(node: any): number {
    if (node === null || node === undefined) return SEED_NULL;
    switch (typeof node) {
        case 'object':
            if (Array.isArray(node)) {
                let arrayHash = SEED_ARRAY;
                for (const item of node)
                    arrayHash = (Math.imul(arrayHash, PRIME_MULTIPLIER) + calculateHash(item)) >>> 0;
                return arrayHash;
            } else {
                // Independent of key order
                let objectHash = SEED_OBJECT;
                for (const key in node)
                    objectHash += (Math.imul(calculateHash(key), PRIME_MULTIPLIER) + calculateHash(node[key]));
                return objectHash >>> 0;
            }
        case 'string':
            let strHash = 2166136261;
            for (let i = 0; i < node.length; i++)
                strHash = Math.imul(strHash ^ node.charCodeAt(i), 16777619);
            return Math.imul(SEED_STRING, PRIME_MULTIPLIER) + (strHash >>> 0);
        case 'number':
            let numHash;
            if (Number.isInteger(node) && node >= -2147483648 && node <= 2147483647)
                numHash = node >>> 0;
            else {
                const str = node.toString();
                numHash = 2166136261;
                for (let i = 0; i < str.length; i++)
                    numHash = Math.imul(numHash ^ str.charCodeAt(i), 16777619);
                numHash = numHash >>> 0;
            }
            return Math.imul(SEED_NUMBER, PRIME_MULTIPLIER) + numHash;
        case 'boolean':
            return Math.imul(SEED_BOOLEAN, PRIME_MULTIPLIER) + (node ? 1 : 0);

        default:
            return 0;
    }
}

// Compare two arrays element-wise, but emit a single `replace` op covering the
// whole array when structure changes (add, remove, reorder). Element-wise diff
// via fast-json-patch is dangerous on arrays of deep objects: deleting one
// entry shifts every following index, each shifted slot deep-diffs "old item N
// vs new item N+1", and the resulting op list can balloon past V8's function
// argument limit (~125k) — `patch.push(...ops)` then throws
// `RangeError: Maximum call stack size exceeded`. Callers MUST iterate the
// returned ops with `for (const op of ops) patch.push(op)` rather than spread,
// to stay safe even when a single item's internal diff is large.
//
// `idKey != null` (modules, botPresets — both gained stable string ids):
// structural detection by id equality at each index, with a safety belt
// that forces `replace` when ids are falsy or duplicated (defensive against
// corrupted backups, or backups predating the id field). `idKey == null`:
// length-only detection — retained as a fallback for arrays without stable
// ids, currently unused by callers but kept for future use.
export function diffArrayWithIdGuard(
    compare: (a: any, b: any) => any[],
    path: string,
    lastArr: any[] | undefined,
    curArr: any[],
    idKey: string | null,
): any[] {
    const last = lastArr ?? []
    let structural = last.length !== curArr.length

    if (!structural && idKey != null) {
        const lastIds = last.map((m: any) => m?.[idKey])
        const curIds = curArr.map((m: any) => m?.[idKey])
        const hasInvalidIds = curIds.some(id => !id) || lastIds.some(id => !id)
        const hasDuplicates = new Set(curIds).size !== curIds.length
        structural = hasInvalidIds || hasDuplicates ||
            lastIds.some((id, i) => id !== curIds[i])
    }

    if (structural) {
        return [{ op: 'replace', path, value: curArr }]
    }

    const ops: any[] = []
    for (let i = 0; i < curArr.length; i++) {
        const subPatch = compare(last[i], curArr[i])
        for (const p of subPatch) {
            ops.push({ ...p, path: `${path}/${i}${p.path}` })
        }
    }
    return ops
}

export type CharacterPatchBudget = {
    maxOperations: number;
    maxBytes: number;
}

const defaultCharacterPatchBudget: CharacterPatchBudget = {
    maxOperations: CHARACTER_PATCH_MAX_OPERATIONS,
    maxBytes: CHARACTER_PATCH_MAX_BYTES,
}

/**
 * Scope one character's diff to its database path without ever spreading the
 * operation array as function arguments. Oversized granular diffs are replaced
 * atomically with the normalized, stub-only character so no partial diff can
 * escape and the next patcher baseline remains identical to the server state.
 *
 * The byte budget applies to the granular JSON Patch representation. A single
 * replacement is allowed to exceed it because dropping that replacement would
 * turn a resource guard into data loss; the ordinary request/full-write limits
 * remain responsible for bounding the complete character value.
 */
export function buildBoundedCharacterPatch(
    operations: readonly any[],
    characterIndex: number,
    normalizedCharacter: any,
    budget: CharacterPatchBudget = defaultCharacterPatchBudget,
): any[] {
    const replacement = [{
        op: 'replace',
        path: `/characters/${characterIndex}`,
        value: normalizedCharacter,
    }]
    if (operations.length > budget.maxOperations) return replacement

    const scoped: any[] = []
    // Include the surrounding array and commas so the counter matches the
    // serialized JSON Patch payload rather than only its operation bodies.
    let encodedBytes = 2
    for (const operation of operations) {
        const scopedOperation = {
            ...operation,
            path: `/characters/${characterIndex}${operation.path}`,
        }
        const serialized = JSON.stringify(scopedOperation)
        encodedBytes += patchByteEncoder.encode(serialized).byteLength
            + (scoped.length === 0 ? 0 : 1)
        if (encodedBytes > budget.maxBytes) return replacement
        scoped.push(scopedOperation)
    }
    return scoped
}

export type RisuSavePatchProposal = {
    patch: any[];
    expectedHash: string;
};

type RisuSavePatcherState = {
    lastSyncedDb: any;
    hashBlocks: { [key: string]: number };
    lastRootKeyJsons: Map<string, string>;
    lastCharJsons: Map<string, string>;
    lastModuleJsons: Map<string, string>;
    moduleItemHashes: Map<string, number>;
};

type PendingRisuSavePatchProposal = {
    revision: number;
    state: RisuSavePatcherState | null;
    conflictDirtyBranches: toSaveType;
};

export class RisuSavePatcher {
    private lastSyncedDb: any = { characters: [] };
    private hashBlocks: { [key: string]: number } = {};
    // Cheap change pre-check baselines. calculateHash over normalizeJSON'd data
    // is the client↔server patch protocol (the server recomputes the same hash,
    // see server.cjs expectedHash verification) and MUST NOT change — but when
    // an entry's JSON is byte-identical to the baseline, the stored hash and
    // baseline are still valid, so the expensive normalize+hash+diff can be
    // skipped wholesale. String comparison is a native memcmp (~3x cheaper).
    // Granularity matters: while typing into a root field (personaPrompt) or a
    // module lorebook, that whole block changes on EVERY save — so baselines
    // are kept per ROOT KEY and per MODULE, and only the changed entry pays
    // normalize + protocol hash + diff.
    // Maps (not plain objects): ids come from user-importable data, so a key
    // like "__proto__" on a plain object would silently hit the prototype
    // setter instead of storing — corrupting the skip checks and, worse, the
    // modules hash fold. Map keys are also type-strict (1 !== "1").
    private lastRootKeyJsons = new Map<string, string>();
    private lastCharJsons = new Map<string, string>();
    private lastModuleJsons = new Map<string, string>();
    private moduleItemHashes = new Map<string, number>();
    private revision = 0;
    private pendingProposals = new WeakMap<RisuSavePatchProposal, PendingRisuSavePatchProposal>();
    private readonly verifyDirtyRevisions: boolean;
    private readonly onWork?: (event: RisuSaveWorkEvent) => void;

    constructor(options: RisuSaveCodecOptions = {}) {
        this.verifyDirtyRevisions = options.verifyDirtyRevisions
            ?? defaultDirtyRevisionVerification();
        this.onWork = options.onWork;
    }

    private recordWork(
        branch: RisuSaveWorkEvent['branch'],
        identity: string,
        work: RisuSaveWorkEvent['work'],
    ): void {
        this.onWork?.({ codec: 'patcher', branch, identity, work });
    }

    hash(): string {
        this.hashBlocks['characters'] = SEED_ARRAY;
        for (const character of this.lastSyncedDb.characters) {
            this.hashBlocks['characters'] = (Math.imul(this.hashBlocks['characters'], PRIME_MULTIPLIER) + this.hashBlocks[character.chaId]) >>> 0;
        }

        const keys = Object.keys(this.lastSyncedDb)
        let rootHash = SEED_OBJECT;
        for (const key of keys) {
            rootHash += (Math.imul(calculateHash(key), PRIME_MULTIPLIER) + this.hashBlocks[key])
        }
        return (rootHash >>> 0).toString(16);
    }

    async init(data: any) {
        this.initializeBaseline(normalizeJSON(data));
    }

    /** Adopt an exact, detached database graph already normalized by the encoder. */
    async initNormalizedBaseline(data: any) {
        this.initializeBaseline(data);
    }

    private initializeBaseline(data: any) {
        this.revision += 1;
        this.pendingProposals = new WeakMap();
        this.lastSyncedDb = data;
        if (!Array.isArray(this.lastSyncedDb.characters)) {
            this.lastSyncedDb.characters = [];
        }
        this.hashBlocks = {};

        const keys = Object.keys(this.lastSyncedDb)

        for (const key of keys) {
            if (key !== 'characters') {
                this.hashBlocks[key] = calculateHash(this.lastSyncedDb[key]);
            }
        }

        for (let i = 0; i < this.lastSyncedDb.characters.length; i++) {
            const character = this.lastSyncedDb.characters[i];
            // Hash with stubs only (matching set()) so hashes stay in sync
            const withStubs = { ...character, chats: (character.chats || []).map((c: any) => chatToStub(c)) };
            this.hashBlocks[character.chaId] = calculateHash(withStubs);
            this.lastSyncedDb.characters[i] = withStubs;
        }

        // Seed the cheap pre-check baselines from the NORMALIZED data, not the
        // raw input. The protocol baseline (what the server holds) is always the
        // normalizeJSON form, so a raw baseline could match a future raw string
        // whose normalized form differs from the server's (e.g. a shared
        // reference that normalize replaced with null then later un-shares),
        // causing the fast path to skip a change the server still needs. Seeding
        // from the normalized form means any normalize-affecting value (shared
        // ref, Date, non-finite) makes raw≠baseline and falls safely to full path.
        const { characters: _c, botPresets: _b, modules: _m, ...normRootOnly } = this.lastSyncedDb
        this.lastRootKeyJsons = new Map();
        for (const key of Object.keys(normRootOnly)) {
            this.lastRootKeyJsons.set(key, JSON.stringify(normRootOnly[key]))
        }
        this.lastCharJsons = new Map();
        for (const character of this.lastSyncedDb.characters) {
            if (character?.chaId) this.lastCharJsons.set(character.chaId, JSON.stringify(character))
        }
        this.lastModuleJsons = new Map();
        this.moduleItemHashes = new Map();
        const normModulesInit = Array.isArray(this.lastSyncedDb.modules) ? this.lastSyncedDb.modules : []
        for (const m of normModulesInit) {
            if (typeof m?.id === 'string' && m.id) {
                this.lastModuleJsons.set(m.id, JSON.stringify(m))
                this.moduleItemHashes.set(m.id, calculateHash(m))
            }
        }
    }

    private captureState(): RisuSavePatcherState {
        return {
            lastSyncedDb: this.lastSyncedDb,
            hashBlocks: this.hashBlocks,
            lastRootKeyJsons: this.lastRootKeyJsons,
            lastCharJsons: this.lastCharJsons,
            lastModuleJsons: this.lastModuleJsons,
            moduleItemHashes: this.moduleItemHashes,
        };
    }

    private applyState(state: RisuSavePatcherState): void {
        this.lastSyncedDb = state.lastSyncedDb;
        this.hashBlocks = state.hashBlocks;
        this.lastRootKeyJsons = state.lastRootKeyJsons;
        this.lastCharJsons = state.lastCharJsons;
        this.lastModuleJsons = state.lastModuleJsons;
        this.moduleItemHashes = state.moduleItemHashes;
    }

    private forkForProposal(): RisuSavePatcher {
        const fork = new RisuSavePatcher({
            verifyDirtyRevisions: this.verifyDirtyRevisions,
            onWork: this.onWork,
        });
        fork.lastSyncedDb = {
            ...this.lastSyncedDb,
            characters: [...(this.lastSyncedDb.characters ?? [])],
            modules: Array.isArray(this.lastSyncedDb.modules)
                ? [...this.lastSyncedDb.modules]
                : this.lastSyncedDb.modules,
        };
        fork.hashBlocks = { ...this.hashBlocks };
        fork.lastRootKeyJsons = new Map(this.lastRootKeyJsons);
        fork.lastCharJsons = new Map(this.lastCharJsons);
        fork.lastModuleJsons = new Map(this.lastModuleJsons);
        fork.moduleItemHashes = new Map(this.moduleItemHashes);
        return fork;
    }

    /**
     * Prepare a patch without advancing the acknowledged baseline. Call
     * commit() only after the server accepts this exact proposal.
     */
    async set(
        data: any,
        toSave: toSaveType,
        revisions?: RisuSaveDirtyRevisions,
    ): Promise<RisuSavePatchProposal> {
        const fork = this.forkForProposal();
        const proposal = await fork.advance(data, toSave, revisions);
        this.pendingProposals.set(proposal, {
            revision: this.revision,
            state: fork.captureState(),
            conflictDirtyBranches: this.deriveConflictDirtyBranches(
                proposal.patch,
                data,
                toSave,
            ),
        });
        return proposal;
    }

    private deriveConflictDirtyBranches(
        patch: any[],
        data: any,
        tracked: toSaveType,
    ): toSaveType {
        const dirty: toSaveType = {
            character: [...tracked.character],
            chat: tracked.chat.map(([chaId, chatId]) => [chaId, chatId]),
            root: tracked.root,
            botPreset: tracked.botPreset,
            modules: tracked.modules,
            plugins: tracked.plugins,
            pluginCustomStorage: tracked.pluginCustomStorage,
        };
        const characterIds = new Set(dirty.character.filter(Boolean));
        const baselineCharacters = Array.isArray(this.lastSyncedDb.characters)
            ? this.lastSyncedDb.characters
            : [];
        const currentCharacters = Array.isArray(data.characters) ? data.characters : [];
        const publicationControls = new Set([
            'optimizePluginMemory',
            'pluginStorageGeneration',
            'pluginStorageFolded',
        ]);

        for (const operation of patch) {
            const path = typeof operation?.path === 'string' ? operation.path : '';
            if (path === '/characters') {
                for (const character of [...baselineCharacters, ...currentCharacters]) {
                    if (character?.chaId) characterIds.add(character.chaId);
                }
                continue;
            }
            const characterMatch = /^\/characters\/(\d+)(?:\/|$)/.exec(path);
            if (characterMatch) {
                const index = Number(characterMatch[1]);
                const chaId = currentCharacters[index]?.chaId
                    ?? baselineCharacters[index]?.chaId;
                if (chaId) characterIds.add(chaId);
                continue;
            }
            const root = path.split('/')[1]?.replaceAll('~1', '/').replaceAll('~0', '~');
            if (root === 'botPresets') dirty.botPreset = true;
            else if (root === 'modules') dirty.modules = true;
            else if (root === 'plugins') dirty.plugins = true;
            else if (root === 'pluginCustomStorage' || root === 'pluginStorageMeta') {
                dirty.pluginCustomStorage = true;
            } else if (root && !publicationControls.has(root)) {
                dirty.root = true;
            }
        }
        dirty.character = [...characterIds];
        return dirty;
    }

    /** Dirty branches proven by the tracked signal plus this baseline diff. */
    conflictDirtyBranches(proposal: RisuSavePatchProposal): toSaveType {
        const pending = this.pendingProposals.get(proposal);
        if (!pending || pending.revision !== this.revision) {
            throw new Error('Cannot inspect a stale or foreign RisuSave patch proposal');
        }
        return {
            ...pending.conflictDirtyBranches,
            character: [...pending.conflictDirtyBranches.character],
            chat: pending.conflictDirtyBranches.chat.map(
                ([chaId, chatId]) => [chaId, chatId],
            ),
        };
    }

    commit(proposal: RisuSavePatchProposal): void {
        const pending = this.pendingProposals.get(proposal);
        this.pendingProposals.delete(proposal);
        if (!pending?.state || pending.revision !== this.revision) {
            throw new Error('Cannot commit a stale or foreign RisuSave patch proposal');
        }
        this.applyState(pending.state);
        pending.state = null;
        this.revision += 1;
    }

    discard(proposal: RisuSavePatchProposal): void {
        const pending = this.pendingProposals.get(proposal);
        if (pending) pending.state = null;
        this.pendingProposals.delete(proposal);
    }

    /** Drop every payload reference before a replacement patcher is built. */
    retire(): void {
        this.revision += 1;
        this.pendingProposals = new WeakMap();
        this.lastSyncedDb = { characters: [] };
        this.hashBlocks = {};
        this.lastRootKeyJsons.clear();
        this.lastCharJsons.clear();
        this.lastModuleJsons.clear();
        this.moduleItemHashes.clear();
    }

    private async advance(
        data: any,
        toSave: toSaveType,
        revisions?: RisuSaveDirtyRevisions,
    ): Promise<RisuSavePatchProposal> {
        const { compare } = await import('fast-json-patch')
        const expectedHash: string = this.hash();
        const patch: any[] = []

        const {
            characters: lastCharacters = [],
            botPresets: lastBotPresets,
            modules: lastModules,
            ...lastRoot
        } = this.lastSyncedDb

        const {
            characters: curCharacters = [],
            botPresets: curBotPresets,
            modules: curModules,
            ...curRoot
        } = data

        // Per-KEY cheap pre-check over the root. While typing into a root field
        // (e.g. personaPrompt) the root changes on every save, so a whole-root
        // pre-check would never match and every save would pay a full-root
        // normalize + deep diff + rehash of ~all root keys. Per key, only the
        // edited key takes that path; every other key is a string compare.
        // Per-key diff/remove ops are equivalent to compare(lastRoot, normRoot):
        // an object diff recurses per key independently, and wrapping the value
        // as {key: value} yields the identical /key-rooted ops with escaping
        // handled by the library. Baselines are built from the NORMALIZED value
        // (see init()) so normalize-affected data always falls to the full path.
        const nextRoot: any = {}
        const removedRootKeys = new Set(Object.keys(lastRoot))
        const rootKeyRevisionDirty = (key: string) => {
            if (!revisions) return false
            if (key === 'plugins') return revisions.plugins !== null
            if (key === 'pluginCustomStorage') {
                return revisions.pluginCustomStorage !== null
            }
            return revisions.rootKeys.has(key)
        }
        const rootKeyTrusted = (key: string) => {
            if (!revisions) return false
            if (key === 'plugins') return revisions.isBranchTrusted('plugins')
            if (key === 'pluginCustomStorage') {
                return revisions.isBranchTrusted('pluginCustomStorage')
            }
            return revisions.isRootKeyTrusted(key)
        }
        for (const key of Object.keys(curRoot)) {
            // An own '__proto__' key can't round-trip through JSON Patch — the
            // server's applyPatch rejects any op touching it (prototype-pollution
            // guard), failing every save. The old whole-root normalizeJSON
            // silently dropped it (its `out[key] =` assignment hits the prototype
            // setter), so match that and drop it. (Other inherited-name keys like
            // 'constructor' are kept here exactly as the old whole-root compare
            // produced them.)
            if (key === '__proto__') continue
            // hasOwn, not `in`: membership must match the baseline's OWN keys
            // (`in` would treat inherited names like 'toString' as present).
            const hadKey = Object.hasOwn(lastRoot, key)
            const revisionDirty = rootKeyRevisionDirty(key)
            const trustedClean = !!revisions && !revisionDirty && rootKeyTrusted(key)
            if (trustedClean) {
                if (this.verifyDirtyRevisions) {
                    this.recordWork(
                        key === 'plugins' ? 'plugins'
                            : key === 'pluginCustomStorage' ? 'pluginCustomStorage'
                            : 'root',
                        key,
                        'json-equality',
                    )
                    let rawMatches = false
                    try {
                        const currentJson = JSON.stringify(curRoot[key])
                        rawMatches = currentJson !== undefined
                            && hadKey
                            && currentJson === this.lastRootKeyJsons.get(key)
                    } catch {
                        rawMatches = false
                    }
                    if (!rawMatches) {
                        const preservePluginStorageKeys = key === 'pluginCustomStorage'
                            || key === 'pluginStorageMeta'
                        const normVal = normalizeJSON(
                            curRoot[key],
                            undefined,
                            preservePluginStorageKeys,
                        )
                        const equalityOps = normVal === undefined
                            ? (hadKey ? compare({ [key]: lastRoot[key] }, {}) : [])
                            : compare(hadKey ? { [key]: lastRoot[key] } : {}, { [key]: normVal })
                        if (equalityOps.length > 0) {
                            throw revisionDivergence('patcher', `root:${key}`)
                        }
                    }
                }
                if (hadKey) {
                    removedRootKeys.delete(key)
                    nextRoot[key] = lastRoot[key]
                }
                continue
            }
            let curKeyJson: string | undefined
            this.recordWork(
                key === 'plugins' ? 'plugins'
                    : key === 'pluginCustomStorage' ? 'pluginCustomStorage'
                    : 'root',
                key,
                'json-equality',
            )
            try { curKeyJson = JSON.stringify(curRoot[key]) } catch { curKeyJson = undefined }
            // Fast skip: raw JSON equals the normalized baseline ⇒ present and
            // unchanged. curKeyJson can be undefined for non-serializable values
            // (toJSON()→undefined, bigint throw, function) — those never equal a
            // stored baseline string, so the explicit guard just makes the skip
            // not fire for them.
            if (curKeyJson !== undefined && hadKey && curKeyJson === this.lastRootKeyJsons.get(key)) {
                removedRootKeys.delete(key)
                nextRoot[key] = lastRoot[key]
                continue
            }
            // Decide presence by the NORMALIZED result, NOT by JSON.stringify of
            // the raw value. normalizeJSON ignores toJSON and maps
            // bigint/function/symbol to undefined; its PARENT then drops keys
            // whose normalized value is undefined. Mirror that here — only a
            // normalized-undefined value means the key is absent. (A raw
            // JSON.stringify of undefined does NOT imply that: e.g.
            // {x:1, toJSON:()=>undefined} normalizes to {x:1}.)
            const preservePluginStorageKeys = key === "pluginCustomStorage"
                || key === "pluginStorageMeta"
            const normVal = normalizeJSON(
                curRoot[key],
                undefined,
                preservePluginStorageKeys,
            )
            if (normVal === undefined) {
                // Absent in the normalized form. If it was present (hadKey) the
                // key stays in removedRootKeys → the removal loop emits a remove;
                // if it was never present, nothing to do.
                continue
            }
            removedRootKeys.delete(key)
            // JSON Patch rejects a path segment named `__proto__`, but a
            // whole-map replacement can safely carry that own key inside the
            // operation value. Use that form for additions, updates, and
            // removals involving the special key.
            const requiresWholePluginMapReplace = preservePluginStorageKeys && (
                hasPluginStorageRecordValue(lastRoot[key], "__proto__")
                || hasPluginStorageRecordValue(normVal, "__proto__")
            )
            if (requiresWholePluginMapReplace) {
                patch.push({
                    op: hadKey ? "replace" : "add",
                    path: `/${key}`,
                    value: normVal,
                })
            } else {
                const before = hadKey ? { [key]: lastRoot[key] } : {}
                for (const p of compare(before, { [key]: normVal })) patch.push(p)
            }
            this.hashBlocks[key] = calculateHash(normVal)
            this.lastRootKeyJsons.set(key, JSON.stringify(normVal))
            nextRoot[key] = normVal
        }
        for (const key of removedRootKeys) {
            // Key deleted from the live db (or its value normalized to undefined)
            // → emit the remove op (escaping via compare) and drop its caches.
            if (
                revisions
                && !rootKeyRevisionDirty(key)
                && rootKeyTrusted(key)
                && this.verifyDirtyRevisions
            ) {
                throw revisionDivergence('patcher', `root:${key}`)
            }
            for (const p of compare({ [key]: lastRoot[key] }, {})) patch.push(p)
            delete this.hashBlocks[key]
            this.lastRootKeyJsons.delete(key)
        }

        const botPresetDirty = toSave.botPreset
            || isRevisionBranchDirty(revisions, 'botPreset')
            || (!!revisions && !revisions.isBranchTrusted('botPreset'))
        if (botPresetDirty) {
            const normBotPresets = normalizeJSON(curBotPresets) ?? []
            const ops = diffArrayWithIdGuard(compare, '/botPresets', lastBotPresets, normBotPresets, 'id')
            for (const op of ops) patch.push(op)
            this.hashBlocks['botPresets'] = calculateHash(normBotPresets);
            this.lastSyncedDb.botPresets = normBotPresets;
        }

        const modulesDirty = toSave.modules
            || (revisions?.modules.size ?? 0) > 0
            || isRevisionBranchDirty(revisions, 'modulesStructural')
            || (!!revisions && (
                !revisions.isBranchTrusted('modulesStructural')
                || (Array.isArray(curModules) ? curModules : []).some((module: any) => (
                    typeof module?.id !== 'string'
                    || !revisions.isModuleTrusted(module.id)
                ))
            ))
        if (modulesDirty) {
            // Per-MODULE cheap pre-check, mirroring diffArrayWithIdGuard's
            // structural-vs-elementwise pivot: editing one module's lorebook
            // changes the modules block on every save, so only the edited
            // module should pay normalize + protocol hash + diff.
            const lastModulesArr: any[] = Array.isArray(lastModules) ? lastModules : []
            const curModulesArr: any[] = Array.isArray(curModules) ? curModules : []
            let structural = lastModulesArr.length !== curModulesArr.length
            if (!structural) {
                const lastModIds = lastModulesArr.map((m: any) => m?.id)
                const curModIds = curModulesArr.map((m: any) => m?.id)
                // Non-string ids (numbers, objects) go structural too: ids come
                // from importable data, and only strings are safe/strict as
                // cache keys (1 vs "1" must not collide).
                const hasInvalidIds = curModIds.some(id => !id || typeof id !== 'string') || lastModIds.some(id => !id || typeof id !== 'string')
                const hasDuplicates = new Set(curModIds).size !== curModIds.length
                structural = hasInvalidIds || hasDuplicates || lastModIds.some((id, i) => id !== curModIds[i])
            }

            if (structural) {
                // Structural change → single whole-array replace, exactly like
                // diffArrayWithIdGuard, and rebuild the per-module baselines.
                const normModules = normalizeJSON(curModulesArr) ?? []
                patch.push({ op: 'replace', path: '/modules', value: normModules })
                this.hashBlocks['modules'] = calculateHash(normModules);
                this.lastSyncedDb.modules = normModules;
                this.lastModuleJsons = new Map();
                this.moduleItemHashes = new Map();
                for (const m of normModules) {
                    if (typeof m?.id === 'string' && m.id) {
                        this.lastModuleJsons.set(m.id, JSON.stringify(m))
                        this.moduleItemHashes.set(m.id, calculateHash(m))
                    }
                }
            } else {
                // Same structure (all ids valid, string-typed, aligned) → element-wise.
                for (let i = 0; i < curModulesArr.length; i++) {
                    const id = curModulesArr[i].id
                    const revisionDirty = revisions?.modules.has(id) === true
                    const trustedClean = !!revisions
                        && !revisionDirty
                        && revisions.isModuleTrusted(id)
                    if (trustedClean) {
                        if (this.verifyDirtyRevisions) {
                            this.recordWork('module', id, 'json-equality')
                            let rawMatches = false
                            try {
                                rawMatches = JSON.stringify(curModulesArr[i])
                                    === this.lastModuleJsons.get(id)
                            } catch {
                                rawMatches = false
                            }
                            if (!rawMatches) {
                                const normModule = normalizeJSON(curModulesArr[i])
                                if (compare(lastModulesArr[i], normModule).length > 0) {
                                    throw revisionDivergence('patcher', `module:${id}`)
                                }
                            }
                        }
                        continue
                    }
                    let curModJson: string | null = null
                    this.recordWork('module', id, revisionDirty ? 'json-encode' : 'json-equality')
                    try { curModJson = JSON.stringify(curModulesArr[i]) } catch { curModJson = null }
                    if (curModJson !== null && curModJson === this.lastModuleJsons.get(id) && this.moduleItemHashes.has(id)) {
                        continue // unchanged: baseline slot + item hash stay valid
                    }
                    const normModule = normalizeJSON(curModulesArr[i])
                    for (const p of compare(lastModulesArr[i], normModule)) {
                        patch.push({ ...p, path: `/modules/${i}${p.path}` })
                    }
                    this.moduleItemHashes.set(id, calculateHash(normModule))
                    this.lastModuleJsons.set(id, JSON.stringify(normModule))
                    this.lastSyncedDb.modules[i] = normModule
                }
                // The protocol hash of the whole array is the documented fold of
                // calculateHash over items (see calculateHash's array branch) —
                // recompose it from the cached per-item hashes so the value is
                // bit-identical to calculateHash(normalizeJSON(modules)).
                let modulesHash = SEED_ARRAY
                for (const m of (Array.isArray(this.lastSyncedDb.modules) ? this.lastSyncedDb.modules : [])) {
                    const cached = (typeof m?.id === 'string') ? this.moduleItemHashes.get(m.id) : undefined
                    const itemHash = cached !== undefined ? cached : calculateHash(m)
                    modulesHash = (Math.imul(modulesHash, PRIME_MULTIPLIER) + itemHash) >>> 0
                }
                this.hashBlocks['modules'] = modulesHash
            }
        } else if (
            revisions
            && revisions.isBranchTrusted('modulesStructural')
            && this.verifyDirtyRevisions
        ) {
            const lastModulesArr: any[] = Array.isArray(lastModules) ? lastModules : []
            const curModulesArr: any[] = Array.isArray(curModules) ? curModules : []
            if (lastModulesArr.length !== curModulesArr.length) {
                throw revisionDivergence('patcher', 'modules:structure')
            }
            for (let i = 0; i < curModulesArr.length; i++) {
                const id = curModulesArr[i]?.id
                this.recordWork('module', String(id ?? i), 'json-equality')
                let rawMatches = false
                try {
                    rawMatches = typeof id === 'string'
                        && JSON.stringify(curModulesArr[i]) === this.lastModuleJsons.get(id)
                } catch {
                    rawMatches = false
                }
                if (!rawMatches) {
                    const normModule = normalizeJSON(curModulesArr[i])
                    if (compare(lastModulesArr[i], normModule).length > 0) {
                        throw revisionDivergence('patcher', `module:${String(id ?? i)}`)
                    }
                }
            }
        }

        // Detect structural changes (additions, deletions, reordering)
        const lastIds = lastCharacters.map((c: any) => c?.chaId)
        const curIds = curCharacters.map((c: any) => c?.chaId)
        const structuralChange = lastIds.length !== curIds.length ||
            lastIds.some((id: string, i: number) => id !== curIds[i])

        // Replace chats with stubs for patch diff — full chat data lives server-side
        function withStubs(char: any) {
            if (!char) return char
            return { ...char, chats: (char.chats || []).map((c: any) => chatToStub(c)) }
        }

        if (structuralChange) {
            if (
                revisions
                && this.verifyDirtyRevisions
                && revisions.charactersStructural === null
                && [...new Set([...lastIds, ...curIds])]
                    .filter(Boolean)
                    .every((chaId: string) => (
                        !revisions.characters.has(chaId)
                        && revisions.isCharacterTrusted(chaId)
                    ))
            ) {
                throw revisionDivergence('patcher', 'characters:structure')
            }
            // Structural change → replace entire characters array (safe for deletions/additions)
            const normChars = normalizeJSON(curCharacters.map(withStubs))
            patch.push({ op: 'replace', path: '/characters', value: normChars })
            // Update all character hashes
            for (const lastId of lastIds) {
                if (lastId) delete this.hashBlocks[lastId];
            }
            for (const char of normChars) {
                if (char?.chaId) {
                    this.hashBlocks[char.chaId] = calculateHash(char);
                }
            }
            this.lastSyncedDb.characters = normChars;
            // Rebuild the cheap baselines from the NORMALIZED chars (the server's
            // state), not the raw input — see init().
            this.lastCharJsons = new Map();
            for (const char of normChars) {
                if (char?.chaId) this.lastCharJsons.set(char.chaId, JSON.stringify(char))
            }
        } else {
            // Same structure → per-character field-level diff (efficient)
            for (let i = 0; i < curCharacters.length; i++) {
                const lastChar = lastCharacters[i]
                const curChar = curCharacters[i]
                const curCharId = curChar?.chaId
                const trackedBySave = toSave.character.includes(curCharId ?? '')
                const revisionDirty = revisions?.characters.has(curCharId ?? '') === true
                const trustedClean = !!revisions
                    && !revisionDirty
                    && !!curCharId
                    && revisions.isCharacterTrusted(curCharId)

                if (trustedClean && !trackedBySave) {
                    if (this.verifyDirtyRevisions) {
                        this.recordWork('character', curCharId, 'json-equality')
                        let rawMatches = false
                        try {
                            rawMatches = JSON.stringify(withStubs(curChar))
                                === this.lastCharJsons.get(curCharId)
                        } catch {
                            rawMatches = false
                        }
                        if (!rawMatches) {
                            const normChar = normalizeJSON(withStubs(curChar))
                            if (compare(lastChar, normChar).length > 0) {
                                throw revisionDivergence('patcher', `character:${curCharId}`)
                            }
                        }
                    }
                    continue
                }

                // Cheap pre-check: identical JSON ⇒ identical data ⇒ stored
                // hash, baseline and (empty) diff are all still valid — skip
                // the normalize + protocol hash + compare entirely.
                let curJson: string | null = null
                this.recordWork(
                    'character',
                    String(curCharId ?? i),
                    revisionDirty || trackedBySave ? 'json-encode' : 'json-equality',
                )
                try { curJson = JSON.stringify(withStubs(curChar)) } catch { curJson = null }
                if (!trackedBySave && curCharId && curJson !== null && curJson === this.lastCharJsons.get(curCharId)) {
                    continue
                }

                const normChar = normalizeJSON(withStubs(curChar))
                const curCharHash = curCharId ? calculateHash(normChar) : undefined
                const changedByHash = !!(curCharId && curCharHash !== this.hashBlocks[curCharId])

                if (trackedBySave || changedByHash) {
                    const charPatch = buildBoundedCharacterPatch(
                        compare(lastChar, normChar),
                        i,
                        normChar,
                    )
                    for (const operation of charPatch) patch.push(operation)
                    this.hashBlocks[normChar.chaId] = curCharHash ?? calculateHash(normChar);
                    this.lastSyncedDb.characters[i] = normChar;
                }
                // Refresh the cheap baseline from the NORMALIZED form (the
                // server's actual state), not curJson — a raw baseline could
                // later match a string whose normalized form differs from the
                // server's (shared ref → null → un-share), silently skipping a
                // real change. Normalized baseline keeps such chars on the safe
                // full path. normChar is cycle-free, so stringify won't throw.
                if (curCharId) {
                    this.lastCharJsons.set(curCharId, JSON.stringify(normChar))
                }
            }
        }

        this.lastSyncedDb = {
            characters: this.lastSyncedDb.characters,
            botPresets: this.lastSyncedDb.botPresets,
            modules: this.lastSyncedDb.modules,
            ...nextRoot
        }

        return {
            patch,
            expectedHash
        }
    }
}

// Stub metadata fields a patch may legitimately touch on `chats[i]`. Anything
// else is chat-internal data that lives server-side via /api/chat-content;
// emitting such ops over /api/patch silently strips the `_stub` flag in the
// server's dbCache and corrupts the on-disk DB. Keep in sync with chatToStub.
const STUB_METADATA_FIELDS = new Set(['id', 'name', '_stub', 'lastDate', 'folderId', 'modules']);

// Only these op types are legitimate on chat-internal paths. The patcher's
// fast-json-patch.compare only emits add/replace/remove; move/copy/test would
// only come from external/legacy clients and could bypass the field-name
// allowlist by aliasing _stub through `from`. Reject them outright.
const ALLOWED_CHAT_OP_TYPES = new Set(['add', 'replace', 'remove'])

const CHAT_FIELD_PATH_RE = /^\/characters\/\d+\/chats\/\d+\/([^/]+)/

/**
 * Detect patch ops that mutate chat-internal fields. The patcher should never
 * produce these — chats are always run through chatToStub before diffing — so
 * any hit indicates a baseline-vs-current mismatch that would cause server-side
 * data loss (see findChatInternalFieldOps in server.cjs). Used by the save
 * pipeline to refuse the patch and fall through to a safe full write.
 *
 * The `_stub` field gets stricter treatment than other allowed fields: only
 * `add`/`replace` with literal value `true` is permitted. Removing `_stub`
 * or setting it to a falsy value is itself the loss vector — the server's
 * reassembleFullDb skips fullChat merge when `_stub` is falsy.
 *
 * `move`/`copy` ops on chat-internal paths are rejected wholesale because
 * the field-name allowlist on `path` alone can't catch a `from` that points
 * at `_stub` or another chat-internal field. Both `path` and `from` are
 * checked when present.
 */
export function findDangerousChatOps(patch: any[]): { op: string; path: string; field: string; reason?: string }[] {
    if (!Array.isArray(patch)) return []
    const violations: { op: string; path: string; field: string; reason?: string }[] = []
    for (const op of patch) {
        if (!op || typeof op !== 'object' || typeof op.path !== 'string') continue

        const pathMatch = op.path.match(CHAT_FIELD_PATH_RE)
        const fromMatch = typeof op.from === 'string' ? op.from.match(CHAT_FIELD_PATH_RE) : null
        if (!pathMatch && !fromMatch) continue

        // Any move/copy/test that touches a chat-internal field — on either
        // path or from — is a bypass attempt. Block at the op-type layer.
        if (!ALLOWED_CHAT_OP_TYPES.has(op.op)) {
            violations.push({
                op: op.op,
                path: op.path,
                field: pathMatch?.[1] ?? fromMatch?.[1] ?? '',
                reason: `disallowed op type on chat field`,
            })
            continue
        }

        if (pathMatch) {
            const field = pathMatch[1]
            if (!STUB_METADATA_FIELDS.has(field)) {
                violations.push({ op: op.op, path: op.path, field })
                continue
            }
            if (field === '_stub') {
                if (op.op === 'remove') {
                    violations.push({ op: op.op, path: op.path, field, reason: 'remove _stub' })
                } else if ((op.op === 'add' || op.op === 'replace') && op.value !== true) {
                    violations.push({ op: op.op, path: op.path, field, reason: 'non-true _stub value' })
                }
            }
        }
    }
    return violations
}
