import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, nativeFixture, textOf, deferred, waitForAbort } from './native-fixture.mjs';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { ResearchSupervisor } from '../lib/supervision.js';

const assignment = messages => textOf(messages.filter(message => message.role === 'user').at(-1));
const submitPlan = () => call('research_submit', { value: { path: 'plan.json' } });

async function simpleFixture(script, options = {}) {
  return nativeFixture({ ...options, script: script ?? (({ step }) => step === 0
    ? call('write', { file_path: 'plan.json', content: '{}' }) : submitPlan()) });
}

for (const mutation of ['missing', 'forged', 'foreign-project', 'reviewer']) {
  test(`full history rejects ${mutation} checkpoint use before calling the model`, { timeout: 15000 }, async () => {
    const fixture = await simpleFixture();
    try {
      const job = fixture.job('planner', { producerContext: { projectId: fixture.root } });
      const first = await fixture.runner.run(job, () => {});
      assert.equal(first.reason, 'completed');
      const next = { ...job, producerContext: { projectId: fixture.root, previous: first.checkpoint } };
      if (mutation === 'missing') delete next.producerContext.previous;
      if (mutation === 'forged') next.producerContext.previous = { ...first.checkpoint };
      if (mutation === 'foreign-project') next.producerContext.projectId += '-other';
      if (mutation === 'reviewer') next.role = 'reviewer';
      const calls = fixture.requests.length;
      await assert.rejects(fixture.runner.run(next, () => {}), /checkpoint|another project|Reviewers|deadline/);
      assert.equal(fixture.requests.length, calls);
    } finally { await fixture.close(); }
  });
}

for (const service of ['compaction', 'toolResultPruner']) {
  test(`full history permits a profile with ${service}`, { timeout: 15000 }, async () => {
    const fixture = await simpleFixture(undefined, { async setup({ ctx }) {
      await ctx.plugin({ name: `fixture-${service}`, apply(scope) { scope.provide(service, {}); } });
    } });
    try {
      const result = await fixture.runner.run(fixture.job('planner', { producerContext: { projectId: fixture.root } }), () => {});
      assert.equal(result.reason, 'completed');
      assert.equal(result.checkpoint.contextLoss, undefined);
      assert.ok(fixture.requests.length > 0);
    } finally { await fixture.close(); }
  });
}

for (const fault of ['truncated', 'surface-replacement', 'compaction', 'overflow', 'query-error']) {
  test(`full context records ${fault} and continues through explicit file handoff`, { timeout: 15000 }, async () => {
    let recovering = false;
    const fixture = await simpleFixture(({ step, messages, lastTool }) => {
      if (recovering) {
        if (step === 0) {
          assert.match(messages.filter(message => message.role === 'user').map(textOf).join('\n'), /Context loss:.*Full transcript is unavailable/s);
          return call('read', { file_path: join(fixture.paths.planner, 'README.md') });
        }
        if (step === 1) {
          assert.notEqual(lastTool.isError, true, textOf(lastTool));
          assert.match(textOf(lastTool), /preserved incremental files/);
          return call('write', { file_path: 'plan.json', content: '{}' });
        }
        return submitPlan();
      }
      if (fault === 'overflow') throw new LlmError('Context is full', 'CONTEXT_WINDOW_EXCEEDED');
      return step === 0 ? call('write', { file_path: 'plan.json', content: '{}' }) : submitPlan();
    }, { setup({ ctx }) {
      if (['truncated', 'compaction', 'query-error'].includes(fault)) {
        const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
        ctx.sessionQuery.observeSession = async (...args) => {
          if (recovering) return observe(...args);
          if (fault === 'query-error') throw new Error('Fixture history query failed');
          const observation = await observe(...args);
          const events = fault === 'truncated' ? observation.events.slice(1)
            : observation.events.map((event, index) => index === 0 ? { ...event, type: 'compaction/complete' } : event);
          return { ...observation, events, [Symbol.dispose]: () => observation[Symbol.dispose]() };
        };
      }
      if (fault === 'surface-replacement') {
        ctx.on('agent/created', ({ agent }) => {
          if (!agent.id.startsWith('research-')) return;
          agent.ctx.on('agent/request', async (payload, next) => {
            if (payload.step > 1) {
              const observation = await ctx.sessionQuery.observeSession(agent.id, { projectionMode: 'none' });
              try {
                const event = observation.events.findLast(item => item.type === 'tool/result');
                agent.session.append('tool/result', event.data,
                  { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] });
              } finally { observation[Symbol.dispose](); }
            }
            return next();
          });
        });
      }
    } });
    try {
      await writeFile(join(fixture.paths.planner, 'README.md'), 'preserved incremental files');
      const job = fixture.job('planner', { producerContext: { projectId: fixture.root } });
      const first = await fixture.runner.run(job, () => {});
      assert.equal(first.reason, fault === 'overflow' ? 'error' : 'completed');
      assert.ok(first.checkpoint.contextLoss);
      recovering = true;
      const cwd = join(fixture.root, 'file-handoff');
      await mkdir(cwd);
      const result = await fixture.runner.run({ ...job, cwd,
        producerContext: { projectId: fixture.root, previous: first.checkpoint } }, () => {});
      assert.equal(result.reason, 'completed', fixture.errors.map(String).join('\n'));
      assert.ok(result.checkpoint.contextLoss, 'loss must remain visible, not falsely labelled full history');
      assert.ok(fixture.children.every(child => !fixture.ctx.agents.get(child.id)));
    } finally { await fixture.close(); }
  });
}

