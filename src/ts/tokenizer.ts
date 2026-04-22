import type { Tiktoken } from "@dqbd/tiktoken";
import type { Tokenizer } from "@mlc-ai/web-tokenizers";
import { type character, type Chat, getCurrentCharacter, getDatabase } from "./storage/database.svelte";
import type { MultiModal, OpenAIChat } from "./process/index.svelte";
import { supportsInlayImage } from "./process/files/inlays";
import { risuChatParser } from "./parser/parser.svelte";
import { tokenizeGGUFModel } from "./process/models/local";
import { globalFetch } from "./globalApi.svelte";
import { getModelInfo, LLMTokenizer, type LLMModel } from "./model/modellist";
import { pluginV2 } from "./plugins/plugins.svelte";
import type { GemmaTokenizer } from "@huggingface/transformers";
import { LRUMap } from 'mnemonist';
import { makeHashedStorageKey, readPersistentJson, writePersistentJson } from "./storage/persistentKv";
import { tokenizeCountViaServer } from "./tokenizerWs";

// Token-count cache. Keyed on a fast 64-bit hash of (data + tokenizer config)
// so we don't have to keep the full chat text in memory for every cached
// entry. The cache is the dominant speedup once a chat grows: only freshly
// edited / appended messages miss, everything else returns synchronously.
const COUNT_CACHE_SIZE = 20000;
const ENCODE_CACHE_SIZE = 1500;

const encodeCache = new LRUMap<string, number[] | Uint32Array | Int32Array>(ENCODE_CACHE_SIZE);
const countCache = new LRUMap<string, number>(COUNT_CACHE_SIZE);

