// Server-side tokenizer service.
//
// Lazy-loads tokenizers for the JSON-based tokenizer formats the browser uses
// (HF `tokenizer.json` style files via `@huggingface/transformers`) plus the
// OpenAI tiktoken encodings via `@dqbd/tiktoken`. Token data files are read
// from disk under dist/token/... (the same files Vite copies from
// public/token); during dev we fall back to public/token directly.
//
// SentencePiece-only tokenizers (mistral, llama, novelai, novellist) do not
// have a Node-friendly pure-JS implementation in this dependency set, so they
// are intentionally not exposed here. The client falls back to its in-browser
// tokenizer for those.
//
// Exposed entry point: tokenizeText(text, key) -> Promise<{ count, tokens? }>

const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');

const TOKEN_DIRS = [
    path.join(process.cwd(), 'dist', 'token'),
    path.join(process.cwd(), 'public', 'token'),
    path.join(__dirname, '..', '..', 'public', 'token'),
    path.join(__dirname, '..', '..', 'dist', 'token'),
];

async function readTokenJson(relativePath) {
    for (const base of TOKEN_DIRS) {
        const candidate = path.join(base, relativePath);
        if (existsSync(candidate)) {
            const buf = await fs.readFile(candidate, 'utf-8');
            return JSON.parse(buf);
        }
    }
    throw new Error(`[Tokenizer] Token file not found: ${relativePath}`);
}

const tokenizerCache = new Map();
const tokenizerLoading = new Map();

const TOKENIZER_DEFS = {
    'tik-cl100k': { kind: 'tiktoken', encoder: 'cl100k_base' },
    'tik-o200k':  { kind: 'tiktoken', encoder: 'o200k_base'  },
    'claude':     { kind: 'hf-json',  file: 'claude/claude.json' },
    'llama3':     { kind: 'hf-json',  file: 'llama/llama3.json' },
    'cohere':     { kind: 'hf-json',  file: 'cohere/tokenizer.json' },
    'deepseek':   { kind: 'hf-json',  file: 'deepseek/tokenizer.json' },
    // Mirrors the browser side, which uses the llama3 tokenizer JSON for
    // gemma counts.
    'gemma':      { kind: 'hf-json',  file: 'llama/llama3.json' },
};

let tiktokenModule = null;
let hfModule = null;

async function getTiktoken() {
    if (!tiktokenModule) tiktokenModule = require('@dqbd/tiktoken');
    return tiktokenModule;
}

async function getHfTransformers() {
    if (!hfModule) hfModule = await import('@huggingface/transformers');
    return hfModule;
}

async function buildTokenizer(key) {
    const def = TOKENIZER_DEFS[key];
    if (!def) {
        throw new Error(`[Tokenizer] Unknown tokenizer key: ${key}`);
    }

    if (def.kind === 'tiktoken') {
        const { Tiktoken } = await getTiktoken();
        const pack = def.encoder === 'cl100k_base'
            ? require('@dqbd/tiktoken/encoders/cl100k_base.json')
            : require('@dqbd/tiktoken/encoders/o200k_base.json');
        const enc = new Tiktoken(pack.bpe_ranks, pack.special_tokens, pack.pat_str);
        return {
            encode: (text) => enc.encode(text),
        };
    }

    if (def.kind === 'hf-json') {
        const { PreTrainedTokenizer } = await getHfTransformers();
        const json = await readTokenJson(def.file);
        const tok = new PreTrainedTokenizer(json, {});
        return {
            encode: (text) => tok.encode(text),
        };
    }

    throw new Error(`[Tokenizer] Unsupported tokenizer kind: ${def.kind}`);
}

async function loadTokenizer(key) {
    const cached = tokenizerCache.get(key);
    if (cached) return cached;
    let pending = tokenizerLoading.get(key);
    if (!pending) {
        pending = buildTokenizer(key)
            .then((tk) => {
                tokenizerCache.set(key, tk);
                tokenizerLoading.delete(key);
                return tk;
            })
            .catch((err) => {
                tokenizerLoading.delete(key);
                throw err;
            });
        tokenizerLoading.set(key, pending);
    }
    return pending;
}

function isSupportedTokenizerKey(key) {
    return Object.prototype.hasOwnProperty.call(TOKENIZER_DEFS, key);
}

async function tokenizeText(text, key, { includeTokens = false } = {}) {
    const tk = await loadTokenizer(key);
    const tokens = tk.encode(text ?? '');
    const count = (tokens && typeof tokens.length === 'number') ? tokens.length : 0;
    if (includeTokens) {
        const arr = Array.isArray(tokens) ? tokens : Array.from(tokens);
        return { count, tokens: arr };
    }
    return { count };
}

module.exports = {
    tokenizeText,
    isSupportedTokenizerKey,
    SUPPORTED_KEYS: Object.keys(TOKENIZER_DEFS),
};
