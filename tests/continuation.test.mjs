import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture, call, textOf, execute, deferred, waitForAbort } from './native-fixture.mjs';

test('a candidate waits idle and reviewer feedback continues the original native session', { timeout: 15000 }, async () => {
  let report;
  const fixture = await nativeFixture({ script({ step, messages, lastTool }) {
    if (step === 0) return call('write', { file_path: 'plan.json', content: '{"draft":true}' });
    if (step === 1) return call('research_submit', { value: { path: 'plan.json' } });
    if (step === 2) {
      const history = messages.map(textOf).join('\n');
      assert.match(history, /original investigation context/);
      assert.match(history, /independent reviewer requests correction/);
      assert.ok(messages.some(message => message.role === 'tool'));
      return call('read', { file_path: report });
    }
    if (step === 3) {
      assert.notEqual(lastTool.isError, true, textOf(lastTool));
      assert.match(textOf(lastTool), /Correct the draft/);
      return call('edit', { file_path: 'plan.json', old_string: 'true', new_string: 'false' });
    }
    if (step === 4) return call('research_submit', { value: { path: 'plan.json' } });
    throw new Error(`Unexpected continuation step ${step}`);
  } });
  try {
    report = join(fixture.paths['plan-reviewer'], 'REVIEW.md');
    await writeFile(report, 'Correct the draft without forgetting the investigation.');
    const job = fixture.job('planner', { prompt: 'original investigation context', keepAlive: true });
    const first = await fixture.runner.run(job, () => {});
    assert.equal(first.reason, 'completed');
    const original = fixture.ctx.agents.get(first.sessionId);
    assert.ok(original, 'candidate submission must not dispose the planner awaiting review');
    assert.equal(fixture.requests.length, 2, 'waiting for review must not call the model');
    assert.equal((await execute(fixture.ctx, original, 'write', { file_path: 'late.txt', content: 'forbidden' })).isError, true);
    assert.equal((await execute(fixture.ctx, original, 'research_submit', { value: { path: 'plan.json' } })).isError, true);
    for (const changes of [{ cwd: fixture.paths.executor }, { taskId: 'another-task' }, { role: 'executor' }]) {
      await assert.rejects(fixture.runner.run({ ...job, sessionId: first.sessionId, ...changes }, () => {}), /Continuation requires/);
    }
    const second = await fixture.runner.run({ ...job, id: 'revision-2', sessionId: first.sessionId,
      prompt: 'independent reviewer requests correction', readRoots: [...job.readRoots, report] }, () => {});
    assert.equal(second.reason, 'completed');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(fixture.ctx.agents.get(second.sessionId), original);
    assert.equal(fixture.children.length, 1);
    await fixture.runner.closeSession(second.sessionId);
    assert.equal(fixture.ctx.agents.get(second.sessionId), undefined);
  } finally { await fixture.close(); }
});

for (const stop of ['closeSession', 'cancel']) {
  test(`${stop} reports native teardown failure for a retained candidate`, { timeout: 10000 }, async () => {
    const fixture = await nativeFixture({ script({ step }) {
      if (step === 0) return call('write', { file_path: 'plan.json', content: '{}' });
      if (step === 1) return call('research_submit', { value: { path: 'plan.json' } });
      throw new Error('Unexpected model request');
    }, setup({ ctx }) {
      const create = ctx.agents.create.bind(ctx.agents);
      ctx.agents.create = async options => {
        const handle = await create(options);
        return { ...handle, async dispose() {
          await handle.dispose();
          throw new Error('Injected native teardown failure');
        } };
      };
    } });
    try {
      const result = await fixture.runner.run(fixture.job('planner', { keepAlive: true }), () => {});
      assert.equal(result.reason, 'completed');
      await assert.rejects(stop === 'closeSession' ? fixture.runner.closeSession(result.sessionId) : fixture.runner.cancel(), /cleanup failed/i);
      assert.equal(fixture.ctx.agents.get(result.sessionId), undefined);
    } finally { await fixture.close(); }
  });
}

for (const stop of ['cancel', 'deadline', 'unload']) {
  test(`${stop} disposes an idle candidate and cannot revive its session`, { timeout: 10000 }, async () => {
    const removed = deferred();
    let target;
    const fixture = await nativeFixture({ script({ step }) {
      if (step === 0) return call('write', { file_path: 'plan.json', content: '{}' });
      if (step === 1) return call('research_submit', { value: { path: 'plan.json' } });
      throw new Error('An idle candidate must not call the model');
    }, setup({ ctx }) {
      ctx.on('agent/created', ({ agent }) => {
        if (agent.id.startsWith('research-')) agent.ctx.effect(() => () => {
          if (agent.id === target) removed.resolve();
        });
      });
    } });
    try {
      const job = fixture.job('planner', { keepAlive: true, deadline: Date.now() + (stop === 'deadline' ? 1000 : 5000) });
      const result = await fixture.runner.run(job, () => {});
      assert.equal(result.reason, 'completed');
      target = result.sessionId;
      assert.ok(fixture.ctx.agents.get(target));
      if (stop === 'cancel') await fixture.runner.cancel();
      else if (stop === 'unload') await fixture.runnerFiber.dispose();
      else await removed.promise;
      await fixture.runner.closeSession(target);
      assert.equal(fixture.ctx.agents.get(target), undefined);
      await assert.rejects(fixture.runner.run({ ...job, sessionId: target }, () => {}), /Continuation requires|disposed/);
      assert.equal(fixture.requests.length, 2);
    } finally { await fixture.close(); }
  });
}

test('a continuation is exclusive and cancellation drains its running model', { timeout: 10000 }, async () => {
  const entered = deferred();
  let aborted = false;
  const fixture = await nativeFixture({ script: async ({ step, signal }) => {
    if (step === 0) return call('write', { file_path: 'plan.json', content: '{}' });
    if (step === 1) return call('research_submit', { value: { path: 'plan.json' } });
    entered.resolve();
    try { return await waitForAbort(signal); } finally { aborted = true; }
  } });
  try {
    const job = fixture.job('planner', { keepAlive: true });
    const initial = await fixture.runner.run(job, () => {});
    const followup = { ...job, sessionId: initial.sessionId, prompt: 'Revise the candidate' };
    const running = fixture.runner.run(followup, () => assert.fail('Cancelled continuation must not submit'));
    await entered.promise;
    await assert.rejects(fixture.runner.run(followup, () => {}), /Continuation requires/);
    await fixture.runner.cancel();
    assert.equal((await running).reason, 'cancelled');
    assert.equal(aborted, true);
    assert.equal(fixture.ctx.agents.get(initial.sessionId), undefined);
    assert.equal(fixture.children.length, 1);
  } finally { await fixture.close(); }
});
