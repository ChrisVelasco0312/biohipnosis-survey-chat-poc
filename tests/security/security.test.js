import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biohipnosis-security-'));
process.env.POC_DATA_DIR = dir;
process.env.POC_LLM = 'off';
process.env.POC_RATE_LIMIT = 'on';

const { runSecuritySuite } = await import('../../server/securitySuite.js');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('security suite passes all deterministic checks', () => {
  const report = runSecuritySuite();
  assert.equal(report.total, 22);
  assert.equal(report.failed, 0, JSON.stringify(report.checks.filter((check) => !check.pass), null, 2));
  assert.equal(report.passed, 22);
});
