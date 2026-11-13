import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture, call, textOf } from './native-fixture.mjs';
import { ResearchSupervisor } from '../lib/supervision.js';

const plan = {
  version: 1,
  claims: [{ id: 'C1', statement: 'Two bounded fixture results', required: true,
    source: { document: 'source.txt', locator: 'line 1' }, requires: ['E1', 'E2'] }],
  evidence: ['E1', 'E2'].map(id => ({ id, claimId: 'C1', description: id, scope: 'engineering fixture only' })),
  tasks: [
    { id: 'T1', title: 'First', objective: 'Produce the checked fixture', produces: ['E1'], consumes: [], dependsOn: [], maxAttempts: 2 },
    { id: 'T2', title: 'Second', objective: 'Consume the accepted fixture', produces: ['E2'], consumes: ['E1'], dependsOn: ['T1'], maxAttempts: 1 },
  ],
};
const review = (decision, accepted, reason) => ({ decision, accepted, reason, report: 'REVIEW.md' });
const delivery = requirement => ({ readme: 'README.md', artifacts: [{ path: 'result.json', requirements: [requirement] }], conclusion: 'Bounded fixture' });
const latestPrompt = messages => messages.filter(message => message.role === 'user').map(textOf).filter(text => text.includes('ROLE:')).at(-1);

