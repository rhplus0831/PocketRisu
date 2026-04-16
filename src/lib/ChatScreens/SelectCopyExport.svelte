<script lang="ts">
    import { DownloadIcon, XIcon, GlobeIcon } from "@lucide/svelte"
    import { language } from "../../lang"
    import { alertClear, alertError, alertNormal, alertWait } from "../../ts/alert"
    import { ParseMarkdown, type CbsConditions, assetRegex } from "../../ts/parser/parser.svelte"
    import { risuChatParser } from "../../ts/parser/parser.svelte"
    import { getCurrentCharacter, type Message } from "../../ts/storage/database.svelte"
    import { DBState, selectedCharID, createSimpleCharacter } from "../../ts/stores.svelte"
    import { findCharacterbyId, getUserName, pickHashRand } from "../../ts/util"
    import { downloadFile } from "../../ts/globalApi.svelte"
    import { getModuleAssets } from "../../ts/process/modules"
    import { get } from "svelte/store"

    interface Props {
        active: boolean
        onclose: () => void
    }

    let { active = $bindable(false), onclose }: Props = $props()

    let rangeStart: number | null = $state(null)
    let rangeEnd: number | null = $state(null)

    function getChat() {
        const charIdx = get(selectedCharID)
        const char = DBState.db.characters[charIdx]
        return char?.chats?.[char.chatPage]
    }

    function getMessages(): Message[] {
        return getChat()?.message ?? []
    }

    function handleMessageClick(idx: number) {
        if (rangeStart === null) {
            rangeStart = idx
            rangeEnd = null
        } else if (rangeEnd === null) {
            if (idx < rangeStart) {
                rangeEnd = rangeStart
                rangeStart = idx
            } else {
                rangeEnd = idx
            }
        } else {
            // Reset and start new selection
            rangeStart = idx
            rangeEnd = null
        }
    }

    function isInRange(idx: number): boolean {
        if (rangeStart === null) return false
        if (rangeEnd === null) return idx === rangeStart
        return idx >= rangeStart && idx <= rangeEnd
    }

    function cancel() {
        rangeStart = null
        rangeEnd = null
        active = false
        onclose()
    }

    async function fetchReadonlyKey(): Promise<string> {
        try {
            const res = await fetch('/api/asset-readonly-key')
            if (res.ok) {
                const data = await res.json()
                return data.key || ''
            }
        } catch (e) {
            console.error('Failed to fetch readonly key:', e)
        }
        return ''
    }

    function makeAbsoluteAssetUrl(url: string, rk: string): string {
        if (!url) return url
        if (url.startsWith('/api/asset/')) {
            const base = window.location.origin
            const absUrl = `${base}${url}`
            if (!rk) return absUrl
            const sep = absUrl.includes('?') ? '&' : '?'
            return `${absUrl}${sep}rk=${rk}`
        }
        return url
    }

    function storageKeyToUrl(storagePath: string, rk: string): string {
        const hex = Buffer.from(storagePath, 'utf-8').toString('hex')
        const base = window.location.origin
        const url = `${base}/api/asset/${hex}`
        if (!rk) return url
        return `${url}?rk=${rk}`
    }

    function inlayAssetUrl(id: string, rk: string): string {
        return storageKeyToUrl(`inlay/${id}`, rk)
    }

    const videoExtensions = ['mp4', 'webm', 'avi', 'm4p', 'm4v']

    function preResolveAssets(data: string, char: any, rk: string, chatIdx: number): string {
        type AssetEntry = { srcPaths: string[]; ext?: string }
        const assetPaths: Record<string, AssetEntry> = {}
        for (const asset of (char.additionalAssets ?? [])) {
            const key = asset[0].toLocaleLowerCase()
            assetPaths[key] ??= { srcPaths: [], ext: asset[2] }
            if (assetPaths[key].ext === asset[2]) {
                assetPaths[key].srcPaths.push(asset[1])
            }
        }
        for (const asset of getModuleAssets()) {
            const key = asset[0].toLocaleLowerCase()
            assetPaths[key] ??= { srcPaths: [], ext: asset[2] }
            if (assetPaths[key].ext === asset[2]) {
                assetPaths[key].srcPaths.push(asset[1])
            }
        }

        const emoPaths: Record<string, { srcPaths: string[] }> = {}
        for (const emo of (char.emotionImages ?? [])) {
            emoPaths[emo[0].toLocaleLowerCase()] = { srcPaths: [emo[1]] }
        }

        const assetWidthString = (DBState.db.assetWidth && DBState.db.assetWidth !== -1 || DBState.db.assetWidth === 0)
            ? `max-width:${DBState.db.assetWidth}rem;` : ''

        let cx: number | null = null

        return data.replace(assetRegex, (full: string, type: string, name: string) => {
            name = name.toLocaleLowerCase()

            if (type === 'emotion') {
                const srcPath = emoPaths[name]?.srcPaths?.[0]
                if (!srcPath) return ''
                const url = storageKeyToUrl(srcPath, rk)
                return `<img src="${url}" alt="${name}" style="${assetWidthString}"/>`
            }

            if (type === 'source') {
                if (name === 'char' && char.image) {
                    return storageKeyToUrl(char.image, rk)
                }
                if (name === 'user') {
                    const userIcon = DBState.db.personas?.[DBState.db.selectedPersona]?.icon
                    return userIcon ? storageKeyToUrl(userIcon, rk) : ''
                }
                return ''
            }

            const match = assetPaths[name]
            if (!match) return ''

            let pSrc = match.srcPaths[0]
            if (match.srcPaths.length > 1) {
                if (cx === null) {
                    cx = pickHashRand(chatIdx, (char.chaId || 'global') + chatIdx)
                }
                pSrc = match.srcPaths[Math.floor(cx * match.srcPaths.length)]
            }

            const url = storageKeyToUrl(pSrc, rk)
            switch (type) {
                case 'raw':
                case 'path':
                    return url
                case 'img':
                    return `<img src="${url}" alt="${name}" style="${assetWidthString}"/>`
                case 'image':
                    return `<div class="risu-inlay-image"><img src="${url}" alt="${name}" style="${assetWidthString}"/></div>\n`
                case 'video':
                    return `<video controls autoplay loop><source src="${url}" type="video/mp4"></video>\n`
                case 'video-img':
                    return `<video autoplay muted loop><source src="${url}" type="video/mp4"></video>\n`
                case 'audio':
                    return `<audio controls autoplay loop><source src="${url}" type="audio/mpeg"></audio>\n`
                case 'bg':
                    return `<div style="width:100%;height:100%;background: linear-gradient(rgba(0,0,0,0.8),rgba(0,0,0,0.8)),url(${url}); background-size: cover;"></div>`
                case 'asset':
                    if (match.ext && videoExtensions.includes(match.ext)) {
                        return `<video autoplay muted loop><source src="${url}" type="video/mp4"></video>\n`
                    }
                    return `<img src="${url}" alt="${name}" style="${assetWidthString}"/>\n`
                case 'bgm':
                    return ''
            }
            return ''
        })
    }

    async function exportRenderedHTML() {
        if (rangeStart === null || rangeEnd === null) return

        try {
            alertWait(language.selectAndCopyGenerating || 'Generating HTML...')

            const rk = await fetchReadonlyKey()
            const messages = getMessages()
            const charIdx = get(selectedCharID)
            const char = DBState.db.characters[charIdx]
            const chat = char.chats[char.chatPage]
            const simpleChar = createSimpleCharacter(char)

            const root = document.querySelector(':root') as HTMLElement
            const textColor = root.style.getPropertyValue('--risu-theme-textcolor') || '#e0e0e0'
            const bgColor = root.style.getPropertyValue('--risu-theme-bgcolor') || '#1a1a2e'
            const darkBg = root.style.getPropertyValue('--risu-theme-darkbg') || '#16213e'
            const borderColor = root.style.getPropertyValue('--risu-theme-darkborderc') || '#333'
            const textColor2 = root.style.getPropertyValue('--risu-theme-textcolor2') || '#999'
            const quoteColor1 = root.style.getPropertyValue('--FontColorQuote1') || '#a8d8ea'
            const quoteColor2 = root.style.getPropertyValue('--FontColorQuote2') || '#fcbad3'
            const italicColor = root.style.getPropertyValue('--FontColorItalic') || '#ccc'
            const boldColor = root.style.getPropertyValue('--FontColorBold') || '#fff'
            const italicBoldColor = root.style.getPropertyValue('--FontColorItalicBold') || '#fff'
            const standardColor = root.style.getPropertyValue('--FontColorStandard') || textColor

            let chatContentHTML = ''

            const processAssetUrl = (url: string): string => {
                if (!url) return url
                if (url.startsWith('/api/asset/')) {
                    return makeAbsoluteAssetUrl(url, rk)
                }
                return url
            }

            for (let i = rangeStart; i <= rangeEnd; i++) {
                const msg = messages[i]
                if (!msg) continue

                const isUser = msg.role === 'user'
                const name = msg.saying
                    ? findCharacterbyId(msg.saying).name
                    : isUser
                        ? getUserName()
                        : char.name

                const cbsConditions: CbsConditions = {
                    firstmsg: i === 0 && !msg.role,
                    chatRole: msg.role ?? null,
                }

                let parsed = risuChatParser(msg.data, {
                    chara: name,
                    chatID: i,
                    rmVar: true,
                    visualize: true,
                    cbsConditions,
                })

                parsed = preResolveAssets(parsed, char, rk, i)

                let rendered = await ParseMarkdown(parsed, getCurrentCharacter(), 'normal', i, cbsConditions)

                const parser = new DOMParser()
                const doc = parser.parseFromString(rendered, 'text/html')

                doc.querySelectorAll('p').forEach((el) => {
                    el.setAttribute('style', `color: ${standardColor}; margin: 0.5em 0;`)
                })
                doc.querySelectorAll('em').forEach((el) => {
                    el.setAttribute('style', `font-style: italic; color: ${italicColor};`)
                })
                doc.querySelectorAll('strong').forEach((el) => {
                    el.setAttribute('style', `font-weight: bold; color: ${boldColor};`)
                })
                doc.querySelectorAll('em strong, strong em').forEach((el) => {
                    el.setAttribute('style', `font-weight: bold; font-style: italic; color: ${italicBoldColor};`)
                })
                doc.querySelectorAll('mark').forEach((el) => {
                    const d = el.getAttribute('risu-mark')
                    if (d === 'quote1' || d === 'quote2') {
                        const color = d === 'quote1' ? quoteColor1 : quoteColor2
                        const newEl = document.createElement('span')
                        newEl.textContent = el.textContent
                        newEl.setAttribute('style', `color: ${color};`)
                        el.replaceWith(newEl)
                    }
                })

                doc.querySelectorAll('img').forEach((img) => {
                    const src = img.getAttribute('src')
                    if (src) {
                        if (src.startsWith('blob:') || src.startsWith('data:')) {
                            const parent = img.closest('[data-inlay-id]')
                            const inlayId = parent?.getAttribute('data-inlay-id')
                            if (inlayId) {
                                img.setAttribute('src', inlayAssetUrl(inlayId, rk))
                            }
                        } else {
                            img.setAttribute('src', processAssetUrl(src))
                        }
                        img.setAttribute('style', 'max-width: 100%; border-radius: 8px; margin: 0.5em 0;')
                    }
                })

                doc.querySelectorAll('[data-inlay-id]').forEach((el) => {
                    const id = el.getAttribute('data-inlay-id')
                    const type = el.getAttribute('data-inlay-type') || 'inlay'
                    if (!id) { el.remove(); return }
                    const url = inlayAssetUrl(id, rk)
                    const img = document.createElement('img')
                    img.setAttribute('src', url)
                    img.setAttribute('style', 'max-width: 100%; border-radius: 8px; margin: 0.5em 0;')
                    el.replaceWith(img)
                })

                doc.querySelectorAll('video source').forEach((source) => {
                    const src = source.getAttribute('src')
                    if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
                        source.setAttribute('src', processAssetUrl(src))
                    }
                })

                doc.querySelectorAll('audio source').forEach((source) => {
                    const src = source.getAttribute('src')
                    if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
                        source.setAttribute('src', processAssetUrl(src))
                    }
                })

                doc.querySelectorAll('[style]').forEach((el) => {
                    const style = el.getAttribute('style')
                    if (style && style.includes('/api/asset/')) {
                        el.setAttribute('style', style.replace(
                            /url\(([^)]*\/api\/asset\/[^)]*)\)/g,
                            (_match, url) => `url(${processAssetUrl(url.replace(/['"]/g, ''))})`
                        ))
                    }
                })

                const roleLabel = isUser ? 'user' : 'char'
                chatContentHTML += `
                <div style="padding: 1rem; border-bottom: 1px solid ${borderColor};" data-role="${roleLabel}">
                    <div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 0.5rem; color: ${textColor};">${name}</div>
                    <div style="color: ${standardColor}; line-height: 1.6;">${doc.body.innerHTML}</div>
                </div>`
            }

            let charIconHtml = ''
            if (char.image) {
                const iconSrc = storageKeyToUrl(char.image, rk)
                charIconHtml = `<img src="${iconSrc}" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 2px solid ${borderColor};" alt="${char.name}">`
            }

            const fullHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${char.name} Chat</title>
