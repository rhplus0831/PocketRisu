import { v4 } from 'uuid'
import { alertConfirm, alertError, alertStore, alertWait, notifySuccess } from './alert'
import { exportCharacterCard, importCharacterProcess } from './characterCards'
import { LocalWriter, markCharacterDirty, readImage } from './globalApi.svelte'
import { language } from 'src/lang'
import { type character, getCharacterInterchangeSnapshot, getDatabase, setDatabase, saveImage, normalizeChat } from './storage/database.svelte'
import type { Chat } from './storage/database.svelte'
import { chatToStub, saveChatToServer, stubToPlaceholder } from './storage/chatStorage'
import { selectFileByDom } from './util'
import { createBlankChar } from './characters'
import { CharXWriter } from './process/processzip'
import { checkCharOrder } from './globalApi.svelte'
import { getInlayAsset, setInlayAsset, getInlayInfosBatch, type InlayAsset } from './process/files/inlays'
import { getInlayMetasBatch, setInlayMeta } from './process/files/inlayMeta'
import { PngChunk } from './pngChunk'
import { reencodeImage } from './process/files/inlays'
import { MissingInterchangeChatError, streamCharacterChats } from './storage/interchangeChatStream'
import { encodePackageChatsJson, parsePackageChatsJson, type ParsedPackageChats } from './storage/streamedJson'
import { consumeZipEntries, consumeZipEntry, readZipEntryBytes, type ReplayableZipSource } from './process/zipStream'

// ── Types ──

export interface PackageManifest {
    type: 'risuCharacterPackage'
    version: 1
    createdAt: string
    character: {
        name: string
        file: string
        isEmpty?: boolean
    }
    chats?: {
        count: number
        file: string
    }
    personas?: {
        name: string
        originalId: string
        file: string
        icon?: string
        note?: string
        largePortrait?: boolean
    }[]
    inlays?: {
        count: number
        metaFile: string
        files: string[]
    }
}

interface InlayMetaEntry {
    name: string
    ext: string
    type: string
    width?: number
    height?: number
    createdAt?: number
    updatedAt?: number
    charId?: string
    chatId?: string
}

type PackagePersona = ReturnType<typeof getDatabase>['personas'][number]

// ── Helpers ──

const INLAY_REF_REGEX = /\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/g

export function scanCharacterInlayIds(char: character): Set<string> {
    const ids = new Set<string>()
    if (!Array.isArray(char?.chats)) return ids
    for (const chat of char.chats) {
        scanChatInlayIds(chat, ids)
    }
    return ids
}

function scanChatInlayIds(chat: Chat, ids: Set<string>): void {
    if (!Array.isArray(chat?.message)) return
    for (const msg of chat.message) {
        if (typeof msg?.data !== 'string') continue
        const regex = new RegExp(INLAY_REF_REGEX.source, 'g')
        let match: RegExpExecArray | null
        while ((match = regex.exec(msg.data)) !== null) {
            ids.add(match[1])
        }
    }
}

export function getCharacterBoundPersonas(char: character): { persona: PackagePersona, id: string }[] {
    const seenIds = new Set<string>()
    if (!Array.isArray(char?.chats)) return []
    for (const chat of char.chats) {
        if (!chat.bindedPersona) continue
        seenIds.add(chat.bindedPersona)
    }
    return getBoundPersonasFromIds(seenIds)
}

function getBoundPersonasFromIds(ids: ReadonlySet<string>): { persona: PackagePersona, id: string }[] {
    const db = getDatabase()
    const result: { persona: PackagePersona, id: string }[] = []
    for (const id of ids) {
        const persona = db.personas.find(p => p.id === id)
        if (persona) {
            result.push({ persona, id })
        }
    }
    return result
}

function sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '') || 'unnamed'
}

async function buildPersonaPng(persona: { name: string, personaPrompt: string, icon: string, note?: string }): Promise<Uint8Array> {
    let img: Uint8Array
    if (!persona.icon) {
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 256
        const ctx = canvas.getContext('2d')
        if (ctx) {
            ctx.fillStyle = 'rgb(100, 116, 139)'
            ctx.fillRect(0, 0, 256, 256)
        }
        const dataUrl = canvas.toDataURL('image/png')
        const base64 = dataUrl.split(',')[1]
        img = new Uint8Array(Buffer.from(base64, 'base64'))
    } else {
        img = await readImage(persona.icon)
    }

    const card = {
        name: persona.name,
        personaPrompt: persona.personaPrompt,
        note: persona.note,
    }

    img = (await PngChunk.write(await reencodeImage(img), {
        "persona": Buffer.from(JSON.stringify(card)).toString('base64')
    })) as Uint8Array

    return img
}

