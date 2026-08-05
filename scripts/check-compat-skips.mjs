#!/usr/bin/env node
// Skip gate for the compatibility suite: reads a vitest --reporter=json
// report and fails when any case was skipped outside the expected
// fixture-gated allowlist, so silently-narrowing coverage cannot pass CI.
//
// Usage: node scripts/check-compat-skips.mjs <vitest-json-report>

import { readFileSync } from 'node:fs';

// Files whose cases may skip. Everything here must name the reason.
const ALLOWED_SKIP_FILES = [
  // Requires the gitignored test/fixtures/upstream/upstream-backup.bin, which
  // exists only on a prepared local machine — tracked by the open
  // real-upstream-backup-fixture-skipped finding.
  'test/compat/upstream-import.test.ts',
];

const SKIP_STATUSES = new Set(['skipped', 'pending', 'todo', 'disabled']);

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Usage: node scripts/check-compat-skips.mjs <vitest-json-report>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`Could not read the vitest JSON report at ${reportPath}: ${error.message}`);
  process.exit(2);
}

if (!Array.isArray(report.testResults) || typeof report.numTotalTests !== 'number') {
  console.error('The report has no testResults; pass a vitest --reporter=json output file.');
  process.exit(2);
}
if (report.numTotalTests === 0) {
  console.error('The report contains zero tests; refusing to treat an empty run as green.');
  process.exit(1);
}

const unexpected = [];
let expected = 0;
for (const file of report.testResults) {
  const name = String(file.name ?? '');
  const allowed = ALLOWED_SKIP_FILES.some(suffix => name.endsWith(suffix));
  const cases = Array.isArray(file.assertionResults) ? file.assertionResults : [];
  // A file that ran zero cases hides what it skipped; treat it like a skip.
  if (cases.length === 0 && !allowed) {
    unexpected.push(`${name} (file produced no test cases)`);
    continue;
  }
  for (const testCase of cases) {
    if (!SKIP_STATUSES.has(testCase.status)) continue;
    if (allowed) expected += 1;
    else unexpected.push(`${name} > ${testCase.fullName ?? testCase.title}`);
  }
}

if (unexpected.length > 0) {
  console.error(`${unexpected.length} case(s) skipped outside the expected fixture-gated set:`);
  for (const line of unexpected) console.error(`  - ${line}`);
  console.error('Either fix the skip or add the file to ALLOWED_SKIP_FILES with a reason.');
  process.exit(1);
}
console.log(`No unexpected skips (${expected} known fixture-gated skip(s)).`);