</head>
<body style="margin: 0; padding: 1rem; background: ${bgColor};">
<div style="font-family: 'Segoe UI', Roboto, Arial, sans-serif; max-width: 700px; margin: 0 auto; background: ${bgColor}; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.3);">
    <div style="padding: 1rem; border-bottom: 1px solid ${borderColor}; display: flex; align-items: center; gap: 0.75rem;">
        ${charIconHtml}
        <div>
            <div style="font-weight: 700; font-size: 1.1rem; color: ${textColor};">${char.name}</div>
            <div style="font-size: 0.75rem; color: ${textColor2};">Messages ${rangeStart + 1}\u2013${rangeEnd + 1}</div>
        </div>
    </div>
    ${chatContentHTML}
    <div style="padding: 0.5rem 1rem; text-align: center; font-size: 0.7rem; color: ${textColor2}; opacity: 0.6;">From RisuAI</div>
</div>
</body>
</html>`

            const date = new Date().toJSON().replace(/[:.]/g, '-')
            const fileName = `${char.name}_${date}_chat.html`.replace(/[<>:"/\\|?*,]/g, '')
            await downloadFile(fileName, fullHTML)

            alertNormal(language.selectAndCopyDone || 'HTML file downloaded')
            cancel()
        } catch (e) {
            console.error('Select and Copy failed:', e)
            alertClear()
            alertError(`Failed to export: ${e.message}`)
        }
    }

    /**
     * Export selected messages as arca.live compatible HTML.
     */
    async function exportArcaHTML() {
        if (rangeStart === null || rangeEnd === null) return

        try {
            alertWait(language.selectAndCopyGenerating || 'Generating HTML...')

            const rk = await fetchReadonlyKey()
            const messages = getMessages()
            const charIdx = get(selectedCharID)
            const char = DBState.db.characters[charIdx]

            const root = document.querySelector(':root') as HTMLElement
            const rawAccent = root.style.getPropertyValue('--risu-theme-selected') || '#5a8fd8'
            const ACCENT = rawAccent.trim()
            const ACCENT_DARK = '#204880'
            const BG_MAIN = '#0c0e14'
            const BG_SECTION = '#111827'
            const BG_CODE = '#0a0e16'
            const BORDER = '#2a2a3a'
            const TEXT_MAIN = '#d8dce6'
            const TEXT_DIM = '#8a94a8'
            const TEXT_LABEL = '#556'

            function sanitizeForArca(html: string): string {
                const parser = new DOMParser()
                const doc = parser.parseFromString(html, 'text/html')

                const disallowed = ['script', 'style', 'link', 'template', 'svg', 'math',
                    'noscript', 'form', 'input', 'select', 'textarea', 'button',
                    'audio', 'object', 'picture', 'source', 'mark', 'small', 'big',
                    'code', 'kbd', 'samp', 'var', 'tt', 'abbr', 'cite', 'dfn', 'q',
                    'data', 'bdi', 'bdo', 'wbr', 'dl', 'dt', 'dd']
                for (const tag of disallowed) {
                    doc.querySelectorAll(tag).forEach(el => {
                        if (['code', 'kbd', 'samp', 'var', 'tt', 'mark', 'small', 'big', 'q', 'cite', 'dfn', 'abbr'].includes(tag)) {
                            const span = doc.createElement('span')
                            if (tag === 'code') {
                                span.setAttribute('style', `background:${BG_CODE};color:#c89ef0;padding:2px 6px;border-radius:4px;font-size:11px;font-family:monospace;`)
                            }
                            span.innerHTML = el.innerHTML
                            el.replaceWith(span)
                        } else {
                            el.remove()
                        }
                    })
                }

                doc.querySelectorAll('em').forEach(el => {
                    el.setAttribute('style', 'font-style:italic;color:#ccc;')
                })

                doc.querySelectorAll('strong').forEach(el => {
                    el.setAttribute('style', 'font-weight:bold;color:#fff;')
                })

                doc.querySelectorAll('[risu-mark]').forEach(el => {
                    const d = el.getAttribute('risu-mark')
                    const span = doc.createElement('span')
                    span.innerHTML = el.innerHTML
                    if (d === 'quote1') {
                        span.setAttribute('style', 'color:#a8d8ea;')
                    } else if (d === 'quote2') {
                        span.setAttribute('style', 'color:#fcbad3;')
                    }
                    el.replaceWith(span)
                })

                doc.querySelectorAll('img').forEach(img => {
                    const src = img.getAttribute('src')
                    if (src) {
                        if (src.startsWith('blob:')) {
                            const parent = img.closest('[data-inlay-id]')
                            const inlayId = parent?.getAttribute('data-inlay-id')
                            if (inlayId) {
                                img.setAttribute('src', inlayAssetUrl(inlayId, rk))
                            }
                        } else if (src.startsWith('/api/asset/')) {
                            img.setAttribute('src', makeAbsoluteAssetUrl(src, rk))
                        }
                    }
                    img.removeAttribute('class')
                    img.setAttribute('style', 'max-width:100%;max-height:400px;object-fit:cover;display:block;margin:4px auto;border-radius:8px;')
                })

                // Convert divs with background-image into img tags (height: 400px)
                doc.querySelectorAll('div[style]').forEach(div => {
                    const style = div.getAttribute('style') || ''
                    const bgMatch = style.match(/background(?:-image)?\s*:[^;]*url\(([^)]+)\)/i)
                    if (bgMatch) {
                        let imgUrl = bgMatch[1].replace(/['"]/g, '')
                        if (imgUrl.startsWith('/api/asset/')) {
                            imgUrl = makeAbsoluteAssetUrl(imgUrl, rk)
                        }
                        const img = doc.createElement('img')
                        img.setAttribute('src', imgUrl)
                        img.setAttribute('style', 'max-width:100%;max-height:400px;object-fit:cover;display:block;margin:4px auto;border-radius:8px;')
                        div.replaceWith(img)
                    }
                })

                doc.querySelectorAll('video').forEach(vid => {
                    const source = vid.querySelector('source')
                    const src = source?.getAttribute('src') || ''
                    if (src) {
                        const link = doc.createElement('a')
                        link.setAttribute('href', src.startsWith('/api/asset/') ? makeAbsoluteAssetUrl(src, rk) : src)
                        link.setAttribute('target', '_blank')
                        link.setAttribute('rel', 'noopener noreferrer')
                        link.setAttribute('style', `color:${ACCENT};font-size:12px;`)
                        link.textContent = '[Video]'
                        vid.replaceWith(link)
                    } else {
                        vid.remove()
                    }
                })

                doc.querySelectorAll('a').forEach(a => {
                    a.setAttribute('target', '_blank')
                    a.setAttribute('rel', 'noopener noreferrer')
                    if (!a.getAttribute('style')) {
                        a.setAttribute('style', `color:${ACCENT};`)
                    }
                })

                doc.querySelectorAll('p').forEach(el => {
                    el.setAttribute('style', `color:${TEXT_MAIN};margin:4px 0;`)
                })

                doc.querySelectorAll('blockquote').forEach(bq => {
                    bq.removeAttribute('style')
                    const inner = doc.createElement('div')
                    inner.setAttribute('style', `border-left:4px solid ${ACCENT};padding:8px 14px;background:linear-gradient(90deg,rgba(90,143,216,0.12),transparent);border-radius:0 8px 8px 0;margin:4px 0;`)
                    inner.innerHTML = bq.innerHTML
                    bq.innerHTML = ''
                    bq.appendChild(inner)
                })

                doc.querySelectorAll('pre').forEach(pre => {
                    pre.setAttribute('style', `background:${BG_CODE};color:#e8d5f0;padding:14px 16px;border-radius:8px;font-size:12px;line-height:1.8;border:1px solid #2a1a2a;border-left:3px solid ${ACCENT};`)
                })

                doc.querySelectorAll('hr').forEach(hr => {
                    hr.setAttribute('style', `border:none;border-top:1px solid ${BORDER};margin:12px 0;`)
                })

                doc.querySelectorAll('[class]').forEach(el => {
                    el.removeAttribute('class')
                })

                doc.querySelectorAll('[id]').forEach(el => {
                    el.removeAttribute('id')
                })

                doc.querySelectorAll('[style]').forEach(el => {
                    const style = el.getAttribute('style') || ''
                    const cleaned = cleanCssForArca(style)
                    if (cleaned) {
                        el.setAttribute('style', cleaned)
                    } else {
                        el.removeAttribute('style')
                    }
                })

                return doc.body.innerHTML
            }

            function cleanCssForArca(css: string): string {
                const blocked = [
                    /\bdisplay\s*:\s*(flex|grid|inline-grid)/i,
                    /\bposition\s*:/i,
                    /\bz-index\s*:/i,
                    /\boverflow\s*:/i,
                    /\bgap\s*:/i,
                    /\bgrid-template/i,
                    /\btransform\s*:/i,
                    /\banimation\s*:/i,
                    /\btransition\s*:/i,
                    /\bopacity\s*:/i,
                    /\bfilter\s*:/i,
                    /\bbackdrop-filter\s*:/i,
                    /\bmix-blend-mode\s*:/i,
                    /\bisolation\s*:/i,
                    /\bclip-path\s*:/i,
                    /\b-webkit-/i,
                    /\bcursor\s*:/i,
                    /\bpointer-events\s*:/i,
                    /\buser-select\s*:/i,
                    /\bresize\s*:/i,
                    /\boutline\s*:/i,
                    /\bwriting-mode\s*:/i,
                    /\bcontent\s*:/i,
                ]

                const parts = css.split(';').map(p => p.trim()).filter(Boolean)
                const allowed = parts.filter(part => {
                    return !blocked.some(re => re.test(part))
                })
                return allowed.join(';') + (allowed.length ? ';' : '')
            }

            let chatRows = ''

            for (let i = rangeStart; i <= rangeEnd; i++) {
                const msg = messages[i]
                if (!msg) continue

                const isUser = msg.role === 'user'
                const name = msg.saying
                    ? findCharacterbyId(msg.saying).name
                    : isUser
                        ? getUserName()
                        : char.name

                const cbsConditions: CbsConditions = {
                    firstmsg: i === 0 && !msg.role,
                    chatRole: msg.role ?? null,
                }

                let parsed = risuChatParser(msg.data, {
                    chara: name,
                    chatID: i,
                    rmVar: true,
                    visualize: true,
                    cbsConditions,
                })

                parsed = preResolveAssets(parsed, char, rk, i)
                let rendered = await ParseMarkdown(parsed, getCurrentCharacter(), 'normal', i, cbsConditions)

                const sanitized = sanitizeForArca(rendered)

                const nameColor = isUser ? '#a8d8ea' : ACCENT
                const roleBg = isUser
                    ? `background:linear-gradient(90deg,rgba(168,216,234,0.1),transparent);`
                    : `background:linear-gradient(90deg,rgba(90,143,216,0.1),transparent);`

                chatRows += `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid ${BORDER};vertical-align:top;">
        <div style="${roleBg}border-left:3px solid ${nameColor};padding:8px 14px;border-radius:0 8px 8px 0;">
          <div style="font-size:11px;font-weight:700;color:${nameColor};letter-spacing:1px;margin-bottom:6px;">${isUser ? '\u2709' : '\u2605'} ${escapeHtml(name)}</div>
          <div style="font-size:13px;color:${TEXT_MAIN};line-height:1.8;">${sanitized}</div>
        </div>
      </td>
    </tr>`
            }

            let charIconCell = ''
            if (char.image) {
                const iconSrc = storageKeyToUrl(char.image, rk)
                charIconCell = `
      <td style="display:table-cell;width:70px;vertical-align:middle;padding:0 12px 0 0;">
        <img src="${iconSrc}" style="width:56px;height:56px;border-radius:50%;border:2px solid ${ACCENT};" alt="${escapeHtml(char.name)}">
      </td>`
            }

            const fullHTML = `<div style="max-width:900px;margin:0 auto 24px auto;background:linear-gradient(160deg,${BG_MAIN},${BG_SECTION},${BG_MAIN});border:2px solid ${ACCENT};border-radius:14px;font-family:'Malgun Gothic',sans-serif;color:${TEXT_MAIN};">

  <div style="background:linear-gradient(135deg,${ACCENT},${ACCENT_DARK});padding:24px 20px;text-align:center;border-radius:12px 12px 0 0;">
    <div style="font-size:10px;letter-spacing:6px;color:rgba(255,255,255,0.5);margin-bottom:8px;">RISUAI CHAT LOG</div>
    <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:1px;">${escapeHtml(char.name)}</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:6px;letter-spacing:2px;">Messages ${rangeStart + 1} \u2013 ${rangeEnd + 1}</div>
  </div>

  <table style="width:100%;border-collapse:collapse;">
    <tbody>
${chatRows}
    </tbody>
  </table>

  <div style="padding:14px 24px;text-align:center;font-size:10px;color:${TEXT_LABEL};letter-spacing:2px;border-top:1px solid ${BORDER};border-radius:0 0 12px 12px;">
    From RisuAI
  </div>

</div>`

            const date = new Date().toJSON().replace(/[:.]/g, '-')
            const fileName = `${char.name}_${date}_arca.html`.replace(/[<>:"/\\|?*,]/g, '')
            await downloadFile(fileName, fullHTML)

            alertNormal(language.selectAndCopyDone || 'HTML file downloaded')
            cancel()
        } catch (e) {
            console.error('Arca HTML export failed:', e)
            alertClear()
            alertError(`Failed to export: ${e.message}`)
        }
    }

    function escapeHtml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
    }

    // Listen for clicks on chat messages when active
    function setupClickListeners() {
        const handler = (e: Event) => {
            if (!active) return
            const target = e.target as HTMLElement
            const chatEl = target.closest('[data-chat-index]') as HTMLElement
            if (chatEl) {
                e.preventDefault()
                e.stopPropagation()
                const idx = parseInt(chatEl.getAttribute('data-chat-index') ?? '-1', 10)
                if (idx >= 0) {
                    handleMessageClick(idx)
                }
            }
        }
        document.addEventListener('click', handler, true)
        return () => document.removeEventListener('click', handler, true)
    }

    let cleanup: (() => void) | null = null

    $effect(() => {
        if (active) {
            cleanup = setupClickListeners()
            requestAnimationFrame(updateHighlights)
        } else {
            cleanup?.()
            cleanup = null
            clearHighlights()
        }
    })

    $effect(() => {
        void rangeStart
        void rangeEnd
        if (active) {
            requestAnimationFrame(updateHighlights)
        }
    })

    function updateHighlights() {
        clearHighlights()
        if (!active) return
        const messages = document.querySelectorAll('[data-chat-index]')
        messages.forEach((el) => {
            const idx = parseInt(el.getAttribute('data-chat-index') ?? '-1', 10)
            if (isInRange(idx)) {
                el.classList.add('select-copy-highlight')
            }
        })
    }

    function clearHighlights() {
        document.querySelectorAll('.select-copy-highlight').forEach((el) => {
            el.classList.remove('select-copy-highlight')
        })
    }
