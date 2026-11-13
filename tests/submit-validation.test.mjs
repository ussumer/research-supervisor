import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture, call, textOf } from './native-fixture.mjs';

test('asynchronous handoff validation returns errors to the same native Agent before concluding', { timeout: 15000 }, async () => {
  let validations = 0;
  const fixture = await nativeFixture({ script({ step, lastTool }) {
    if (step === 0) return call('write', { file_path: 'plan.json', content: '{"valid":false}' });
    if (step === 1) return call('research_submit', { value: { path: 'plan.json' } });
    if (step === 2) {
      assert.match(textOf(lastTool), /invalid fixture plan/i);
      return call('edit', { file_path: 'plan.json', old_string: 'false', new_string: 'true' });
    }
    if (step === 3) return call('research_submit', { value: { path: 'plan.json' } });
    throw new Error('Unexpected step');
  } });
  try {
    const result = await fixture.runner.run(fixture.job('planner'), async submission => {
      validations++;
      const plan = JSON.parse(await readFile(join(fixture.paths.planner, submission.path), 'utf8'));
      if (!plan.valid) throw new Error('invalid fixture plan');
    });
    assert.equal(result.reason, 'completed');
    assert.equal(validations, 2);
    assert.equal(fixture.requests.length, 4);
  } finally { await fixture.close(); }
});