// cyrb53 — small, fast, low-collision 53-bit string hash. Synchronous (unlike
// SubtleCrypto) so it's cheap to call from the tokenisation hot path. Returns
// a base36 string so the LRU map keys stay short.
function cyrb53(str: string, seed = 0): string {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function getHash(
    data: string,
    aiModel: string,
    customTokenizer: string,
    currentPluginProvider: string,
    googleClaudeTokenizing: boolean,
    modelInfo: LLMModel,
    pluginTokenizer: string
): string {
    // Hash the text portion separately from the (small) configuration suffix
    // so we never allocate a giant concatenated string for every long message.
    const textHash = cyrb53(data);
    return `${textHash}|${data.length}|${aiModel}|${customTokenizer}|${currentPluginProvider}|${googleClaudeTokenizing ? 1 : 0}|${modelInfo.tokenizer}|${pluginTokenizer}`;
}


export const tokenizerList = [
    ['tik', 'Tiktoken (OpenAI)'],
    ['mistral', 'Mistral'],
    ['novelai', 'NovelAI'],
    ['claude', 'Claude'],
    ['llama', 'Llama'],
    ['llama3', 'Llama3'],
    ['novellist', 'Novellist'],
    ['gemma', 'Gemma'],
    ['cohere', 'Cohere'],
    ['deepseek', 'DeepSeek'],
] as const

export async function encodeWithTokenizer(data: string, tokenizerType: string): Promise<(number[] | Uint32Array | Int32Array)> {
    switch (tokenizerType) {
        case 'tik':
            return await tikJS(data, 'cl100k_base');
        case 'mistral':
            return await tokenizeWebTokenizers(data, 'mistral');
        case 'novelai':
            return await tokenizeWebTokenizers(data, 'novelai');
        case 'claude':
            return await tokenizeWebTokenizers(data, 'claude');
        case 'llama':
            return await tokenizeWebTokenizers(data, 'llama');
        case 'llama3':
            return await tokenizeWebTokenizers(data, 'llama3');
        case 'novellist':
            return await tokenizeWebTokenizers(data, 'novellist');
        case 'gemma':
            return await gemmaTokenize(data);
        case 'cohere':
            return await tokenizeWebTokenizers(data, 'cohere');
        case 'deepseek':
            return await tokenizeWebTokenizers(data, 'DeepSeek');
        default:
            return await tikJS(data, 'cl100k_base');
    }
}

export async function encode(data:string):Promise<(number[]|Uint32Array|Int32Array)>{
    const db = getDatabase();
    const modelInfo = getModelInfo(db.aiModel);
    const pluginTokenizer = pluginV2.providerOptions.get(db.currentPluginProvider)?.tokenizer ?? "none";

    let cacheKey = ''
    if(db.useTokenizerCaching){
        cacheKey = getHash(
            data,
            db.aiModel,
            db.customTokenizer,
            db.currentPluginProvider,
            db.googleClaudeTokenizing,
            modelInfo,
            pluginTokenizer
        );
        const cachedResult = encodeCache.get(cacheKey);
        if (cachedResult !== undefined) {
            return cachedResult;
        }
    }

    let result: number[] | Uint32Array | Int32Array;

    if(db.aiModel === 'openrouter' || db.aiModel === 'reverse_proxy' || db.aiModel === 'risuext'){
        switch(db.customTokenizer){
            case 'mistral':
                result = await tokenizeWebTokenizers(data, 'mistral'); break;
            case 'llama':
                result = await tokenizeWebTokenizers(data, 'llama'); break;
            case 'novelai':
                result = await tokenizeWebTokenizers(data, 'novelai'); break;
            case 'claude':
                result = await tokenizeWebTokenizers(data, 'claude'); break;
            case 'novellist':
                result = await tokenizeWebTokenizers(data, 'novellist'); break;
            case 'llama3':
                result = await tokenizeWebTokenizers(data, 'llama'); break;
            case 'gemma':
                result = await gemmaTokenize(data); break;
            case 'cohere':
                result = await tokenizeWebTokenizers(data, 'cohere'); break;
            case 'deepseek':
                result = await tokenizeWebTokenizers(data, 'DeepSeek'); break;
            default:
                result = await tikJS(data, 'o200k_base'); break;
        }
    } else if (db.aiModel === 'custom' && pluginTokenizer) {
        switch(pluginTokenizer){
            case 'mistral':
                result = await tokenizeWebTokenizers(data, 'mistral'); break;
            case 'llama':
                result = await tokenizeWebTokenizers(data, 'llama'); break;
            case 'novelai':
                result = await tokenizeWebTokenizers(data, 'novelai'); break;
            case 'claude':
                result = await tokenizeWebTokenizers(data, 'claude'); break;
            case 'novellist':
                result = await tokenizeWebTokenizers(data, 'novellist'); break;
            case 'llama3':
                result = await tokenizeWebTokenizers(data, 'llama'); break;
            case 'gemma':
                result = await gemmaTokenize(data); break;
            case 'cohere':
                result = await tokenizeWebTokenizers(data, 'cohere'); break;
            case 'o200k_base':
                result = await tikJS(data, 'o200k_base'); break;
            case 'cl100k_base':
                result = await tikJS(data, 'cl100k_base'); break;
            case 'custom':
                result = await pluginV2.providerOptions.get(db.currentPluginProvider)?.tokenizerFunc?.(data) ?? [0]; break;
            default:
                result = await tikJS(data, 'o200k_base'); break; 
        }
    } 
    
    // Fallback
    if (result === undefined) {
        if(modelInfo.tokenizer === LLMTokenizer.NovelList){
            result = await tokenizeWebTokenizers(data, 'novellist');
        } else if(modelInfo.tokenizer === LLMTokenizer.Claude){
            result = await tokenizeWebTokenizers(data, 'claude');
        } else if(modelInfo.tokenizer === LLMTokenizer.NovelAI){
            result = await tokenizeWebTokenizers(data, 'novelai');
        } else if(modelInfo.tokenizer === LLMTokenizer.Mistral){
            result = await tokenizeWebTokenizers(data, 'mistral');
        } else if(modelInfo.tokenizer === LLMTokenizer.Llama){
            result = await tokenizeWebTokenizers(data, 'llama');
        } else if(modelInfo.tokenizer === LLMTokenizer.Local){
            result = await tokenizeGGUFModel(data);
        } else if(modelInfo.tokenizer === LLMTokenizer.tiktokenO200Base){
            result = await tikJS(data, 'o200k_base');
        } else if(modelInfo.tokenizer === LLMTokenizer.GoogleCloud && db.googleClaudeTokenizing){
            result = await tokenizeGoogleCloud(data);
        } else if(modelInfo.tokenizer === LLMTokenizer.Gemma || modelInfo.tokenizer === LLMTokenizer.GoogleCloud){
            result = await gemmaTokenize(data);
        } else if(modelInfo.tokenizer === LLMTokenizer.DeepSeek){
            result = await tokenizeWebTokenizers(data, 'DeepSeek');
        } else if(modelInfo.tokenizer === LLMTokenizer.Cohere){
            result = await tokenizeWebTokenizers(data, 'cohere');
        } else {
            result = await tikJS(data);
        }
    }
    if(db.useTokenizerCaching){
        encodeCache.set(cacheKey, result);
    }

    return result;
}

// ─── Server-assisted tokenisation ────────────────────────────────────────────
//
// For consumers that only need the token count (the common case: tokenize,
// tokenizeAccurate, ChatTokenizer, ...) we try to forward the work to the Node
// server over a WebSocket and only fall back to the heavier in-browser
// tokenizer if the server is unavailable. This keeps the main thread snappy
// once chats grow long.

type StaticTokenizerKey =
    | 'tik-cl100k' | 'tik-o200k'
    | 'claude' | 'llama3' | 'gemma' | 'cohere' | 'deepseek';

// NOTE: Some tokenizer types (mistral, llama, novelai, novellist) are
// SentencePiece-based and not currently supported server-side, so the
// resolver returns null for them and the in-browser tokenizer is used.
function resolveStaticTokenizerKey(): StaticTokenizerKey | null {
    const db = getDatabase();
    const modelInfo = getModelInfo(db.aiModel);
    const pluginTokenizer = pluginV2.providerOptions.get(db.currentPluginProvider)?.tokenizer ?? "none";

    if (db.aiModel === 'openrouter' || db.aiModel === 'reverse_proxy' || db.aiModel === 'risuext') {
        switch (db.customTokenizer) {
            case 'mistral': return null;
            case 'llama': return null;
            case 'novelai': return null;
            case 'claude': return 'claude';
            case 'novellist': return null;
            // Mirrors the existing local routing which intentionally uses the
            // `llama` SentencePiece tokenizer for `llama3` choice → not
            // supported server-side, fall back.
            case 'llama3': return null;
            case 'gemma': return 'gemma';
            case 'cohere': return 'cohere';
            case 'deepseek': return 'deepseek';
            default: return 'tik-o200k';
        }
    }
    if (db.aiModel === 'custom' && pluginTokenizer) {
        switch (pluginTokenizer) {
            case 'mistral': return null;
            case 'llama': return null;
            case 'novelai': return null;
            case 'claude': return 'claude';
            case 'novellist': return null;
            case 'llama3': return null;
            case 'gemma': return 'gemma';
            case 'cohere': return 'cohere';
            case 'o200k_base': return 'tik-o200k';
            case 'cl100k_base': return 'tik-cl100k';
            case 'custom': return null;
            default: return 'tik-o200k';
        }
    }

    switch (modelInfo.tokenizer) {
        case LLMTokenizer.NovelList: return null;
        case LLMTokenizer.Claude: return 'claude';
        case LLMTokenizer.NovelAI: return null;
        case LLMTokenizer.Mistral: return null;
        case LLMTokenizer.Llama: return null;
        case LLMTokenizer.tiktokenO200Base: return 'tik-o200k';
        case LLMTokenizer.DeepSeek: return 'deepseek';
        case LLMTokenizer.Cohere: return 'cohere';
        case LLMTokenizer.Gemma: return 'gemma';
        case LLMTokenizer.GoogleCloud:
            return db.googleClaudeTokenizing ? null : 'gemma';
        case LLMTokenizer.Local: return null;
        default: return 'tik-cl100k';
    }
}

export async function tokenizeCount(data: string): Promise<number> {
    const db = getDatabase();
    const modelInfo = getModelInfo(db.aiModel);
    const pluginTokenizer = pluginV2.providerOptions.get(db.currentPluginProvider)?.tokenizer ?? "none";

    let cacheKey = '';
    if (db.useTokenizerCaching) {
        cacheKey = getHash(
            data,
            db.aiModel,
            db.customTokenizer,
            db.currentPluginProvider,
            db.googleClaudeTokenizing,
            modelInfo,
            pluginTokenizer
        );
        const cachedCount = countCache.get(cacheKey);
        if (cachedCount !== undefined) return cachedCount;
        const cachedTokens = encodeCache.get(cacheKey);
        if (cachedTokens !== undefined) {
            countCache.set(cacheKey, cachedTokens.length);
            return cachedTokens.length;
        }
    }

    const staticKey = resolveStaticTokenizerKey();
    if (staticKey && !db.disableServerTokenizer) {
        const remoteCount = await tokenizeCountViaServer(data, staticKey);
        if (remoteCount !== null) {
            if (db.useTokenizerCaching) countCache.set(cacheKey, remoteCount);
            return remoteCount;
        }
    }

    const encoded = await encode(data);
    const count = encoded.length;
    if (db.useTokenizerCaching) countCache.set(cacheKey, count);
    return count;
}

type tokenizerType = 'novellist'|'claude'|'novelai'|'llama'|'mistral'|'llama3'|'gemma'|'cohere'|'googleCloud'|'DeepSeek'

let tikParser:Tiktoken = null
let tokenizersTokenizer:Tokenizer = null
let tokenizersType:tokenizerType = null
let lastTikModel = 'cl100k_base'

let googleCloudTokenizedCache = new Map<string, number>()

async function tokenizeGoogleCloud(text:string) {
    const db = getDatabase()
    const model = getModelInfo(db.aiModel)
    const cacheKey = text + model.internalID

    if(googleCloudTokenizedCache.has(cacheKey)){
        const count = googleCloudTokenizedCache.get(cacheKey) ?? 0
        return new Uint32Array(count)
    }

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.internalID}:countTokens?key=${db.google?.accessToken}`, {
        method: 'POST',
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            contents: [{
                parts:[{
                    text: text
                }]
            }]
        }),
    })

    if(res.status !== 200){
        return await tokenizeWebTokenizers(text, 'gemma')
    }

    const json = await res.json()
    googleCloudTokenizedCache.set(cacheKey, json.totalTokens as number)
    const count = json.totalTokens as number

    return new Uint32Array(count)
}

let gemmaTokenizer:GemmaTokenizer = null
async function gemmaTokenize(text:string) {
    if(!gemmaTokenizer){
        const {GemmaTokenizer} = await import('@huggingface/transformers')
        gemmaTokenizer = new GemmaTokenizer(
            await (await fetch("/token/llama/llama3.json")
        ).json(), {})
    }
    return gemmaTokenizer.encode(text)
}

async function tikJS(text:string, model='cl100k_base') {
    if(!tikParser || lastTikModel !== model){
        tikParser?.free()
        if(model === 'cl100k_base'){
            const {Tiktoken} = await import('@dqbd/tiktoken')
            const cl100k_base = await import("@dqbd/tiktoken/encoders/cl100k_base.json");
            lastTikModel = model   
        
            tikParser = new Tiktoken(
                cl100k_base.bpe_ranks,
                cl100k_base.special_tokens,
                cl100k_base.pat_str
            );
        }
        if(model === 'o200k_base'){
            const {Tiktoken} = await import('@dqbd/tiktoken')
            const o200k_base = await import("src/etc/o200k_base.json");
            lastTikModel = model
            tikParser = new Tiktoken(
                o200k_base.bpe_ranks,
                o200k_base.special_tokens,
                o200k_base.pat_str
            );
        }
    }
    return tikParser.encode(text)
}

async function geminiTokenizer(text:string) {
    const db = getDatabase()
    const fetchResult = await globalFetch(`https://generativelanguage.googleapis.com/v1beta/${db.aiModel}:countTextTokens`, {
        "headers": {
            "content-type": "application/json",
            "authorization": `Bearer ${db.google.accessToken}`
        },
        "body": JSON.stringify({
            "prompt":{
                text: text
            }
        }),
        "method": "POST"
    })

    if(!fetchResult.ok){
        //fallback to tiktoken
        return await tikJS(text)
    }

    const result = fetchResult.data

    return result.tokenCount ?? 0
}