</script>

{#if active}
    <div class="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-gray-800 text-white rounded-full px-5 py-3 shadow-2xl border border-gray-600">
        <span class="text-sm whitespace-nowrap">
            {#if rangeStart === null}
                {language.selectAndCopySelectRange || 'Click a message to set range start/end'}
            {:else if rangeEnd === null}
                Start: #{rangeStart + 1} — click another message for end
            {:else}
                #{rangeStart + 1} — #{rangeEnd + 1} selected
            {/if}
        </span>

        {#if rangeStart !== null && rangeEnd !== null}
            <button
                class="flex items-center gap-1 bg-green-600 hover:bg-green-500 transition-colors rounded-full px-3 py-1.5 text-sm font-medium"
                onclick={exportRenderedHTML}
            >
                <DownloadIcon size={14} />
                {language.selectAndCopyConfirm || 'Download'}
            </button>
            <button
                class="flex items-center gap-1 bg-blue-600 hover:bg-blue-500 transition-colors rounded-full px-3 py-1.5 text-sm font-medium"
                onclick={exportArcaHTML}
                title="아카라이브 형식 HTML로 내보내기"
            >
                <GlobeIcon size={14} />
                {language.selectAndCopyArca || '아카라이브'}
            </button>
        {/if}

        <button
            class="flex items-center gap-1 bg-red-600 hover:bg-red-500 transition-colors rounded-full px-3 py-1.5 text-sm"
            onclick={cancel}
        >
            <XIcon size={14} />
            {language.selectAndCopyCancel || 'Cancel'}
        </button>
    </div>
{/if}

<style>
    :global(.select-copy-highlight) {
        outline: 2px solid #3b82f6 !important;
        outline-offset: -2px;
        background-color: rgba(59, 130, 246, 0.08) !important;
        transition: outline 0.15s, background-color 0.15s;
    }
</style>