function base64ToUint8Array(base64: string): Uint8Array {
    const raw = base64.includes(',') ? base64.split(',')[1] : base64
    return new Uint8Array(Buffer.from(raw, 'base64'))
}

async function readStreamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.byteLength
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.byteLength
    }
    return result
}

// ── Shared import logic ──

export async function parseAndValidatePackage(
    file: { name: string, data: ReplayableZipSource },
): Promise<{ source: ReplayableZipSource, manifest: PackageManifest } | null> {
    alertWait(language.characterPackageProgressReading)

    const manifestBytes = await readZipEntryBytes(file.data, 'manifest.json')
    if (!manifestBytes) {
        alertError(language.characterPackageInvalidZip)
        return null
    }
    const manifest: PackageManifest = JSON.parse(new TextDecoder().decode(manifestBytes))
    if (manifest.type !== 'risuCharacterPackage' || manifest.version !== 1) {
        alertError(language.characterPackageInvalidZip)
        return null
    }

    return { source: file.data, manifest }
}

function buildImportSummary(manifest: PackageManifest): string {
    let summary = `${language.characterPackageImportSummary}\n\n`
    if (manifest.character.isEmpty) {
        summary += `• ${language.characterPackageCharacter}: (${language.characterPackageEmpty})\n`
    } else {
        summary += `• ${language.characterPackageCharacter}: ${manifest.character.name}\n`
    }
    if (manifest.chats) {
        summary += `• ${language.characterPackageChats}: ${manifest.chats.count}${language.characterPackageChatCount}\n`
    }
    if (manifest.personas && manifest.personas.length > 0) {
        summary += `• ${language.characterPackagePersona}: ${manifest.personas.map(p => p.name).join(', ')}\n`
    }
    if (manifest.inlays) {
        summary += `• ${language.characterPackageInlays}: ${manifest.inlays.count}${language.characterPackageInlayCount}\n`
    }
    return summary
}

type ProgressFn = (msg: string, subPct?: number) => void

async function importPersonas(
    manifest: PackageManifest,
    source: ReplayableZipSource,
    progress: ProgressFn
): Promise<Record<string, string>> {
    const personaIdMap: Record<string, string> = {}
    if (!manifest.personas || manifest.personas.length === 0) return personaIdMap

    progress(language.characterPackageProgressImportPersona)
    const db = getDatabase()
    const { AppendableBuffer: AB } = await import('./globalApi.svelte')
    const entriesByFile = new Map(manifest.personas.map(entry => [entry.file, entry]))
    const seenFiles = new Set<string>()

    await consumeZipEntries(source, new Set(entriesByFile.keys()), async (fileName, stream) => {
        const personaEntry = entriesByFile.get(fileName)
        if (!personaEntry) return
        seenFiles.add(fileName)
        const pngBytes = await readStreamBytes(stream)
        const readGenerator = PngChunk.readGenerator(pngBytes)
        let decoded: string | undefined
        for await (const chunk of readGenerator) {
            if (chunk && !(chunk instanceof AB) && chunk.key === 'persona') {
                decoded = chunk.value
                break
            }
        }

        if (!decoded) {
            console.warn(`[characterPackage] No persona data in ${personaEntry.file}, skipping`)
            return
        }

        const card: { name: string, personaPrompt: string, note?: string } = JSON.parse(
            Buffer.from(decoded, 'base64').toString('utf-8'),
        )
        const existing = db.personas.find(p =>
            p.id === personaEntry.originalId
            && p.name === card.name
            && p.personaPrompt === card.personaPrompt
            && (p.note ?? '') === (card.note ?? '')
            && (p.largePortrait ?? false) === (personaEntry.largePortrait ?? false)
            && p.icon === (personaEntry.icon ?? '')
        )

        if (existing) {
            // Exact duplicate — reuse existing, skip import
            personaIdMap[personaEntry.originalId] = existing.id
            return
        }

        const newId = v4()
        db.personas.push({
            name: card.name,
            icon: await saveImage(await reencodeImage(pngBytes)),
            personaPrompt: card.personaPrompt,
            note: card.note,
            id: newId,
        })
        personaIdMap[personaEntry.originalId] = newId
    })

    for (const personaEntry of manifest.personas) {
        if (!seenFiles.has(personaEntry.file)) {
            console.warn(`[characterPackage] Persona file ${personaEntry.file} not found, skipping`)
        }
    }

    return personaIdMap
}

