import { get } from "svelte/store";
import { getDatabase, setDatabase, type Chat, type character } from "../storage/database.svelte";
import { selectedCharID } from "../stores.svelte";
import { alertInput, alertMd, alertNormal, alertSelect } from "../alert";
import { sayTTS } from "./tts";
import { risuChatParser } from "../parser/parser.svelte";
import { sendChat } from "./index.svelte";
import {
    captureGenerationOwnership,
    chatGenKey,
    endGenerationIfOwned,
    isChatGenerating,
} from "./generationState";
import { loadLoreBookV3Prompt } from "./lorebook.svelte";
import { runTrigger } from "./triggers";
import { setChatBackupReason } from "../storage/chatStorage";
import {
    SCRIPT_BULK_CHAT_BACKUP_REASON,
    splitScriptCommandPipeline,
} from "./scriptCapabilities";
import {
    captureChatPublicationGuard,
    publishTriggerChatToTarget,
    resolveChatSendTarget,
    type ChatPublicationGuard,
    type ChatSendTarget,
} from "./chatSendTarget";
import { safeStructuredClone } from "../polyfill";

export interface TriggerCommandContext {
    target: ChatSendTarget
    character: character
    chat: Chat
    chatPublicationGuard: ChatPublicationGuard
}

interface CommandExecutionState {
    trigger?: TriggerCommandContext
    destructiveChatMutation: boolean
    targetMissing: boolean
    chatPublicationGuard?: ChatPublicationGuard
}

export interface TriggerMultiCommandResult {
    result: false | string
    chat: Chat
    destructiveChatMutation: boolean
    targetMissing: boolean
    chatPublicationGuard?: ChatPublicationGuard
}

async function sendNestedChat(
    generationKey: string,
    target?: ChatSendTarget,
): Promise<boolean> {
    if(isChatGenerating(generationKey)) return false

    const pendingSend = sendChat(-1, target ? { target } : undefined)
    // sendChat registers synchronously before its first await. Because this
    // helper rejected a pre-existing entry above, the captured token belongs
    // to this nested send (and follows its auto-continue/resend chain).
    const ownership = captureGenerationOwnership(generationKey)
    try {
        return await pendingSend
    } finally {
        if(ownership){
            endGenerationIfOwned(generationKey, ownership)
        }
    }
}

export async function processMultiCommand(command:string) {
    return (await processMultiCommandInternal(command, {
        destructiveChatMutation: false,
        targetMissing: false,
    })).result
}

export async function processTriggerMultiCommand(
    command: string,
    context: TriggerCommandContext,
): Promise<TriggerMultiCommandResult> {
    const execution = await processMultiCommandInternal(command, {
        trigger: context,
        destructiveChatMutation: false,
        targetMissing: false,
        chatPublicationGuard: context.chatPublicationGuard,
    })
    return {
        result: execution.result,
        chat: execution.state.trigger!.chat,
        destructiveChatMutation: execution.state.destructiveChatMutation,
        targetMissing: execution.state.targetMissing,
        chatPublicationGuard: execution.state.chatPublicationGuard,
    }
}

async function processMultiCommandInternal(command:string, state:CommandExecutionState) {
    let pipe = ''
    const splited = splitScriptCommandPipeline(command)
    console.log(splited)
    for(let i = 0; i<splited.length; i++){
        const result = await processCommand(splited[i].trim(), pipe, state)
        console.log(pipe)
        if(result === false){
            return { result: false as const, state }
        }
        else{
            pipe = result
        }
    }
    return { result: pipe, state }
}


