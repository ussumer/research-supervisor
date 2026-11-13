import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeFixture, call, textOf, deferred, waitForAbort } from './native-fixture.mjs';
import { ResearchSupervisor } from '../lib/supervision.js';

const plan = {
  version: 1,
  claims: [{ id: 'C', statement: 'Two fixture results', required: true, source: { document: 'source.txt', locator: 'line 1' }, requires: ['E1', 'E2'] }],
  evidence: ['E1', 'E2'].map(id => ({ id, claimId: 'C', description: id, scope: 'fixture only' })),
  tasks: [
    { id: 'T1', title: 'First', objective: 'First result', produces: ['E1'], consumes: [], dependsOn: [], maxAttempts: 2, timeoutMinutes: 0.5 },
    { id: 'T2', title: 'Second', objective: 'Second result', produces: ['E2'], consumes: ['E1'], dependsOn: ['T1'], maxAttempts: 2, timeoutMinutes: 0.25 },
  ],
};
const promptOf = messages => messages.filter(item => item.role === 'user').map(textOf).filter(text => text.includes('ROLE:')).at(-1);
const review = (decision, accepted, reason) => call('research_submit', { value: { decision, accepted, reason, report: 'REVIEW.md' } });
const delivery = id => call('research_submit', { value: { readme: 'README.md', artifacts: [{ path: 'result.json', requirements: [id] }], conclusion: 'Fixture computed' } });

for (const scenario of ['replan', 'pause-review', 'reconcile-blocked']) {
  test(`full-context supervisor preserves its production chain through ${scenario}`, { timeout: 30000 }, async () => {
    let supervisor;
    let plans = 0;
    let resumed = false;
    let reviewers = 0;
    const held = deferred();
    const fixture = await nativeFixture({ script: async ({ role, step, messages, signal }) => {
      const prompt = promptOf(messages);
      if (role.includes('reviewer') && step === 0) {
        assert.ok(!messages.some(message => message.role === 'assistant' || message.role === 'tool'));
      }
      if (role === 'planner') {
        if (step === 0) {
          plans++;
          const value = structuredClone(plan);
          if (plans > 1) {
            assert.match(JSON.stringify(messages), /T2 investigation/);
            assert.match(prompt, /replace the second route/);
            value.version = 2;
            value.tasks.push({ ...value.tasks[1], id: 'T3' });
          }
          return call('write', { file_path: 'plan.json', content: JSON.stringify(value) });
        }
        if (step === 1) return call('write', { file_path: 'README.md', content: 'Planning investigation' });
        return call('research_submit', { value: { path: 'plan.json' } });
      }
      if (role === 'plan-reviewer') {
        if (step === 0) return call('write', { file_path: 'REVIEW.md', content: 'Plan evaluated' });
        return review('accept', ['E1', 'E2'], 'Plan evaluated');
      }
      const task = JSON.parse(/Task: (\{[^\n]*\})/.exec(prompt)[1]);
      if (role === 'executor') {
        if (step === 0) {
          assert.match(JSON.stringify(messages), /Planning investigation/);
          if (task.id !== 'T1') assert.match(JSON.stringify(messages), /T1 investigation/);
          if (task.id === 'T3') assert.match(JSON.stringify(messages), /T2 investigation/);
          return call('write', { file_path: 'README.md', content: `${task.id} investigation` });
        }
        if (step === 1) return call('write', { file_path: 'result.json', content: '{"value":2}' });
        return delivery(task.id === 'T1' ? 'E1' : 'E2');
      }
      if (role === 'reviewer') {
        if (step === 0) {
          reviewers++;
          if (scenario === 'pause-review' && !resumed) { held.resolve(); return waitForAbort(signal); }
          return call('write', { file_path: 'REVIEW.md', content: 'Independent review' });
        }
        if (scenario === 'reconcile-blocked' && !resumed) return review('blocked', [], 'temporary fixture blocker');
        if (scenario === 'replan' && task.id === 'T2') return review('replan', [], 'replace the second route');
        return review('accept', task.produces, 'Bounded evidence accepted');
      }
      throw new Error('Unexpected role');
    } });
    try {
      const source = join(fixture.paths.inputs, 'source.txt');
      await writeFile(source, 'Two bounded results');
      const deadline = new Date(Date.now() + 20000).toISOString();
      supervisor = await ResearchSupervisor.open(join(fixture.root, 'project'), fixture.runner, {
        goal: 'Exercise producer history', sources: [source], deadline, maxReplans: 1, producerContext: 'full',
      });
      const running = supervisor.run();
      if (scenario === 'pause-review') {
        await held.promise;
        await supervisor.pause('Fixture user pause');
        await running;
        const paused = supervisor.status();
        assert.equal(paused.status, 'paused');
        assert.equal(paused.attempts.length, 1);
        assert.equal(paused.attempts[0].review, undefined);
        resumed = true;
        await supervisor.run();
      } else {
        await running;
        if (scenario === 'reconcile-blocked') {
          assert.equal(supervisor.status().status, 'blocked');
          assert.throws(() => supervisor.run(), /Reconcile/);
          await supervisor.reconcile();
          resumed = true;
          await supervisor.run();
        }
      }
      const state = supervisor.status();
      assert.equal(state.status, 'completed', state.reason);
      assert.equal(state.request.deadline, deadline);
      assert.equal(state.evidence.length, 2);
      assert.equal(state.request.producerContext, 'full');
      assert.ok(state.producerCheckpoint.generation >= 3);
      assert.equal(state.attempts.filter(item => item.taskId === 'T1').length, scenario === 'reconcile-blocked' ? 2 : 1,
        'only explicit reconciliation retries a blocked attempt');
      if (scenario === 'replan') {
        assert.equal(plans, 2);
        assert.equal(state.replans, 1);
        assert.equal(state.attempts.at(-1).taskId, 'T3');
      } else assert.equal(reviewers, 3, 'paused reviewer replaced, not falsely accepted');
      assert.ok(fixture.children.every(child => !fixture.ctx.agents.get(child.id)));
      assert.deepEqual(fixture.errors, []);
    } finally { await supervisor?.close(); await fixture.close(); }
  });
}