for (const producerContext of ['isolated', 'full']) {
test(`${producerContext}: plan and task quality rework return to original sessions while reviewers correct scope`, { timeout: 30000 }, async () => {
  let supervisor;
  let plannerSession;
  let executorSession;
  let planReviews = 0;
  let taskReviews = 0;
  const reviewOrdinals = new Map();
  const fixture = await nativeFixture({ script({ role, sessionId, step, lastTool, messages }) {
    const prompt = latestPrompt(messages);
    if (step === 0 && role === 'executor' && producerContext === 'full') {
      assert.match(JSON.stringify(messages), /Initial investigation/, 'planner history must reach executors');
      if (prompt.includes('"id":"T2"')) assert.match(JSON.stringify(messages), /Original implementation investigation/);
    }
    if (step === 0 && role.includes('reviewer')) {
      assert.ok(!messages.some(message => message.role === 'assistant' || message.role === 'tool'), 'reviewer starts without producer messages');
    }
    if (role === 'planner') {
      if (step === 0) {
        assert.equal(plannerSession, undefined, 'plan rework must not create a new planner');
        plannerSession = sessionId;
        return call('write', { file_path: 'plan.json', content: JSON.stringify(plan) });
      }
      if (step === 1) return call('write', { file_path: 'README.md', content: 'Initial investigation from source.txt; see plan.json.' });
      if (step === 2) return call('research_submit', { value: { path: 'plan.json' } });
      if (step === 3) {
        assert.match(prompt, /explain method comparison/);
        assert.match(JSON.stringify(messages), /Initial investigation/);
        return call('read', { file_path: supervisor.status().plans[0].report });
      }
      if (step === 4) {
        assert.notEqual(lastTool.isError, true, textOf(lastTool));
        return call('write', { file_path: 'README.md', content: 'Revised investigation: explain method comparison using the source.' });
      }
      if (step === 5) return call('research_submit', { value: { path: 'plan.json' } });
    }
    if (role === 'plan-reviewer') {
      if (step === 0) {
        reviewOrdinals.set(sessionId, ++planReviews);
        assert.ok(fixture.ctx.agents.get(plannerSession), 'planner stays alive but idle while reviewed');
        return call('write', { file_path: 'REVIEW.md', content: planReviews === 1 ? 'Please explain method comparison.' : 'Source and revised plan inspected.' });
      }
      if (step === 1) return call('research_submit', { value: review('accept', ['E404'], 'Invalid scope fixture') });
      if (step === 2) {
        assert.equal(lastTool.isError, true);
        assert.match(textOf(lastTool), /E404/);
        return call('research_submit', { value: reviewOrdinals.get(sessionId) === 1
          ? review('rework', [], 'Please explain method comparison') : review('accept', ['E1', 'E2'], 'Plan inspected') });
      }
    }
    if (role === 'executor') {
      const task = JSON.parse(/Task: (\{[^\n]*\})/.exec(prompt)[1]);
      if (task.id === 'T2') {
        assert.equal(supervisor.status().evidence.filter(item => item.requirementId === 'E1').length, 1);
        if (step === 0) return call('write', { file_path: 'result.json', content: '{"value":3}' });
        if (step === 1) return call('write', { file_path: 'README.md', content: 'Consumes the accepted E1 snapshot; see result.json.' });
        if (step === 2) return call('research_submit', { value: delivery('E2') });
      } else {
        if (step === 0) {
          assert.equal(executorSession, undefined, 'task rework must not create a new executor');
          executorSession = sessionId;
          return call('write', { file_path: 'result.json', content: '{"value":1}' });
        }
        if (step === 1) return call('write', { file_path: 'README.md', content: 'Original implementation investigation; see result.json.' });
        if (step === 2) return call('research_submit', { value: delivery('E2') });
        if (step === 3) {
          assert.equal(lastTool.isError, true);
          assert.match(textOf(lastTool), /explicit evidence mapping/);
          assert.equal(supervisor.status().attempts.length, 1, 'malformed submission does not consume another quality attempt');
          return call('research_submit', { value: delivery('E1') });
        }
        if (step === 4) {
          assert.match(prompt, /correct value to two/);
          assert.match(JSON.stringify(messages), /Original implementation investigation/);
          assert.equal(supervisor.status().evidence.length, 0);
          return call('read', { file_path: supervisor.status().attempts[0].reviewReport });
        }
        if (step === 5) {
          assert.notEqual(lastTool.isError, true, textOf(lastTool));
          return call('edit', { file_path: 'result.json', old_string: '1', new_string: '2' });
        }
        if (step === 6) return call('research_submit', { value: delivery('E1') });
      }
    }
    if (role === 'reviewer') {
      const task = JSON.parse(/Task: (\{[^\n]*\})/.exec(prompt)[1]);
      if (step === 0) {
        reviewOrdinals.set(sessionId, ++taskReviews);
        if (task.id === 'T1') assert.ok(fixture.ctx.agents.get(executorSession), 'executor waits idle for quality review');
        return call('write', { file_path: 'REVIEW.md', content: taskReviews === 1 ? 'Please correct value to two.' : 'Read implementation and actual outputs in the candidate snapshot.' });
      }
      const ordinal = reviewOrdinals.get(sessionId);
      if (step === 1) return call('research_submit', { value: ordinal === 1
        ? review('rework', [], 'Please correct value to two')
        : review('accept', ordinal === 2 ? ['E1', 'E2'] : ['E2'], 'Bounded evidence inspected') });
      if (step === 2 && ordinal === 2) {
        assert.equal(lastTool.isError, true);
        assert.match(textOf(lastTool), /E1/);
        assert.match(textOf(lastTool), /E2/);
        return call('research_submit', { value: review('accept', ['E1'], 'Only T1 evidence inspected') });
      }
    }
    throw new Error(`Unexpected feedback-loop step ${role}/${step}`);
  } });
  try {
    const source = join(fixture.paths.inputs, 'source.txt');
    await writeFile(source, 'Produce two fixtures and explain the method comparison.');
    const root = join(fixture.root, 'project');
    supervisor = await ResearchSupervisor.open(root, fixture.runner, {
      goal: 'Exercise native quality feedback', sources: [source], deadline: new Date(Date.now() + 20000).toISOString(), maxReplans: 1,
      producerContext,
    });
    await supervisor.run().catch(error => { throw new Error(`${error.message}\n${fixture.errors.map(String).join('\n')}`, { cause: error }); });
    const state = supervisor.status();
    assert.equal(state.status, 'completed', state.reason);
    assert.equal(state.plans.length, 2);
    assert.equal(state.plans[0].sessionId, state.plans[1].sessionId);
    assert.equal(state.attempts.length, 3);
    assert.equal(state.attempts[0].sessionId, state.attempts[1].sessionId);
    assert.equal(state.attempts[0].directory, state.attempts[1].directory);
    assert.notEqual(state.attempts[0].id, state.attempts[1].id);
    assert.notEqual(state.attempts[0].reviewSessionId, state.attempts[1].reviewSessionId);
    assert.equal(await readFile(join(root, 'snapshots', state.attempts[0].id, 'result.json'), 'utf8'), '{"value":1}');
    assert.equal(await readFile(join(root, 'snapshots', state.attempts[1].id, 'result.json'), 'utf8'), '{"value":2}');
    assert.equal(state.evidence.length, 2);
    assert.equal(state.active, undefined);
    assert.ok(fixture.children.every(child => !fixture.ctx.agents.get(child.id)));
    assert.deepEqual(fixture.errors, []);
  } finally { await supervisor?.close(); await fixture.close(); }
});

}