async function readPackageChatsMetadata(
    source: ReplayableZipSource,
    fileName: string,
): Promise<ParsedPackageChats | null> {
    let metadata: ParsedPackageChats | null = null
    const found = await consumeZipEntry(source, fileName, async stream => {
        metadata = await parsePackageChatsJson(stream, () => {})
    })
    return found ? metadata : null
}

export type PackageChatImportResult =
    | { status: 'not-declared', count: 0 }
    | { status: 'imported', count: number }
    | { status: 'failed', reason: string }

function describePackageChatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function packageChatFailure(reason: string): PackageChatImportResult {
    return { status: 'failed', reason }
}

export async function importChatsToCharacter(
    manifest: PackageManifest,
    source: ReplayableZipSource,
    targetChar: character,
    personaIdMap: Record<string, string>,
    progress: ProgressFn,
    mode: 'replace' | 'append' = 'replace'
): Promise<PackageChatImportResult> {
    if (!manifest.chats) return { status: 'not-declared', count: 0 }

    progress(language.characterPackageProgressImportChats)
    const declaredChats = manifest.chats
    let chatsMetadata: ParsedPackageChats | null
    try {
        chatsMetadata = await readPackageChatsMetadata(source, declaredChats.file)
    } catch (error) {
        return packageChatFailure(
            `Declared chats entry "${declaredChats.file}" is invalid or unreadable: ${describePackageChatError(error)}`,
        )
    }
    if (!chatsMetadata) {
        return packageChatFailure(`Declared chats entry "${declaredChats.file}" is missing from the package.`)
    }
    if (!Number.isSafeInteger(declaredChats.count) || declaredChats.count < 0) {
        return packageChatFailure(`Manifest declares an invalid chat count: ${String(declaredChats.count)}.`)
    }
    if (chatsMetadata.count !== declaredChats.count) {
        return packageChatFailure(
            `Declared chats entry "${declaredChats.file}" contains ${chatsMetadata.count} chat rows, but the manifest declares ${declaredChats.count}.`,
        )
    }

    type ImportedFolder = { id: string, name?: string, color?: string, folded: boolean }
    const importedFolders = Array.isArray(chatsMetadata.folders)
        ? chatsMetadata.folders as ImportedFolder[]
        : null
    const folderIdMap: Record<string, string> = {}

    if (mode === 'append') {
        // Remap folder IDs that collide with existing ones
        if (importedFolders) {
            const existingFolders = targetChar.chatFolders ?? []
            for (const folder of importedFolders) {
                if (existingFolders.some(f => f.id === folder.id)) {
                    const newId = v4()
                    folderIdMap[folder.id] = newId
                    folder.id = newId
                } else {
                    folderIdMap[folder.id] = folder.id
                }
            }
        }
    }

    const placeholders: Chat[] = []
    let parsedCount = 0
    let importedMetadataCount: number | null = null
    let found = false
    try {
        found = await consumeZipEntry(source, declaredChats.file, async stream => {
            const importedMetadata = await parsePackageChatsJson(stream, async rawChat => {
                const chat = rawChat as Chat
                if (chat.bindedPersona && personaIdMap[chat.bindedPersona]) {
                    chat.bindedPersona = personaIdMap[chat.bindedPersona]
                }
                if (chat.folderId && folderIdMap[chat.folderId]) {
                    chat.folderId = folderIdMap[chat.folderId]
                }
                chat.id = v4()
                const normalized = normalizeChat(chat)
                await saveChatToServer(targetChar.chaId, parsedCount, chat.id, normalized)
                placeholders.push(stubToPlaceholder(chatToStub(normalized)))
                parsedCount++
            })
            importedMetadataCount = importedMetadata.count
        })
    } catch (error) {
        return packageChatFailure(
            `Declared chats entry "${declaredChats.file}" could not be imported: ${describePackageChatError(error)}`,
        )
    }
    if (!found) {
        return packageChatFailure(`Declared chats entry "${declaredChats.file}" is missing from the package.`)
    }
    if (importedMetadataCount !== declaredChats.count || parsedCount !== declaredChats.count) {
        return packageChatFailure(
            `Declared chats entry "${declaredChats.file}" contains ${parsedCount} imported chat rows, but the manifest declares ${declaredChats.count}.`,
        )
    }

    if (mode === 'append') {
        targetChar.chats = [...placeholders, ...(targetChar.chats ?? [])]
        if (importedFolders) {
            targetChar.chatFolders = [...importedFolders, ...(targetChar.chatFolders ?? [])]
        }
    } else {
        targetChar.chats = placeholders
        if (importedFolders) targetChar.chatFolders = importedFolders
        targetChar.chatPage = 0
    }
    return { status: 'imported', count: parsedCount }
}

