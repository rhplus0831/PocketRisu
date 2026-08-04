#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import MarkdownIt from 'markdown-it'

const execFileAsync = promisify(execFile)
const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const FINDINGS_ROOT = join(ROOT, 'docs', 'findings')
const OPEN_ROOT = join(FINDINGS_ROOT, 'open')
const DECISIONS_ROOT = join(FINDINGS_ROOT, 'decisions')
const WORK_INDEX = join(FINDINGS_ROOT, 'WORK-INDEX.md')
const md = new MarkdownIt({ html: true, linkify: false })

const args = new Set(process.argv.slice(2))
const printIndex = args.has('--print-index')
const linksOnly = args.has('--links-only')
const indexOnly = args.has('--index-only')

const ownerLabels = new Map([
    ['backup-recovery', 'backup and recovery'],
    ['characters-personas', 'characters and personas'],
    ['chat-pipeline', 'chat pipeline'],
    ['client-storage', 'client storage'],
    ['media-translation', 'media and translation'],
    ['model-providers', 'model providers'],
    ['operations-coverage', 'operations and coverage'],
    ['plugin-storage', 'plugin storage'],
    ['scripting-extensions', 'scripting and extensions'],
    ['server-backend', 'server backend'],
])

async function exists(path) {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

async function walkMarkdown(root) {
    const files = []
    if (!(await exists(root))) return files
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) files.push(...(await walkMarkdown(path)))
        else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') files.push(path)
    }
    return files
}

function parseRecord(path, source) {
    const title = /^#\s+(.+)$/m.exec(source)?.[1]?.trim()
    const status = /^- Status:\s*(.+)$/m.exec(source)?.[1]?.trim()
    const owner = /^- Owner:\s*(.+)$/m.exec(source)?.[1]?.trim()
    const sourceValue = /^- Source(?: reports)?:\s*(.+)$/m.exec(source)?.[1]?.trim()
    return { path, title, status, owner, source: sourceValue }
}

function relativeMarkdownLink(from, to) {
    return relative(dirname(from), to).split(sep).join('/')
}

async function collectFindings() {
    const issues = []
    const records = []
    const files = (await walkMarkdown(OPEN_ROOT)).sort()

    for (const path of files) {
        const source = await readFile(path, 'utf8')
        const record = parseRecord(path, source)
        const rel = relative(ROOT, path).split(sep).join('/')
        const ownerSlug = relative(OPEN_ROOT, dirname(path)).split(sep)[0]
        const expectedOwner = ownerLabels.get(ownerSlug)
        const id = `FND-${path.slice(path.lastIndexOf(sep) + 1, -3)}`

        if (!record.title) issues.push(`${rel}: missing H1 title`)
        if (!['Open', 'Deferred'].includes(record.status)) {
            issues.push(`${rel}: Status must be Open or Deferred, got ${record.status ?? 'missing'}`)
        }
        if (!expectedOwner) issues.push(`${rel}: unknown owner directory ${ownerSlug}`)
        else if (record.owner !== expectedOwner) {
            issues.push(`${rel}: Owner must be "${expectedOwner}", got ${record.owner ?? 'missing'}`)
        }
        if (!record.source) issues.push(`${rel}: missing Source or Source reports metadata`)

        records.push({ ...record, id, ownerSlug, rel })
    }

    const ids = new Set()
    for (const record of records) {
        if (ids.has(record.id)) issues.push(`${record.rel}: duplicate finding ID ${record.id}`)
        ids.add(record.id)
    }
    return { issues, records }
}

async function collectDecisions() {
    const issues = []
    const records = []
    for (const path of (await walkMarkdown(DECISIONS_ROOT)).sort()) {
        const source = await readFile(path, 'utf8')
        const record = parseRecord(path, source)
        const rel = relative(ROOT, path).split(sep).join('/')
        if (!record.title) issues.push(`${rel}: missing H1 title`)
        if (record.status !== 'Accepted decision') {
            issues.push(`${rel}: Status must be Accepted decision, got ${record.status ?? 'missing'}`)
        }
        if (!record.owner) issues.push(`${rel}: missing Owner metadata`)
        if (!record.source) issues.push(`${rel}: missing Source metadata`)
        records.push({ ...record, rel })
    }
    return { issues, records }
}

function renderWorkIndex(findings, decisions) {
    const openCount = findings.filter((item) => item.status === 'Open').length
    const deferredCount = findings.filter((item) => item.status === 'Deferred').length
    const lines = [
        '# Findings work index',
        '',
        'Generated from the machine-readable headers in `open/` and `decisions/`.',
        'Run `pnpm check:docs` after changing a finding, status, path, or link.',
        'These are point-in-time reports; revalidate their evidence against current code',
        'before implementation.',
        '',
        `Current catalog: **${openCount} open**, **${deferredCount} deferred**, and **${decisions.length} accepted decisions**.`,
        '',
        '## Active work by owner',
        '',
    ]

    for (const [ownerSlug, ownerLabel] of ownerLabels) {
        const group = findings.filter((item) => item.ownerSlug === ownerSlug)
        if (group.length === 0) continue
        lines.push(`### ${ownerLabel}`, '', '| ID | Finding | Status | Source |', '|---|---|---|---|')
        for (const item of group.sort((a, b) => a.title.localeCompare(b.title))) {
            const link = relativeMarkdownLink(WORK_INDEX, item.path)
            const source = item.source.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            lines.push(`| \`${item.id}\` | [${item.title}](${link}) | ${item.status} | ${source} |`)
        }
        lines.push('')
    }

    lines.push('## Accepted decisions and limitations', '', '| Decision | Owner | Source |', '|---|---|---|')
    for (const item of decisions.sort((a, b) => a.title.localeCompare(b.title))) {
        const link = relativeMarkdownLink(WORK_INDEX, item.path)
        const source = item.source.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        lines.push(`| [${item.title}](${link}) | ${item.owner} | ${source} |`)
    }
    lines.push(
        '',
        '## Active audit and remediation programs',
        '',
        '- [2026-08 performance remediation](programs/performance-2026-08/README.md)',
        '',
        'Completed programs and source reports are indexed in',
        '[`.archived-docs/`](../../.archived-docs/README.md).',
        '',
    )
    return lines.join('\n')
}