for (const action of ['cancel', 'deadline', 'unload', 'model-error']) {
  test(`full history drains ${action} without losing the last producer turn`, { timeout: 15000 }, async () => {
    const entered = deferred();
    let recovering = false;
    const fixture = await simpleFixture(async ({ step, signal, messages }) => {
      if (recovering) {
        if (step === 0) {
          assert.match(JSON.stringify(messages), /BEFORE_STOP/);
          return call('write', { file_path: 'plan.json', content: '{}' });
        }
        return submitPlan();
      }
      if (step === 0) return call('write', { file_path: 'plan.json', content: '{"observation":"BEFORE_STOP"}' });
      entered.resolve();
      if (action === 'model-error') throw new Error('Simulated provider failure');
      return waitForAbort(signal);
    });
    try {
      const job = fixture.job('planner', { deadline: Date.now() + (action === 'deadline' ? 1500 : 10000), producerContext: { projectId: fixture.root } });
      const running = fixture.runner.run(job, () => assert.fail('No candidate submitted'));
      await entered.promise;
      if (action === 'cancel') await fixture.runner.cancel();
      if (action === 'unload') await fixture.runnerFiber.dispose();
      const result = await running;
      assert.equal(result.reason, action === 'deadline' ? 'timeout' : action === 'model-error' ? 'error' : 'cancelled');
      assert.ok(result.checkpoint);
      assert.equal(fixture.ctx.agents.get(result.sessionId), undefined);
      if (action === 'cancel' || action === 'model-error') {
        const foreignRunner = fixture.createRunner();
        const cwd = join(fixture.root, 'recovery');
        await mkdir(cwd);
        const next = { ...job, cwd, producerContext: { projectId: fixture.root, previous: result.checkpoint } };
        await assert.rejects(foreignRunner.run(next, () => {}), /owned checkpoint/);
        recovering = true;
        const recovered = await fixture.runner.run(next, () => {});
        assert.equal(recovered.reason, 'completed');
        assert.equal(recovered.checkpoint.generation, 2);
        assert.notEqual(recovered.sessionId, result.sessionId);
      }
    } finally { await fixture.close(); }
  });
}