async function tokenizeWebTokenizers(text:string, type:tokenizerType) {
    if(type !== tokenizersType || !tokenizersTokenizer){
        const webTokenizer = await import('@mlc-ai/web-tokenizers')
        switch(type){
            case "novellist":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/trin/spiece.model")
                ).arrayBuffer())
                break
            case "claude":
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/claude/claude.json")
                ).arrayBuffer())
                break
            case 'llama3':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/llama/llama3.json")
                ).arrayBuffer())
                break
            case 'cohere':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/cohere/tokenizer.json")
                ).arrayBuffer())
                break
            case 'novelai':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/nai/nerdstash_v2.model")
                ).arrayBuffer())
                
                break
            case 'llama':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/llama/llama.model")
                ).arrayBuffer())
                break
            case 'mistral':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/mistral/tokenizer.model")
                ).arrayBuffer())
                break
            case 'gemma':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromSentencePiece(
                    await (await fetch("/token/gemma/tokenizer.model")
                ).arrayBuffer())
                break
            case 'DeepSeek':
                tokenizersTokenizer = await webTokenizer.Tokenizer.fromJSON(
                    await (await fetch("/token/deepseek/tokenizer.json")
                ).arrayBuffer())
                break

        }
        tokenizersType = type
    }
    return (tokenizersTokenizer.encode(text))
}

