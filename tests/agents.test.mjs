import assert from 'node:assert/strict';
import test from 'node:test';
import { access, link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { call, deferred, execute, nativeFixture, textOf, waitForAbort } from './native-fixture.mjs';

const review = { decision: 'blocked', accepted: [], report: 'REVIEW.md', reason: 'Fixture review report.' };
const dummy = (name, body) => defineTool({ name, description: 'Local test-only tool', parameters: {},
  output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
  execute: async () => { body?.(); return 'ran'; } });

async function heldFixture(options = {}) {
  const entered = deferred();
  const fixture = await nativeFixture({ ...options, script: async request => {
    entered.resolve(request);
    return waitForAbort(request.signal);
  } });
  return { fixture, entered: entered.promise };
}

test('only exec.agent owns a submission; simultaneous roles cannot impersonate each other or overwrite', { timeout: 10_000 }, async () => {
  const entered = deferred();
  let enteredCount = 0;
  const fixture = await nativeFixture({ script: async ({ signal }) => {
    if (++enteredCount === 2) entered.resolve();
    return waitForAbort(signal);
  } });
  const submissions = [];
  try {
    await writeFile(join(fixture.paths.planner, 'plan.json'), '{}');
    await writeFile(join(fixture.paths.reviewer, 'REVIEW.md'), 'Independent report');
    const plannerRun = fixture.runner.run(fixture.job('planner'), value => submissions.push(['planner', value]));
    const reviewerRun = fixture.runner.run(fixture.job('reviewer'), value => submissions.push(['reviewer', value]));
    await entered.promise;
    const planner = fixture.children.find(agent => agent.id.startsWith('research-planner-'));
    const reviewer = fixture.children.find(agent => agent.id.startsWith('research-reviewer-'));
    assert.equal((await execute(fixture.ctx, undefined, 'research_submit', { value: { path: 'plan.json' } })).isError, true);
    assert.equal((await execute(fixture.ctx, fixture.parent, 'research_submit', { value: review })).isError, true);
    assert.equal((await execute(fixture.ctx, planner, 'research_submit', { value: review, role: 'reviewer', agentId: reviewer.id })).isError, true);
    assert.equal((await execute(fixture.ctx, planner, 'research_submit', { value: review })).isError, true);
    assert.equal((await execute(fixture.ctx, reviewer, 'research_submit', { value: review })).isError, false);
    assert.equal((await execute(fixture.ctx, planner, 'research_submit', { value: { path: 'plan.json' } })).isError, false);
    const duplicate = await execute(fixture.ctx, reviewer, 'research_submit', { value: { ...review, reason: 'overwrite attempt' } });
    assert.equal(duplicate.isError, true);
    assert.match(textOf(duplicate), /Duplicate/u);
    assert.deepEqual(submissions, [['reviewer', review], ['planner', { path: 'plan.json' }]]);
    assert.equal((await execute(fixture.ctx, reviewer, 'write', { file_path: 'after-submit', content: 'late change' })).isError, true);
    await fixture.runner.cancel();
    assert.equal((await plannerRun).reason, 'cancelled');
    assert.equal((await reviewerRun).reason, 'cancelled');
    assert.equal((await execute(fixture.ctx, reviewer, 'research_submit', { value: review })).isError, true);
  } finally { await fixture.close(); }
});

test('multiple runners share one native submission tool but keep parent routing and cancellation separate', { timeout: 10_000 }, async () => {
  const bothEntered = deferred();
  const reviewerGate = deferred();
  let entered = 0;
  const fixture = await nativeFixture({ script: async ({ role, step, signal, model }) => {
    if (step === 0 && ++entered === 2) bothEntered.resolve();
    if (role === 'planner') return waitForAbort(signal);
    assert.equal(model, 'second-parent-model');
    if (step === 0) { await reviewerGate.promise; return call('write', { file_path: 'REVIEW.md', content: 'Second parent independent review' }); }
    return call('research_submit', { value: review });
  } });
  let secondParent;
  try {
    secondParent = await fixture.ctx.agents.create({ sessionId: 'second-parent', meta: { cwd: fixture.paths.parent },
      agentOptions: { provider: 'local-scripted', model: 'second-parent-model' } });
    const secondRunner = fixture.createRunner(secondParent.agent);
    assert.equal(fixture.ctx.tools.schemas().filter(tool => tool.name === 'research_submit').length, 1);
    const firstRun = fixture.runner.run(fixture.job('planner'), () => assert.fail('First runner was cancelled'));
    let submission;
    const secondRun = secondRunner.run(fixture.job('reviewer'), value => { submission = value; });
    await bothEntered.promise;
    await fixture.runner.cancel();
    assert.equal((await firstRun).reason, 'cancelled');
    const reviewer = fixture.children.find(agent => agent.id.startsWith('research-reviewer-'));
    assert.equal(fixture.ctx.agents.get(reviewer.id), reviewer, 'one runner must not cancel another');
    reviewerGate.resolve();
    assert.equal((await secondRun).reason, 'completed');
    assert.deepEqual(submission, review);
    assert.equal(reviewer.session.header.parentSession, secondParent.agent.id);
  } finally { reviewerGate.resolve(); await secondParent?.dispose(); await fixture.close(); }
});

test('child monotonic guard rejects authority and unknown tools despite permissive hooks without restricting parent', { timeout: 10_000 }, async () => {
  const { fixture, entered } = await heldFixture();
  let bodyCalls = 0;
  try {
    const running = fixture.runner.run(fixture.job('executor'), () => {});
    await entered;
    const child = fixture.children[0];
    fixture.ctx.on('tools/pre-execute', () => ({ kind: 'allow' }));
    for (const name of ['spawn', 'schedule', 'goal', 'cordis', 'future_admin']) {
      fixture.ctx.tools.register(dummy(name, () => bodyCalls++));
      child.ctx.tools.register(dummy(name, () => bodyCalls++));
      const denied = await execute(fixture.ctx, child, name);
      assert.equal(denied.isError, true);
      assert.match(textOf(denied), /not permitted/u);
      assert.equal((await execute(fixture.ctx, fixture.parent, name)).isError, false);
    }
    assert.equal(bodyCalls, 5, 'only the parent may reach these fixture bodies');
    await fixture.runner.cancel();
    assert.equal((await running).reason, 'cancelled');
    await fixture.runnerFiber.dispose();
    assert.equal(fixture.ctx.tools.get('research_submit'), undefined, 'submission registration is owned by ctx.effect');
    assert.equal((await execute(fixture.ctx, fixture.parent, 'spawn')).isError, false);
  } finally { await fixture.close(); }
});

test('native file tools enforce canonical roots, readonly inputs, traversal, symlinks and hardlinks', { timeout: 10_000 }, async () => {
  const testsRoot = fileURLToPath(new URL('./', import.meta.url));
  const { fixture, entered } = await heldFixture({ runnerOptions: { readRoots: [testsRoot] } });
  try {
    const { paths } = fixture;
    await writeFile(join(paths.inputs, 'source.txt'), 'read-only source');
    await writeFile(join(paths.executor, 'own.txt'), 'workspace data');
    await writeFile(join(paths.outside, 'secret.txt'), 'outside-sentinel');
    await symlink(join(paths.outside, 'secret.txt'), join(paths.executor, 'escape'));
    await symlink(paths.outside, join(paths.executor, 'escape-directory'));
    await symlink(join(paths.outside, 'missing'), join(paths.executor, 'dangling'));
    await symlink(join(paths.inputs, 'source.txt'), join(paths.executor, 'input-link'));
    await link(join(paths.executor, 'own.txt'), join(paths.executor, 'own-hardlink'));
    const siblingPrefix = `${paths.executor}-sibling`;
    await mkdir(siblingPrefix);
    await writeFile(join(siblingPrefix, 'secret.txt'), 'prefix escape');
    const running = fixture.runner.run(fixture.job('executor'), () => {});
    await entered;
    const child = fixture.children[0];
    for (const file_path of ['own.txt', 'input-link', join(paths.inputs, 'source.txt'), join(testsRoot, 'native-fixture.mjs')]) {
      const result = await execute(fixture.ctx, child, 'read', { file_path });
      assert.equal(result.isError, false, textOf(result));
    }
    for (const file_path of ['escape', 'escape-directory/secret.txt', 'dangling', '../inputs/source.txt',
      join(paths.outside, 'secret.txt'), join(siblingPrefix, 'secret.txt'), '~/outside', 'own.txt\0']) {
      assert.equal((await execute(fixture.ctx, child, 'read', { file_path })).isError, true, file_path);
    }
    for (const file_path of [join(paths.inputs, 'source.txt'), 'input-link', 'escape',
      'escape-directory/new.txt', 'dangling', '../outside/new.txt', join(siblingPrefix, 'new.txt')]) {
      assert.equal((await execute(fixture.ctx, child, 'write', { file_path, content: 'tampered' })).isError, true, file_path);
    }
    assert.equal((await execute(fixture.ctx, child, 'write', { file_path: 'new/nested.txt', content: 'own output' })).isError, false);
    assert.equal(await readFile(join(paths.executor, 'new/nested.txt'), 'utf8'), 'own output');
    assert.equal((await execute(fixture.ctx, child, 'write', { file_path: 'own-hardlink', content: 'updated' })).isError, false);
    assert.equal(await readFile(join(paths.executor, 'own-hardlink'), 'utf8'), 'updated');
    const editedInput = await execute(fixture.ctx, child, 'edit', { file_path: join(paths.inputs, 'source.txt'), old_string: 'read-only', new_string: 'changed' });
    assert.equal(editedInput.isError, true);
    for (const name of ['glob', 'grep']) {
      assert.equal((await execute(fixture.ctx, child, name, { path: paths.outside, pattern: '*' })).isError, true);
    }
    const grep = await execute(fixture.ctx, child, 'grep', { pattern: 'outside-sentinel' });
    assert.equal(grep.isError, false);
    assert.deepEqual(grep.value.matches, [], 'native recursive search must not follow escaping symlinks');
    assert.equal(await readFile(join(paths.inputs, 'source.txt'), 'utf8'), 'read-only source');
    assert.equal((await execute(fixture.ctx, child, 'bash', { description: 'Forbidden external workdir', command: 'true', workdir: paths.outside })).isError, true);
    assert.equal((await execute(fixture.ctx, child, 'bash', { description: 'Forbidden background job', command: 'true', run_in_background: true })).isError, true);
    assert.equal((await execute(fixture.ctx, child, 'bash', { description: 'Forbidden escalation', command: 'true', sandbox_permissions: 'danger-full-access' })).isError, true);
    await fixture.runner.cancel();
    await running;
  } finally { await fixture.close(); }
});

for (const [label, options] of [
  ['local unsandboxed shell', { nativeSandbox: false }],
  ['native full access', { sandboxMode: 'danger-full-access' }],
  ['native read-only policy', { sandboxMode: 'read-only' }],
]) {
  test(`bash fails closed for ${label}`, { timeout: 10_000 }, async () => {
    const fixture = await nativeFixture({ ...options, script({ step, lastTool }) {
      if (step === 0) return call('bash', { command: "printf 'must not execute' > forbidden", description: 'Probe fail closed shell configuration' });
      assert.equal(lastTool.isError, true);
      assert.match(textOf(lastTool), /Bash blocked:/u);
      return { text: 'The native shell was blocked, not executed.' };
    } });
    try {
      const result = await fixture.runner.run(fixture.job('executor'), () => assert.fail('No submission expected'));
      assert.equal(result.reason, 'error');
      assert.equal(fixture.results.filter(entry => entry.name === 'bash').length, 1);
      await assert.rejects(access(join(fixture.paths.executor, 'forbidden')));
      assert.equal(fixture.ctx.agents.get(result.sessionId), undefined);
    } finally { await fixture.close(); }
  });
}

test('native workspace-write shell allows a tmp read root without a probe', async () => {
  const fixture = await nativeFixture({ runnerOptions: { readRoots: ['/tmp'] }, script({ step, lastTool }) {
    if (step === 0) return call('bash', { command: 'printf allowed > output.txt', description: 'Write workspace output' });
    assert.notEqual(lastTool.isError, true, textOf(lastTool));
    return { text: 'Done' };
  } });
  try {
    await fixture.runner.run(fixture.job('executor'), () => {});
    assert.equal(await readFile(join(fixture.paths.executor, 'output.txt'), 'utf8'), 'allowed');
  } finally { await fixture.close(); }
});

test('invalid submissions and callback validation are native tool failures that the same Agent can repair', { timeout: 10_000 }, async () => {
  let attempts = 0;
  const fixture = await nativeFixture({ script({ step, lastTool }) {
    if (step === 0) return call('research_submit', { value: { path: 'plan.json' } });
    if (step === 1) { assert.equal(lastTool.isError, true); return call('write', { file_path: 'plan.json', content: '{}' }); }
    if (step === 2) return call('research_submit', { value: { path: 'plan.json' } });
    if (step === 3) { assert.equal(lastTool.isError, true); assert.match(textOf(lastTool), /host asks for repair/u); return call('write', { file_path: 'plan.json', content: '{"corrected":true}' }); }
    if (step === 4) return call('research_submit', { value: { path: 'plan.json' } });
    throw new Error('Unexpected retry after submission');
  } });
  try {
    const result = await fixture.runner.run(fixture.job('planner'), () => { if (++attempts === 1) throw new Error('host asks for repair'); });
    assert.equal(result.reason, 'completed', JSON.stringify(fixture.results));
    assert.equal(attempts, 2);
    assert.equal(fixture.requests.length, 5);
    assert.equal(await readFile(join(fixture.paths.planner, 'plan.json'), 'utf8'), '{"corrected":true}');
  } finally { await fixture.close(); }
});

test('model override uses the native option resolver without changing the parent', { timeout: 10_000 }, async () => {
  const fixture = await nativeFixture({ parentOptions: { model: 'parent-model' }, runnerOptions: { agentOptions: { model: 'role-model' } },
    script({ step, model }) {
      assert.equal(model, 'role-model');
      if (step === 0) return call('write', { file_path: 'plan.json', content: '{}' });
      return call('research_submit', { value: { path: 'plan.json' } });
    } });
  try {
    const result = await fixture.runner.run(fixture.job('planner'), () => {});
    assert.equal(result.reason, 'completed');
    assert.equal(fixture.parent.options.model, 'parent-model');
  } finally { await fixture.close(); }
});

test('prepublication cancellation and already expired jobs leave no native child', { timeout: 10_000 }, async () => {
  const entered = deferred();
  const fixture = await nativeFixture({ setup({ ctx }) {
    ctx.on('agent/created', async ({ agent, signal }) => {
      if (!agent.id.startsWith('research-')) return;
      entered.resolve();
      await waitForAbort(signal);
    });
  } });
  try {
    const running = fixture.runner.run(fixture.job('planner'), () => assert.fail('No submission expected'));
    await entered.promise;
    await fixture.runner.cancel();
    const result = await running;
    assert.equal(result.reason, 'cancelled');
    assert.equal(fixture.ctx.agents.get(result.sessionId), undefined);
    const expired = await fixture.runner.run(fixture.job('planner', { deadline: Date.now() - 1 }), () => assert.fail('Expired job must not submit'));
    assert.equal(expired.reason, 'timeout');
    assert.equal(fixture.ctx.agents.get(expired.sessionId), undefined);
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
});

test('creation failure and missing or failed model output cannot become completed work', { timeout: 10_000 }, async () => {
  const fixture = await nativeFixture({ script: () => { throw new Error('scripted local provider failed'); } });
  try {
    const removeFailure = fixture.ctx.on('agent/created', ({ agent }) => { if (agent.id.startsWith('research-')) throw new Error('creation fixture failure'); });
    const failedCreate = await fixture.runner.run(fixture.job('planner'), () => assert.fail('No submission expected'));
    assert.equal(failedCreate.reason, 'error');
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.ctx.agents.get(failedCreate.sessionId), undefined);
    removeFailure();
    const failedModel = await fixture.runner.run(fixture.job('planner'), () => assert.fail('No submission expected'));
    assert.equal(failedModel.reason, 'error');
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.ctx.agents.get(failedModel.sessionId), undefined);
  } finally { await fixture.close(); }
});

test('ctx.effect unload waits for native cancellation and unregisters the unique submission tool', { timeout: 10_000 }, async () => {
  const { fixture, entered } = await heldFixture();
  try {
    const running = fixture.runner.run(fixture.job('reviewer'), () => assert.fail('No submission expected'));
    await entered;
    await fixture.runnerFiber.dispose();
    const result = await running;
    assert.equal(result.reason, 'cancelled');
    assert.equal(fixture.ctx.agents.get(result.sessionId), undefined);
    assert.equal(fixture.ctx.tools.get('research_submit'), undefined);
    assert.equal(fixture.ctx.agents.get(fixture.parent.id), fixture.parent);
    await assert.rejects(fixture.runner.run(fixture.job('planner'), () => {}), /disposed/u);
  } finally { await fixture.close(); }
});