test('seeded workspaces can read retired artifacts but cannot write them', { timeout: 15000 }, async () => {
  let previousFile;
  const fixture = await simpleFixture(({ role, step, lastTool }) => {
    if (role === 'planner') return step === 0 ? call('write', { file_path: 'plan.json', content: '{"retired":true}' }) : submitPlan();
    if (step === 0) return call('read', { file_path: previousFile });
    if (step === 1) {
      assert.notEqual(lastTool.isError, true, textOf(lastTool));
      assert.match(textOf(lastTool), /retired/);
      return call('write', { file_path: previousFile, content: 'tampered' });
    }
    if (step === 2) {
      assert.equal(lastTool.isError, true);
      return call('bash', { command: `printf tampered > ${JSON.stringify(previousFile)}`, description: 'Probe old directory write protection' });
    }
    if (step === 3) {
      assert.match(textOf(lastTool), /Permission denied|Read-only|EACCES|EROFS/i);
      return call('write', { file_path: 'README.md', content: 'Current workspace only' });
    }
    if (step === 4) return call('write', { file_path: 'result.json', content: '{}' });
    return call('research_submit', { value: { readme: 'README.md', artifacts: [{ path: 'result.json', requirements: ['E1'] }], conclusion: 'Checked' } });
  });
  try {
    const deadline = Date.now() + 10000;
    previousFile = join(fixture.paths.planner, 'plan.json');
    const parent = await fixture.runner.run(fixture.job('planner', { deadline, producerContext: { projectId: fixture.root } }), () => {});
    const result = await fixture.runner.run(fixture.job('executor', { deadline, producerContext: { projectId: fixture.root, previous: parent.checkpoint } }), () => {});
    assert.equal(result.reason, 'completed', fixture.errors.map(String).join('\n'));
    assert.equal(await readFile(previousFile, 'utf8'), '{"retired":true}');
  } finally { await fixture.close(); }
});

test('full producer history crosses task boundaries while both reviewers remain isolated', { timeout: 15000 }, async () => {
  const fixture = await nativeFixture({ script({ role, step, messages, lastTool }) {
    const current = assignment(messages);
    const history = JSON.stringify(messages);
    if (role === 'plan-reviewer' || role === 'reviewer') {
      assert.doesNotMatch(history, /PLANNER_ONLY|T1_ONLY/);
      if (step === 0) return call('write', { file_path: 'REVIEW.md', content: 'Independent fixture review.' });
      return call('research_submit', { value: { decision: 'accept', accepted: ['E1'], report: 'REVIEW.md', reason: 'Checked fixture' } });
    }
    if (role === 'planner') {
      if (step === 0) return call('bash', { command: "printf 'PLANNER_ONLY'", description: 'Produce a transient fixture observation' });
      if (step === 1) {
        assert.match(textOf(lastTool), /PLANNER_ONLY/);
        return call('write', { file_path: 'plan.json', content: '{}' });
      }
      return call('research_submit', { value: { path: 'plan.json' } });
    }
    if (step === 0) {
      assert.match(history, /PLANNER_ONLY/, 'executor must inherit the planner tool history');
      if (current.includes('TASK TWO')) {
        assert.match(history, /T1_ONLY/);
        assert.equal(messages.filter(message => message.role === 'tool' && textOf(message).includes('PLANNER_ONLY')).length, 1);
      }
      return call('bash', { command: current.includes('TASK TWO') ? 'pwd' : "printf 'T1_ONLY'", description: 'Observe current task workspace' });
    }
    if (step === 1) return call('write', { file_path: 'README.md', content: 'Fixture result.' });
    if (step === 2) return call('write', { file_path: 'result.json', content: '{"valid":true}' });
    return call('research_submit', { value: { readme: 'README.md', artifacts: [{ path: 'result.json', requirements: ['E1'] }], conclusion: 'Done' } });
  } });
  try {
    const deadline = Date.now() + 10000;
    let previous;
    for (const [role, taskId, prompt] of [['planner', undefined, 'PLAN'], ['plan-reviewer', undefined, 'REVIEW PLAN'], ['executor', 'T1', 'TASK ONE'], ['reviewer', 'T1', 'REVIEW T1'], ['executor', 'T2', 'TASK TWO']]) {
      const cwd = join(fixture.root, `${role}-${taskId ?? 'plan'}`);
      await mkdir(cwd);
      const producer = role === 'planner' || role === 'executor';
      const result = await fixture.runner.run(fixture.job(role, { cwd, taskId, prompt, deadline,
        ...(producer ? { producerContext: { projectId: fixture.root, previous } } : {}) }), () => {});
      assert.equal(result.reason, 'completed', fixture.errors.map(String).join('\n'));
      if (producer) {
        assert.ok(result.checkpoint, 'full producer run returns a retained history checkpoint');
        previous = result.checkpoint;
      } else assert.equal(result.checkpoint, undefined);
      assert.equal(fixture.ctx.agents.get(result.sessionId), undefined);
    }
    assert.equal(previous.generation, 3);
    assert.equal(fixture.children.length, 5);
    assert.equal(fixture.results.filter(result => result.name === 'bash').length, 3, 'inherited tool calls are never re-executed');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
