const textEncoder = new TextEncoder()

function indentJson(json: string, spaces: number): string {
    const prefix = ' '.repeat(spaces)
    return prefix + json.replaceAll('\n', `\n${prefix}`)
}

export async function* encodePrettyJsonArray<T>(
    rows: AsyncIterable<T> | Iterable<T>,
    spaces = 4,
): AsyncGenerator<Uint8Array> {
    yield textEncoder.encode('[')
    let count = 0
    for await (const row of rows) {
        const json = JSON.stringify(row, null, spaces)
        if (json === undefined) continue
        yield textEncoder.encode(`${count === 0 ? '\n' : ',\n'}${indentJson(json, spaces)}`)
        count++
    }
    yield textEncoder.encode(count === 0 ? ']' : '\n]')
}

export async function* encodePackageChatsJson(
    chats: AsyncIterable<unknown> | Iterable<unknown>,
    folders: unknown[],
): AsyncGenerator<Uint8Array> {
    yield textEncoder.encode('{\n  "type": "risuAllChats",\n  "ver": 2,\n  "data": [')
    let count = 0
    for await (const chat of chats) {
        const json = JSON.stringify(chat, null, 2)
        if (json === undefined) continue
        yield textEncoder.encode(`${count === 0 ? '\n' : ',\n'}${indentJson(json, 4)}`)
        count++
    }

    const foldersJson = indentJson(JSON.stringify(folders, null, 2), 2).slice(2)
    const dataEnd = count === 0 ? '],\n' : '\n  ],\n'
    yield textEncoder.encode(`${dataEnd}  "folders": ${foldersJson}\n}`)
}

export interface ParsedPackageChats {
    type: 'risuAllChats'
    ver: 2
    folders?: unknown[]
    count: number
}

type ParserMode =
    | 'objectStart'
    | 'propertyOrEnd'
    | 'property'
    | 'colon'
    | 'valueStart'
    | 'value'
    | 'dataItemOrEnd'
    | 'dataItem'
    | 'afterData'
    | 'done'

class PackageChatsStreamParser {
    #mode: ParserMode = 'objectStart'
    #propertyToken = ''
    #propertyEscape = false
    #propertyName = ''
    #valueParts: string[] = []
    #valueBuffer = ''
    #valueDepth = 0
    #valueInString = false
    #valueEscape = false
    #metadata: Record<string, unknown> = {}
    #dataSeen = false
    #count = 0

    constructor(private onChat: (chat: unknown, index: number) => void | Promise<void>) {}

    async push(text: string): Promise<void> {
        for (const char of text) {
            const pending = this.#pushChar(char)
            if (pending) await pending
        }
    }

    finish(): ParsedPackageChats {
        if (this.#mode !== 'done') {
            throw new SyntaxError('Invalid risuAllChats JSON structure')
        }
        if (!this.#dataSeen) throw new TypeError('Unsupported chat package format')
        if (this.#metadata.type !== 'risuAllChats'
            || this.#metadata.ver !== 2) {
            throw new TypeError('Unsupported chat package format')
        }
        const folders = this.#metadata.folders
        return {
            type: 'risuAllChats',
            ver: 2,
            ...(Array.isArray(folders) ? { folders } : {}),
            count: this.#count,
        }
    }

    #pushChar(char: string): void | Promise<void> {
        switch (this.#mode) {
            case 'objectStart':
                if (/\s/u.test(char)) return
                if (char !== '{') {
                    if (char === '[' || char === '"' || /[-0-9tfn]/u.test(char)) {
                        throw new TypeError('Unsupported chat package format')
                    }
                    throw new SyntaxError('Expected a JSON object')
                }
                this.#mode = 'propertyOrEnd'
                return
            case 'propertyOrEnd':
                if (/\s/u.test(char)) return
                if (char === '}') {
                    this.#mode = 'done'
                    return
                }
                if (char !== '"') throw new SyntaxError('Expected a JSON property')
                this.#propertyToken = '"'
                this.#propertyEscape = false
                this.#mode = 'property'
                return
            case 'property':
                this.#propertyToken += char
                if (this.#propertyEscape) {
                    this.#propertyEscape = false
                    return
                }
                if (char === '\\') {
                    this.#propertyEscape = true
                    return
                }
                if (char === '"') {
                    this.#propertyName = JSON.parse(this.#propertyToken)
                    this.#mode = 'colon'
                }
                return
            case 'colon':
                if (/\s/u.test(char)) return
                if (char !== ':') throw new SyntaxError('Expected a JSON property separator')
                this.#mode = 'valueStart'
                return
            case 'valueStart':
                if (/\s/u.test(char)) return
                if (this.#propertyName === 'data') {
                    if (char !== '[') throw new TypeError('Unsupported chat package format')
                    this.#dataSeen = true
                    this.#mode = 'dataItemOrEnd'
                    return
                }
                this.#resetValue()
                this.#mode = 'value'
                return this.#captureValueChar(char, false)
            case 'value':
                return this.#captureValueChar(char, false)
            case 'dataItemOrEnd':
                if (/\s/u.test(char)) return
                if (char === ']') {
                    this.#mode = 'afterData'
                    return
                }
                this.#resetValue()
                this.#mode = 'dataItem'
                return this.#captureValueChar(char, true)
            case 'dataItem':
                return this.#captureValueChar(char, true)
            case 'afterData':
                if (/\s/u.test(char)) return
                if (char === ',') {
                    this.#mode = 'propertyOrEnd'
                    return
                }
                if (char === '}') {
                    this.#mode = 'done'
                    return
                }
                throw new SyntaxError('Expected the end of the chat data property')
            case 'done':
                if (!/\s/u.test(char)) throw new SyntaxError('Unexpected data after JSON object')
        }
    }

