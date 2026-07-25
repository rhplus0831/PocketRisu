import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pkg from './importJournal.cjs'

const {
    writeImportJournal,
    readImportJournal,
    clearImportJournal,
    recoverImportSwap,
} = pkg as {
    writeImportJournal: (journalPath: string, journal: ImportJournal, fsImpl?: typeof fs) => void
    readImportJournal: (journalPath: string, fsImpl?: typeof fs) => ImportJournal | null
    clearImportJournal: (journalPath: string, fsImpl?: typeof fs) => void
    recoverImportSwap: (options: {
        journal: ImportJournal
        markerPresent: boolean
        fs: typeof fs
    }) => { action: 'finalized' | 'restored'; directories: number }
}

interface JournalDir {
    liveDir: string
    backupDir: string
    stagingDir: string
    liveExisted: boolean
}

interface ImportJournal {
    id: string
    phase: 'swapped' | 'committed'
    dirs: JournalDir[]
}

const tempDirs: string[] = []

function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketrisu-import-journal-'))
    tempDirs.push(root)
    return root
}

function makeDirState(root: string, name: string, liveExisted = true): JournalDir {
    return {
        liveDir: path.join(root, name),
        backupDir: path.join(root, `${name}_import_backup`),
        stagingDir: path.join(root, `${name}_import_staging`),
        liveExisted,
    }
}

function writeFile(dir: string, name: string, value: string): void {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), value)
}

function journalFor(dirs: JournalDir[], phase: ImportJournal['phase'] = 'swapped'): ImportJournal {
    return { id: '2f66aec6-bb33-4131-8d64-dc279e008f53', phase, dirs }
}

