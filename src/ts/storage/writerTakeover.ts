import { language } from "../../lang"
import { alertSelect } from "../alert"

const FROZEN_CLASS = 'risu-writer-offline-frozen'
const BANNER_ID = 'risu-writer-offline-banner'
const WRITER_ACCESS_LOST_EVENT = 'risu-writer-access-lost'
const NON_TEXT_INPUT_TYPES = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
])

let writerAccessLost = false
let offlineFreezeObserver: MutationObserver | null = null
let removeInteractionGuards: (() => void) | null = null

export type WriterTakeoverReason = 'session-takeover' | 'server-upgrade' | 'server-restart'

export type WriterLockState = 'free' | 'active' | 'fresh' | 'stale' | 'unknown'

interface WriterTakeoverReturnCheck {
    getWriterLockState: () => Promise<WriterLockState>
    isOperationActive: () => boolean
    claimWriterAccessLoss: () => boolean
}

export function isWriterAccessLost(): boolean {
    return writerAccessLost
}

/**
 * Permanently fence this page after another browser session becomes the writer.
 * The server remains authoritative: this flow never retries a stale write or
 * attempts to reclaim ownership without a full reload.
 */
export function enterWriterTakeoverFlow(reason: WriterTakeoverReason = 'session-takeover'): void {
    if (writerAccessLost) return
    writerAccessLost = true
    window.dispatchEvent(new CustomEvent(WRITER_ACCESS_LOST_EVENT))
    void runWriterTakeoverFlow(reason)
}

/**
 * Check writer authority when a page returns to the foreground. A stale page
 * must use the same explicit recovery flow as a mutation-time 423 instead of
 * discarding its in-memory state through an automatic reload.
 */
export async function checkWriterTakeoverOnReturn({
    getWriterLockState,
    isOperationActive,
    claimWriterAccessLoss,
}: WriterTakeoverReturnCheck): Promise<boolean> {
    if (isOperationActive()) return false
    if (await getWriterLockState() !== 'stale') return false

    // The status request is asynchronous. If an input hook or generation began
    // while it was in flight, let its eventual 423 enter the takeover flow.
    if (isOperationActive() || !claimWriterAccessLoss()) return false

    enterWriterTakeoverFlow()
    return true
}

async function runWriterTakeoverFlow(reason: WriterTakeoverReason): Promise<void> {
    let selection = '0'
    try {
        selection = await alertSelect(
            [language.writerTakeoverStayOffline, language.writerTakeoverReload],
            reason === 'session-takeover'
                ? language.writerTakeoverBody
                : language.clientUpgradeDirtyBody,
        )
    } catch (error) {
        console.error('[Writer] Failed to show takeover dialog:', error)
    }

    if (selection === '1') {
        globalThis.location?.reload()
        return
    }

    enterFrozenOfflineState(reason)
}

function enterFrozenOfflineState(reason: WriterTakeoverReason): void {
    if (typeof document === 'undefined') return
    const appRoot = document.getElementById('app')
    if (!appRoot) return

    appRoot.classList.add(FROZEN_CLASS)
    freezeEditableTree(appRoot)
    installInteractionGuards(appRoot)

    let banner = document.getElementById(BANNER_ID)
    if (!banner) {
        banner = document.createElement('div')
        banner.id = BANNER_ID
        banner.className = 'risu-writer-offline-banner'
        banner.setAttribute('role', 'status')
        banner.setAttribute('aria-live', 'polite')

        const message = document.createElement('span')
        message.textContent = reason === 'session-takeover'
            ? language.writerOfflineBanner
            : language.clientUpgradeOfflineBanner
        banner.appendChild(message)

        const reload = document.createElement('button')
        reload.type = 'button'
        reload.textContent = language.writerTakeoverReload
        reload.addEventListener('click', () => globalThis.location?.reload())
        banner.appendChild(reload)
        document.body.appendChild(banner)
    }

    if (!offlineFreezeObserver && typeof MutationObserver !== 'undefined') {
        offlineFreezeObserver = new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === 'attributes') {
                    freezeEditableTree(record.target)
                    continue
                }
                for (const node of record.addedNodes) freezeEditableTree(node)
            }
        })
        offlineFreezeObserver.observe(appRoot, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['contenteditable', 'readonly', 'type'],
        })
    }
}

function freezeEditableTree(node: Node): void {
    if (!(node instanceof Element)) return
    freezeEditableElement(node)
    for (const element of node.querySelectorAll('textarea, input, [contenteditable]')) {
        freezeEditableElement(element)
    }
}

function freezeEditableElement(element: Element): void {
    if (element instanceof HTMLTextAreaElement) {
        element.readOnly = true
    }
    if (element instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(element.type)) {
        element.readOnly = true
    }
    if (element.hasAttribute('contenteditable')) {
        element.setAttribute('contenteditable', 'false')
    }
}

function installInteractionGuards(appRoot: HTMLElement): void {
    if (removeInteractionGuards) return

    const blockedEvents = ['click', 'beforeinput', 'input', 'change', 'submit', 'drop', 'dragover', 'paste', 'cut'] as const
    const blockInsideApp = (event: Event) => {
        if (!(event.target instanceof Node) || !appRoot.contains(event.target)) return
        event.preventDefault()
        event.stopImmediatePropagation()
    }
    const blockUnsafeKey = (event: KeyboardEvent) => {
        if (!(event.target instanceof Node) || !appRoot.contains(event.target)) return
        const key = event.key.toLowerCase()
        const safeShortcut = (event.ctrlKey || event.metaKey) && ['a', 'c', 'f'].includes(key)
        const safeNavigation = [
            'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
            'pageup', 'pagedown', 'home', 'end', 'escape',
        ].includes(key)
        if (safeShortcut || safeNavigation) {
            // Preserve browser copy/select/find and scrolling behavior without
            // letting application hotkeys mutate the frozen projection.
            event.stopImmediatePropagation()
            return
        }
        event.preventDefault()
        event.stopImmediatePropagation()
    }

    for (const eventName of blockedEvents) {
        document.addEventListener(eventName, blockInsideApp, true)
    }
    document.addEventListener('keydown', blockUnsafeKey, true)
    removeInteractionGuards = () => {
        for (const eventName of blockedEvents) {
            document.removeEventListener(eventName, blockInsideApp, true)
        }
        document.removeEventListener('keydown', blockUnsafeKey, true)
    }
}

/** Test-only cleanup for the process-global takeover latch and DOM guards. */
export function resetWriterTakeoverForTests(): void {
    writerAccessLost = false
    offlineFreezeObserver?.disconnect()
    offlineFreezeObserver = null
    removeInteractionGuards?.()
    removeInteractionGuards = null
    if (typeof document !== 'undefined') {
        document.getElementById('app')?.classList.remove(FROZEN_CLASS)
        document.getElementById(BANNER_ID)?.remove()
    }
}
