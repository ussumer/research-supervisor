import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, access } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { call, deferred, nativeFixture, textOf, waitForAbort } from './native-fixture.mjs';
import { ResearchSupervisor } from '../lib/supervision.js';

const plan = {
  version: 1,
  claims: [{ id: 'C-sum', statement: 'The example adds two integers', source: { document: 'spec.txt', locator: 'line 1' },
    required: true, requires: ['E-sum'] }],
  evidence: [{ id: 'E-sum', claimId: 'C-sum', description: 'Actual passing assertion and implementation', scope: 'add(2,3)=5' }],
  tasks: [{ id: 'T-sum', title: 'Implement addition', objective: 'Run and fix the integer addition example',
    produces: ['E-sum'], consumes: [], dependsOn: [], maxAttempts: 2 }],
};

function success(message) {
  assert.ok(message, 'model must observe a real tool result before continuing');
  assert.notEqual(message.isError, true, textOf(message));
  return textOf(message);
}

function reviewValue(decision = 'accept') {
  return { decision, accepted: decision === 'accept' ? ['E-sum'] : [], report: 'REVIEW.md', reason: 'Checked actual source and test output.' };
}

test('native independent role sessions read, write, run a failing test, edit, rerun and submit', { timeout: 30_000 }, async () => {
  let paths;
  const transitions = [];
  const fixture = await nativeFixture({ script(request) {
    const { role, step, lastTool } = request;
    assert.equal(request.model, 'scripted-fixture', 'role inherits the parent route');
    if (step === 0) {
      assert.ok(request.tools.some(tool => tool.name === 'research_submit'));
      assert.ok(request.tools.some(tool => tool.name === 'bash'));
    }
    assert.ok(request.tools.every(tool => ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'research_submit'].includes(tool.name)));
    if (role === 'planner') {
      if (step === 0) return call('read', { file_path: join(paths.inputs, 'spec.txt') });
      if (step === 1) {
        assert.match(success(lastTool), /Expected add\(2,3\)=5/u);
        return call('write', { file_path: 'plan.json', content: JSON.stringify(plan) });
      }
      if (step === 2) { success(lastTool); return call('write', { file_path: 'README.md', content: 'Source spec.txt line 1 requires a passing addition assertion. See plan.json.' }); }
      if (step === 3) { success(lastTool); return call('research_submit', { value: { path: 'plan.json' } }); }
    }
    if (role === 'plan-reviewer') {
      if (step === 0) return call('read', { file_path: join(paths.planner, 'plan.json') });
      if (step === 1) { assert.match(success(lastTool), /E-sum/u); return call('read', { file_path: join(paths.inputs, 'spec.txt') }); }
      if (step === 2) { assert.match(success(lastTool), /Expected/u); return call('write', { file_path: 'REVIEW.md', content: 'Plan C-sum and E-sum match spec.txt line 1; a real assertion is required.' }); }
      if (step === 3) { success(lastTool); return call('research_submit', { value: reviewValue() }); }
    }
    if (role === 'executor') {
      if (step === 0) return call('read', { file_path: join(paths.inputs, 'spec.txt') });
      if (step === 1) { assert.match(success(lastTool), /Expected/u); return call('write', { file_path: 'sum.cjs', content: 'module.exports = (left, right) => left - right;\n' }); }
      if (step === 2) { success(lastTool); return call('write', { file_path: 'sum.test.cjs', content: "const assert = require('node:assert/strict');\nassert.equal(require('./sum.cjs')(2, 3), 5);\nconsole.log('checks passed');\n" }); }
      if (step === 3) { success(lastTool); return call('bash', { command: 'node sum.test.cjs', description: 'Run the actual addition assertion' }); }
      if (step === 4) {
        assert.match(textOf(lastTool), /AssertionError|ERR_ASSERTION/u, 'the model must see the real failed assertion');
        transitions.push('observed failure');
        return call('read', { file_path: 'sum.cjs' });
      }
      if (step === 5) {
        assert.match(success(lastTool), /left - right/u);
        return call('edit', { file_path: 'sum.cjs', old_string: 'left - right', new_string: 'left + right' });
      }
      if (step === 6) { success(lastTool); return call('bash', { command: 'set -o pipefail; node sum.test.cjs | tee test.log', description: 'Rerun and record the repaired assertion' }); }
      if (step === 7) {
        assert.match(success(lastTool), /checks passed/u);
        transitions.push('observed success');
        return call('glob', { pattern: '*.cjs' });
      }
      if (step === 8) { assert.match(success(lastTool), /sum\.test\.cjs/u); return call('grep', { pattern: 'left \\+ right', include: 'sum.cjs' }); }
      if (step === 9) { assert.match(success(lastTool), /left \+ right/u); return call('write', { file_path: 'README.md', content: 'Task T-sum: node sum.test.cjs initially failed (-1 !== 5). Replaced subtraction with addition. Reran node sum.test.cjs; actual output is in test.log. Source: inputs/spec.txt line 1. This is an engineering fixture, not scientific acceptance.' }); }
      if (step === 10) {
        success(lastTool);
        return call('research_submit', { value: { readme: 'README.md', conclusion: 'The actual assertion passed after the correction.',
          artifacts: ['sum.cjs', 'sum.test.cjs', 'test.log'].map(path => ({ path, requirements: ['E-sum'] })) } });
      }
    }
    if (role === 'reviewer') {
      if (step === 0) return call('read', { file_path: join(paths.executor, 'README.md') });
      if (step === 1) { assert.match(success(lastTool), /initially failed/u); return call('read', { file_path: join(paths.executor, 'sum.cjs') }); }
      if (step === 2) { assert.match(success(lastTool), /left \+ right/u); return call('read', { file_path: join(paths.executor, 'test.log') }); }
      if (step === 3) { assert.match(success(lastTool), /checks passed/u); return call('bash', { command: `node -e ${JSON.stringify(`require('node:assert/strict').equal(require(${JSON.stringify(join(paths.executor, 'sum.cjs'))})(2,3),5); console.log('independent check passed')`)}`, description: 'Independently rerun the submitted addition check' }); }
      if (step === 4) { assert.match(success(lastTool), /independent check passed/u); return call('write', { file_path: 'REVIEW.md', content: 'Read README, implementation and actual test.log; independently executed add(2,3)=5. E-sum is supported within this engineering fixture scope.' }); }
      if (step === 5) { success(lastTool); return call('research_submit', { value: reviewValue() }); }
    }
    throw new Error(`Unexpected fixture step ${role}/${step}`);
  } });
  paths = fixture.paths;
  try {
    await writeFile(join(paths.inputs, 'spec.txt'), 'Expected add(2,3)=5. Run a real assertion; do not claim success without execution.\n');
    const outputs = new Map();
    const runs = [];
    for (const role of ['planner', 'plan-reviewer', 'executor', 'reviewer']) {
      const readRoots = [paths.inputs, ...(role === 'plan-reviewer' ? [paths.planner] : []), ...(role === 'reviewer' ? [paths.executor] : [])];
      const result = await fixture.runner.run(fixture.job(role, { readRoots }), value => outputs.set(role, value));
      assert.equal(result.reason, 'completed', `${role}: ${fixture.errors.map(String).join('\n')}\n${JSON.stringify(fixture.results.filter(entry => entry.isError))}`);
      assert.equal(fixture.ctx.agents.get(result.sessionId), undefined, 'run returns only after native child disposal');
      runs.push(result);
    }
    assert.equal(new Set(runs.map(result => result.sessionId)).size, 4);
    assert.notEqual(runs[0].sessionId, runs[3].sessionId);
    assert.deepEqual(transitions, ['observed failure', 'observed success']);
    assert.equal(outputs.get('reviewer').decision, 'accept');
    assert.equal(await readFile(join(paths.executor, 'test.log'), 'utf8'), 'checks passed\n');
    assert.equal(await readFile(join(paths.inputs, 'spec.txt'), 'utf8'), 'Expected add(2,3)=5. Run a real assertion; do not claim success without execution.\n');
    for (const child of fixture.children) {
      assert.equal(child.session.header.isSeeded, false);
      assert.notEqual(child.session.header.cwd, fixture.parent.session.header.cwd);
    }
    const bash = fixture.results.filter(result => result.name === 'bash');
    assert.equal(bash.length, 3);
    assert.ok(bash.every(result => result.value.sandbox.mode === 'workspace-write' && result.value.sandbox.enforcement === 'full'));
    assert.notEqual(bash[0].value.exitCode, 0);
    assert.equal(bash[1].value.exitCode, 0);
    assert.equal(bash[2].value.exitCode, 0);
    assert.equal(fixture.ctx.agents.get(fixture.parent.id), fixture.parent, 'parent is not disposed or restricted');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('ResearchSupervisor automatically reaches completed through actual native role loops and sealed evidence', { timeout: 30_000 }, async () => {
  let source;
  let supervisor;
  const observed = [];
  const fixture = await nativeFixture({ script({ role, step, lastTool, messages }) {
    const instructions = messages.filter(message => message.role === 'user').map(textOf).join('\n');
    const readRoots = JSON.parse(/Read-only inputs: (\[[^\n]*\])\./u.exec(instructions)[1]);
    const snapshot = readRoots.at(-1);
    if (role === 'planner') {
      if (step === 0) return call('read', { file_path: source });
      if (step === 1) { assert.match(success(lastTool), /add\(2,3\)=5/u); return call('write', { file_path: 'plan.json', content: JSON.stringify(plan) }); }
      if (step === 2) { success(lastTool); return call('write', { file_path: 'README.md', content: 'Plan C-sum/E-sum comes from spec.txt line 1 and requires actual execution evidence.' }); }
      if (step === 3) return call('research_submit', { value: { path: 'plan.json' } });
    }
    if (role === 'plan-reviewer') {
      if (step === 0) return call('read', { file_path: join(snapshot, 'README.md') });
      if (step === 1) { assert.match(success(lastTool), /requires actual execution/u); return call('read', { file_path: join(snapshot, 'plan.json') }); }
      if (step === 2) { assert.match(success(lastTool), /E-sum/u); return call('read', { file_path: source }); }
      if (step === 3) { assert.match(success(lastTool), /add\(2,3\)=5/u); return call('write', { file_path: 'REVIEW.md', content: 'The sealed plan explicitly maps source line 1 to E-sum and a real executable assertion.' }); }
      if (step === 4) return call('research_submit', { value: reviewValue() });
    }
    if (role === 'executor') {
      if (step === 0) return call('read', { file_path: source });
      if (step === 1) { assert.match(success(lastTool), /add\(2,3\)=5/u); return call('write', { file_path: 'sum.cjs', content: 'module.exports = (left, right) => left - right;\n' }); }
      if (step === 2) return call('write', { file_path: 'sum.test.cjs', content: "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5); console.log('checks passed');\n" });
      if (step === 3) return call('bash', { command: 'node sum.test.cjs', description: 'Run the implementation assertion before delivery' });
      if (step === 4) {
        assert.match(textOf(lastTool), /AssertionError|ERR_ASSERTION/u);
        observed.push('failed assertion');
        return call('edit', { file_path: 'sum.cjs', old_string: 'left - right', new_string: 'left + right' });
      }
      if (step === 5) { success(lastTool); return call('bash', { command: 'set -o pipefail; node sum.test.cjs | tee test.log', description: 'Rerun the repaired assertion and capture output' }); }
      if (step === 6) {
        assert.match(success(lastTool), /checks passed/u);
        observed.push('passed assertion');
        return call('write', { file_path: 'README.md', content: 'T-sum: read spec.txt line 1; wrote sum.cjs and sum.test.cjs. Ran node sum.test.cjs: failed (-1 !== 5). Corrected subtraction to addition and reran: checks passed (actual test.log). This is engineering-fixture evidence only.' });
      }
      if (step === 7) return call('research_submit', { value: { readme: 'README.md', conclusion: 'Real assertion passed after correcting the implementation.',
        artifacts: ['sum.cjs', 'sum.test.cjs', 'test.log'].map(path => ({ path, requirements: ['E-sum'] })) } });
    }
    if (role === 'reviewer') {
      if (step === 0) {
        assert.match(snapshot, /\/snapshots\//u, 'reviewer receives the sealed delivery, not mutable executor work');
        return call('read', { file_path: join(snapshot, 'README.md') });
      }
      if (step === 1) { assert.match(success(lastTool), /failed/u); return call('read', { file_path: join(snapshot, 'sum.cjs') }); }
      if (step === 2) { assert.match(success(lastTool), /left \+ right/u); return call('read', { file_path: join(snapshot, 'test.log') }); }
      if (step === 3) { assert.match(success(lastTool), /checks passed/u); return call('bash', { command: `node ${JSON.stringify(join(snapshot, 'sum.test.cjs'))}`, description: 'Independently execute the sealed delivery test' }); }
      if (step === 4) {
        assert.match(success(lastTool), /checks passed/u);
        observed.push('reviewed actual evidence');
        return call('write', { file_path: 'REVIEW.md', content: 'Independently read sealed README, source and test.log, then reran the sealed test successfully. E-sum supports only the bounded addition claim.' });
      }
      if (step === 5) return call('research_submit', { value: reviewValue() });
    }
    throw new Error(`Unexpected product-loop step ${role}/${step}`);
  } });
  try {
    source = join(fixture.paths.inputs, 'spec.txt');
    await writeFile(source, 'Expected add(2,3)=5; the implementation must be tested by actual execution.\n');
    const projectRoot = join(fixture.root, 'project-state');
    supervisor = await ResearchSupervisor.open(projectRoot, fixture.runner, {
      goal: 'Build and actually test the bounded integer addition fixture.', sources: [source],
      deadline: new Date(Date.now() + 20_000).toISOString(), maxReplans: 0,
    });
    await supervisor.run();
    const project = supervisor.status();
    assert.equal(project.status, 'completed', project.reason);
    assert.equal(project.plans.length, 1);
    assert.equal(project.attempts.length, 1);
    assert.equal(project.evidence.length, 1);
    assert.equal(project.evidence[0].requirementId, 'E-sum');
    assert.equal(project.attempts[0].review.decision, 'accept');
    assert.equal(project.active, undefined);
    assert.deepEqual(observed, ['failed assertion', 'passed assertion', 'reviewed actual evidence']);
    const sessions = [project.plans[0].sessionId, project.plans[0].reviewSessionId,
      project.attempts[0].sessionId, project.attempts[0].reviewSessionId];
    assert.equal(new Set(sessions).size, 4);
    assert.ok(sessions.every(sessionId => fixture.ctx.agents.get(sessionId) === undefined));
    assert.equal(await readFile(join(projectRoot, 'snapshots', project.attempts[0].id, 'test.log'), 'utf8'), 'checks passed\n');
    assert.deepEqual(fixture.errors, []);
  } finally { await supervisor?.close(); await fixture.close(); }
});

test('actual native bash sandbox blocks readonly inputs and sibling writes', { timeout: 20_000 }, async () => {
  let paths;
  const fixture = await nativeFixture({ script({ step, lastTool }) {
    if (step === 0) return call('bash', { command: `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(paths.inputs, 'source.txt'))},'tampered')`)}`, description: 'Probe native readonly input protection' });
    if (step === 1) {
      assert.match(textOf(lastTool), /EACCES|EROFS|permission denied|read-only/iu);
      return call('bash', { command: `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(paths.outside, 'forbidden.txt'))},'tampered')`)}`, description: 'Probe native sibling workspace protection' });
    }
    if (step === 2) {
      assert.match(textOf(lastTool), /EACCES|EROFS|permission denied|read-only/iu);
      return call('write', { file_path: 'REVIEW.md', content: 'Both attempted writes were denied by the actual native file sandbox.' });
    }
    if (step === 3) { success(lastTool); return call('research_submit', { value: reviewValue('blocked') }); }
    throw new Error('Unexpected sandbox probe step');
  } });
  paths = fixture.paths;
  try {
    await writeFile(join(paths.inputs, 'source.txt'), 'immutable input');
    const result = await fixture.runner.run(fixture.job('reviewer'), () => {});
    assert.equal(result.reason, 'completed', JSON.stringify(fixture.results));
    assert.equal(await readFile(join(paths.inputs, 'source.txt'), 'utf8'), 'immutable input');
    await assert.rejects(access(join(paths.outside, 'forbidden.txt')));
    const bash = fixture.results.filter(entry => entry.name === 'bash');
    assert.equal(bash.length, 2);
    assert.ok(bash.every(entry => entry.value?.sandbox.enforcement === 'full' && entry.value.exitCode !== 0));
  } finally { await fixture.close(); }
});