async function importInlays(
    manifest: PackageManifest,
    source: ReplayableZipSource,
    targetCharId: string,
    importCurrentStep: number,
    importTotalSteps: number,
    progressLabel: string
): Promise<void> {
    if (!manifest.inlays || manifest.inlays.files.length === 0) return

    let metaMap: Record<string, InlayMetaEntry> = {}
    if (manifest.inlays.metaFile) {
        const metaBytes = await readZipEntryBytes(source, manifest.inlays.metaFile)
        if (metaBytes) {
            metaMap = JSON.parse(new TextDecoder().decode(metaBytes))
        }
    }

    const allInlayIds = manifest.inlays.files.map(fp => {
        const fn = fp.split('/').pop() || ''
        const dot = fn.lastIndexOf('.')
        return dot > 0 ? fn.substring(0, dot) : fn
    })
    const existingInfos = await getInlayInfosBatch(allInlayIds)

    let processed = 0
    let skipped = 0
    const selectedFiles = new Set(manifest.inlays.files)
    await consumeZipEntries(source, selectedFiles, async (filePath, stream) => {
        processed++
        const fileBytes = await readStreamBytes(stream)

        const fileName = filePath.split('/').pop() || ''
        const lastDot = fileName.lastIndexOf('.')
        const id = lastDot > 0 ? fileName.substring(0, lastDot) : fileName
        const ext = lastDot > 0 ? fileName.substring(lastDot + 1) : 'png'

        if (existingInfos[id]) {
            skipped++
            return
        }

        alertStore.set({
            type: 'progress',
            msg: `${progressLabel} (${importCurrentStep + 1}/${importTotalSteps})\n${language.characterPackageProgressImportInlays} (${processed - skipped}/${manifest.inlays.files.length - skipped})`,
            submsg: String(((importCurrentStep + (processed - skipped) / (manifest.inlays.files.length - skipped || 1)) / importTotalSteps * 100).toFixed(0))
        })

        const meta = metaMap[id]
        const blob = new Blob([fileBytes as unknown as BlobPart], { type: `image/${ext}` })

        await setInlayAsset(id, {
            data: blob,
            ext: meta?.ext || ext,
            name: meta?.name || id,
            type: (meta?.type as InlayAsset['type']) || 'image',
            width: meta?.width,
            height: meta?.height,
        })

        if (meta?.createdAt) {
            await setInlayMeta(id, {
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt || Date.now(),
                charId: targetCharId,
                chatId: meta.chatId,
            })
        }
    })
}

// ── Export ──

