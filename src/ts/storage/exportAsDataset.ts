import { getCharacterInterchangeSnapshot, getDatabase } from "./database.svelte";
import { downloadFileParts } from "../globalApi.svelte";
import { notifySuccess } from "../alert";
import { language } from "src/lang";
import { streamCharacterChats } from "./interchangeChatStream";
import { encodePrettyJsonArray } from "./streamedJson";

export interface DatasetExportRow {
    name: string
    description: string
    chats: unknown
    lorebook: unknown
}

export async function* streamDatasetRows(): AsyncGenerator<DatasetExportRow> {
    const characterCount = getDatabase().characters.length
    for(let characterIndex = 0; characterIndex < characterCount; characterIndex++){
        const snapshot = getCharacterInterchangeSnapshot(characterIndex)
        if(!snapshot) continue
        const char = snapshot.character
        for await(const chat of streamCharacterChats(characterIndex, snapshot)){
            yield {
                name: char.name,
                description: char.desc,
                chats: chat.message,
                lorebook: char.globalLore,
            }
        }
    }
}

export async function encodeDatasetBlobParts(
    rows: AsyncIterable<DatasetExportRow>|Iterable<DatasetExportRow>,
): Promise<Blob[]> {
    const parts: Blob[] = []
    for await(const chunk of encodePrettyJsonArray(rows, 4)){
        // Blob construction takes an immutable snapshot of the freshly encoded
        // row, letting the Uint8Array/string graph be released before the next.
        parts.push(new Blob([chunk as unknown as BlobPart]))
    }
    return parts
}

export async function exportAsDataset(){
    const parts = await encodeDatasetBlobParts(streamDatasetRows())
    await downloadFileParts('dataset.json', parts, 'application/json')

    notifySuccess(language.successExport)
}