export async function tokenizerChar(char:character) {
    return await tokenizeCount(char.name + '\n' + char.firstMessage + '\n' + char.desc)
}

export async function tokenize(data:string) {
    return await tokenizeCount(data)
}

export async function tokenizeAccurate(data:string | null | undefined, consistantChar?:boolean) {
    data = risuChatParser((data ?? '').replace('{{slot}}',''), {
        tokenizeAccurate: true,
        consistantChar: consistantChar,
    })
    return await tokenizeCount(data)
}


export class ChatTokenizer {

    private chatAdditionalTokens:number
    private useName:'name'|'noName'

    constructor(chatAdditionalTokens:number, useName:'name'|'noName'){
        this.chatAdditionalTokens = chatAdditionalTokens
        this.useName = useName
    }
    async tokenizeChat(data:OpenAIChat, args:{
        countThoughts?:boolean,
    } = {}) {
        let encoded = (await tokenizeCount(data.content)) + this.chatAdditionalTokens
        if(data.name && this.useName ==='name'){
            encoded += (await tokenizeCount(data.name)) + 1
        }
        if(data.multimodals && data.multimodals.length > 0){
            for(const multimodal of data.multimodals){
                encoded += await this.tokenizeMultiModal(multimodal)
            }
        }
        if(data.thoughts && data.thoughts.length > 0 && args.countThoughts){
            for(const thought of data.thoughts){
                encoded += (await tokenizeCount(thought)) + 1
            }
        }
        return encoded
    }
    async tokenizeChats(data:OpenAIChat[]){
        let encoded = 0
        for(const chat of data){
            encoded += await this.tokenizeChat(chat)
        }
        return encoded
    }

