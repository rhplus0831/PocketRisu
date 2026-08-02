import type { Database, DatabaseSnapshotField } from '../storage/database.svelte'

/**
 * Bounded, non-secret settings that are useful when diagnosing client issues.
 * Unknown database roots are excluded by default instead of being filtered by
 * name after a whole-database clone.
 */
export const SETTINGS_BUG_REPORT_FIELDS = [
    'apiType',
    'aiModel',
    'subModel',
    'formatversion',
    'language',
    'translatorType',
    'theme',
    'textTheme',
    'colorSchemeName',
    'nodeOnlyStandardChatWidth',
    'zoomsize',
    'iconsize',
    'classicMaxWidth',
    'fullScreen',
    'roundIcons',
    'temperature',
    'maxContext',
    'maxResponse',
    'frequencyPenalty',
    'PresensePenalty',
    'top_p',
    'top_k',
    'repetition_penalty',
    'min_p',
    'top_a',
    'generationSeed',
    'reasoningEffort',
    'thinkingTokens',
    'thinkingType',
    'adaptiveThinkingEffort',
    'verbosity',
    'useStreaming',
    'streamingDisplayOptimizationMode',
    'swipe',
    'confirmReroll',
    'clickToEdit',
    'sendKeyPC',
    'sendKeyMobile',
    'fixedChatTextarea',
    'enableBlockPartialEdit',
    'enableDragPartialEdit',
    'useChatCopy',
    'autoTranslate',
    'useAutoTranslateInput',
    'noWaitForTranslate',
    'combineTranslation',
    'legacyTranslation',
    'translateBeforeHTMLFormatting',
    'autoTranslateCachedOnly',
    'imageCompression',
    'inlayImageLossless',
    'inlayImagePriority',
    'newImageHandlingBeta',
    'memoryAlgorithmType',
    'emotionProcesser',
    'useExperimental',
    'showMemoryLimit',
    'useLegacyGUI',
    'betaMobileGUI',
    'localNetworkMode',
    'localNetworkTimeoutSec',
    'optimizePluginMemory',
    'pluginStorageGeneration',
    'autoConvertPluginStorageValues',
    'legacyPluginCompatibility',
    'allowV2Plugin',
    'pluginDevelopMode',
    'chatLoadInitialPages',
    'chatLoadAdditionalPages',
    'chatCompression',
    'requestLogEnabled',
    'requestLogStreamUsage',
    'showRequestStatus',
    'nodeOnlyServerSideRequests',
    'useModelPresetByDefault',
    'nodeOnlyModelModeLock',
    'moduleModelBindingsEnabled',
    'modelPresetMigrationVersion',
    'modelPresetMigrationAppliedAt',
    'dynamicModelRegistry',
    'modelProfileVisibilityLevel',
    'useCustomModelRegistry',
    'dynamicOutput',
    'statics',
] as const satisfies readonly DatabaseSnapshotField[]

type SettingsBugReportField = typeof SETTINGS_BUG_REPORT_FIELDS[number]
export type SettingsBugReportSource = Pick<Database, SettingsBugReportField>

export interface SettingsBugReportMeta {
    isNodeServer: boolean
    protocol: string
    appVersion: string
    nodeOnlyVersion: string
}

export type SettingsBugReport = Partial<SettingsBugReportSource> & {
    meta: SettingsBugReportMeta
}

/** Assemble a report from an already detached field projection. */
export function buildSettingsBugReport(
    source: Partial<Database>,
    meta: SettingsBugReportMeta,
): SettingsBugReport {
    const report: Record<string, unknown> = {}
    for (const field of SETTINGS_BUG_REPORT_FIELDS) {
        if (Object.hasOwn(source, field)) {
            report[field] = source[field]
        }
    }
    report.meta = { ...meta }
    return report as SettingsBugReport
}