test('cancelling a published native role actually disposes its running shell process', { timeout: 15_000 }, async () => {
  const started = deferred();
  const fixture = await nativeFixture({ script({ step, signal }) {
    if (step === 0) return call('bash', { command: `node -e ${JSON.stringify("require('node:fs').writeFileSync('started','yes'); setTimeout(() => require('node:fs').writeFileSync('late-write','bad'), 1500); setTimeout(() => {}, 30000)")}`, description: 'Run a cancellable native process fixture' });
    return waitForAbort(signal);
  } });
  const watcher = watch(fixture.paths.executor, (_event, filename) => { if (filename === 'started') started.resolve(); });
  try {
    const running = fixture.runner.run(fixture.job('executor'), () => assert.fail('Cancelled role must not submit'));
    await Promise.race([started.promise, running.then(result => { throw new Error(`Native shell never started: ${JSON.stringify(result)} ${JSON.stringify(fixture.results)}`); })]);
    await fixture.runner.cancel();
    const result = await running;
    assert.equal(result.reason, 'cancelled');
    assert.equal(fixture.ctx.agents.get(result.sessionId), undefined);
    assert.equal(await readFile(join(fixture.paths.executor, 'started'), 'utf8'), 'yes');
    await new Promise(resolve => setTimeout(resolve, 1700));
    await assert.rejects(access(join(fixture.paths.executor, 'late-write')));
  } finally { watcher.close(); await fixture.close(); }
});

test('deadline after publication cancels native model work and disposes the handle', { timeout: 10_000 }, async () => {
  const entered = deferred();
  let aborted = false;
  const fixture = await nativeFixture({ script: async ({ signal }) => {
    entered.resolve();
    try { await waitForAbort(signal); } finally { aborted = true; }
  } });
  try {
    const running = fixture.runner.run(fixture.job('planner', { deadline: Date.now() + 1000 }), () => assert.fail('No submission expected'));
    await entered.promise;
    const result = await running;
    assert.equal(result.reason, 'timeout');
    assert.equal(aborted, true);
    assert.equal(fixture.ctx.agents.get(result.sessionId), undefined);
  } finally { await fixture.close(); }
});