function recoverPending(journalPath: string, markerPresent: boolean): ReturnType<typeof recoverImportSwap> | null {
    const journal = readImportJournal(journalPath)
    if (!journal) return null
    const summary = recoverImportSwap({ journal, markerPresent, fs })
    clearImportJournal(journalPath)
    return summary
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

describe('import journal persistence', () => {
    it('round-trips an atomically written journal', () => {
        const root = makeRoot()
        const journalPath = path.join(root, 'import_journal.json')
        const journal = journalFor([makeDirState(root, 'assets')])

        writeImportJournal(journalPath, journal)

        expect(readImportJournal(journalPath)).toEqual(journal)
        expect(fs.existsSync(`${journalPath}.tmp`)).toBe(false)
    })

    it('discards a partial tmp and rejects a truncated journal', () => {
        const root = makeRoot()
        const journalPath = path.join(root, 'import_journal.json')
        const liveDir = path.join(root, 'assets')
        writeFile(liveDir, 'original.bin', 'original')
        fs.writeFileSync(`${journalPath}.tmp`, '{"id":"partial"')
        fs.writeFileSync(journalPath, '{"id":"truncated"')

        expect(recoverPending(journalPath, false)).toBeNull()
        expect(fs.existsSync(`${journalPath}.tmp`)).toBe(false)
        expect(fs.readFileSync(path.join(liveDir, 'original.bin'), 'utf-8')).toBe('original')
    })
})

describe('import swap recovery', () => {
    it('leaves live data untouched when prep finds only a staging leftover', () => {
        const root = makeRoot()
        const journalPath = path.join(root, 'import_journal.json')
        const dirs = makeDirState(root, 'assets')
        writeFile(dirs.liveDir, 'original.bin', 'original')
        writeFile(dirs.stagingDir, 'imported.bin', 'imported')

        expect(recoverPending(journalPath, false)).toBeNull()
        fs.rmSync(dirs.stagingDir, { recursive: true, force: true })
        fs.rmSync(dirs.backupDir, { recursive: true, force: true })

        expect(fs.readFileSync(path.join(dirs.liveDir, 'original.bin'), 'utf-8')).toBe('original')
    })

    it('restores both fully swapped directories when the marker is absent', () => {
        const root = makeRoot()
        const journalPath = path.join(root, 'import_journal.json')
        const assets = makeDirState(root, 'assets')
        const inlays = makeDirState(root, 'inlays')
        for (const [dir, original, imported] of [
            [assets, 'old-asset', 'new-asset'],
            [inlays, 'old-inlay', 'new-inlay'],
        ] as const) {
            writeFile(dir.backupDir, 'payload.bin', original)
            writeFile(dir.liveDir, 'payload.bin', imported)
        }
        writeImportJournal(journalPath, journalFor([assets, inlays]))

        const summary = recoverPending(journalPath, false)

        expect(summary).toMatchObject({ action: 'restored', directories: 2 })
        expect(fs.readFileSync(path.join(assets.liveDir, 'payload.bin'))).toEqual(Buffer.from('old-asset'))
        expect(fs.readFileSync(path.join(inlays.liveDir, 'payload.bin'))).toEqual(Buffer.from('old-inlay'))
        expect(fs.existsSync(assets.backupDir)).toBe(false)
        expect(fs.existsSync(inlays.backupDir)).toBe(false)
        expect(fs.existsSync(journalPath)).toBe(false)
    })

    it('restores a backup when the process died between the two renames', () => {
        const root = makeRoot()
        const journalPath = path.join(root, 'import_journal.json')
        const dirs = makeDirState(root, 'assets')
        writeFile(dirs.backupDir, 'original.bin', 'original')
        writeFile(dirs.stagingDir, 'imported.bin', 'imported')
        writeImportJournal(journalPath, journalFor([dirs]))

        recoverPending(journalPath, false)

        expect(fs.readFileSync(path.join(dirs.liveDir, 'original.bin'), 'utf-8')).toBe('original')
        expect(fs.existsSync(dirs.stagingDir)).toBe(false)
    })

    it('removes an imported live directory when no original existed', () => {
        const root = makeRoot()
        const journalPath = path.join(root, 'import_journal.json')
        const dirs = makeDirState(root, 'assets', false)
        writeFile(dirs.liveDir, 'imported.bin', 'imported')
        writeImportJournal(journalPath, journalFor([dirs]))

        recoverPending(journalPath, false)

        expect(fs.existsSync(dirs.liveDir)).toBe(false)
    })

    it('keeps live intact when the live-to-backup rename never ran', () => {
        const root = makeRoot()
        const journalPath = path.join(root, 'import_journal.json')
        const dirs = makeDirState(root, 'assets')
        writeFile(dirs.liveDir, 'original.bin', 'original')
        writeFile(dirs.stagingDir, 'imported.bin', 'imported')
        writeImportJournal(journalPath, journalFor([dirs]))

        recoverPending(journalPath, false)

        expect(fs.readFileSync(path.join(dirs.liveDir, 'original.bin'), 'utf-8')).toBe('original')
        expect(fs.existsSync(dirs.stagingDir)).toBe(false)
    })

    it('finalizes a swapped journal when its commit marker survived', () => {
        const root = makeRoot()
        const journalPath = path.join(root, 'import_journal.json')
        const dirs = makeDirState(root, 'assets')
        writeFile(dirs.liveDir, 'imported.bin', 'imported')
        writeFile(dirs.backupDir, 'original.bin', 'original')
        writeImportJournal(journalPath, journalFor([dirs]))

        const summary = recoverPending(journalPath, true)

        expect(summary).toMatchObject({ action: 'finalized' })
        expect(fs.readFileSync(path.join(dirs.liveDir, 'imported.bin'), 'utf-8')).toBe('imported')
        expect(fs.existsSync(dirs.backupDir)).toBe(false)
    })

    it('finalizes a committed journal without a marker', () => {
        const root = makeRoot()
        const journalPath = path.join(root, 'import_journal.json')
        const dirs = makeDirState(root, 'assets')
        writeFile(dirs.liveDir, 'imported.bin', 'imported')
        writeFile(dirs.backupDir, 'original.bin', 'original')
        writeImportJournal(journalPath, journalFor([dirs], 'committed'))

        const summary = recoverPending(journalPath, false)

        expect(summary).toMatchObject({ action: 'finalized' })
        expect(fs.readFileSync(path.join(dirs.liveDir, 'imported.bin'), 'utf-8')).toBe('imported')
        expect(fs.existsSync(dirs.backupDir)).toBe(false)
    })

    it('keeps originals safe when the next prep deletes backup directories', () => {
        const root = makeRoot()
        const journalPath = path.join(root, 'import_journal.json')
        const dirs = makeDirState(root, 'assets')
        writeFile(dirs.liveDir, 'imported.bin', 'imported')
        writeFile(dirs.backupDir, 'original.bin', 'original')
        writeImportJournal(journalPath, journalFor([dirs]))

        recoverPending(journalPath, false)
        fs.rmSync(dirs.stagingDir, { recursive: true, force: true })
        fs.rmSync(dirs.backupDir, { recursive: true, force: true })

        expect(fs.readFileSync(path.join(dirs.liveDir, 'original.bin'), 'utf-8')).toBe('original')
    })
})