function githubSlug(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/<[^>]*>/g, '')
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-')
}

function collectAnchors(source) {
    const anchors = new Set()
    const seen = new Map()
    const tokens = md.parse(source, {})
    for (let i = 0; i < tokens.length; i += 1) {
        if (tokens[i].type !== 'heading_open') continue
        const text = tokens[i + 1]?.content ?? ''
        const base = githubSlug(text)
        const count = seen.get(base) ?? 0
        seen.set(base, count + 1)
        anchors.add(count === 0 ? base : `${base}-${count}`)
    }
    for (const match of source.matchAll(/<(?:a|span)\b[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/gi)) {
        anchors.add(match[1])
    }
    return anchors
}

function destinations(tokens) {
    const found = []
    for (const token of tokens) {
        if (token.type === 'inline' && token.children) {
            for (const child of token.children) {
                if (child.type === 'link_open') found.push({ href: child.attrGet('href'), line: (token.map?.[0] ?? 0) + 1 })
                if (child.type === 'image') found.push({ href: child.attrGet('src'), line: (token.map?.[0] ?? 0) + 1 })
            }
        }
    }
    return found.filter((item) => item.href)
}

async function trackedMarkdown() {
    const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '*.md'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    })
    const allowed = (rel) =>
        rel === 'README.md' ||
        rel === 'STRUCTURE.md' ||
        rel.startsWith('docs/') ||
        rel.startsWith('.archived-docs/') ||
        rel.startsWith('test/e2e/')

    const files = []
    for (const rel of stdout.split('\0').filter(Boolean)) {
        if (!allowed(rel)) continue
        const path = join(ROOT, rel)
        if (await exists(path)) files.push(path)
    }
    return [...new Set(files)].sort()
}

async function checkLinks() {
    const issues = []
    const anchorCache = new Map()
    for (const path of await trackedMarkdown()) {
        const source = await readFile(path, 'utf8')
        const rel = relative(ROOT, path).split(sep).join('/')
        for (const { href, line } of destinations(md.parse(source, {}))) {
            if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue
            if (href.startsWith('/')) {
                issues.push(`${rel}:${line}: root-relative local link is unsupported: ${href}`)
                continue
            }
            const [rawPath, rawFragment] = href.split('#', 2)
            let decodedPath
            let fragment
            try {
                decodedPath = decodeURIComponent(rawPath)
                fragment = rawFragment ? decodeURIComponent(rawFragment) : ''
            } catch {
                issues.push(`${rel}:${line}: invalid URL encoding: ${href}`)
                continue
            }
            const target = rawPath ? resolve(dirname(path), decodedPath) : path
            if (!target.startsWith(`${ROOT}${sep}`) && target !== ROOT) {
                issues.push(`${rel}:${line}: local link escapes the repository: ${href}`)
                continue
            }
            if (!(await exists(target))) {
                issues.push(`${rel}:${line}: missing local target: ${href}`)
                continue
            }
            if (!fragment || extname(target).toLowerCase() !== '.md') continue
            if (!anchorCache.has(target)) anchorCache.set(target, collectAnchors(await readFile(target, 'utf8')))
            if (!anchorCache.get(target).has(fragment)) {
                issues.push(`${rel}:${line}: missing Markdown anchor #${fragment} in ${relative(ROOT, target)}`)
            }
        }
    }
    return issues
}

async function main() {
    const findings = await collectFindings()
    const decisions = await collectDecisions()
    const expectedIndex = renderWorkIndex(findings.records, decisions.records)

    if (printIndex) {
        process.stdout.write(expectedIndex)
        return
    }

    const issues = []
    if (!linksOnly) {
        issues.push(...findings.issues, ...decisions.issues)
        const actual = (await exists(WORK_INDEX)) ? await readFile(WORK_INDEX, 'utf8') : ''
        if (actual !== expectedIndex) issues.push('docs/findings/WORK-INDEX.md is stale; regenerate it with check-docs.mjs --print-index')
    }
    if (!indexOnly) issues.push(...(await checkLinks()))

    if (issues.length > 0) {
        console.error(`Documentation check failed with ${issues.length} issue(s):`)
        for (const issue of issues) console.error(`  - ${issue}`)
        process.exit(1)
    }
    console.log('Documentation links and findings index are valid.')
}

main().catch((error) => {
    console.error('check-docs failed:', error)
    process.exit(2)
})
