import { toGetter } from "../globalApi.svelte";
import { clearPersistentPrefix, decodeStorageKeyComponent, listPersistentKeys, makeEncodedStorageKey, readPersistentJson, removePersistentKey, writePersistentJson } from "../storage/persistentKv";
import { snapshotJsonValue } from "../storage/jsonValue";
import { recordOwner, removeOwner, clearOwners } from "./pluginStorageMeta";

const pluginStorage = new Map<string, unknown>();
const pluginStoragePrefix = 'cache/plugin-storage/';

function hasUnknownCommitOutcome(error: unknown): boolean {
    return !!error
        && typeof error === 'object'
        && ((error as { commitOutcomeUnknown?: unknown }).commitOutcomeUnknown === true
            || (error as { code?: unknown }).code === 'COMMIT_OUTCOME_UNKNOWN');
}

function clearPluginStorageCache(): void {
    for (const key of [...pluginStorage.keys()]) {
        if (key.startsWith('safe_plugin_')) pluginStorage.delete(key);
    }
}

function snapshotLegacyLocalPluginStorageValue(value: unknown): unknown {
    // SafeLocalPluginStorage historically accepted the values JSON.stringify
    // can normalize. Keep that compatibility at this API boundary while the
    // persistence layer itself continues to accept only detached JSON data.
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new TypeError("Local plugin storage requires a JSON-representable value.");
    }
    return snapshotJsonValue(JSON.parse(serialized));
}

export class SafeLocalStorage {
    getItem(key: string): string | null {
        return localStorage.getItem(`safe_plugin_${key}`);
    }
    setItem(key: string, value: string): void {
        localStorage.setItem(`safe_plugin_${key}`, value);
    }
    removeItem(key: string): void {
        localStorage.removeItem(`safe_plugin_${key}`);
    }
    //not a standard localStorage method, but useful
    keys(): string[] {
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('safe_plugin_')) {
                keys.push(key.substring('safe_plugin_'.length));
            }
        }
        return keys;
    }

    key(index: number): string | null {
        const safeKeys = this.keys();
        return safeKeys[index] || null;
    }

    clear(): void {
        const keys = this.keys();
        for (const key of keys) {
            this.removeItem(key);
        }
    }

    get length(): number {
        return this.keys().length;
    }


}


export class SafeLocalPluginStorage {
    __classType = 'REMOTE_REQUIRED' as const;
    __compatJsonStringifySetItem = true as const;
    __requestAbortMethods = new Set(['getItem', 'setItem', 'removeItem', 'keys', 'clear']);
    // The originating plugin, set when the instance is created via the V3
    // getLocalPluginStorage() API. Used to tag new writes with their origin in
    // the sidecar meta store. Undefined (e.g. when instantiated by the built-in
    // storage viewer) means writes don't touch ownership metadata.
    private owner?: string;
    constructor(owner?: string) {
        this.owner = owner;
    }
    async getItem<T>(key: string, signal?: AbortSignal): Promise<T | null> {
        signal?.throwIfAborted();
        const cacheKey = `safe_plugin_${key}`;
        if (pluginStorage.has(cacheKey)) {
            return snapshotJsonValue(pluginStorage.get(cacheKey)) as T;
        }
        const storageKey = makeEncodedStorageKey(pluginStoragePrefix, key);
        const payload = signal
            ? await readPersistentJson<T>(storageKey, { signal })
            : await readPersistentJson<T>(storageKey);
        if (payload !== null) {
            const snapshot = snapshotJsonValue(payload);
            pluginStorage.set(cacheKey, snapshot);
            return snapshotJsonValue(snapshot) as T;
        }
        return null;
    }
    async setItem<T>(key: string, value: T, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const cacheKey = `safe_plugin_${key}`;
        // Apply the compatibility API's historical JSON.stringify coercions
        // synchronously, then publish the detached value only after persistence
        // succeeds. Rejected writes leave any previous cache entry authoritative
        // and cannot retain a caller-owned alias.
        const snapshot = snapshotLegacyLocalPluginStorageValue(value);
        const storageKey = makeEncodedStorageKey(pluginStoragePrefix, key);
        try {
            if (signal) await writePersistentJson(storageKey, snapshot, signal);
            else await writePersistentJson(storageKey, snapshot);
        } catch (error) {
            if (hasUnknownCommitOutcome(error)) pluginStorage.delete(cacheKey);
            throw error;
        }
        pluginStorage.set(cacheKey, snapshot);
        if (this.owner) await recordOwner('idb', key, this.owner, signal);
    }
    async removeItem(key: string, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const storageKey = makeEncodedStorageKey(pluginStoragePrefix, key);
        try {
            if (signal) await removePersistentKey(storageKey, signal);
            else await removePersistentKey(storageKey);
        } catch (error) {
            if (hasUnknownCommitOutcome(error)) pluginStorage.delete(`safe_plugin_${key}`);
            throw error;
        }
        pluginStorage.delete(`safe_plugin_${key}`);
        if (this.owner) await removeOwner('idb', key, signal);
    }
    async keys(signal?: AbortSignal): Promise<string[]> {
        signal?.throwIfAborted();
        const keys: string[] = [];
        const storageKeys = signal
            ? await listPersistentKeys(pluginStoragePrefix, signal)
            : await listPersistentKeys(pluginStoragePrefix);
        for (const key of storageKeys) {
            const encodedKey = key.slice(pluginStoragePrefix.length, -'.json'.length);
            keys.push(decodeStorageKeyComponent(encodedKey));
        }
        return keys;
    }
    async clear(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        let clearAttempted = false;
        try {
            clearAttempted = true;
            if (signal) await clearPersistentPrefix(pluginStoragePrefix, signal);
            else await clearPersistentPrefix(pluginStoragePrefix);
            clearPluginStorageCache();
            if (this.owner) await clearOwners('idb', signal);
        } catch (error) {
            // Generic prefix clear is sequential, so any attempted failure can
            // follow earlier durable deletions even when the final error is
            // explicitly safe. Never retain ghost entries after a partial run.
            if (clearAttempted) clearPluginStorageCache();
            throw error;
        }
    }
}