test('a failed continuation releases its session binding before another bounded attempt', { timeout: 15000 }, async () => {
  let supervisor;
  let reviews = 0;
  const boundedPlan = { ...plan, tasks: [{ ...plan.tasks[0], produces: ['E1', 'E2'], maxAttempts: 3 }] };
  const fixture = await nativeFixture({ script({ role, step }) {
    if (role === 'planner') {
      if (step === 0) return call('write', { file_path: 'plan.json', content: JSON.stringify(boundedPlan) });
      if (step === 1) return call('write', { file_path: 'README.md', content: 'Bounded plan from source.txt.' });
      if (step === 2) return call('research_submit', { value: { path: 'plan.json' } });
    }
    if (role === 'plan-reviewer') {
      if (step === 0) return call('write', { file_path: 'REVIEW.md', content: 'Checked bounded plan.' });
      if (step === 1) return call('research_submit', { value: review('accept', ['E1', 'E2'], 'Plan accepted') });
    }
    if (role === 'executor') {
      if (step === 0) return call('write', { file_path: 'result.json', content: '{"value":2}' });
      if (step === 1) return call('write', { file_path: 'README.md', content: 'Actual fixture data: result.json.' });
      if (step === 2) return call('research_submit', { value: { ...delivery('E1'), artifacts: [{ path: 'result.json', requirements: ['E1', 'E2'] }] } });
      if (step === 3) return { text: 'The continuation ended without a valid candidate.' };
    }
    if (role === 'reviewer') {
      if (step === 0) { reviews++; return call('write', { file_path: 'REVIEW.md', content: 'Independent quality decision.' }); }
      if (step === 1) return call('research_submit', { value: reviews < 3
        ? review('rework', [], 'A bounded retry is needed') : review('accept', ['E1', 'E2'], 'The new candidate supports both') });
    }
    throw new Error(`Unexpected failed-continuation step ${role}/${step}`);
  } });
  try {
    const source = join(fixture.paths.inputs, 'source.txt');
    await writeFile(source, 'Produce two bounded fixture results.');
    supervisor = await ResearchSupervisor.open(join(fixture.root, 'project'), fixture.runner, {
      goal: 'Exercise bounded recovery', sources: [source], deadline: new Date(Date.now() + 10000).toISOString(), maxReplans: 0,
    });
    await supervisor.run();
    const state = supervisor.status();
    assert.equal(state.status, 'completed', state.reason);
    assert.equal(state.attempts.length, 3);
    assert.equal(state.attempts[0].sessionId, state.attempts[1].sessionId);
    assert.notEqual(state.attempts[1].sessionId, state.attempts[2].sessionId);
    assert.match(state.attempts[1].error, /Executor ended: error/);
    assert.equal(state.attempts[1].review.decision, 'rework');
    assert.equal(state.evidence.length, 2);
    assert.ok(fixture.children.every(child => !fixture.ctx.agents.get(child.id)));
    assert.deepEqual(fixture.errors, []);
  } finally { await supervisor?.close(); await fixture.close(); }
});