export async function exportCharacterPackage(
    charIndex: number,
    options: {
        includeCharacter: boolean
        includeChats: boolean
        includePersona: boolean
        includeInlays: boolean
    }
): Promise<void> {
    try {
        const snapshot = getCharacterInterchangeSnapshot(charIndex)
        if (!snapshot) {
            alertError('Character not found')
            return
        }
        const char = snapshot.character

        const charName = sanitizeFilename(char.name || 'character')

        // Preserve the existing fail-closed preflight and summary contents, but
        // inspect at most two detached/fetched rows at a time.
        const boundPersonaIds = new Set<string>()
        const inlayIds = new Set<string>()
        try {
            for await (const chat of streamCharacterChats(charIndex, snapshot)) {
                if (options.includePersona && chat.bindedPersona) {
                    boundPersonaIds.add(chat.bindedPersona)
                }
                if (options.includeInlays) {
                    scanChatInlayIds(chat, inlayIds)
                }
            }
        } catch (error) {
            if (error instanceof MissingInterchangeChatError) {
                alertError(`${error.message} Export aborted to prevent data loss.`)
                return
            }
            throw error
        }

        // Confirm
        let summary = `${language.characterPackage}\n\n`
        if (options.includeCharacter) {
            summary += `• ${language.characterPackageCharacter}: ${char.name}\n`
        } else {
            summary += `• ${language.characterPackageCharacter}: (${language.characterPackageEmpty})\n`
        }
        if (options.includeChats) {
            summary += `• ${language.characterPackageChats}: ${snapshot.chats.length}${language.characterPackageChatCount}\n`
        }
        const boundPersonas = options.includePersona ? getBoundPersonasFromIds(boundPersonaIds) : []
        if (options.includePersona && boundPersonas.length > 0) {
            summary += `• ${language.characterPackagePersona}: ${boundPersonas.map(p => p.persona.name).join(', ')}\n`
        }
        if (options.includeInlays && inlayIds.size > 0) {
            summary += `• ${language.characterPackageInlays}: ${inlayIds.size}${language.characterPackageInlayCount}\n`
        }

        const confirmed = await alertConfirm(summary)
        if (!confirmed) return

        // Count total steps for progress
        const totalSteps =
            (options.includeCharacter ? 1 : 0)
            + (options.includeChats && snapshot.chats.length > 0 ? 1 : 0)
            + (options.includePersona && boundPersonas.length > 0 ? 1 : 0)
            + (options.includeInlays && inlayIds.size > 0 ? 1 : 0)
            + 1 /* finalize */
        let currentStep = 0
        const progress = (msg: string) => {
            currentStep++
            alertStore.set({
                type: 'progress',
                msg: `${language.characterPackageExport} (${currentStep}/${totalSteps})\n${msg}`,
                submsg: String(((currentStep - 1) / totalSteps * 100).toFixed(0))
            })
        }

        // 2. Open outer package ZIP via streaming
        const localWriter = new LocalWriter()
        await localWriter.init(`${charName}_package`, ['zip'])
        const zipWriter = new CharXWriter(localWriter)

        const manifest: PackageManifest = {
            type: 'risuCharacterPackage',
            version: 1,
            createdAt: new Date().toISOString(),
            character: { name: char.name, file: '', isEmpty: !options.includeCharacter },
        }

        // 1. Build and write charx (only if character included)
        if (options.includeCharacter) {
            progress(language.characterPackageProgressCharacter)
            char.image = char.image || ''
            if (!char.image) {
                const res = await fetch('/none.webp')
                const data = new Uint8Array(await res.arrayBuffer())
                const { saveAsset } = await import('./globalApi.svelte')
                char.image = await saveAsset(data)
            }
            const charxPath = `character/${charName}.charx`
            await zipWriter.writeEntry(charxPath, async writer => {
                await exportCharacterCard(char, 'charx', {
                    writer,
                    spec: 'v3',
                    onProgress: (msg, pct) => {
                        alertStore.set({
                            type: 'progress',
                            msg: `${language.characterPackageExport} (${currentStep}/${totalSteps})\n${msg}`,
                            submsg: String(((currentStep - 1 + pct / 100) / totalSteps * 100).toFixed(0))
                        })
                    }
                })
            })
            manifest.character.file = charxPath
        }

        // 4. Write chats
        if (options.includeChats && snapshot.chats.length > 0) {
            progress(language.characterPackageProgressChats)
            const chatsPath = 'chats/chats.json'
            await zipWriter.writeIterable(
                chatsPath,
                encodePackageChatsJson(
                    streamCharacterChats(charIndex, snapshot),
                    char.chatFolders ?? [],
                ),
                6,
            )
            manifest.chats = { count: snapshot.chats.length, file: chatsPath }
        }

        // 5. Write personas
        if (options.includePersona && boundPersonas.length > 0) {
            progress(language.characterPackageProgressPersona)
            manifest.personas = []
            const usedNames = new Set<string>()
            for (const { persona, id } of boundPersonas) {
                let safeName = sanitizeFilename(persona.name || 'persona')
                let uniqueName = safeName
                let counter = 1
                while (usedNames.has(uniqueName)) {
                    uniqueName = `${safeName}_${counter++}`
                }
                usedNames.add(uniqueName)

                const pngBytes = await buildPersonaPng(persona)
                const personaPath = `persona/${uniqueName}.png`
                await zipWriter.write(personaPath, pngBytes)
                manifest.personas.push({
                    name: persona.name,
                    originalId: id,
                    file: personaPath,
                    icon: persona.icon,
                    note: persona.note,
                    largePortrait: persona.largePortrait,
                })
            }
        }

        // 6. Write inlays
        if (options.includeInlays && inlayIds.size > 0) {
            const ids = [...inlayIds]
            const metaMap: Record<string, InlayMetaEntry> = {}
            const inlayFiles: string[] = []
            let processed = 0

            const [infos, metas] = await Promise.all([
                getInlayInfosBatch(ids),
                getInlayMetasBatch(ids),
            ])

            for (const id of ids) {
                processed++
                alertStore.set({
                    type: 'progress',
                    msg: `${language.characterPackageExport} (${currentStep + 1}/${totalSteps})\n${language.characterPackageProgressInlays} (${processed}/${ids.length})`,
                    submsg: String(((currentStep + processed / ids.length) / totalSteps * 100).toFixed(0))
                })

                const asset = await getInlayAsset(id)
                if (!asset) {
                    console.warn(`[characterPackage] Inlay ${id} not found, skipping`)
                    continue
                }

                const ext = asset.ext || 'png'
                const filePath = `inlays/${id}.${ext}`
                const imageData = base64ToUint8Array(asset.data as string)
                await zipWriter.write(filePath, imageData)
                inlayFiles.push(filePath)

                const info = infos[id]
                const meta = metas[id]
                metaMap[id] = {
                    name: asset.name || id,
                    ext,
                    type: asset.type || 'image',
                    width: asset.width ?? info?.width,
                    height: asset.height ?? info?.height,
                    createdAt: meta?.createdAt,
                    updatedAt: meta?.updatedAt,
                    charId: meta?.charId,
                    chatId: meta?.chatId,
                }
            }
            currentStep++

            if (inlayFiles.length > 0) {
                const metaPath = 'inlays/meta.json'
                await zipWriter.write(metaPath, JSON.stringify(metaMap, null, 2), 6)
                manifest.inlays = { count: inlayFiles.length, metaFile: metaPath, files: inlayFiles }
            }
        }

        // 7. Write manifest (last)
        progress(language.characterPackageProgressFinalizing)
        await zipWriter.write('manifest.json', JSON.stringify(manifest, null, 2), 6)
        await zipWriter.end()

        notifySuccess(language.characterPackageExportSuccess)
    } catch (error) {
        alertError(error)
    }
}

