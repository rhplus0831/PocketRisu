/// <reference types="svelte" />
/// <reference types="vite/client" />


declare const __APP_VERSION__: string
declare const __APP_BRANCH__: string
declare const __APP_COMMIT__: string
declare const __CLIENT_BUILD_STAMP__: string
declare var Buffer: BufferConstructor
declare var safeStructuredClone: <T>(data: T) => T
declare var userScriptFetch: (url: string,arg:RequestInit) => Promise<Response>
