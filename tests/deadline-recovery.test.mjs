import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeFixture, call, waitForAbort } from './native-fixture.mjs';
import { ResearchSupervisor } from '../lib/supervision.js';
import { plannerPrompt } from '../lib/roles.js';

for (const mode of ['isolated', 'full']) {
  for (const change of ['shorter', 'longer']) {
    test(`${mode}: retained session re-arms a ${change} deadline`, { timeout: 15000 }, async () => {
      let continuing = false;
      let oldDeadline;
      const fixture = await nativeFixture({ script: async ({ step, signal }) => {
        if (continuing) {
          if (change === 'shorter') return waitForAbort(signal);
          await delay(Math.max(0, oldDeadline - Date.now() + 100), undefined, { signal });
          return call('research_submit', { value: { path: 'plan.json' } });
        }
        return step === 0 ? call('write', { file_path: 'plan.json', content: '{}' })
          : call('research_submit', { value: { path: 'plan.json' } });
      } });
      try {
        oldDeadline = Date.now() + 1500;
        const job = fixture.job('planner', { keepAlive: true, deadline: oldDeadline,
          ...(mode === 'full' ? { producerContext: { projectId: fixture.root } } : {}) });
        const first = await fixture.runner.run(job, () => {});
        assert.equal(first.reason, 'completed');
        continuing = true;
        const next = { ...job, sessionId: first.sessionId,
          deadline: Date.now() + (change === 'shorter' ? 100 : 5000),
          ...(mode === 'full' ? { producerContext: { projectId: fixture.root, previous: first.checkpoint } } : {}) };
        const second = await fixture.runner.run(next, () => {});
        assert.equal(second.sessionId, first.sessionId);
        assert.equal(second.reason, change === 'shorter' ? 'timeout' : 'completed');
        if (change === 'shorter') assert.ok(Date.now() < oldDeadline, 'new shorter timer must fire before old timer');
        else assert.ok(Date.now() > oldDeadline, 'continuation survives old timer');
      } finally { await fixture.close(); }
    });
  }
}

test('producer fork accepts a different task deadline', async () => {
  const fixture = await nativeFixture({ script: ({ step }) => step === 0
    ? call('write', { file_path: 'plan.json', content: '{}' })
    : call('research_submit', { value: { path: 'plan.json' } }) });
  try {
    const job = fixture.job('planner', { producerContext: { projectId: fixture.root } });
    const first = await fixture.runner.run(job, () => {});
    const second = await fixture.runner.run({ ...job, deadline: job.deadline - 1000,
      producerContext: { projectId: fixture.root, previous: first.checkpoint } }, () => {});
    assert.equal(second.reason, 'completed');
    assert.equal(second.checkpoint.generation, 2);
    assert.notEqual(second.sessionId, first.sessionId);
  } finally { await fixture.close(); }
});

test('interrupted full project retains attempt files and clears stale checkpoint durably', async t => {
  const root = await mkdtemp(join(tmpdir(), 'research-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'work', 'old');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'README.md'), 'incremental work');
  const request = { goal: 'fixture', sources: [join(root, 'source')],
    deadline: new Date(Date.now() + 60000).toISOString(), maxReplans: 1, producerContext: 'full' };
  await writeFile(join(root, 'project.json'), JSON.stringify({ revision: 0, request, status: 'active',
    plans: [], evidence: [], replans: 0, reason: 'running',
    attempts: [{ id: 'old', taskId: 'T', directory, inputEvidence: [], error: 'Execution has not yet settled' }],
    active: { id: 'old', taskId: 'T', role: 'executor', directory },
    producerCheckpoint: { sessionId: 'lost', boundary: 9, generation: 1 } }));
  const supervisor = await ResearchSupervisor.open(root, { async cancel() {} });
  try {
    assert.equal(supervisor.status().active, undefined);
    assert.equal(supervisor.status().attempts[0].error, 'Interrupted by host restart');
    await supervisor.reconcile();
    const saved = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'));
    assert.equal(saved.status, 'paused');
    assert.equal(saved.producerCheckpoint, undefined);
    assert.equal(await readFile(join(directory, 'README.md'), 'utf8'), 'incremental work');
  } finally { await supervisor.close(); }
});

test('planner advertises optional task timeout', () => {
  assert.match(plannerPrompt({}), /timeoutMinutes\?:positive number/);
});
