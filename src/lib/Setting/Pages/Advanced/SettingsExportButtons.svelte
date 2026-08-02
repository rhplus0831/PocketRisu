<script lang="ts">
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { alertMd, notifySuccess } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { appVer, getDatabaseFieldsSnapshot, nodeOnlyVer } from "src/ts/storage/database.svelte";
    import { buildSettingsBugReport, SETTINGS_BUG_REPORT_FIELDS } from "src/ts/setting/settingsReport";
    import { isNodeServer } from "src/ts/platform";

</script>

<Button
    className="mt-4"
    onclick={async () => {
        let mdTable = "| Type | Value |\n| --- | --- |\n"
        const s = DBState.db.statics
        for (const key in s) {
            mdTable += `| ${key} | ${s[key]} |\n`
        }
        mdTable += `\n\n<small>${language.staticsDisclaimer}</small>`
        alertMd(mdTable)
    }}
>
Show Statistics
</Button>

<Button
    className="mt-4"
    onclick={async () => {
        const db = buildSettingsBugReport(
            getDatabaseFieldsSnapshot(SETTINGS_BUG_REPORT_FIELDS),
            {
                isNodeServer,
                protocol: location.protocol,
                appVersion: appVer,
                nodeOnlyVersion: nodeOnlyVer,
            },
        )

        const json = JSON.stringify(db, null, 2)
        await downloadFile('risuai-settings-report.json', new TextEncoder().encode(json))
        await navigator.clipboard.writeText(json)
        notifySuccess(language.settingsExported)
        

    }}
>
Export Settings for Bug Report
</Button>
