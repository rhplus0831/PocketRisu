export interface ChatSendHotkeySettings {
    sendWithEnter: boolean
    sendOnlyWithButton?: boolean
}

export interface KeyboardEventLike {
    key: string
    shiftKey?: boolean
    isComposing?: boolean
}

export function shouldSendOnEnter(
    settings: ChatSendHotkeySettings,
    event: KeyboardEventLike
): boolean {
    if (event.key.toLocaleLowerCase() !== 'enter') {
        return false
    }

    if (event.isComposing || settings.sendOnlyWithButton) {
        return false
    }

    if (settings.sendWithEnter) {
        return !event.shiftKey
    }

    return !!event.shiftKey
}
