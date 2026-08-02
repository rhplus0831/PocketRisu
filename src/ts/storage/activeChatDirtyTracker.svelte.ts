import { deepTouch } from '../gui/deepTouch.svelte'

export interface ActiveChatDirtySelection<T extends object> {
    chaId: string
    chatId: string
    chat: T | null | undefined
    suppressDirty?: boolean
}

export interface ActiveChatDirtyTrackerOptions<T extends object> {
    select: () => ActiveChatDirtySelection<T>
    onDirty: (chaId: string, chatId: string) => void
    retouchDelayMs: number | ((selection: ActiveChatDirtySelection<T>) => number)
    touch?: (chat: T) => void
}

export interface ActiveChatDirtyTracker {
    rearm: () => void
    stop: () => void
}

/**
 * Observe the active chat without re-walking its complete graph on every
 * reactive flush.
 *
 * The first nested mutation is detected through the same `deepTouch`
 * dependencies used by the original save effect. That run queues the live
 * chat and deliberately omits another deep read, temporarily dropping the
 * nested subscriptions. A revision timer then re-runs the effect and restores
 * the complete subscription once per save-debounce window. Mutations while the
 * subscription is dropped are already covered by the queued live chat object.
 *
 * Selection changes establish a clean baseline. Replacing the object for the
 * same durable chat id is dirty unless hydration suppression is active.
 */
export function watchActiveChatDirty<T extends object>(
    options: ActiveChatDirtyTrackerOptions<T>,
): ActiveChatDirtyTracker {
    let retouchRevision = $state(0)
    let subscribedRevision = -1
    let trackedKey = ''
    let trackedChat: T | null | undefined
    let trackedSuppression = false
    let retouchTimer: ReturnType<typeof setTimeout> | null = null
    const touch = options.touch ?? deepTouch
    const getRetouchDelayMs = (selection: ActiveChatDirtySelection<T>) => Math.max(
        0,
        typeof options.retouchDelayMs === 'function'
            ? options.retouchDelayMs(selection)
            : options.retouchDelayMs,
    )

    const cancelRetouch = () => {
        if (retouchTimer === null) return
        clearTimeout(retouchTimer)
        retouchTimer = null
    }

    const scheduleRetouch = (selection: ActiveChatDirtySelection<T>) => {
        if (retouchTimer !== null) return
        retouchTimer = setTimeout(() => {
            retouchTimer = null
            retouchRevision += 1
        }, getRetouchDelayMs(selection))
    }

    const stop = $effect.root(() => {
        $effect(() => {
            const revision = retouchRevision
            const selection = options.select()
            const key = selection.chaId && selection.chatId
                ? `${selection.chaId}\0${selection.chatId}`
                : ''
            const suppressDirty = selection.suppressDirty === true

            if (!key || !selection.chat) {
                cancelRetouch()
                trackedKey = ''
                trackedChat = selection.chat
                trackedSuppression = suppressDirty
                subscribedRevision = revision
                return
            }

            const keyChanged = trackedKey !== key
            const chatChanged = trackedChat !== selection.chat
            const suppressionChanged = trackedSuppression !== suppressDirty
            const revisionChanged = subscribedRevision !== revision

            if (keyChanged) {
                cancelRetouch()
                trackedKey = key
                trackedChat = selection.chat
                trackedSuppression = suppressDirty
                subscribedRevision = revision
                touch(selection.chat)
                return
            }

            if (chatChanged) {
                cancelRetouch()
                trackedChat = selection.chat
                trackedSuppression = suppressDirty
                subscribedRevision = revision
                touch(selection.chat)
                if (!suppressDirty) {
                    options.onDirty(selection.chaId, selection.chatId)
                }
                return
            }

            if (suppressionChanged || revisionChanged) {
                trackedSuppression = suppressDirty
                subscribedRevision = revision
                touch(selection.chat)
                return
            }

            // Schedule the re-subscription before the save debounce. With equal
            // delays, this timer is therefore due first and closes the small
            // unobserved window before the queued save starts.
            scheduleRetouch(selection)
            if (!suppressDirty) {
                options.onDirty(selection.chaId, selection.chatId)
            }
        })

        return cancelRetouch
    })

    return {
        rearm: () => {
            cancelRetouch()
            retouchRevision += 1
        },
        stop,
    }
}
