import { allowedDbKeys, customProviderStore, getV2PluginAPIs, handlePluginInstallViaPlugin, pluginV2, type EditFunction, type PluginV2ProviderArgument, type PluginV2ProviderOptions, type RisuPlugin } from "../plugins.svelte";
import { SandboxHost } from "./factory";
import {
    getDatabase,
    normalizeChat,
    setDatabase as setDatabaseState,
} from "src/ts/storage/database.svelte";
import { cloneDatabaseField } from "src/ts/storage/databaseClone";
import { SafeLocalPluginStorage, tagWhitelist } from "../pluginSafeClass";
import { recordOwner, removeOwner, clearOwners } from "../pluginStorageMeta";
import {
    clearOwnedPluginSaveStorage,
    atomicBatchOwnedPluginSaveStorage,
    rewriteOwnedPluginSaveStorageItem,
    getPluginSaveStorageItem,
    getPluginSaveStorageItemWithRevision,
    readPluginSaveStorageItemResult,
    getPluginSaveStorageKey,
    getPluginSaveStorageKeys,
    getPluginSaveStorageLength,
    getPluginSaveStorageSnapshot,
    removeOwnedPluginSaveStorageItem,
    setOwnedPluginSaveStorageItemFromRead,
    removeOwnedPluginSaveStorageItemConfirmed,
    removeOwnedPluginSaveStorageItemWithOutcome,
    setOwnedPluginSaveStorageItem,
    setOwnedPluginSaveStorageItemWithOutcome,
    updateDatabaseWithPluginStorageSnapshot,
} from "../pluginSaveStorage";
import { createPluginDatabaseBridge } from "./pluginDatabaseBridge";
import { disableEnabledLegacyPluginsForOptimizedMemory } from "../pluginMemoryOptimization";
import DOMPurify from 'dompurify';
import { additionalChatMenu, additionalFloatingActionButtons, additionalHamburgerMenu, additionalSettingsMenu, bodyIntercepterStore, chatPanelStore, DBState, selectedCharID, type MenuDef } from "src/ts/stores.svelte";
import { v4 } from "uuid";
import { sleep } from "src/ts/util";
import { alertConfirm, alertError, alertNormal, notifyError, notifyWarning } from "src/ts/alert";
import { language } from "src/lang";
import { checkCharOrder, forageStorage, getFetchLogs } from "src/ts/globalApi.svelte";
import { changeColorScheme, updateColorScheme, updateTextThemeAndCSS, type ColorScheme } from "src/ts/gui/colorscheme";
import { get } from "svelte/store";
import { registerMCPModule, registeredCustomPluginMCPs, unregisterMCPModule } from "src/ts/process/mcp/pluginmcp";
import { getLLMCache, searchLLMCache } from "src/ts/translator/translator";
import { hasher } from "src/ts/parser/parser.svelte";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from "src/ts/model/types";
import { readPersistentJson, removePersistentKey, writePersistentJson } from "src/ts/storage/persistentKv";
import { awaitWithAbort, forwardAbortSignal, throwIfAborted } from "src/ts/storage/abort";
import { sendChat as processSendChat, doingChat } from "src/ts/process/index.svelte";
import { getModelInfo } from "src/ts/model/modellist";
import type { ModelModeExtended } from "src/ts/process/request/shared";
import { requestChatDataMain } from "src/ts/process/request/request";
import type { OpenAIChat } from "src/ts/process/index.svelte";
import {
    PluginStorageUpdateCoordinator,
    type PluginStorageUpdateOptions,
    type PluginStorageUpdateTransform,
} from "./pluginStorageUpdate";
import { getModuleLorebooks } from "src/ts/process/modules";
import {
    registerTTSPreprocessor,
    unregisterTTSPreprocessor,
    registerTTSPostprocessor,
    unregisterTTSPostprocessor,
    type BeforeTTSContext,
    type BeforeTTSResult,
    type AfterTTSContext,
    type AfterTTSResult,
    type TTSHookFn,
} from "src/ts/process/ttsHooks";

/*
    V3 API for RisuAI Plugins

    Before adding new APIs here, please check the limitations

    - APIs must be a functions
        - If you want nested objects, first add as a plain function, `_getPluginStorage` for example
            And add it too _getAliases function ({'pluginStorage':{'getItem': '_getPluginStorage', ... }})
            This will make pluginStorage.getItem() work in plugins
        - If you need constants, use _getPropertiesForInitialization to set them up
            For example apiVersion and apiVersionCompatibleWith are set this way,
            Accessable in plugins as risuai.apiVersion
    - APIs must return, or accept as parameters, only the following types:
        - Serializable data (string, number, boolean, null, array, object)
        - Class instances marked with __classType = 'REMOTE_REQUIRED'
        - Callback functions (only as parameters)
        - Note that Class or Callbacks inside arrays or objects are not supported
*/

export const pluginChannel = new Map<string, Function>();

type V3LifecycleCallback = (signal?: AbortSignal) => void | Promise<void>;
type V3ScriptMode = 'input' | 'output' | 'process' | 'display';

class V3PluginLifecycleScope {
    private state: 'initializing' | 'ready' | 'terminating' | 'terminated' = 'initializing';
    private cleanupCallbacks: V3LifecycleCallback[] = [];
    private unloadCallbacks: V3LifecycleCallback[] = [];
    private postUnloadDrains: Array<() => void | Promise<void>> = [];

    constructor(private pluginName: string) {}

    assertCanRegister() {
        if (this.state === 'terminating' || this.state === 'terminated') {
            throw new Error(`Plugin ${this.pluginName} is terminating; registrations are closed.`);
        }
    }

    canInvokeCallbacks() {
        return this.state !== 'terminating' && this.state !== 'terminated';
    }

    assertCanInvokeCallbacks() {
        if (!this.canInvokeCallbacks()) {
            throw new Error(`Plugin ${this.pluginName} is terminating; callback invocation was rejected.`);
        }
    }

    addCleanup(callback: V3LifecycleCallback) {
        this.assertCanRegister();
        this.cleanupCallbacks.push(callback);
    }

    addUnload(callback: V3LifecycleCallback) {
        this.assertCanRegister();
        this.unloadCallbacks.push(callback);
    }

    addPostUnloadDrain(callback: () => void | Promise<void>) {
        this.assertCanRegister();
        this.postUnloadDrains.push(callback);
    }

    markReady() {
        if (this.state !== 'initializing') return false;
        this.state = 'ready';
        return true;
    }

    beginTermination() {
        if (this.state === 'terminating' || this.state === 'terminated') return false;
        this.state = 'terminating';
        return true;
    }

    async runUnloadCallbacks(host: SandboxHost, timeoutMs = 1000): Promise<unknown[]> {
        const callbacks = this.unloadCallbacks.splice(0);
        if (callbacks.length === 0) {
            await host.drainUnloadStorageMutations();
            return [];
        }
        const controller = new AbortController();
        host.beginUnloadStorageAdmission();
        const completion = Promise.allSettled(callbacks.map(callback =>
            Promise.resolve().then(() => host.invokeUnloadCallback(callback, controller.signal)),
        ));
        const timeout = 'timeout' as const;
        let result: PromiseSettledResult<void>[] | typeof timeout = await Promise.race([
            completion,
            sleep(timeoutMs).then(() => timeout),
        ]);
        host.endUnloadStorageAdmission();

        if (result === timeout) {
            // Stop callback code from preparing later work. Storage mutations
            // accepted before this boundary remain alive and are drained below.
            controller.abort(new DOMException(
                `Plugin ${this.pluginName} unload grace period expired.`,
                'AbortError',
            ));
        }
        await host.drainUnloadStorageMutations();

        if (result === timeout) {
            result = await Promise.race([
                completion,
                sleep(100).then(() => timeout),
            ]);
        }
        if (result === timeout) {
            const error = new Error(
                `Plugin ${this.pluginName} unload did not finish after admitted storage drained.`,
            ) as Error & Record<string, unknown>;
            error.name = 'PluginUnloadIncompleteError';
            error.code = 'PLUGIN_UNLOAD_INCOMPLETE';
            error.retryable = false;
            error.commitOutcomeUnknown = false;
            error.operation = 'unload';
            return [error];
        }
        return result
            .filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
            .map(entry => entry.reason);
    }

    async cleanup(): Promise<unknown[]> {
        const callbacks = this.cleanupCallbacks.splice(0).reverse();
        const errors: unknown[] = [];
        for (const callback of callbacks) {
            try {
                await callback();
            } catch (error) {
                errors.push(error);
            }
        }
        this.state = 'terminated';
        return errors;
    }

    async drainPostUnloadWork(): Promise<unknown[]> {
        const drains = this.postUnloadDrains.splice(0);
        const results = await Promise.allSettled(drains.map(drain => drain()));
        return results
            .filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
            .map(entry => entry.reason);
    }
}

class SafeElement {
    #element: HTMLElement;
    #lifecycle?: V3PluginLifecycleScope;
    __classType = 'REMOTE_REQUIRED' as const;

    constructor(element: HTMLElement, lifecycle?: V3PluginLifecycleScope) {
        if(element.getAttribute('freezed')){
            throw new Error("This element cannot be accessed by SafeELement")
        }
        this.#element = element;
        this.#lifecycle = lifecycle;
    }

    public appendChild(child: SafeElement) {
        this.#element.appendChild(child.#element);
    }

    public removeChild(child: SafeElement) {
        this.#element.removeChild(child.#element);
    }

    public replaceChild(newChild: SafeElement, oldChild: SafeElement) {
        this.#element.replaceChild(newChild.#element, oldChild.#element);
    }

    public replaceWith(newElement: SafeElement) {
        this.#element.replaceWith(newElement.#element);
    }