test('a cold full-context project clears its checkpoint and resumes via file handoff', async t => {
  const root = await mkdtemp(join(tmpdir(), 'research-full-cold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.txt');
  await writeFile(source, 'fixture');
  const request = { goal: 'fixture', sources: [source], deadline: new Date(Date.now() + 60000).toISOString(), maxReplans: 1, producerContext: 'full' };
  const project = join(root, 'project');
  await mkdir(project);
  const previous = join(project, 'work', 'previous');
  await mkdir(previous, { recursive: true });
  await writeFile(join(previous, 'README.md'), 'unfinished implementation');
  await writeFile(join(project, 'project.json'), JSON.stringify({ revision: 1, request, status: 'paused', plan,
    plans: [], attempts: [{ id: 'previous', taskId: 'T1', directory: previous, inputEvidence: [],
      review: { decision: 'rework', accepted: [], report: 'REVIEW.md', reason: 'continue' } }],
    evidence: [], replans: 0, reason: 'paused',
    producerCheckpoint: { sessionId: 'lost-native-session', boundary: 12, generation: 1 } }));
  let started = false;
  const runner = { async run(job) {
    started = true;
    assert.equal(job.role, 'executor');
    assert.equal(job.producerContext.previous, undefined);
    assert.ok(job.readRoots.includes(source));
    assert.ok(job.readRoots.includes(previous));
    assert.match(job.prompt, /explicit file\/README handoff/);
    throw new Error('fixture reached fresh producer');
  }, async cancel() {} };
  const supervisor = await ResearchSupervisor.open(project, runner);
  try {
    assert.equal(supervisor.status().status, 'paused');
    assert.equal(supervisor.status().producerCheckpoint, undefined);
    assert.match(supervisor.status().reason, /file\/README handoff/);
    await supervisor.reconcile();
    await assert.rejects(supervisor.run(), /fixture reached fresh producer/);
    assert.equal(started, true);
  } finally { await supervisor.close(); }
});