export const SafeIdbFactory = {
    databases: async (): Promise<{ name: string; version: number }[]> => {
        if ('databases' in indexedDB) {
            const r = await indexedDB.databases();
            return r.filter(db => db.name && db.name.startsWith('safe_plugin_')).map(db => ({
                name: db.name!.substring('safe_plugin_'.length),
                version: db.version
            }));
        } else {
            return [];
        }
    },
    deleteDatabase: async (name: string): Promise<IDBOpenDBRequest> => {
        return indexedDB.deleteDatabase(`safe_plugin_${name}`);
    },
    open: (name: string, version?: number): IDBOpenDBRequest => {
        return indexedDB.open(`safe_plugin_${name}`, version);
    },
    cmp: (first: string, second: string): number => {
        //well, we don't need to prefix here, as the comparison is the same
        return indexedDB.cmp(first, second);
    }
}

export const tagWhitelist = [
    'a',
    'abbr',
    'acronym',
    'address',
    'area',
    'article',
    'aside',
    'audio',
    'b',
    'bdi',
    'bdo',
    'big',
    'blink',
    'blockquote',
    'body',
    'br',
    'button',
    'canvas',
    'caption',
    'center',
    'cite',
    'code',
    'col',
    'colgroup',
    'content',
    'data',
    'datalist',
    'dd',
    'decorator',
    'del',
    'details',
    'dfn',
    'dialog',
    'dir',
    'div',
    'dl',
    'dt',
    'element',
    'em',
    'fieldset',
    'figcaption',
    'figure',
    'font',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'head',
    'header',
    'hgroup',
    'hr',
    'html',
    'i',
    'img',
    'input',
    'ins',
    'kbd',
    'label',
    'legend',
    'li',
    'main',
    'map',
    'mark',
    'marquee',
    'menu',
    'menuitem',
    'meter',
    'nav',
    'nobr',
    'ol',
    'optgroup',
    'option',
    'output',
    'p',
    'picture',
    'pre',
    'progress',
    'q',
    'rp',
    'rt',
    'ruby',
    's',
    'samp',
    'search',
    'section',
    'select',
    'shadow',
    'slot',
    'small',
    'source',
    'spacer',
    'span',
    'strike',
    'strong',
    'style',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'template',
    'textarea',
    'tfoot',
    'th',
    'thead',
    'time',
    'tr',
    'track',
    'tt',
    'u',
    'ul',
    'var',
    'video',
    'wbr',
    'svg',
    'a',
    'altglyph',
    'altglyphdef',
    'altglyphitem',
    'animatecolor',
    'animatemotion',
    'animatetransform',
    'circle',
    'clippath',
    'defs',
    'desc',
    'ellipse',
    'enterkeyhint',
    'exportparts',
    'filter',
    'font',
    'g',
    'glyph',
    'glyphref',
    'hkern',
    'image',
    'inputmode',
    'line',
    'lineargradient',
    'marker',
    'mask',
    'metadata',
    'mpath',
    'part',
    'path',
    'pattern',
    'polygon',
    'polyline',
    'radialgradient',
    'rect',
    'stop',
    'style',
    'switch',
    'symbol',
    'text',
    'textpath',
    'title',
    'tref',
    'tspan',
    'view',
    'vkern',
];

const restrictElement = <T extends Node>(element: T): T => {
    //since we already trimed out, just return the element
    return element;
}

const restrictNodeList = <T extends Element, Q extends NodeListOf<T>|HTMLCollectionOf<T> >(nodeList: Q): Q => {
    return nodeList;
}