    tokenizeMultiModal(data:MultiModal){
        const db = getDatabase()
        if(!supportsInlayImage()){
            return this.chatAdditionalTokens
        }
        if(db.gptVisionQuality === 'low'){
            return 87
        }

        let encoded = this.chatAdditionalTokens
        let height = data.height ?? 0
        let width = data.width ?? 0

        if(height === width){
            if(height > 768){
                height = 768
                width = 768
            }
        }
        else if(height > width){
            if(width > 768){
                width = 768
                height = height * (768 / width)
            }
        }
        else{
            if(height > 768){
                height = 768
                width = width * (768 / height)
            }
        }

        const chunkSize = Math.ceil(width / 512) * Math.ceil(height / 512)
        encoded += chunkSize * 2
        encoded += 85

        return encoded
    }
    
}

export async function tokenizeNum(data:string) {
    const encoded = await encode(data)
    return encoded
}

const strongBanCache = new Map<string, {[key:number]:number}>();
const strongBanCachePrefix = 'cache/strong-ban/';

async function getPersistedStrongBan(cacheKey: string) {
    if (strongBanCache.has(cacheKey)) {
        return strongBanCache.get(cacheKey)
    }
    const storageKey = await makeHashedStorageKey(strongBanCachePrefix, cacheKey)
    const payload = await readPersistentJson<{ key: string, value: {[key:number]:number} }>(storageKey)
    if (!payload || payload.key !== cacheKey) {
        return null
    }
    strongBanCache.set(cacheKey, payload.value)
    return payload.value
}

