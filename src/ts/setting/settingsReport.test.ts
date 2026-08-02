import { describe, expect, test } from 'vitest'
import {
    buildSettingsBugReport,
    SETTINGS_BUG_REPORT_FIELDS,
} from './settingsReport'

describe('settings bug report', () => {
    test('includes only allowlisted diagnostics and metadata', () => {
        const source = {
            language: 'ko',
            apiType: 'openai',
            statics: { messages: 12, imports: 2 },
            pluginCustomStorage: { secretPluginValue: 'do not export' },
            pluginStorageMeta: { key: { plugin: 'private', updatedAt: 1 } },
            characters: [{ name: 'private character' }],
            mainPrompt: 'private prompt',
            openAIKey: 'secret API key',
            unknownFutureField: 'future secret',
        } as any
        const report = buildSettingsBugReport(source, {
            isNodeServer: true,
            protocol: 'https:',
            appVersion: '2026.2.291',
            nodeOnlyVersion: 'test',
        })

        expect(report).toEqual({
            apiType: 'openai',
            language: 'ko',
            statics: { messages: 12, imports: 2 },
            meta: {
                isNodeServer: true,
                protocol: 'https:',
                appVersion: '2026.2.291',
                nodeOnlyVersion: 'test',
            },
        })
        expect(JSON.stringify(report)).not.toContain('secret')
        expect(JSON.stringify(report)).not.toContain('private')
    })

    test('does not read unallowlisted database roots', () => {
        let pluginStorageReads = 0
        const source = { language: 'en' } as Record<string, unknown>
        Object.defineProperty(source, 'pluginCustomStorage', {
            enumerable: true,
            get() {
                pluginStorageReads++
                throw new Error('plugin storage must not be read')
            },
        })

        const report = buildSettingsBugReport(source as any, {
            isNodeServer: false,
            protocol: 'https:',
            appVersion: 'test',
            nodeOnlyVersion: 'test',
        })

        expect(report.language).toBe('en')
        expect(pluginStorageReads).toBe(0)
        expect(Object.hasOwn(report, 'pluginCustomStorage')).toBe(false)
    })

    test('keeps payload and credential roots out of the allowlist', () => {
        const fields = new Set<string>(SETTINGS_BUG_REPORT_FIELDS)
        expect(fields.has('characters')).toBe(false)
        expect(fields.has('personas')).toBe(false)
        expect(fields.has('plugins')).toBe(false)
        expect(fields.has('pluginCustomStorage')).toBe(false)
        expect(fields.has('pluginStorageMeta')).toBe(false)
        expect(fields.has('openAIKey')).toBe(false)
        expect(fields.has('modelPresets')).toBe(false)
        expect(fields.has('mainPrompt')).toBe(false)
    })
})
