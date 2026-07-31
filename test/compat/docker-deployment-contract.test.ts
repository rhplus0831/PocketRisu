import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const repositoryRoot = new URL('../../', import.meta.url)

function readRepositoryFile(name: string): string {
    return readFileSync(new URL(name, repositoryRoot), 'utf8')
}

function indentedBlock(source: string, header: string, indent: number): string {
    const lines = source.split(/\r?\n/)
    const start = lines.findIndex((line) => line === `${' '.repeat(indent)}${header}:`)
    if (start < 0) throw new Error(`Missing ${header} block at indentation ${indent}`)

    const body: string[] = []
    for (const line of lines.slice(start + 1)) {
        if (line.trim() && line.length - line.trimStart().length <= indent) break
        body.push(line)
    }
    return body.join('\n')
}

describe('shipped Docker Compose persistence contract', () => {
    test('persists both live state and server-created backup archives', () => {
        const compose = readRepositoryFile('docker-compose.yml')
        const service = indentedBlock(indentedBlock(compose, 'services', 0), 'risuai', 2)
        const serviceVolumes = indentedBlock(service, 'volumes', 4)
        const declaredVolumes = indentedBlock(compose, 'volumes', 0)

        expect(serviceVolumes).toMatch(/^\s+- risuai-save:\/app\/save\s*$/m)
        expect(serviceVolumes).toMatch(/^\s+- risuai-backups:\/app\/backups\s*$/m)

        const saveVolume = indentedBlock(declaredVolumes, 'risuai-save', 2)
        const backupVolume = indentedBlock(declaredVolumes, 'risuai-backups', 2)
        expect(saveVolume).toMatch(/^\s+name: risuai-nodeonly_risuai-save\s*$/m)
        expect(backupVolume).toMatch(/^\s+name: risuai-nodeonly_risuai-backups\s*$/m)
    })
})