    #resetValue(): void {
        this.#valueParts = []
        this.#valueBuffer = ''
        this.#valueDepth = 0
        this.#valueInString = false
        this.#valueEscape = false
    }

    #captureValueChar(char: string, dataItem: boolean): void | Promise<void> {
        if (this.#valueInString) {
            this.#appendValue(char)
            if (this.#valueEscape) {
                this.#valueEscape = false
            } else if (char === '\\') {
                this.#valueEscape = true
            } else if (char === '"') {
                this.#valueInString = false
            }
            return
        }

        if (char === '"') {
            this.#valueInString = true
            this.#appendValue(char)
            return
        }
        if (char === '{' || char === '[') {
            this.#valueDepth++
            this.#appendValue(char)
            return
        }
        if (char === '}' || char === ']') {
            if (this.#valueDepth > 0) {
                this.#valueDepth--
                this.#appendValue(char)
                return
            }
            if (dataItem && char === ']') {
                this.#mode = 'afterData'
                return this.#finishDataItem()
            }
            if (!dataItem && char === '}') {
                this.#finishMetadataValue()
                this.#mode = 'done'
                return
            }
            throw new SyntaxError('Unexpected JSON closing delimiter')
        }
        if (char === ',' && this.#valueDepth === 0) {
            if (dataItem) {
                this.#mode = 'dataItemOrEnd'
                return this.#finishDataItem()
            } else {
                this.#finishMetadataValue()
                this.#mode = 'propertyOrEnd'
            }
            return
        }
        this.#appendValue(char)
    }

    #finishMetadataValue(): void {
        const token = this.#takeValue().trim()
        if (!token) throw new SyntaxError('Missing JSON property value')
        this.#metadata[this.#propertyName] = JSON.parse(token)
    }

    #finishDataItem(): void | Promise<void> {
        const token = this.#takeValue().trim()
        if (!token) throw new SyntaxError('Missing chat array item')
        const chat = JSON.parse(token)
        const index = this.#count++
        return this.onChat(chat, index)
    }

    #appendValue(char: string): void {
        this.#valueBuffer += char
        if (this.#valueBuffer.length >= 16 * 1024) {
            this.#valueParts.push(this.#valueBuffer)
            this.#valueBuffer = ''
        }
    }

    #takeValue(): string {
        const value = this.#valueParts.length === 0
            ? this.#valueBuffer
            : this.#valueParts.join('') + this.#valueBuffer
        this.#valueParts = []
        this.#valueBuffer = ''
        return value
    }
}

export async function parsePackageChatsJson(
    stream: ReadableStream<Uint8Array>,
    onChat: (chat: unknown, index: number) => void | Promise<void>,
): Promise<ParsedPackageChats> {
    const parser = new PackageChatsStreamParser(onChat)
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await parser.push(decoder.decode(value, { stream: true }))
    }
    await parser.push(decoder.decode())
    return parser.finish()
}