    public cloneNode(deep: boolean = false): SafeElement {
        const cloned = this.#element.cloneNode(deep);
        return new SafeElement(cloned as HTMLElement, this.#lifecycle);
    }

    public prepend(child: SafeElement) {
        this.#element.prepend(child.#element);
    }

    public remove() {
        this.#element.remove();
    }

    public innerText(): string {
        return this.#element.innerText;
    }

    public textContent(): string | null {
        return this.#element.textContent;
    }

    public setTextContent(value: string) {
        this.#element.textContent = value;
    }

    public setInnerText(value: string) {
        this.#element.innerText = value;
    }


    public setAttribute(name: string, value: string) {
        if(!name.startsWith('x-')){
            throw new Error("Can only set attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.");
        }
        this.#element.setAttribute(name, value);
    }
    public getAttribute(name: string): string | null {
        if(!name.startsWith('x-')){
            throw new Error("Can only get attributes starting with 'x-' for security reasons. for other attributes, use dedicated methods.");
        }
        return this.#element.getAttribute(name);
    }
    public setStyle(property: string, value: string) {
        (this.#element.style as any)[property] = value;
    }
    public getStyle(property: string): string {
        return (this.#element.style as any)[property];
    }
    public getStyleAttribute(): string {
        return this.#element.getAttribute('style') || '';
    }
    public setStyleAttribute(value: string) {
        this.#element.setAttribute('style', value);
    }
    public addClass(className: string) {
        // 
        this.#element.classList.add(className);
    }
    public removeClass(className: string) {
        // 
        this.#element.classList.remove(className);
    }
    public setClassName(className: string){
        this.#element.className = className
    }
    public getClassName(){
        return this.#element.className
    }
    public hasClass(className: string): boolean {
        //We don't need to check the className here since we're just checking
        return this.#element.classList.contains(className);
    }
    public focus() {
        this.#element.focus();
    }
    public getChildren(): SafeClassArray<SafeElement> {
        const children: SafeElement[] = [];
        this.#element.childNodes.forEach(node => {
            if(node instanceof HTMLElement) {
                children.push(new SafeElement(node, this.#lifecycle));
            }
        });
        return new SafeClassArray<SafeElement>(children);
    }
    public getParent(): SafeElement | null {
        if(this.#element.parentElement) {
            return new SafeElement(this.#element.parentElement, this.#lifecycle);
        }
        return null;
    }
    public getInnerHTML(): string {
        return this.#element.innerHTML;
    }
    public getOuterHTML(): string {
        return this.#element.outerHTML;
    }
    public clientHeight(): number {
        return this.#element.clientHeight;
    }
    public clientWidth(): number {
        return this.#element.clientWidth;
    }
    public clientTop(): number {
        return this.#element.clientTop;
    }
    public clientLeft(): number {
        return this.#element.clientLeft;
    }
    public nodeName(): string {
        return this.#element.nodeName;
    }
    public nodeType(): number {
        return this.#element.nodeType;
    }
    public querySelectorAll(selector: string): SafeClassArray<SafeElement> {
        const nodeList = this.#element.querySelectorAll(selector);
        const elements: SafeElement[] = [];
        nodeList.forEach(node => {
            if(node instanceof HTMLElement) {
                elements.push(new SafeElement(node, this.#lifecycle));
            }
        });
        return new SafeClassArray<SafeElement>(elements);
    }
    public querySelector(selector: string): SafeElement | null {
        const element = this.#element.querySelector(selector);
        if(element instanceof HTMLElement) {
            return new SafeElement(element, this.#lifecycle);
        }
        return null;
    }
    public getElementById(id: string): SafeElement | null {
        const element = this.querySelector('#' + id);
        return element;
    }
    public getElementsByClassName(className: string): SafeClassArray<SafeElement> {
        return this.querySelectorAll('.' + className);
    }
    public getClientRects(): DOMRectList {
        return this.#element.getClientRects();
    }
    public getBoundingClientRect(): DOMRect {
        return this.#element.getBoundingClientRect();
    }
    public setInnerHTML(value: string) {
        const san = DOMPurify.sanitize(value);
        this.#element.innerHTML = san;
    }
    public setOuterHTML(value: string) {
        const san = DOMPurify.sanitize(value);
        this.#element.outerHTML = san;
    }
    public scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
        this.#element.scrollIntoView(options);
    }
    #eventIdMap = new Map<string, {
        type: string;
        listener: EventListener;
        options: AddEventListenerOptions;
    }>()

    public async addEventListener(type:string, listener: (event: any) => void, options?: boolean | AddEventListenerOptions):Promise<string> {
        this.#lifecycle?.assertCanRegister();
        const realOptions = typeof options === 'boolean' ? { capture: options } : options || {};

        //allowed with unlimited
        const allowedDocumentEventListeners = [
            'click',
            'dblclick',
            'contextmenu',
            'mousedown',
            'mouseup',
            'mousemove',
            'mouseover',
            'mouseleave',
            'pointercancel',
            'pointerdown',
            'pointerenter',
            'pointerleave',
            'pointermove',
            'pointerout',
            'pointerover',
            'pointerup',
            'scroll',
            'scrollend'
        ]

        //allowed, but it has fingerprinting issues,
        //so it will be delayed random ms.
        const allowedDelayedEventListeners = [
            'keydown',
            'keyup',
            'keypress'
        ]

        const id = v4()

        const trimEvent = (event: MouseEvent | KeyboardEvent | Event) => {
            if(event instanceof MouseEvent){
                return {
                    type: event.type,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    button: event.button,
                    buttons: event.buttons,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                }
            }
            else if(event instanceof KeyboardEvent){
                return {
                    type: event.type,
                    key: event.key,
                    code: event.code,
                    repeat: event.repeat,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                }
            }
            else{
                return {
                    type: event.type
                }
            }

        }

        if(allowedDocumentEventListeners.includes(type)){
            const modifiedListener = (event: any) => {
                if (this.#lifecycle && !this.#lifecycle.canInvokeCallbacks()) return;
                listener(trimEvent(event))
            }
            this.#eventIdMap.set(id, { type, listener: modifiedListener, options: realOptions })
            document.addEventListener(type, modifiedListener, realOptions)
            this.#lifecycle?.addCleanup(() => this.removeEventListener(type, id, realOptions))
            return id;
        }
        else if(allowedDelayedEventListeners.includes(type)){
            const modifiedListener = (event: any) => {
                if (this.#lifecycle && !this.#lifecycle.canInvokeCallbacks()) return;
                let delay = 0;
                try {
                    delay = (crypto.getRandomValues(new Uint32Array(1))[0] / 100) % 100; //0-99 ms              
                } catch (error) {}
                setTimeout(() => {
                    if (this.#lifecycle && !this.#lifecycle.canInvokeCallbacks()) return;
                    listener(trimEvent(event));
                }, delay);
            }
            this.#eventIdMap.set(id, { type, listener: modifiedListener, options: realOptions })
            document.addEventListener(type, modifiedListener, realOptions);
            this.#lifecycle?.addCleanup(() => this.removeEventListener(type, id, realOptions))
            return id;
        }
        else{
            throw new Error(`Event listener of type '${type}' is not allowed for security reasons.`);
        }        
    }

    public removeEventListener(type:string, id:string, options?: boolean | EventListenerOptions) {
        const registration = this.#eventIdMap.get(id);
        if(registration){
            const realOptions = typeof options === 'boolean' ? { capture: options } : options || {};
            document.removeEventListener(
                registration.type,
                registration.listener,
                options === undefined ? registration.options : realOptions,
            );
            this.#eventIdMap.delete(id);
        }
    }

    public matches (selector: string): boolean {
        return this.#element.matches(selector);
    }
}

class SafeDocument extends SafeElement {
    __classType = 'REMOTE_REQUIRED' as const;
    #lifecycle?: V3PluginLifecycleScope;
    constructor(document: Document, lifecycle?: V3PluginLifecycleScope) {
        super(document.documentElement, lifecycle);
        this.#lifecycle = lifecycle;
    }
    createElement(tagName: string): SafeElement {
        if(!tagWhitelist.includes(tagName.toLowerCase())) {
            console.warn(`Creation of <${tagName}> elements is restricted. Creating a <div> instead.`);
            tagName = 'div';
        }
        if(tagName.toLowerCase() === 'a'){
            console.warn(`<a> can be created but href attribute cannot be set directly for security reasons. Use .createAnchorElement(href: string) to create safe anchor elements.`);
        }
        const element = document.createElement(tagName);
        return new SafeElement(element, this.#lifecycle);
    }
    createAnchorElement(href: string): SafeElement {
        const anchor = document.createElement('a');
        try {
            const url = new URL(href);
            if(url.protocol !== 'http:' && url.protocol !== 'https:'){
                throw new Error("Invalid protocol");
            }
            anchor.setAttribute('href', url.toString());
        } catch (error) {
            console.warn(`Invalid URL provided for anchor element: ${href}. Setting href to '#' instead.`);
            anchor.setAttribute('href', '#');
        }
        return new SafeElement(anchor, this.#lifecycle);
    }
}

type SafeMutationRecordObject = {
    type: string;
    target: SafeElement;
    addedNodes: SafeElement[];
}

class SafeClassArray<T> {
    #items: T[];
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(items: T[] = []) {
        this.#items = items;
    }
    at(index: number): T {
        return this.#items.at(index);
    }
    length(): number {
        return this.#items.length;
    }
    push(item: T) {
        this.#items.push(item);
    }
}

class SafeMutationRecord{
    __classType = 'REMOTE_REQUIRED' as const;
    #type: string;
    #target: SafeElement;
    #addedNodes: SafeClassArray<SafeElement>;
    constructor(type: string, target: SafeElement, addedNodes: SafeElement[]) {
        this.#type = type;
        this.#target = target;
        this.#addedNodes = new SafeClassArray<SafeElement>(addedNodes);
    }
    getType(): string {
        return this.#type;
    }
    getTarget(): SafeElement {
        return this.#target;
    }
    getAddedNodes(): SafeClassArray<SafeElement> {
        return this.#addedNodes;
    }
}

type SafeMutationCallback = (mutations: SafeClassArray<SafeMutationRecord>) => void;

class SafeMutationObserver {
    #observer: MutationObserver;
    #lifecycle?: V3PluginLifecycleScope;
    __classType = 'REMOTE_REQUIRED' as const;
    constructor(callback: SafeMutationCallback, lifecycle?: V3PluginLifecycleScope) {
        this.#lifecycle = lifecycle;
        this.#observer = new MutationObserver((mutations) => {
            if (this.#lifecycle && !this.#lifecycle.canInvokeCallbacks()) return;
            const safeMutations: SafeMutationRecordObject[] = mutations.map(mutation => {

                const elementMapHelper = (nodeList: NodeList): SafeElement[] => {
                    const elements: SafeElement[] = [];
                    nodeList.forEach(node => {
                        if(node instanceof HTMLElement) {
                            elements.push(new SafeElement(node, this.#lifecycle));
                        }
                    })
                    return elements;
                }

                return {
                    type: mutation.type,
                    target: new SafeElement(mutation.target as HTMLElement, this.#lifecycle),
                    addedNodes: elementMapHelper(mutation.addedNodes),
                    removedNodes: elementMapHelper(mutation.removedNodes)
                    
                }
            })

            const safeClassed = new SafeClassArray<SafeMutationRecord>([]);
            for(const record of safeMutations){
                safeClassed.push(new SafeMutationRecord(
                    record.type,
                    record.target,
                    record.addedNodes
                ));
            }
            callback(safeClassed);
        });
    }

    observe(element:SafeElement, options: MutationObserverInit) {
        this.#lifecycle?.assertCanRegister();
        const identifier = v4();
        element.setAttribute('x-identifier', identifier);
        const rawElement = document.querySelector(`[x-identifier="${identifier}"]`) as HTMLElement;
        if(rawElement){
            this.#observer.observe(rawElement, options);
            element.setAttribute('x-identifier', '');
        }
    }

    disconnect() {
        this.#observer.disconnect();
    }

}

const makeMenuUnloadCallback = (menuDef: MenuDef, menuStore: MenuDef[]) =>{
    return () => {
        const index = menuStore.indexOf(menuDef);
        if(index !== -1){
            menuStore.splice(index, 1);
        }
    }
}

const removeChatPanel = (id: string) => {
    const index = chatPanelStore.findIndex(item => item.id === id);
    if(index !== -1){
        chatPanelStore.splice(index, 1);
    }
}

const unloadV3PluginInstance = async (instance: V3PluginInstance) => {
    if (!instance.teardown) {
        instance.teardown = (async () => {
            const index = v3PluginInstances.indexOf(instance);
            if (index !== -1) v3PluginInstances.splice(index, 1);

            // Close all registration/RPC surfaces first. The captured onUnload
            // callbacks may finish local guest work during their bounded grace
            // period, but cannot mutate host state or resurrect the generation.
            instance.scope.beginTermination();
            instance.host.beginTermination();

            const errors: unknown[] = [];
            try {
                // Remove every globally reachable callback/registration first.
                // Only the separately captured onUnload callbacks remain
                // authorized during the bounded guest grace period.
                errors.push(...await instance.scope.cleanup());
            } finally {
                try {
                    errors.push(...await instance.scope.runUnloadCallbacks(instance.host));
                } finally {
                    try {
                        // onUnload may admit a storage CAS after ordinary
                        // cleanup has run. Keep the sandbox alive until every
                        // such non-cancellable publication has acknowledged.
                        errors.push(...await instance.scope.drainPostUnloadWork());
                    } finally {
                        instance.host.terminate();
                    }
                }
            }

            if (errors.length > 0) {
                throw new AggregateError(errors, `Plugin ${instance.name} teardown failed.`);
            }
        })();
    }
    await instance.teardown;
}

const unloadV3Plugin = async (pluginName: string) => {
    const instance = v3PluginInstances.find(p => p.name === pluginName);
    if (instance) await unloadV3PluginInstance(instance);
}

export type PluginPermissionDesc = 'fetchLogs'|'db'|'mainDom'|'replacer'|'provider'|'sendChat';
export type PluginPermissionDecision = 'granted'|'revoked'|'ask';
export const pluginPermissionDescs: readonly PluginPermissionDesc[] = ['fetchLogs', 'db', 'mainDom', 'replacer', 'provider', 'sendChat'];

// Plugin names are free text (the //@name directive), so `${name}_${desc}` keys
// can collide — both across permissions and with a legacy name-only entry that
// happens to read like "name_desc". JSON-encoding the pair makes every key
// unambiguous: ["foo","db"] can never equal a plain "foo_db" or ["foo_db","x"].
const permissionKeyOf = (pluginName: string, permissionDesc: string) =>
    JSON.stringify([pluginName, permissionDesc])

const permissionGivenPlugins: Set<string> = new Set();
const permissionDeniedPlugins: Set<string> = new Set();
const permissionCache = new Map<string, boolean | number>();
const pluginPermissionStateKey = 'cache/plugin-permissions/state.json';
let pluginPermissionLoadPromise: Promise<void> | null = null;
let pluginPermissionLoadController: AbortController | null = null;
let pluginPermissionMutationChain: Promise<unknown> = Promise.resolve();

async function ensurePluginPermissionStateLoaded(signal?: AbortSignal | null) {
    throwIfAborted(signal)
    if (!pluginPermissionLoadPromise) {
        const controller = new AbortController()
        const created = (async () => {
            const payload = await readPersistentJson<{
                given: string[]
                denied: string[]
                cache: [string, boolean | number][]
            }>(pluginPermissionStateKey, { signal: controller.signal })
            throwIfAborted(controller.signal)
            if (!payload) {
                return
            }
            permissionGivenPlugins.clear()
            permissionDeniedPlugins.clear()
            permissionCache.clear()
            for (const pluginName of payload.given ?? []) {
                permissionGivenPlugins.add(pluginName)
            }
            for (const pluginName of payload.denied ?? []) {
                permissionDeniedPlugins.add(pluginName)
            }
            for (const [key, value] of payload.cache ?? []) {
                permissionCache.set(key, value)
            }
        })()
        pluginPermissionLoadPromise = created
        pluginPermissionLoadController = controller
        void created.then(
            () => {
                if (pluginPermissionLoadPromise === created) {
                    pluginPermissionLoadController = null
                }
            },
            () => {
                if (pluginPermissionLoadPromise === created) {
                    pluginPermissionLoadPromise = null
                    pluginPermissionLoadController = null
                }
            },
        )
    }
    const activePromise = pluginPermissionLoadPromise
    const activeController = pluginPermissionLoadController
    const stopForwardingAbort = activeController
        ? forwardAbortSignal(signal, activeController)
        : () => undefined
    const evictOnAbort = () => {
        if (pluginPermissionLoadPromise === activePromise) {
            pluginPermissionLoadPromise = null
            pluginPermissionLoadController = null
        }
    }
    signal?.addEventListener("abort", evictOnAbort, { once: true })
    try {
        await awaitWithAbort(activePromise, signal)
    } finally {
        stopForwardingAbort()
        signal?.removeEventListener("abort", evictOnAbort)
    }
}

export async function resetAllPluginPermissions() {
    pluginPermissionLoadController?.abort()
    pluginPermissionLoadController = null
    permissionGivenPlugins.clear()
    permissionDeniedPlugins.clear()
    permissionCache.clear()
    pluginPermissionLoadPromise = Promise.resolve()
    await removePersistentKey(pluginPermissionStateKey)
}

export async function resetPluginPermission(pluginName: string) {
    await ensurePluginPermissionStateLoaded()
    // Permission descs are a fixed enum, so we delete the exact key for each
    // one rather than prefix-matching (which would also wipe another plugin's
    // keys). `pluginName` alone covers legacy name-only entries from older
    // versions, which JSON keys never collide with but reset should still clear.
    const exactKeys = pluginPermissionDescs.map(desc => permissionKeyOf(pluginName, desc))
    for (const key of [pluginName, ...exactKeys]) {
        permissionGivenPlugins.delete(key)
        permissionDeniedPlugins.delete(key)
    }
    for (const desc of pluginPermissionDescs) {
        permissionCache.delete(permissionKeyOf(pluginName, desc) + '_lastGrantTime')
    }
    const plugin = DBState.db.plugins?.find(p => p.name === pluginName)
    if (plugin?.script) {
        const scriptHashBase = await hasher(new TextEncoder().encode(plugin.script))
        for (const key of [...permissionCache.keys()]) {
            if (key.startsWith(scriptHashBase + '_')) {
                permissionCache.delete(key)
            }
        }
    }
    await persistPluginPermissionState()
}

export async function getPluginPermissionDecisions(
    pluginName: string,
): Promise<Record<PluginPermissionDesc, PluginPermissionDecision>> {
    await ensurePluginPermissionStateLoaded()
    return Object.fromEntries(pluginPermissionDescs.map((desc) => {
        const permissionKey = permissionKeyOf(pluginName, desc)
        const decision: PluginPermissionDecision = permissionDeniedPlugins.has(permissionKey)
            ? 'revoked'
            : permissionGivenPlugins.has(permissionKey)
                ? 'granted'
                : 'ask'
        return [desc, decision]
    })) as Record<PluginPermissionDesc, PluginPermissionDecision>
}

export function setPluginPermissionDecision(
    pluginName: string,
    permissionDesc: PluginPermissionDesc,
    decision: Exclude<PluginPermissionDecision, 'ask'>,
) {
    const run = pluginPermissionMutationChain.catch(() => {}).then(async () => {
        await ensurePluginPermissionStateLoaded()
        const permissionKey = permissionKeyOf(pluginName, permissionDesc)
        const lastGrantTimeKey = permissionKey + '_lastGrantTime'
        const previous = {
            given: permissionGivenPlugins.has(permissionKey),
            denied: permissionDeniedPlugins.has(permissionKey),
            lastGrantTime: permissionCache.get(lastGrantTimeKey),
        }

        if (decision === 'granted') {
            permissionGivenPlugins.add(permissionKey)
            permissionDeniedPlugins.delete(permissionKey)
            // Periodically reconfirmed permissions should respect a grant made
            // here instead of immediately opening another prompt.
            permissionCache.set(lastGrantTimeKey, Date.now())
        } else {
            permissionGivenPlugins.delete(permissionKey)
            permissionDeniedPlugins.add(permissionKey)
            permissionCache.delete(lastGrantTimeKey)
        }

        try {
            await persistPluginPermissionState()
        } catch (error) {
            if (previous.given) permissionGivenPlugins.add(permissionKey)
            else permissionGivenPlugins.delete(permissionKey)
            if (previous.denied) permissionDeniedPlugins.add(permissionKey)
            else permissionDeniedPlugins.delete(permissionKey)
            if (previous.lastGrantTime === undefined) permissionCache.delete(lastGrantTimeKey)
            else permissionCache.set(lastGrantTimeKey, previous.lastGrantTime)
            throw error
        }
    })
    pluginPermissionMutationChain = run.catch(() => {})
    return run
}

async function persistPluginPermissionState(signal?: AbortSignal | null) {
    const state = {
        given: [...permissionGivenPlugins],
        denied: [...permissionDeniedPlugins],
        cache: [...permissionCache.entries()]
    }
    if (signal) await writePersistentJson(pluginPermissionStateKey, state, signal)
    else await writePersistentJson(pluginPermissionStateKey, state)
}

type PluginV3ProviderOptions = PluginV2ProviderOptions & {
    model?: LLMModel
}

export const customV3ProviderMetaStore:LLMModel[] = []

// Serializes permission dialogs. Every plugin shares the single global
// alertStore, so when several plugins request permission at boot they would
// otherwise overwrite each other's dialog — only the last one stays clickable
// and a single click resolves all of them. The chain makes each dialog wait
// for the previous one to finish, showing them one at a time.
let pluginPermissionDialogChain: Promise<unknown> = Promise.resolve()

const isPermissionResolved = async (
    pluginName: string,
    permissionDesc: PluginPermissionDesc,
    requiresReconfirm: boolean,
    signal?: AbortSignal | null,
): Promise<{ resolved: boolean; value: boolean; pluginHash: string }> => {
    throwIfAborted(signal)
    const permissionKey = permissionKeyOf(pluginName, permissionDesc);
    // A revoked permission stays blocked until the user grants or resets it.
    // Periodic reconfirmation only applies to grants; otherwise a denied
    // periodic permission would immediately prompt again on every use.
    if (permissionDeniedPlugins.has(permissionKey)) {
        return { resolved: true, value: false, pluginHash: '' }
    }
    if (!requiresReconfirm && permissionGivenPlugins.has(permissionKey)) {
        return { resolved: true, value: true, pluginHash: '' }
    }

    const pluginHash = await awaitWithAbort(hasher(
        new TextEncoder().encode(
            DBState.db.plugins.find(p => p.name === pluginName)?.script
        )
    ), signal) + `_${permissionDesc}`;

    if (!requiresReconfirm && permissionCache.get(pluginHash)) {
        permissionGivenPlugins.add(permissionKey);
        return { resolved: true, value: true, pluginHash }
    }

    return { resolved: false, value: false, pluginHash }
}

const getPluginPermission = async (
    pluginName: string,
    permissionDesc: PluginPermissionDesc,
    reconfirm: boolean|'periodically' = false,
    signal?: AbortSignal | null,
) => {
    throwIfAborted(signal)
    await ensurePluginPermissionStateLoaded(signal)

    // Recomputed (not captured) so a periodic reconfirm reflects the latest
    // lastGrantTime: when several identical requests queue together, an earlier
    // one may refresh it, making the reconfirm no longer due for the rest.
    const computeRequiresReconfirm = () => {
        if(reconfirm === 'periodically'){
            const lastGrantTime = permissionCache.get(permissionKeyOf(pluginName, permissionDesc) + '_lastGrantTime') as number | undefined;
            return !lastGrantTime || Date.now() - lastGrantTime > 3 * 24 * 60 * 60 * 1000; //3 days
        }
        return reconfirm === true;
    }

    // Fast path: if the answer is already known, skip the serialization queue
    // entirely so cached/granted permissions never block on a pending dialog.
    const early = await isPermissionResolved(
        pluginName,
        permissionDesc,
        computeRequiresReconfirm(),
        signal,
    )
    if (early.resolved) {
        return early.value
    }

    const showDialog = async (): Promise<boolean> => {
        throwIfAborted(signal)
        // Re-check under the lock: an earlier queued dialog for the same plugin
        // may have already granted/denied (or refreshed a periodic grant) while
        // we were waiting our turn — recompute reconfirm so we don't re-prompt.
        const requiresReconfirm = computeRequiresReconfirm()
        const recheck = await isPermissionResolved(
            pluginName,
            permissionDesc,
            requiresReconfirm,
            signal,
        )
        if (recheck.resolved) {
            return recheck.value
        }
        const pluginHash = recheck.pluginHash

        let alertTitle =
            permissionDesc === 'fetchLogs' ? language.fetchLogConsent.replace("{}", pluginName)
            : permissionDesc === 'db' ? language.getFullDatabaseConsent.replace("{}", pluginName)
            : permissionDesc === 'mainDom' ? language.mainDomAccessConsent.replace("{}", pluginName)
            : permissionDesc === 'replacer' ? language.replacerPermissionConsent.replace("{}", pluginName)
            : permissionDesc === 'provider' ? language.providerPermissionConsent.replace("{}", pluginName)
            : permissionDesc === 'sendChat' ? language.sendChatConsent.replace("{}", pluginName)
            : `Error`
        if(alertTitle === 'Error'){
            return false;
        }
        const permissionKey = permissionKeyOf(pluginName, permissionDesc);
        const conf = await awaitWithAbort(alertConfirm(alertTitle), signal)
        throwIfAborted(signal)
        if(conf && pluginHash){
            permissionGivenPlugins.add(permissionKey);
            permissionDeniedPlugins.delete(permissionKey);
            permissionCache.set(pluginHash, true);
            if(reconfirm === 'periodically'){
                permissionCache.set(permissionKeyOf(pluginName, permissionDesc) + '_lastGrantTime', Date.now());
            }
            await persistPluginPermissionState(signal)
            return true;
        }
        permissionGivenPlugins.delete(permissionKey);
        permissionDeniedPlugins.add(permissionKey);
        permissionCache.delete(permissionKey + '_lastGrantTime');
        await persistPluginPermissionState(signal)
        return false;
    }

    // Append to the dialog chain so only one permission dialog is shown at a
    // time. finally restores the chain even if showDialog throws, so a single
    // failure never deadlocks every later permission request.
    const predecessor = pluginPermissionDialogChain.catch(() => {})
    const run = awaitWithAbort(predecessor, signal)
        .then(() => showDialog())
    // Keep the queue tail behind its predecessor even if this caller aborts
    // while waiting. Otherwise a cancelled middle waiter could let a later
    // dialog overtake the still-open earlier one.
    pluginPermissionDialogChain = predecessor
        .then(() => run)
        .catch(() => {})
    return run
}

const urlBlacklist = [
    'risuai.xyz',
    'risuai.net',
    'sionyw.com',
]

const authorizationHeaders = [
    'x-api-key',
    'authorization',
    'proxy-authorization',
]

export const makeRisuaiAPIV3 = (
    iframe: HTMLIFrameElement,
    plugin: RisuPlugin,
    lifecycle = new V3PluginLifecycleScope(plugin.name),
) => {

    const guardPluginCallback = <T extends (...args: any[]) => any>(callback: T): T => {
        return ((...args: Parameters<T>): ReturnType<T> => {
            lifecycle.assertCanInvokeCallbacks();
            return callback(...args);
        }) as T;
    };

    const oldApis = getV2PluginAPIs();
    const databaseBridge = createPluginDatabaseBridge({
        allowedDbKeys,
        getLiveDatabase: () => getDatabase() as unknown as Record<string, unknown>,
        snapshotField: (key, value) => cloneDatabaseField(key, value),
        getPluginStorageSnapshot: getPluginSaveStorageSnapshot,
        updateWithPluginStorageSnapshot: updateDatabaseWithPluginStorageSnapshot,
        normalizePluginMutation: (signal) => {
            throwIfAborted(signal);
            const liveDatabase = getDatabase();
            const disabledPlugins = disableEnabledLegacyPluginsForOptimizedMemory(
                liveDatabase.plugins,
                liveDatabase.optimizePluginMemory,
            );
            if (disabledPlugins.length > 0) {
                notifyWarning(language.optimizePluginMemoryLegacyAutoDisabled(
                    disabledPlugins.join(", "),
                ));
            }
        },
        applyLite: (mutation, signal) => {
            const db = getDatabase();
            for (const key of Object.keys(mutation)) {
                throwIfAborted(signal);
                (db as any)[key] = mutation[key];
            }
            throwIfAborted(signal);
            DBState.db = db;
        },
        applyFull: async (mutation, signal) => {
            const db = getDatabase();
            const preparedEntries: [string, unknown][] = [];
            for (const key of Object.keys(mutation)) {
                throwIfAborted(signal);
                const value = key === "plugins"
                    ? await awaitWithAbort(
                        handlePluginInstallViaPlugin(mutation[key] as RisuPlugin[]),
                        signal,
                    )
                    : mutation[key];
                throwIfAborted(signal);
                preparedEntries.push([key, value]);
            }
            // Commit ordinary database fields together only after every
            // potentially async preparation step has completed.
            for (const [key, value] of preparedEntries) {
                (db as any)[key] = value;
            }
            throwIfAborted(signal);
            setDatabaseState(db);
        },
    });
    const pluginStorageUpdates = new PluginStorageUpdateCoordinator({
        read: getPluginSaveStorageItemWithRevision,
        atomicSet: (key, value, expectedRevision, signal) => (
            atomicBatchOwnedPluginSaveStorage([{
                type: "set",
                key,
                value,
                expectedRevision,
            }], plugin.name, signal)
        ),
    });
    const reportedPluginStorageCompatibilityErrors = new Set<string>();
    const reportPluginStorageCompatibilityError = (candidate: unknown): void => {
        if (getDatabase().optimizePluginMemory !== true
            || candidate === null
            || typeof candidate !== "object") return;
        const source = candidate as Record<string, unknown>;
        const nested = source.error && typeof source.error === "object"
            ? source.error as Record<string, unknown>
            : source;
        const code = typeof nested.code === "string" ? nested.code : "";
        if (code !== "PLUGIN_STORAGE_VALUE_UNSUPPORTED"
            && code !== "PLUGIN_VALUE_TOO_LARGE") return;
        if (reportedPluginStorageCompatibilityErrors.has(code)) return;
        reportedPluginStorageCompatibilityErrors.add(code);
        notifyError(language.pluginStorageWriteRejected(plugin.name), {
            description: typeof nested.message === "string" && nested.message.length > 0
                ? nested.message
                : "Optimized plugin storage rejected an unsupported value.",
            source: "plugin-storage",
        });
    };
    const observePluginStorageOperation = async <T>(operation: Promise<T>): Promise<T> => {
        try {
            const result = await operation;
            reportPluginStorageCompatibilityError(result);
            return result;
        } catch (error) {
            reportPluginStorageCompatibilityError(error);
            throw error;
        }
    };
    const runPluginStorageWriter = <T>(
        operation: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> => observePluginStorageOperation(
        pluginStorageUpdates.runWriter(operation, signal),
    );
    lifecycle.addPostUnloadDrain(() => pluginStorageUpdates.drainPendingPublications());
    return {

        //Old APIs from v2.1
        risuFetch: (url, options) => {
            console.error(`[DEPRECATION WARNING] risuFetch is deprecated and will be removed in future versions. Please use nativeFetch instead.`)
            for(const blocked of urlBlacklist){
                if(url.toLowerCase().includes(blocked)){
                    throw new Error(`Requests to ${blocked} are blocked for security reasons.`);
                }
            }

            //scan headers
            const headers = options?.headers || {};
            for(const headerName in headers){
                if(authorizationHeaders.includes(headerName.toLowerCase())){
                    console.warn(`Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to only work with nativeFetch.`);
                }
            }
            return oldApis.risuFetch(url, options);
        },
        nativeFetch: (url, options) => {
            for(const blocked of urlBlacklist){
                if(url.toLowerCase().includes(blocked)){
                    throw new Error(`Requests to ${blocked} are blocked for security reasons.`);
                }
            }

            //scan headers
            const headers = options?.headers || {};
            for(const headerName in headers){
                if(authorizationHeaders.includes(headerName.toLowerCase())){
                    console.warn(`Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to use server-side approch with write-only api access in the future for better security.`);
                }
            }
            return oldApis.nativeFetch(url, options);
        },
        getChar: oldApis.getChar,
        setChar: oldApis.setChar,
        addProvider: (name: string, func: (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string }>, options?: PluginV3ProviderOptions) => {
            lifecycle.assertCanRegister();
            console.warn(`[WARN] addProvider is a powerful API that can potentially be unsafe if used incorrectly. addProvider's functionality might be limited or changed in future updates to ensure security. please use other APIs if possible.`);
            let provs = get(customProviderStore)
            provs.push(name)
            const provider = async (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => {
               lifecycle.assertCanInvokeCallbacks();
               await getPluginPermission(plugin.name, 'provider', 'periodically');
               lifecycle.assertCanInvokeCallbacks();
               //mode is overridden to v3, due to vulnerabilities using mode.
               //Alternative to mode will be added in future
               arg.mode = 'v3'
               return await func(arg, abortSignal);
            };
            pluginV2.providers.set(name, provider)
            pluginV2.providerOptions.set(name, options ?? {})
            customProviderStore.set(provs)

            const modelData:LLMModel = {
                id: `pluginmodel:::${name}`,
                name: options?.model?.name ?? name,
                shortName: options?.model?.shortName ?? name,
                fullName: options?.model?.fullName ?? name,
                internalID: options?.model?.internalID ?? `pluginmodel:::${name}`,
                provider: LLMProvider.AsIs,
                format: LLMFormat.Plugin,
                flags: options?.model?.flags ?? [LLMFlags.hasFullSystemPrompt],
                parameters: options?.model?.parameters ?? ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'min_p', 'top_a', 'top_k', 'thinking_tokens'],
                tokenizer:options?.model?.tokenizer ??  LLMTokenizer.Unknown
            }
            customV3ProviderMetaStore.push(modelData);
            lifecycle.addCleanup(() => {
                if (pluginV2.providers.get(name) === provider) {
                    pluginV2.providers.delete(name);
                    pluginV2.providerOptions.delete(name);
                }
                const modelIndex = customV3ProviderMetaStore.indexOf(modelData);
                if (modelIndex !== -1) customV3ProviderMetaStore.splice(modelIndex, 1);
                if (!pluginV2.providers.has(name)) {
                    customProviderStore.update(values => values.filter(value => value !== name));
                }
            });
        },
        addTTSPreprocessor: async (
            func: TTSHookFn<BeforeTTSContext, BeforeTTSResult>,
        ) => {
            lifecycle.assertCanRegister();
            const guardedFunc = guardPluginCallback(func);
            registerTTSPreprocessor(guardedFunc);
            lifecycle.addCleanup(() => unregisterTTSPreprocessor(guardedFunc));
        },
        addTTSPostprocessor: async (
            func: TTSHookFn<AfterTTSContext, AfterTTSResult>,
        ) => {
            lifecycle.assertCanRegister();
            const guardedFunc = guardPluginCallback(func);
            registerTTSPostprocessor(guardedFunc);
            lifecycle.addCleanup(() => unregisterTTSPostprocessor(guardedFunc));
        },
        addRisuScriptHandler: (name: V3ScriptMode, func: EditFunction) => {
            lifecycle.assertCanRegister();
            // The V3 surface uses "display" while the legacy declaration still
            // calls that mode "editdisplay"; the legacy implementation itself
            // prepends "edit", so preserve the V3 runtime value here.
            const legacyName = name as unknown as Parameters<typeof oldApis.addRisuScriptHandler>[0];
            const guardedFunc = guardPluginCallback(func);
            oldApis.addRisuScriptHandler(legacyName, guardedFunc);
            lifecycle.addCleanup(() => oldApis.removeRisuScriptHandler(legacyName, guardedFunc));
        },
        removeRisuScriptHandler: oldApis.removeRisuScriptHandler,
        addRisuReplacer: async (name:string,func:Function) => {
            lifecycle.assertCanRegister();
            //permission check for replacer
            const conf = await getPluginPermission(plugin.name, 'replacer', 'periodically');
            if(!conf){
                return;
            }
            lifecycle.assertCanRegister();
            const guardedFunc = guardPluginCallback(func as (...args: any[]) => any);
            oldApis.addRisuReplacer(name, guardedFunc as any);
            lifecycle.addCleanup(() => oldApis.removeRisuReplacer(name, guardedFunc as any));
        },
        removeRisuReplacer: oldApis.removeRisuReplacer,
        setDatabaseLite: async (database: unknown, signal?: AbortSignal) => {
            await runPluginStorageWriter(async () => {
                const conf = await getPluginPermission(
                    plugin.name,
                    'db',
                    'periodically',
                    signal,
                );
                if (!conf) return;
                throwIfAborted(signal);
                await databaseBridge.setDatabaseLite(database, signal);
            }, signal);
        },
        setDatabase: async (database: unknown, signal?: AbortSignal) => {
            await runPluginStorageWriter(async () => {
                const conf = await getPluginPermission(
                    plugin.name,
                    'db',
                    'periodically',
                    signal,
                );
                if (!conf) return;
                throwIfAborted(signal);
                await databaseBridge.setDatabase(database, signal);
            }, signal);
        },
        loadPlugins: oldApis.loadPlugins,
        readImage: oldApis.readImage,
        saveAsset: oldApis.saveAsset,
        //Same functionality, but new implementation
        getDatabase: async (
            includeOnly:string[]|'all' = 'all',
            signal?: AbortSignal,
        ) => {
            const conf = await getPluginPermission(
                plugin.name,
                'db',
                'periodically',
                signal,
            );
            if(!conf){
                return null;
            }
            throwIfAborted(signal);
            return await databaseBridge.getDatabase(includeOnly, signal);
        },

        installPlugin: handlePluginInstallViaPlugin,

        // --- Color Scheme APIs ---
        changeColorScheme: (name: string) => {
            changeColorScheme(name)
        },
        setColorScheme: (scheme: ColorScheme) => {
            const requiredKeys = ['bgcolor','darkbg','borderc','selected','draculared','textcolor','textcolor2','darkBorderc','darkbutton','type'] as const
            for (const key of requiredKeys) {
                if (typeof (scheme as any)[key] !== 'string') {
                    throw new Error(`Invalid color scheme: missing or invalid '${key}'`)
                }
            }
            if (scheme.type !== 'light' && scheme.type !== 'dark') {
                throw new Error('Invalid color scheme type: must be "light" or "dark"')
            }
            const db = DBState.db
            db.colorSchemeName = 'custom'
            db.colorScheme = scheme
            updateColorScheme()
        },
        getColorScheme: () => {
            const db = DBState.db
            return {
                name: db.colorSchemeName,
                scheme: $state.snapshot(db.colorScheme)
            }
        },

        // --- Text Theme APIs ---
        changeTextTheme: (name: string) => {
            if (!['standard','highcontrast'].includes(name)) {
                throw new Error(`Invalid text theme: ${name}`)
            }
            const db = DBState.db
            db.textTheme = name
            updateTextThemeAndCSS()
        },
        setCustomTextTheme: (theme: {
            FontColorStandard: string,
            FontColorBold: string,
            FontColorItalic: string,
            FontColorItalicBold: string,
            FontColorQuote1: string,
            FontColorQuote2: string
        }) => {
            const requiredKeys = ['FontColorStandard','FontColorBold','FontColorItalic','FontColorItalicBold','FontColorQuote1','FontColorQuote2'] as const
            for (const key of requiredKeys) {
                if (typeof (theme as any)[key] !== 'string') {
                    throw new Error(`Invalid text theme: missing or invalid '${key}'`)
                }
            }
            const db = DBState.db
            db.textTheme = 'custom'
            db.customTextTheme = theme
            updateTextThemeAndCSS()
        },
        getTextTheme: () => {
            const db = DBState.db
            return {
                name: db.textTheme,
                customTheme: $state.snapshot(db.customTextTheme)
            }
        },

        //Deprecated APIs from v2.1
        //Use getArgument / setArgument instead if possible
        getArg: oldApis.getArg,
        setArg: oldApis.setArg,

        //New APIs for v3
        getArgument: async (key:string) => {
            const db = getDatabase()
            for (const p of db.plugins) {
                if (p.name === plugin.name) {
                    return p.realArg[key];
                }
            }
        },
        setArgument: async (key:string, value:string) => {
            const db = getDatabase();
            for (const p of db.plugins) {
                if (p.name === plugin.name) {
                    p.realArg[key] = value;
                }
            }
        },
        getCharacterFromIndex: (index:number) => {
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[index];
            if(charId){
                return $state.snapshot(db.characters[charId]);
            }
            return null;
        },
        setCharacterToIndex: (index:number, char:any) => {
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[index];
            if(charId){
                DBState.db.characters[charId] = char
            }
        },
        getChatFromIndex: (characterIndex:number, chatIndex:number) => {
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[characterIndex];
            if(charId){
                const chats = db.characters[charId].chats;
                if(chats && chats[chatIndex]){
                    return $state.snapshot(chats[chatIndex]);
                }
            }
            return null;
        },
        setChatToIndex: (characterIndex:number, chatIndex:number, chat:any) => {
            const db = DBState.db
            const charIds = Object.keys(db.characters);
            const charId = charIds[characterIndex];
            if(charId){
                const chats = db.characters[charId].chats;
                if(chats && chats[chatIndex]){
                    DBState.db.characters[charId].chats[chatIndex] = normalizeChat(chat)
                }
            }
        },
        getCurrentCharacterIndex: () => {
            return get(selectedCharID)
        },
        getCurrentChatIndex: () => {
            const db = DBState.db
            const charId = get(selectedCharID)
            return db.characters[charId].chatPage
        },
        getCurrentLorebookEntries: () => {
            const charId = get(selectedCharID)
            const char = DBState.db.characters[charId]
            if(!char){
                return []
            }
            const page = char.chatPage
            const characterLore = char.globalLore ?? []
            const chatLore = char.chats?.[page]?.localLore ?? []
            const moduleLore = getModuleLorebooks()
            return $state.snapshot(characterLore.concat(chatLore).concat(moduleLore))
        },
        //New names for character APIs, to match API naming conventions
        getCharacter: oldApis.getChar,
        setCharacter: oldApis.setChar,

        showContainer: (
            //more types may be added in future
            type: 'fullscreen' = 'fullscreen'
        ) => {
            iframe.style.display = "block";
            
            switch(type) {
                case 'fullscreen': {
                    //move iframe to body if not already there
                    if(iframe.parentElement !== document.body) {
                        document.body.appendChild(iframe);
                    }

                    //Make iframe cover whole screen
                    iframe.style.position = "fixed";
                    iframe.style.top = "0";
                    iframe.style.left = "0";
                    iframe.style.width = "100%";
                    iframe.style.height = "100%";
                    iframe.style.border = "none";
                    iframe.style.zIndex = "1000";
                    break;
                }
                default: {
                    return
                }
            }
        },
        hideContainer: () => {
            iframe.style.display = "none";
        },
        getRootDocument: async () => {
            const conf = await getPluginPermission(plugin.name, 'mainDom');
            if(!conf){
                return null;
            }
            lifecycle.assertCanRegister();
            return new SafeDocument(document, lifecycle);
        },
        registerSetting: (
            name:string,
            callback: any,
            icon:string = '',
            iconType:'html'|'img'|'none' = 'none',
            id?:string
        ) => {
            lifecycle.assertCanRegister();
            if(iconType !== 'html' && iconType !== 'img' && iconType !== 'none'){
                throw new Error("iconType must be 'html', 'img' or 'none'");
            }
            if(typeof name !== 'string' || name.trim() === ''){
                throw new Error("name must be a non-empty string");
            }
            const menuId = id || v4()
            const menuDef:MenuDef = {
                id: menuId,
                name,
                icon,
                iconType,
                callback: guardPluginCallback(callback)
            }
            const existingIndex = additionalSettingsMenu.findIndex(item => item.id === menuId)
            if(existingIndex !== -1){
                additionalSettingsMenu[existingIndex] = menuDef
                lifecycle.addCleanup(makeMenuUnloadCallback(additionalSettingsMenu[existingIndex], additionalSettingsMenu))
                return {id: menuId}
            }
            additionalSettingsMenu.push(menuDef)
            lifecycle.addCleanup(makeMenuUnloadCallback(additionalSettingsMenu[additionalSettingsMenu.length - 1], additionalSettingsMenu))
            return {id: menuId};
        },
        registerBodyIntercepter: async (callback: (body: any, type: string) => any) => {
            lifecycle.assertCanRegister();
            if(await getPluginPermission(plugin.name, 'replacer') === false){
                return null;
            }
            lifecycle.assertCanRegister();
            const id = v4();
            const registration = {
                id,
                callback: guardPluginCallback(callback)
            };
            bodyIntercepterStore.push(registration)
            const storedRegistration = bodyIntercepterStore[bodyIntercepterStore.length - 1];
            lifecycle.addCleanup(() => {
                const index = bodyIntercepterStore.indexOf(storedRegistration);
                if(index !== -1){
                    bodyIntercepterStore.splice(index, 1);
                }
            })
            return {id:id};
        },
        
        unregisterBodyIntercepter: (id: string) => {
            const index = bodyIntercepterStore.findIndex(item => item.id === id);
            if(index !== -1){
                bodyIntercepterStore.splice(index, 1);
            }
        },
            
        registerButton: (
            arg: {
                name: string,
                icon: string,
                iconType: 'html'|'img'|'none',
                location?: 'action'|'chat'|'hamburger',
                id?: string
            },
            callback: () => void
        ) => {
            lifecycle.assertCanRegister();
            let { name, icon, iconType, location, id: providedId } = arg;
            location = location || 'action';
            if(iconType !== 'html' && iconType !== 'img' && iconType !== 'none'){
                throw new Error("iconType must be 'html', 'img' or 'none'");
            }
            if(typeof name !== 'string' || name.trim() === ''){
                throw new Error("name must be a non-empty string");
            }
            if(typeof icon !== 'string'){
                throw new Error("icon must be a string");
            }
            const id = providedId || v4()
            const menuDef:MenuDef = {
                name,
                icon,
                iconType,
                callback: guardPluginCallback(callback),
                id
            }

            const buttonStores = [additionalFloatingActionButtons, additionalHamburgerMenu, additionalChatMenu]
            for(const store of buttonStores){
                const existingIndex = store.findIndex(item => item.id === id)
                if(existingIndex !== -1){
                    store[existingIndex] = menuDef
                    lifecycle.addCleanup(makeMenuUnloadCallback(store[existingIndex], store))
                    return {id}
                }
            }

            switch(location){
                case 'action':{
                    additionalFloatingActionButtons.push(menuDef)
                    lifecycle.addCleanup(makeMenuUnloadCallback(additionalFloatingActionButtons[additionalFloatingActionButtons.length - 1], additionalFloatingActionButtons))
                    break
                }
                case 'hamburger':{
                    additionalHamburgerMenu.push(menuDef)
                    lifecycle.addCleanup(makeMenuUnloadCallback(additionalHamburgerMenu[additionalHamburgerMenu.length - 1], additionalHamburgerMenu))
                    break
                }
                case 'chat':{
                    additionalChatMenu.push(menuDef)
                    lifecycle.addCleanup(makeMenuUnloadCallback(additionalChatMenu[additionalChatMenu.length - 1], additionalChatMenu))
                    break
                }
                default:{
                    throw new Error("Invalid location for button")
                }
            }
            return {id};
        },
        setChatPanel: (
            content: string | null,
            options: {
                id?: string,
                className?: string,
            } = {}
        ) => {
            lifecycle.assertCanRegister();
            const id = options.id || `${plugin.name}:default`;

            if(content === null || content === ''){
                removeChatPanel(id);
                return {id};
            }

            if(typeof content !== 'string'){
                throw new Error("content must be a string or null");
            }

            const panel = {
                id,
                pluginName: plugin.name,
                html: DOMPurify.sanitize(content),
                className: typeof options.className === 'string'
                    ? DOMPurify.sanitize(options.className, {ALLOWED_TAGS: [], ALLOWED_ATTR: []})
                    : undefined,
            }

            const existingIndex = chatPanelStore.findIndex(item => item.id === id);
            if(existingIndex !== -1){
                chatPanelStore[existingIndex] = panel;
            }
            else{
                chatPanelStore.push(panel);
            }
            const storedPanel = chatPanelStore.find(item => item.id === id);
            lifecycle.addCleanup(() => {
                const panelIndex = storedPanel ? chatPanelStore.indexOf(storedPanel) : -1;
                if (panelIndex !== -1) chatPanelStore.splice(panelIndex, 1);
            });
            return {id};
        },
        registerMCP: async (...args: Parameters<typeof registerMCPModule>) => {
            lifecycle.assertCanRegister();
            const guardedArgs: Parameters<typeof registerMCPModule> = [
                args[0],
                guardPluginCallback(args[1]),
                guardPluginCallback(args[2]),
            ];
            await registerMCPModule(...guardedArgs);
            const identifier = args[0].identifier;
            const client = registeredCustomPluginMCPs.get(identifier);
            try {
                lifecycle.addCleanup(() => {
                    if (registeredCustomPluginMCPs.get(identifier) === client) {
                        return unregisterMCPModule(identifier);
                    }
                });
            } catch (error) {
                if (registeredCustomPluginMCPs.get(identifier) === client) {
                    await unregisterMCPModule(identifier);
                }
                throw error;
            }
        },
        unregisterMCP: unregisterMCPModule,
        unregisterUIPart: (id: string) => {
            const removeFromMenuStore = (menuStore: MenuDef[]) => {
                const index = menuStore.findIndex(item => item.id === id);
                if(index !== -1){
                    menuStore.splice(index, 1);
                }
            }

            removeFromMenuStore(additionalSettingsMenu);
            removeFromMenuStore(additionalFloatingActionButtons);
            removeFromMenuStore(additionalHamburgerMenu);
            removeFromMenuStore(additionalChatMenu);
            removeChatPanel(id);
        },
        log: (message:string) => {
            console.log(`[RisuAI Plugin: ${plugin.name}] ${message}`);
        },
        createMutationObserver(callback: SafeMutationCallback): SafeMutationObserver {
            lifecycle.assertCanRegister();
            const observer = new SafeMutationObserver(callback, lifecycle);
            lifecycle.addCleanup(() => observer.disconnect());
            return observer;
        },
        onUnload: (callback: (signal?: AbortSignal) => void | Promise<void>) => {
            lifecycle.addUnload(callback);
        },
        getFetchLogs: async () => {
            const unsafeFetchLog = getFetchLogs()
            const conf = await getPluginPermission(plugin.name, 'fetchLogs');
            if(!conf){
                return null;
            }
            return unsafeFetchLog.map(log => {

                const url = new URL(log.url);
                return {
                    url: url.origin + url.pathname,
                    body: log.body,
                    status: log.status,
                    response: log.response,
                }
            })
        },

        alert: (msg:string) => {
            return alertNormal(msg)
        },
        alertConfirm: (msg:string) => {
            return alertConfirm(msg)
        },
        alertError: (msg:string) => {
            return alertError(msg)
        },
        getRuntimeInfo: () => {
            return {
                apiVersion: "3.0",
                platform: 'node',
                saveMethod:
                    forageStorage.isAccount ? 'account' :
                    'local',
            }
        },
        getLocalPluginStorage: () => {
            return new SafeLocalPluginStorage(plugin.name)
        },
        checkCharOrder: checkCharOrder,
        requestPluginPermission: (permission:string) => {
            return getPluginPermission(plugin.name, permission as any);
        },
        //Internal use APIs
        _getOldKeys: () => {
            return Object.keys(oldApis)
        },
        _getPropertiesForInitialization: () => {
            const v = {
                apiVersion: "3.0",
                apiVersionCompatibleWith: ["3.0"],
            } as any;

            v.list = Object.keys(v);
            
            return v;
        },
        // V3 calls cross the async iframe bridge, so these can switch between
        // inline save data and the on-demand pluginsave/ KV backend without an
        // observable API change. V2 keeps using oldApis.pluginStorage directly.
        _getPluginStorage: (key: string, signal?: AbortSignal) => {
            return getPluginSaveStorageItem(key, signal)
        },
        _getVersionedPluginStorage: async (
            key: string,
            _unloadCapabilityOrRequestSignal?: AbortSignal,
            requestSignal?: AbortSignal,
        ) => {
            if (!requestSignal) {
                return getPluginSaveStorageItemWithRevision(
                    key,
                    _unloadCapabilityOrRequestSignal,
                )
            }
            const controller = new AbortController()
            const stopCapability = forwardAbortSignal(
                _unloadCapabilityOrRequestSignal,
                controller,
            )
            const stopRequest = forwardAbortSignal(requestSignal, controller)
            try {
                return await getPluginSaveStorageItemWithRevision(key, controller.signal)
            } finally {
                stopCapability()
                stopRequest()
            }
        },
        _readPluginStorageResult: (key: string, signal?: AbortSignal) => {
            return readPluginSaveStorageItemResult(key, signal)
        },
        _setPluginStorageFromRead: (
            read: Parameters<typeof setOwnedPluginSaveStorageItemFromRead>[0],
            value: unknown,
            signal?: AbortSignal,
        ) => runPluginStorageWriter(
            () => setOwnedPluginSaveStorageItemFromRead(read, value, plugin.name, signal),
            signal,
        ),
        _atomicBatchPluginStorage: (
            operations: Parameters<typeof atomicBatchOwnedPluginSaveStorage>[0],
            _unloadCapabilityOrRequestSignal?: AbortSignal,
            requestSignal?: AbortSignal,
        ) => runPluginStorageWriter(
            () => atomicBatchOwnedPluginSaveStorage(
                operations,
                plugin.name,
                requestSignal ?? _unloadCapabilityOrRequestSignal,
            ),
            requestSignal ?? _unloadCapabilityOrRequestSignal,
        ),
        _rewritePluginStorage: (
            key: string,
            value: unknown,
            expectedRevision?: string | null,
            _unloadCapabilityOrRequestSignal?: AbortSignal,
            requestSignal?: AbortSignal,
        ) => runPluginStorageWriter(
            () => rewriteOwnedPluginSaveStorageItem(
                key,
                value,
                plugin.name,
                expectedRevision,
                requestSignal ?? _unloadCapabilityOrRequestSignal,
            ),
            requestSignal ?? _unloadCapabilityOrRequestSignal,
        ),
        _updatePluginStorage: (
            key: string,
            transform: PluginStorageUpdateTransform,
            options?: PluginStorageUpdateOptions,
            unloadSignal?: AbortSignal,
            requestSignal?: AbortSignal,
        ) => observePluginStorageOperation(
            pluginStorageUpdates.updateItem(
                key,
                transform,
                options,
                [unloadSignal, requestSignal],
            ),
        ),
        _setPluginStorage: async (key: string, value: any, signal?: AbortSignal) => {
            await runPluginStorageWriter(
                () => setOwnedPluginSaveStorageItem(key, value, plugin.name, signal),
                signal,
            )
        },
        _setPluginStorageWithOutcome: (key: string, value: any, signal?: AbortSignal) => (
            runPluginStorageWriter(
                () => setOwnedPluginSaveStorageItemWithOutcome(key, value, plugin.name, signal),
                signal,
            )
        ),
        _removePluginStorage: async (key: string, signal?: AbortSignal) => {
            await runPluginStorageWriter(
                () => removeOwnedPluginSaveStorageItem(key, signal),
                signal,
            )
        },
        _removePluginStorageWithOutcome: (key: string, signal?: AbortSignal) => (
            runPluginStorageWriter(
                () => removeOwnedPluginSaveStorageItemWithOutcome(key, signal),
                signal,
            )
        ),
        _removePluginStorageConfirmed: (key: string, signal?: AbortSignal) => (
            runPluginStorageWriter(
                () => removeOwnedPluginSaveStorageItemConfirmed(key, signal),
                signal,
            )
        ),
        _clearPluginStorage: async (signal?: AbortSignal) => {
            await runPluginStorageWriter(
                () => clearOwnedPluginSaveStorage(signal),
                signal,
            )
        },
        _keyPluginStorage: (index: number, signal?: AbortSignal) => (
            getPluginSaveStorageKey(index, signal)
        ),
        _keysPluginStorage: (signal?: AbortSignal) => getPluginSaveStorageKeys(signal),
        _lengthPluginStorage: (signal?: AbortSignal) => getPluginSaveStorageLength(signal),
        _getSafeLocalStorage: oldApis.safeLocalStorage.getItem,
        _setSafeLocalStorage: (key: string, value: string, signal?: AbortSignal) => {
            signal?.throwIfAborted()
            oldApis.safeLocalStorage.setItem(key, value)
            recordOwner('local', key, plugin.name, signal)
        },
        _removeSafeLocalStorage: (key: string, signal?: AbortSignal) => {
            signal?.throwIfAborted()
            oldApis.safeLocalStorage.removeItem(key)
            removeOwner('local', key, signal)
        },
        _clearSafeLocalStorage: (signal?: AbortSignal) => {
            signal?.throwIfAborted()
            oldApis.safeLocalStorage.clear()
            clearOwners('local', signal)
        },
        _keySafeLocalStorage: oldApis.safeLocalStorage.key,
        _keysSafeLocalStorage: oldApis.safeLocalStorage.keys,
        searchTranslationCache: async (partialKey: string) => {
            return searchLLMCache(partialKey)
        },
        getTranslationCache: async (key: string) => {
            return getLLMCache(key)
        },
        _getAliases: () => {
            return {
                'pluginStorage':{
                    'getItem': '_getPluginStorage',
                    'getWithRevision': '_getVersionedPluginStorage',
                    'readItem': '_readPluginStorageResult',
                    'setFromRead': '_setPluginStorageFromRead',
                    'atomicBatch': '_atomicBatchPluginStorage',
                    'rewriteItem': '_rewritePluginStorage',
                    'updateItem': '_updatePluginStorage',
                    'setItem': '_setPluginStorage',
                    'setItemWithOutcome': '_setPluginStorageWithOutcome',
                    'removeItem': '_removePluginStorage',
                    'removeItemWithOutcome': '_removePluginStorageWithOutcome',
                    'removeItemConfirmed': '_removePluginStorageConfirmed',
                    'clear': '_clearPluginStorage',
                    'key': '_keyPluginStorage',
                    'keys': '_keysPluginStorage',
                    'length': '_lengthPluginStorage',
                },
                'safeLocalStorage':{
                    'getItem': '_getSafeLocalStorage',
                    'setItem': '_setSafeLocalStorage',
                    'removeItem': '_removeSafeLocalStorage',
                    'clear': '_clearSafeLocalStorage',
                    'key': '_keySafeLocalStorage',
                    'keys': '_keysSafeLocalStorage',
                }
            }
        },
        runLLMModel: async (options: {
            mode: ModelModeExtended
            messages: OpenAIChat[]
            staticModel?: string
            allowPlugins?: boolean
        }) => {
            return requestChatDataMain({
                formated: options.messages,
                bias: {},
                staticModel: options.staticModel,

                // Calls into plugin-provided models are blocked by default to
                // guard against accidental IPC loops between provider plugins.
                // Plugin authors who need to reach the user's plugin-supplied
                // main or auxiliary model (e.g. a TTS preprocessor that
                // rewrites text with the configured otherAx model) can opt in
                // explicitly with `allowPlugins: true`, accepting responsibility
                // for avoiding provider-to-provider call loops.
                blockPlugins: !options.allowPlugins,
            }, options.mode)
        },
        sendChat: async (message: string) => {
            const conf = await getPluginPermission(plugin.name, 'sendChat');
            if(!conf){
                return false;
            }

            if(typeof message !== 'string'){
                throw new Error("Message must be a string");
            }

            if(get(doingChat)){
                throw new Error("A chat is already in progress");
            }

            if(getModelInfo(DBState.db.aiModel).id.startsWith('pluginmodel:::')){
                // Executing plugin provider is block because it can be used for loopholes for ipc right now.
                throw new Error("Sending chat with plugin-based model is currently blocked");
            }

            const charId = get(selectedCharID);
            const char = DBState.db.characters[charId];
            if(!char){
                throw new Error("No character selected");
            }

            const chat = char.chats[char.chatPage];
            if(!chat){
                throw new Error("No active chat found");
            }

            if(message){
                chat.message.push({
                    role: 'user',
                    data: message,
                    time: Date.now(),
                });
            }

            try {
                await processSendChat(-1, {});
            } finally {
                // Plugin API path does not pass through the UI unlock logic,
                // so release doingChat here on both success and failure.
                doingChat.set(false);
            }

            return true;
        },
        addPluginChannelListener: (channelName: string, callback: Function) => {
            lifecycle.assertCanRegister();
            const key = plugin.name + channelName;
            const guardedCallback = guardPluginCallback(callback as (...args: any[]) => any);
            pluginChannel.set(key, guardedCallback);
            lifecycle.addCleanup(() => {
                if (pluginChannel.get(key) === guardedCallback) pluginChannel.delete(key);
            });
        },
        postPluginChannelMessage: (pluginName: string, channelName: string, message: any) => {

            const currentPluginName = plugin.name;
            const receiverPlugin = DBState.db.plugins.find(p => p.name === pluginName);

            if(!receiverPlugin){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to non-existent plugin '${pluginName}' on channel '${channelName}'.`);
                return;
            }

            if(!receiverPlugin.allowedIPC?.includes(currentPluginName)){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but receiver plugin does not allow IPC communication from this plugin. declare //@allowed-ipc ${currentPluginName} in the reciver plugin script to allow IPC communication.`);
                return;
            }

            if(!plugin.allowedIPC?.includes(receiverPlugin.name)){
                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but the sender plugin does not allow IPC communication to this plugin. declare //@allowed-ipc ${receiverPlugin.name} in the sender plugin script to allow IPC communication.`);
                return;
            }


            const callback = pluginChannel.get(pluginName + channelName);
            if(callback){
                callback(message, {
                    sender: currentPluginName,
                    channel: channelName
                });
            }
        },
        saveSecretHeader: async (key: string, value: string|string[]) => {
            //TODO: Implement server-side secret storage with write-only access for plugins, to enhance security when handling sensitive information like API keys.
            //This will have rate-limit, to prevent saving it publicly and writing as secret every time before using it.
            console.warn(`[RisuAI Plugin: ${plugin.name}] saveServerSecret is not implemented yet. This API is intended for securely storing sensitive information like API keys with write-only access for plugins. Please avoid using this API until it is implemented.`);
        }
    }
}

type V3PluginInstance = {
    name: string;
    host: SandboxHost;
    scope: V3PluginLifecycleScope;
    initialization: Promise<void>;
    teardown?: Promise<void>;
}

const v3PluginInstances: V3PluginInstance[] = [];

export async function teardownV3Plugins(){
    // unloadV3Plugin removes from the live array synchronously, so iterate a
    // snapshot or every shifted second instance would be skipped.
    const results = await Promise.allSettled(
        [...v3PluginInstances].map(instance => unloadV3PluginInstance(instance)),
    );
    const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason);
    if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more V3 plugin teardowns failed.');
    }
}

export async function loadV3PluginGeneration(plugins:RisuPlugin[]){
    // Promise.all rejects as soon as one guest fails. A generation must not be
    // reported settled while another guest is still initializing, otherwise a
    // lifecycle transition could tear down registrations that arrive later.
    const results = await Promise.allSettled(
        plugins.map(plugin => executePluginV3(plugin)),
    );
    const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
    if (errors.length > 0) {
        throw new AggregateError(errors, "One or more V3 plugins failed to initialize.");
    }
}

export async function loadV3Plugins(plugins:RisuPlugin[]){
    await teardownV3Plugins();
    await loadV3PluginGeneration(plugins);
}

export async function executePluginV3(plugin:RisuPlugin){

    const alreadyRunning = v3PluginInstances.find(p => p.name === plugin.name);
    if(alreadyRunning){
        // The matching instance may still be inside its async guest startup.
        // Joining it preserves executePluginV3's readiness contract even for
        // overlapping or duplicate direct calls.
        await alreadyRunning.initialization;
        console.log(`[RisuAI Plugin: ${plugin.name}] Plugin is already running. Skipping load.`);
        return;
    }

    const iframe = document.createElement('iframe');
    iframe.style.display = "none";
    document.body.appendChild(iframe);
    const scope = new V3PluginLifecycleScope(plugin.name);
    const host = new SandboxHost(makeRisuaiAPIV3(iframe, plugin, scope));
    const initialization = host.run(iframe, plugin.script);
    const instance: V3PluginInstance = {
        name: plugin.name,
        host,
        scope,
        initialization,
    };
    v3PluginInstances.push(instance);
    try {
        await initialization;
        if (!scope.markReady()) {
            throw new Error("Plugin initialization was cancelled during teardown.");
        }
        console.log(`[RisuAI Plugin: ${plugin.name}] Loaded API V3 plugin.`);
    } catch (error) {
        // A guest can register UI/hooks before a later awaited initialization
        // step rejects. Run its normal unload path and always terminate the
        // iframe so a late ready message cannot resurrect this generation.
        let teardownError: unknown;
        try {
            await unloadV3PluginInstance(instance);
        } catch (cleanupError) {
            teardownError = cleanupError;
            host.terminate();
        }

        const message = error instanceof Error ? error.message : String(error);
        console.error(`[RisuAI Plugin: ${plugin.name}] Failed to initialize API V3 plugin.`, error);
        notifyError(language.pluginInitializationFailed(plugin.name), {
            description: message,
            source: "plugin-startup",
        });
        if (teardownError !== undefined) {
            throw new AggregateError(
                [error, teardownError],
                `Plugin ${plugin.name} initialization and cleanup failed.`,
            );
        }
        throw error;
    }
}

export function getV3PluginInstance(name: string) {
    return v3PluginInstances.find(p => p.name === name);
}

globalThis.__debugV3Plugin = (code: string|Function, pluginName: string = '') => {
    if(code instanceof Function){
        code = `(${code.toString()})()`;
    }
    if(pluginName === ''){
        return v3PluginInstances[0].host.executeInIframe(code);
    }
    const instance = v3PluginInstances.find(p => p.name === pluginName);
    if(!instance){
        throw new Error(`Plugin ${pluginName} not found.`);
    }
    return instance.host.executeInIframe(code);
};