for (const outcome of ['partial-then-accept', 'rework-at-limit']) {
  test(`${outcome} preserves published snapshots and the original attempt limit`, { timeout: 15000 }, async () => {
    let supervisor;
    let reviews = 0;
    const boundedPlan = { ...plan, tasks: [{ ...plan.tasks[0], produces: ['E1', 'E2'], maxAttempts: 2 }] };
    const candidate = { readme: 'README.md', artifacts: [{ path: 'result.json', requirements: ['E1', 'E2'] }], conclusion: 'Bounded fixture' };
    const fixture = await nativeFixture({ script({ role, step, lastTool }) {
      if (role === 'planner') {
        if (step === 0) return call('write', { file_path: 'plan.json', content: JSON.stringify(boundedPlan) });
        if (step === 1) return call('write', { file_path: 'README.md', content: 'Two requirements in one bounded task.' });
        if (step === 2) return call('research_submit', { value: { path: 'plan.json' } });
      }
      if (role === 'plan-reviewer') {
        if (step === 0) return call('write', { file_path: 'REVIEW.md', content: 'The bounded fixture plan is adequate.' });
        if (step === 1) return call('research_submit', { value: review('accept', ['E1', 'E2'], 'Reviewed plan') });
      }
      if (role === 'executor') {
        if (step === 0) return call('write', { file_path: 'result.json', content: '{"revision":1}' });
        if (step === 1) return call('write', { file_path: 'README.md', content: 'See result.json for bounded candidate data.' });
        if (step === 2) return call('research_submit', { value: candidate });
        if (step === 3) {
          assert.equal(reviews, 1);
          assert.equal(supervisor.status().evidence.length, outcome === 'partial-then-accept' ? 1 : 0);
          return call('read', { file_path: supervisor.status().attempts[0].reviewReport });
        }
        if (step === 4) {
          assert.notEqual(lastTool.isError, true, textOf(lastTool));
          return call('edit', { file_path: 'result.json', old_string: '1', new_string: '2' });
        }
        if (step === 5) return call('research_submit', { value: candidate });
      }
      if (role === 'reviewer') {
        if (step === 0) {
          reviews++;
          return call('write', { file_path: 'REVIEW.md', content: 'Check each requirement; fix the unresolved result.' });
        }
        if (step === 1) return call('research_submit', { value: outcome === 'rework-at-limit'
          ? review('rework', [], 'Needs more work')
          : reviews === 1 ? review('partial', ['E1'], 'E2 needs correction') : review('accept', ['E1', 'E2'], 'Both requirements supported') });
      }
      throw new Error(`Unexpected bounded-loop step ${role}/${step}`);
    } });
    try {
      const source = join(fixture.paths.inputs, 'source.txt');
      await writeFile(source, 'Two bounded engineering requirements.');
      const root = join(fixture.root, 'project');
      const deadline = new Date(Date.now() + 10000).toISOString();
      supervisor = await ResearchSupervisor.open(root, fixture.runner, { goal: 'Bounded feedback', sources: [source], deadline, maxReplans: 0 });
      await supervisor.run();
      const state = supervisor.status();
      assert.equal(state.status, outcome === 'partial-then-accept' ? 'completed' : 'blocked');
      assert.equal(state.request.deadline, deadline);
      assert.equal(state.attempts.length, 2);
      assert.equal(state.attempts[0].sessionId, state.attempts[1].sessionId);
      assert.equal(fixture.children.filter(child => child.id.startsWith('research-executor-')).length, 1);
      assert.equal(await readFile(join(root, 'snapshots', state.attempts[0].id, 'result.json'), 'utf8'), '{"revision":1}');
      assert.equal(await readFile(join(root, 'snapshots', state.attempts[1].id, 'result.json'), 'utf8'), '{"revision":2}');
      if (outcome === 'partial-then-accept') {
        assert.equal(state.evidence.length, 2);
        assert.equal(state.evidence.find(item => item.requirementId === 'E1').attemptId, state.attempts[0].id);
        assert.equal(state.evidence.find(item => item.requirementId === 'E2').attemptId, state.attempts[1].id);
      } else assert.equal(state.evidence.length, 0);
      assert.ok(fixture.children.every(child => !fixture.ctx.agents.get(child.id)));
      assert.deepEqual(fixture.errors, []);
    } finally { await supervisor?.close(); await fixture.close(); }
  });
}