async function processCommand(
    command:string,
    pipe:string,
    state:CommandExecutionState,
):Promise<false | string>{
    const db = getDatabase()
    let currentChar: character
    let currentChat: Chat
    if(state.trigger){
        const resolvedTarget = resolveChatSendTarget(db, state.trigger.target)
        if(!resolvedTarget
            || resolvedTarget.chat._placeholder
            || state.trigger.character.chaId !== state.trigger.target.chaId
            || state.trigger.chat.id !== state.trigger.target.chatId){
            state.targetMissing = true
            return false
        }
        currentChar = state.trigger.character
        currentChat = state.trigger.chat
    }
    else{
        currentChar = db.characters[get(selectedCharID)]
        currentChat = currentChar?.chats?.[currentChar.chatPage]
        if(!currentChar || !currentChat){
            return false
        }
    }
    let {commandName, arg, namedArg} = commandParser(command, pipe)

    if(!arg){
        arg = pipe
    }

    arg = risuChatParser(arg, {
        chara: currentChar.type === 'character' ? currentChar : null
    })

    const namedArgKeys = Object.keys(namedArg)
    for(const key of namedArgKeys){
        namedArg[key] = risuChatParser(namedArg[key], {
            chara: currentChar.type === 'character' ? currentChar : null
        })
    }

    const commitOrdinaryMutation = () => {
        if(!state.trigger){
            setDatabase(db)
        }
    }

    const markActualDestructiveMutation = (previousLength: number) => {
        if(state.trigger && currentChat.message.length < previousLength){
            state.destructiveChatMutation = true
        }
    }

    switch(commandName){
        //STScript compatibility commands
        case 'input':{
            pipe = await alertInput(arg)
            return pipe
        }
        case 'echo':
        case 'popup':{
            alertNormal(arg)
            return pipe
        }
        case 'pass':{
            pipe = arg
            return pipe
        }
        case 'buttons': {
            if(namedArg.labels){
                try {
                    const JSONLabels = JSON.parse(namedArg.labels)
                    if(Array.isArray(JSONLabels)){
                        pipe = await alertSelect(JSONLabels)
                    }
                } catch (error) {}
            }
            return pipe
        }
        case 'setinput': {
            //NOT IMPLEMENTED
            return false
        }
        case 'speak': {
            if(currentChar){
                await sayTTS(currentChar, arg)
            }
            return pipe
        }
        case 'send': {
            currentChat.message.push({
                role: "user",
                data: arg
            })
            commitOrdinaryMutation()
            return pipe
        }
        case 'sendas': {
            //name not implemented
            currentChat.message.push({
                role: "char",
                data: arg
            })
            commitOrdinaryMutation()
            return pipe
        }
        case 'comment': {
            //works differently, but its close enough
            const addition = `<Comment>\n${arg}\n</Comment>`
            currentChat.message[currentChat.message.length-1].data += addition
            commitOrdinaryMutation()
            return pipe
        }
        case 'cut':{
            const previousLength = currentChat.message.length
            if(arg.includes('-')){
                const [start, end] = arg.split('-')
                currentChat.message = currentChat.message.slice(parseInt(start), parseInt(end))
                commitOrdinaryMutation()
            }
            else if(!isNaN(parseInt(arg))){
                const index = parseInt(arg)
                currentChat.message = currentChat.message.splice(index, 1)
                commitOrdinaryMutation()
            }
            else{ //For risu, doesn'ts work for STScript
                const id = arg
                currentChat.message = currentChat.message.filter((e)=>e.chatId !== id)
                commitOrdinaryMutation()
            }
            markActualDestructiveMutation(previousLength)
            return pipe
        }
        case 'del': {
            const previousLength = currentChat.message.length
            const size = parseInt(arg)
            if(!isNaN(size)){
                currentChat.message = currentChat.message.slice(currentChat.message.length-size)
                commitOrdinaryMutation()
            }
            markActualDestructiveMutation(previousLength)
            return pipe
        }
        case 'len':{
            try {
                const parsed = JSON.parse(arg)
                if(Array.isArray(parsed)){
                    pipe = parsed.length.toString()
                }
            } catch (error) {}
            return pipe
        }
        case 'multisend':{
            const splited = arg.split('|||')
            let clearMode = false
            if(splited[0] && splited[0].trim() === 'clear'){
                clearMode = true
                splited.shift()
            }
            for(const e of splited){
                const nestedGenerationKey = chatGenKey(
                    state.trigger?.target.chatId ?? currentChat.id,
                )
                if(isChatGenerating(nestedGenerationKey)){
                    return false
                }
                let clearedThisIteration = false
                if(clearMode){
                    clearedThisIteration = currentChat.message.length > 0
                    currentChat.message = []
                    if(clearedThisIteration && state.trigger){
                        state.destructiveChatMutation = true
                    }
                }
                currentChat.message.push({
                    role: 'user',
                    data: e
                })
                if(state.trigger){
                    const publishedTarget = publishTriggerChatToTarget(
                        getDatabase(),
                        state.trigger.target,
                        {
                            chat: currentChat,
                            destructiveChatMutation: clearedThisIteration,
                        },
                        ({ chaId, chatId }) => setChatBackupReason(
                            chaId,
                            chatId,
                            SCRIPT_BULK_CHAT_BACKUP_REASON,
                        ),
                        state.chatPublicationGuard,
                    )
                    if(!publishedTarget){
                        state.targetMissing = true
                        return false
                    }
                    const sent = await sendNestedChat(
                        nestedGenerationKey,
                        state.trigger.target,
                    )
                    if(!sent) return false
                    const refreshedTarget = resolveChatSendTarget(
                        getDatabase(),
                        state.trigger.target,
                    )
                    if(!refreshedTarget || refreshedTarget.chat._placeholder){
                        state.targetMissing = true
                        return false
                    }
                    currentChat = safeStructuredClone(refreshedTarget.chat)
                    state.trigger.chat = currentChat
                    state.chatPublicationGuard = captureChatPublicationGuard(
                        refreshedTarget.chat,
                    )
                    state.trigger.chatPublicationGuard = state.chatPublicationGuard
                    continue
                }
                const sent = await sendNestedChat(nestedGenerationKey)
                if(!sent) return false
            }
            return ''
        }
        case 'setvar':{
            console.log(namedArg, arg)
            currentChat.scriptstate = currentChat.scriptstate ?? {}
            currentChat.scriptstate['$' + namedArg['key']] = arg
            console.log(currentChat.scriptstate)
            commitOrdinaryMutation()
            return ''
        }
        case 'addvar':{
            currentChat.scriptstate = currentChat.scriptstate ?? {}
            currentChat.scriptstate['$' + namedArg['key']] = (
                Number(currentChat.scriptstate['$' + namedArg['key']]) + Number(arg)
            ).toString()
            commitOrdinaryMutation()
            return ''
        }
        case 'getvar':{
            currentChat.scriptstate = currentChat.scriptstate ?? {}
            pipe = currentChat.scriptstate['$' + namedArg['key']]?.toString() ?? 'null'
            return pipe
        }
        case 'test_lorebook':{
            const p = await loadLoreBookV3Prompt()
            console.log(p)
            alertNormal(p.actives.map((e)=>e.prompt).join('§'))
            return JSON.stringify(p)
        }
        case 'trigger':{
            if(!currentChar.chaId || !currentChat.id){
                return pipe
            }
            const triggerTarget = state.trigger?.target ?? {
                chaId: currentChar.chaId,
                chatId: currentChat.id,
            }
            const initialGuard = state.trigger?.chatPublicationGuard
                ?? captureChatPublicationGuard(currentChat)
            const triggerResult = await runTrigger(currentChar, 'manual', {
                chat: currentChat,
                manualName: arg,
                chatPublicationGuard: initialGuard,
            });

            if(triggerResult){
                if(state.trigger){
                    state.trigger.chat = triggerResult.chat
                    state.destructiveChatMutation ||= triggerResult.destructiveChatMutation === true
                    state.chatPublicationGuard = triggerResult.chatPublicationGuard
                        ?? initialGuard
                    state.trigger.chatPublicationGuard = state.chatPublicationGuard
                }
                else{
                    const publishedTarget = publishTriggerChatToTarget(
                        getDatabase(),
                        triggerTarget,
                        triggerResult,
                        ({ chaId, chatId }) => setChatBackupReason(
                            chaId,
                            chatId,
                            SCRIPT_BULK_CHAT_BACKUP_REASON,
                        ),
                        triggerResult.chatPublicationGuard ?? initialGuard,
                    )
                    if(!publishedTarget) return false
                }
            }
            return pipe
        }
        case '?':{
            alertMd(`
            # /input [text]
            - Show input dialog
            - Return input text
            - Example: /input Hello World
            # /echo [text]
            - Show alert dialog
            - Return input text
            - Example: /echo Hello World
            # /popup [text]
            - Show alert dialog
            - Return input text
            - Example: /popup Hello World
            # /pass [text]
            - Return input text
            - Example: /pass Hello World
            # /buttons [labels]
            - Show select dialog
            - Return selected label
            - Example: /buttons Yes§No
            # /speak [text]
            - Speak text
            - Example: /speak Hello World
            # /send [text]
            - Send text to chat
            - Example: /send Hello World
            # /sendas [text]
            - Send text to chat as character
            - Example: /sendas Hello World
            # /comment [text]
            - Add comment to chat
            - Example: /comment Hello World
            # /cut [index]
            - Cut chat message
            - Example: /cut 1
            # /del [size]
            - Delete chat message
            - Example: /del 1
            # /len [array]
            - Return length of array
            - Example: /len Hello§World
            # /setvar key=[key] [value]
            - Set variable
            - Example: /setvar key=hello world
            # /addvar key=[key] [value]
            - Add value to variable
            - Example: /addvar key=damage 10
            # /getvar key=[key]
            - Get variable
            - Example: /getvar key=damage
            # /trigger [name]
            - Run trigger
            # /?
            - Show help
            `)
            return 'help'
        }


    }
    return false
}


function commandParser(command:string, pipe:string){
    if(command.startsWith('/')){
        command = command.slice(1)
    }
    const sliced = command.split(' ').filter((e)=>e!='')
    const commandName = sliced[0]
    let argArray:string[] = []
    let namedArg:{[key:string]:string} = {}
    for(let i = 1; i<sliced.length; i++){
        if(sliced[i].includes('=')){
            const [key, value] = sliced[i].split('=')
            namedArg[key] = value
        }
        else{
            argArray.push(sliced[i])
        }
    }
    const arg = argArray.join(' ')
        .replace('{{pipe}}', pipe) //STScript compatibility
        .replace('{{slot}}', pipe) //Risu default
    return {commandName, arg, namedArg}

}