export const SafeDocument = {
    body: document.body,
    characterSet: document.characterSet,
    doctype: document.doctype,
    documentElement: document.documentElement,
    documentURI: document.documentURI,
    location: document.location,
    readyState: document.readyState,
    title: document.title,
    head: document.head,
    createElement: (tagName: string): HTMLElement => {
        console.log('Creating element:', tagName);
        tagName = tagName.toLowerCase().trim();
        if (!tagWhitelist.includes(tagName.toLowerCase())) {
            throw new Error(`Creation of <${tagName}> elements is not allowed in plugin context.`);
        }
        if(tagName.toLowerCase() === 'a'){
            console.error(`
                Creation of <a> elements is restricted. due to potential security risks. Creating a <div> instead.
                Use document.createAnchorElement(href: string) from the plugin API to create safe anchor elements.
            `);
            return restrictElement(document.createElement('div')) as HTMLElement;
        }
        return restrictElement(document.createElement(tagName));
    },
    createTextNode: (data: string): Text => {
        return restrictElement(document.createTextNode(data));
    },
    createElementNS: (namespaceURI: string, qualifiedName: string): Element => {
        console.log('Creating namespaced element:', qualifiedName);
        qualifiedName = qualifiedName.toLowerCase().trim();
        if (!tagWhitelist.includes(qualifiedName.toLowerCase())) {
            throw new Error(`Creation of <${qualifiedName}> elements is not allowed in plugin context.`);
        }
        if(qualifiedName.toLowerCase() === 'a'){
            console.error(`
                Creation of <a> elements is restricted. due to potential security risks. Creating a <div> instead.
                Use document.createAnchorElement(href: string) from the plugin API to create safe anchor elements.
            `);
            return restrictElement(document.createElementNS(namespaceURI, 'div'));
        }
        return restrictElement(document.createElementNS(namespaceURI, qualifiedName));
    },
    createAnchorElement: (href: string): HTMLAnchorElement => {
        const anchor = document.createElement('a');

        try {
            const hrefURL = new URL(href, document.baseURI);
            if(hrefURL.protocol !== 'http:' && hrefURL.protocol !== 'https:'){
                throw new Error(`Only http and https links are allowed for anchor elements in plugin context.`);
            }
            new URL(href);
        } catch {
            throw new Error(`Invalid URL provided for anchor element in plugin context.`);
        }

        anchor.href = href;
        return toGetter(() => anchor, {
            restrictChildren: [
                'ownerDocument',
                'href',
                'download',
                'hash',
                'host',
                'hostname',
                'hreflang',
                'origin',
                'password',
                'pathname',
                'ping',
                'port',
                'protocol',
                'referrerPolicy',
                'rel',
                'relList',
                'search',
                'target',
                'text',
                'type',
                'username'
            ]
        }) as HTMLAnchorElement;
    },

    //add safe methods as needed
    createRange: (): Range => {
        return (document.createRange());
    },
    createDocumentFragment: (): DocumentFragment => {
        return restrictElement(document.createDocumentFragment());
    },
    querySelector: (selectors: string): Element | null => {
        return restrictElement(document.querySelector(selectors));
    },
    querySelectorAll: (selectors: string): NodeListOf<Element> => {
        return restrictNodeList(document.querySelectorAll(selectors));
    },
    getElementById: (elementId: string): HTMLElement | null => {
        return restrictElement(document.getElementById(elementId));
    },
    getElementsByClassName: (classNames: string): HTMLCollectionOf<Element> => {
        return restrictNodeList(document.getElementsByClassName(classNames))
    },
    getElementsByTagName: (qualifiedName: string): HTMLCollectionOf<Element> => {
        return restrictNodeList(document.getElementsByTagName(qualifiedName));
    },
    getElementsByName: (elementName: string): NodeListOf<Element> => {
        return restrictNodeList(document.getElementsByName(elementName));
    },
    createComment: (data: string): Comment => {
        return restrictElement(document.createComment(data));
    },
    elementFromPoint: (x: number, y: number): Element | null => {
        return restrictElement(document.elementFromPoint(x, y));
    },
    elementsFromPoint: (x: number, y: number): Element[] => {
        return document.elementsFromPoint(x, y).map(el => restrictElement(el));
    },
    hasFocus: (): boolean => {
        return document.hasFocus();
    },
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void => {
        const allowedEvents = ['click', 'keydown', 'keyup', 'input', 'change', 'submit', 'focus', 'blur', 'mouseover', 'mouseout', 'mousemove', 'mousedown', 'mouseup'];
        if(!allowedEvents.includes(type)) {
            console.warn(`Event type '${type}' is not allowed in plugin context.`);
            return;
        }
        document.addEventListener(type, listener, options);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void => {
        const allowedEvents = ['click', 'keydown', 'keyup', 'input', 'change', 'submit', 'focus', 'blur', 'mouseover', 'mouseout', 'mousemove', 'mousedown', 'mouseup'];
        if(!allowedEvents.includes(type)) {
            console.warn(`Event type '${type}' is not allowed in plugin context.`);
            return;
        }
        document.removeEventListener(type, listener, options);
    }
}