// ── Import (new character) ──

async function selectCharacterPackageFile(): Promise<{ name: string, data: File } | null> {
    const files = await selectFileByDom(['zip'], 'single')
    const file = files?.[0]
    return file ? { name: file.name, data: file } : null
}

export async function importCharacterPackage(): Promise<void> {
    try {
        const file = await selectCharacterPackageFile()
        if (!file) return

        const parsed = await parseAndValidatePackage(file)
        if (!parsed) return
        const { source, manifest } = parsed

        // Warn if character is empty
        let summary = buildImportSummary(manifest)
        if (manifest.character.isEmpty) {
            summary += `\n⚠ ${language.characterPackageEmptyWarning}`
        }

        const confirmed = await alertConfirm(summary)
        if (!confirmed) return

        const progressLabel = language.characterPackageImport
        const importTotalSteps =
            1 /* character */
            + (manifest.personas && manifest.personas.length > 0 ? 1 : 0)
            + (manifest.chats ? 1 : 0)
            + (manifest.inlays && manifest.inlays.files.length > 0 ? 1 : 0)
        let importCurrentStep = 0
        const importProgress: ProgressFn = (msg) => {
            importCurrentStep++
            alertStore.set({
                type: 'progress',
                msg: `${progressLabel} (${importCurrentStep}/${importTotalSteps})\n${msg}`,
                submsg: String(((importCurrentStep - 1) / importTotalSteps * 100).toFixed(0))
            })
        }

        // Import character
        let newCharIndex: number
        if (manifest.character.isEmpty || !manifest.character.file) {
            importProgress(language.characterPackageProgressImportChar)
            const db = getDatabase()
            const blankChar = createBlankChar()
            blankChar.name = manifest.character.name || ''
            db.characters.push(blankChar)
            setDatabase(db)
            newCharIndex = db.characters.length - 1
        } else {
            importProgress(language.characterPackageProgressImportChar)
            let result: number | null = null
            const found = await consumeZipEntry(source, manifest.character.file, async stream => {
                result = await importCharacterProcess({
                    name: manifest.character.file.split('/').pop() || 'package.charx',
                    data: stream,
                })
            })
            if (!found) {
                alertError('Character file not found in package')
                return
            }
            if (result === undefined || result === null) {
                alertError('Failed to import character from package')
                return
            }
            newCharIndex = result
        }

        let db = getDatabase()

        try {
            const newChar = db.characters[newCharIndex] as character

            const personaIdMap = await importPersonas(manifest, source, importProgress)
            const chatImport = await importChatsToCharacter(manifest, source, newChar, personaIdMap, importProgress)
            if (chatImport.status === 'failed') throw new Error(chatImport.reason)
            // A new character can be imported while the home screen or another
            // character is selected. Chat rows were already routed through the
            // per-row storage API; explicitly publish their placeholder block.
            markCharacterDirty(newChar.chaId)
            await importInlays(manifest, source, newChar.chaId, importCurrentStep, importTotalSteps, progressLabel)

            setDatabase(db)
            checkCharOrder()
            notifySuccess(language.characterPackageImportSuccess)
        } catch (error) {
            db.characters.splice(newCharIndex, 1)
            setDatabase(db)
            throw error
        }
    } catch (error) {
        alertError(error)
    }
}