export async function strongBan(data:string, bias:{[key:number]:number}) {

    const cacheKey = 'strongBan_' + data
    const cached = await getPersistedStrongBan(cacheKey)
    if(cached){
        return cached
    }
    const performace = performance.now()
    const length = Object.keys(bias).length
    let charAlt = [
        data,
        data.trim(),
        data.toLocaleUpperCase(),
        data.toLocaleLowerCase(),
        data[0].toLocaleUpperCase() + data.slice(1),
        data[0].toLocaleLowerCase() + data.slice(1),
    ]

    let banChars = " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~“”‘’«»「」…–―※"
    let unbanChars:number[] = []

    for(const char of banChars){
        unbanChars.push((await tokenizeNum(char))[0])
    }



    for(const char of banChars){
        const encoded = await tokenizeNum(char)
        if(encoded.length > 0){
            if(!unbanChars.includes(encoded[0])){
                bias[encoded[0]] = -100
            }
        }
        for(const alt of charAlt){
            let fchar = char

            const encoded = await tokenizeNum(alt + fchar)
            if(encoded.length > 0){
                if(!unbanChars.includes(encoded[0])){
                    bias[encoded[0]] = -100
                }
            }
            const encoded2 = await tokenizeNum(fchar + alt)
            if(encoded2.length > 0){
                if(!unbanChars.includes(encoded2[0])){
                    bias[encoded2[0]] = -100
                }
            }
        }
    }
    strongBanCache.set(cacheKey, bias)
    const storageKey = await makeHashedStorageKey(strongBanCachePrefix, cacheKey)
    await writePersistentJson(storageKey, {
        key: cacheKey,
        value: bias
    })
    return bias
}

export async function getCharToken(char?:character|null){
    let persistant = 0
    let dynamic = 0

    if(!char){
        const c = getCurrentCharacter()
        char = c
    }
    const basicTokenize = async (data:string) => {
        data = data.replace(/{{char}}/g, char.name).replace(/<char>/g, char.name)
        return await tokenize(data)
    }

    persistant += await basicTokenize(char.desc)
    persistant += await basicTokenize(char.personality ?? '')
    persistant += await basicTokenize(char.scenario ?? '')
    for(const lore of char.globalLore){
        let cont = lore.content.split('\n').filter((line) => {
            if(line.startsWith('@@')){
                return false
            }
            if(line === ''){
                return false
            }
            return true
        }).join('\n')
        dynamic += await basicTokenize(cont)
    }

    return {persistant, dynamic}
}

export async function getChatToken(chat:Chat) {
    let persistant = 0

    const chatTokenizer = new ChatTokenizer(0, 'name')
    const chatf = chat.message.map((d) => {
        return {
            role: d.role === 'user' ? 'user' : 'assistant',
            content: d.data,
        } as OpenAIChat
    })
    for(const chat of chatf){
        persistant += await chatTokenizer.tokenizeChat(chat)
    }

    return persistant
}