// ── Import to existing character ──

export async function importPackageToCharacter(charIndex: number): Promise<void> {
    try {
        const file = await selectCharacterPackageFile()
        if (!file) return

        const parsed = await parseAndValidatePackage(file)
        if (!parsed) return
        const { source, manifest } = parsed

        const db = getDatabase()
        const targetChar = db.characters[charIndex] as character
        if (!targetChar) {
            alertError('Character not found')
            return
        }

        // Warn if character names differ
        if (!manifest.character.isEmpty && manifest.character.name !== targetChar.name) {
            const nameConfirmed = await alertConfirm(language.characterPackageNameMismatch)
            if (!nameConfirmed) return
        }

        // Show summary
        const summary = buildImportSummary(manifest)
        const confirmed = await alertConfirm(summary)
        if (!confirmed) return

        const progressLabel = language.characterPackageImportToChar
        const importTotalSteps =
            (manifest.personas && manifest.personas.length > 0 ? 1 : 0)
            + (manifest.chats ? 1 : 0)
            + (manifest.inlays && manifest.inlays.files.length > 0 ? 1 : 0)
        if (importTotalSteps === 0) {
            notifySuccess(language.characterPackageImportSuccess)
            return
        }
        let importCurrentStep = 0
        const importProgress: ProgressFn = (msg) => {
            importCurrentStep++
            alertStore.set({
                type: 'progress',
                msg: `${progressLabel} (${importCurrentStep}/${importTotalSteps})\n${msg}`,
                submsg: String(((importCurrentStep - 1) / importTotalSteps * 100).toFixed(0))
            })
        }

        const personaIdMap = await importPersonas(manifest, source, importProgress)
        const chatImport = await importChatsToCharacter(
            manifest,
            source,
            targetChar,
            personaIdMap,
            importProgress,
            'append',
        )
        if (chatImport.status === 'failed') throw new Error(chatImport.reason)
        markCharacterDirty(targetChar.chaId)
        await importInlays(manifest, source, targetChar.chaId, importCurrentStep, importTotalSteps, progressLabel)

        setDatabase(db)
        notifySuccess(language.characterPackageImportSuccess)
    } catch (error) {
        alertError(error)
    }
}
