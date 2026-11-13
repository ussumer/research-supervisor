import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import Commands from '@deepseek-ai/dsh-commands';
import * as Plugin from '../lib/index.js';

function parentAgent() {
  const events = [];
  return {
    id: 'same-id-does-not-confer-ownership',
    model: { provider: 'inherited-provider', model: 'inherited-model' },
    events,
    session: { append(type, data) { events.push({ type, data }); return { seq: events.length }; } },
  };
}

async function setup(testContext, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'research-plugin-'));
  const source = join(directory, 'sources');
  const root = join(directory, 'private-state');
  const requestPath = join(directory, 'human request.json');
  await mkdir(source);
  const request = { goal: 'Reproduce a supplied result', sources: [source],
    deadline: new Date(Date.now() + 60_000).toISOString(), maxReplans: 2 };
  await writeFile(requestPath, JSON.stringify(request));
  const ctx = new Context();
  const logs = [];
  ctx.logger.exporter({ export(message) { logs.push(message); } });
  ctx.provide('agents', {});
  ctx.provide('tools', {});
  ctx.provide('workingDirectory', {});
  ctx.provide('agentLoop', {});
  await ctx.plugin(Commands);
  const events = [];
  const opened = [];
  const runnerArguments = [];
  let current;
  let running;
  let runCount = 0;
  const state = { revision: 0, request, status: 'planning', plans: [], attempts: [], evidence: [], replans: 0, reason: '' };
  const runner = {
    async run() { throw new Error('Fixture runner must never execute an Agent loop'); },
    async cancel() {
      events.push('cancel');
      await options.onCancel?.();
      current?.resolve();
    },
  };
  const supervisor = {
    run() {
      events.push('run');
      runCount++;
      state.status = 'active';
      current = Promise.withResolvers();
      running = (options.onRun ? Promise.resolve().then(() => options.onRun(state)) : current.promise)
        .finally(() => { events.push('run:settled'); });
      return running;
    },
    async pause(reason) {
      events.push('pause');
      state.status = 'paused';
      state.reason = reason;
      await runner.cancel();
      await running?.catch(() => undefined);
      events.push('pause:settled');
    },
    async reconcile() {
      events.push('reconcile');
      await options.onReconcile?.();
      delete state.active;
      if (['blocked', 'paused'].includes(state.status)) state.status = 'paused';
    },
    async close() { events.push('close'); },
    status() { return structuredClone(state); },
  };
  const dependencies = Plugin.createPluginDependencies({
    createRunner(...args) { runnerArguments.push(args); return runner; },
    async open(...args) {
      opened.push(args);
      await options.onOpen?.();
      if (options.openError) throw options.openError;
      if (args[2]) state.request = args[2];
      return supervisor;
    },
  });
  const fiber = ctx.plugin({ name: Plugin.name, inject: Plugin.inject, Config: Plugin.Config,
    apply(context, config) { Plugin.apply(context, config, dependencies); } }, { projectDirectory: root });
  await fiber;
  const owner = parentAgent();
  const execute = async (input, agent = owner, signal = new AbortController().signal, attachments = []) => {
    const execution = await ctx.commands.execute(agent, `/research ${input}`, attachments, signal);
    return execution?.result;
  };
  testContext.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return { directory, source, root, request, requestPath, ctx, fiber, events, opened, runnerArguments,
    supervisor, state, owner, logs, execute, get runCount() { return runCount; },
    start: () => execute(`start ${JSON.stringify(requestPath)}`),
    finish() { state.status = 'completed'; current?.resolve(); },
    reject(error) { current?.reject(error); },
  };
}

test('real Cordis commands registry mounts the human command without starting work', async testContext => {
  const fixture = await setup(testContext);
  assert.deepEqual(fixture.ctx.commands.list(fixture.owner).map(command => command.name), ['research']);
  assert.equal(fixture.ctx.commands.find(fixture.owner, 'research').recordInput, false);
  assert.equal(fixture.runCount, 0);
  assert.equal(fixture.opened.length, 0);
  assert.match((await fixture.execute('status')).text, /No project is active/);
  for (const input of ['', 'unknown sk-test-secret', 'status extra', 'pause extra', 'resume extra', 'start']) {
    const result = await fixture.execute(input);
    assert.equal(result.kind, 'error');
    assert.doesNotMatch(result.text, /sk-test-secret/);
  }
  await fixture.fiber.dispose();
  assert.deepEqual(fixture.ctx.commands.list(fixture.owner), []);
  assert.equal(fixture.runCount, 0);
});

test('unload preserves a completed result rather than rewriting it as paused', async testContext => {
  const fixture = await setup(testContext);
  await fixture.start();
  fixture.finish();
  await nextTurn();
  await fixture.fiber.dispose();
  assert.equal(fixture.state.status, 'completed');
  assert.ok(!fixture.events.includes('pause'));
  assert.ok(fixture.events.includes('close'));
});

test('start binds the exact invoking Agent and holds a nonblocking background run', async testContext => {
  const fixture = await setup(testContext);
  const result = await fixture.start();
  assert.equal(result.kind, 'success');
  assert.match(result.text, /background/);
  await nextTurn();
  assert.equal(fixture.runCount, 1);
  assert.equal(fixture.runnerArguments.length, 1);
  assert.equal(fixture.runnerArguments[0].length, 2);
  assert.equal(fixture.runnerArguments[0][1], fixture.owner);
  assert.equal(fixture.opened[0][0], await realpath(fixture.root));
  assert.deepEqual(fixture.opened[0][2], fixture.request);
  assert.match((await fixture.execute('status')).text, /running=true/);
  assert.equal((await fixture.start()).kind, 'error');
  assert.equal((await fixture.execute('resume')).kind, 'error');
  assert.equal(fixture.opened.length, 1);
  fixture.finish();
  await nextTurn();
  assert.match((await fixture.execute('status')).text, /completed; running=false/);
  assert.equal((await fixture.execute('resume')).kind, 'error');
  assert.equal((await fixture.execute('pause')).kind, 'error');
  assert.equal(fixture.state.status, 'completed');
});

test('different parent objects cannot read or control an existing project, even with the same id', async testContext => {
  const fixture = await setup(testContext);
  await fixture.start();
  const other = parentAgent();
  for (const input of ['status', 'pause', 'resume', `start ${fixture.requestPath}`]) {
    const result = await fixture.execute(input, other);
    assert.equal(result.kind, 'error');
    assert.match(result.text, /different parent Agent/);
  }
  assert.equal(fixture.events.includes('cancel'), false);
  assert.equal(fixture.runCount, 1);
});

test('concurrent starts are serialized and only the winning parent owns the project', async testContext => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const fixture = await setup(testContext, { onOpen() { entered.resolve(); return gate.promise; } });
  const first = fixture.start();
  await entered.promise;
  const second = fixture.execute(`start ${fixture.requestPath}`, parentAgent());
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.kind), ['success', 'error']);
  assert.equal(fixture.opened.length, 1);
});

test('pause drains cancellation and resume preserves the original request and deadline', async testContext => {
  const fixture = await setup(testContext);
  await fixture.start();
  const deadline = fixture.request.deadline;
  assert.equal((await fixture.execute('pause')).kind, 'success');
  assert.deepEqual(fixture.events.slice(0, 5), ['run', 'pause', 'cancel', 'run:settled', 'pause:settled']);
  await writeFile(fixture.requestPath, JSON.stringify({ ...fixture.request, deadline: '2099-01-01T00:00:00Z' }));
  assert.equal((await fixture.execute('resume')).kind, 'success');
  assert.equal(fixture.runCount, 2);
  assert.equal(fixture.opened.length, 1);
  assert.equal(fixture.state.request.deadline, deadline);
  assert.match((await fixture.execute('status')).text, new RegExp(deadline.replaceAll('.', '\\.')));
});

test('resume never extends an expired deadline or replays an unfinished role', async testContext => {
  const fixture = await setup(testContext);
  await fixture.start();
  await fixture.execute('pause');
  fixture.state.active = { id: 'unfinished', role: 'executor', directory: 'private' };
  assert.match((await fixture.execute('resume')).text, /requires reconciliation/);
  delete fixture.state.active;
  const realNow = Date.now;
  Date.now = () => Date.parse(fixture.request.deadline) + 1;
  try { assert.match((await fixture.execute('resume')).text, /deadline has expired/); }
  finally { Date.now = realNow; }
  assert.equal(fixture.runCount, 1);
});

test('resume attaches persisted paused state and keeps its original deadline', async testContext => {
  const fixture = await setup(testContext);
  fixture.state.status = 'paused';
  assert.equal((await fixture.execute('resume')).kind, 'success');
  assert.equal(fixture.opened.length, 1);
  assert.equal(fixture.opened[0][2], undefined);
  assert.equal(fixture.runCount, 1);
  assert.ok((await fixture.execute('status')).text.includes(fixture.request.deadline));
});

test('reconcile attaches blocked persisted state without launching and rejects running recovery', async testContext => {
  const fixture = await setup(testContext);
  fixture.state.status = 'blocked';
  fixture.state.active = { id: 'interrupted', role: 'executor' };
  assert.equal((await fixture.execute('reconcile')).kind, 'success');
  assert.equal(fixture.opened[0][2], undefined);
  assert.equal(fixture.state.active, undefined);
  assert.equal(fixture.state.status, 'paused');
  assert.equal(fixture.runCount, 0);
  assert.equal((await fixture.execute('resume')).kind, 'success');
  assert.match((await fixture.execute('reconcile')).text, /Pause research before reconciling/);
  assert.equal(fixture.events.filter(event => event === 'reconcile').length, 1);
});

test('resume attachment cannot renew an expired persisted deadline', async testContext => {
  const fixture = await setup(testContext);
  fixture.state.status = 'paused';
  fixture.state.request.deadline = '2000-01-01T00:00:00Z';
  const result = await fixture.execute('resume');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /original project deadline has expired/);
  assert.equal(fixture.runCount, 0);
  assert.equal(fixture.opened[0][2], undefined);
});

test('unload while attaching persisted state closes it without launching', async testContext => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const fixture = await setup(testContext, { onOpen() { entered.resolve(); return gate.promise; } });
  fixture.state.status = 'paused';
  const resume = fixture.execute('resume');
  await entered.promise;
  const disposal = fixture.fiber.dispose();
  gate.resolve();
  assert.equal((await resume).kind, 'error');
  await disposal;
  assert.equal(fixture.runCount, 0);
  assert.deepEqual(fixture.events, ['close']);
});

test('failed reconciliation stays attached and retry can recover without reopening', async testContext => {
  let fail = true;
  const fixture = await setup(testContext, { onReconcile() { if (fail) throw new Error('Recovery storage unavailable'); } });
  fixture.state.status = 'blocked';
  assert.equal((await fixture.execute('reconcile')).kind, 'error');
  assert.match((await fixture.execute('status')).text, /Recovery storage unavailable/);
  assert.equal((await fixture.execute('resume')).kind, 'error');
  fail = false;
  const recovered = await fixture.execute('reconcile');
  assert.equal(recovered.kind, 'success');
  assert.doesNotMatch(recovered.text, /Recovery storage unavailable/);
  assert.equal((await fixture.execute('resume')).kind, 'success');
  assert.equal(fixture.opened.length, 1);
});

test('resume attachment failures cancel the runner and retain the actual diagnostic', async testContext => {
  const fixture = await setup(testContext, { openError: new Error('No persisted project') });
  const result = await fixture.execute('resume');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /No persisted project/);
  assert.deepEqual(fixture.events, ['cancel']);
  assert.equal(fixture.runCount, 0);
});

test('unload cancels then waits for settlement before closing and removing the command', async testContext => {
  const cancelGate = Promise.withResolvers();
  const cancelEntered = Promise.withResolvers();
  const fixture = await setup(testContext, { onCancel() { cancelEntered.resolve(); return cancelGate.promise; } });
  await fixture.start();
  let disposed = false;
  const disposal = fixture.fiber.dispose().then(() => { disposed = true; });
  await cancelEntered.promise;
  assert.equal(disposed, false);
  assert.equal(fixture.events.includes('close'), false);
  cancelGate.resolve();
  await disposal;
  assert.equal(disposed, true);
  assert.deepEqual(fixture.events, ['run', 'pause', 'cancel', 'run:settled', 'pause:settled', 'close']);
  assert.deepEqual(fixture.ctx.commands.list(fixture.owner), []);
});

test('unload during open cannot launch detached research afterwards', async testContext => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const fixture = await setup(testContext, { onOpen() { entered.resolve(); return gate.promise; } });
  const start = fixture.start();
  await entered.promise;
  const disposal = fixture.fiber.dispose();
  gate.resolve();
  assert.equal((await start).kind, 'error');
  await disposal;
  assert.equal(fixture.runCount, 0);
  assert.deepEqual(fixture.events, ['pause', 'cancel', 'pause:settled', 'close']);
});

test('aborted start checks the invocation again after asynchronous open', async testContext => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const fixture = await setup(testContext, { onOpen() { entered.resolve(); return gate.promise; } });
  const abort = new AbortController();
  const execution = fixture.execute(`start ${fixture.requestPath}`, fixture.owner, abort.signal);
  const rejected = assert.rejects(execution, /cancelled by test/);
  await entered.promise;
  abort.abort(new Error('cancelled by test'));
  gate.resolve();
  await rejected;
  await fixture.execute('status');
  assert.equal(fixture.runCount, 0);
  assert.equal(fixture.events.at(-1), 'close');
});

test('background rejection is caught, logged and reported without raw credentials', async testContext => {
  const secret = 'sk-test-do-not-print';
  const fixture = await setup(testContext);
  await fixture.start();
  fixture.state.status = 'blocked';
  const failure = new Error(`provider failure Authorization: Bearer ${secret}`);
  failure.stack += '\n    at originalProviderCall (provider.js:42:7)';
  fixture.reject(failure);
  await nextTurn();
  const status = await fixture.execute('status');
  assert.match(status.text, /provider failure/);
  assert.match(status.text, /running=false/);
  assert.ok(fixture.logs.some(message => message.type === 'error' && JSON.stringify(message.args).includes('originalProviderCall (provider.js:42:7)')));
  assert.doesNotMatch(JSON.stringify([fixture.logs, fixture.owner.events, status]), new RegExp(secret));
  await fixture.execute('pause');
  assert.equal((await fixture.execute('resume')).kind, 'error');
  assert.equal(fixture.runCount, 1);
  const reconciled = await fixture.execute('reconcile');
  assert.equal(reconciled.kind, 'success');
  assert.match(reconciled.text, /paused/);
  assert.doesNotMatch(reconciled.text, /provider failure/);
  assert.equal((await fixture.execute('resume')).kind, 'success');
  assert.equal(fixture.runCount, 2);
});

test('synchronous run failure is retained and opening failures cancel their runner', async testContext => {
  const fixture = await setup(testContext, { openError: new Error('Writer unavailable credential=not-for-command-output') });
  const result = await fixture.start();
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Writer unavailable/);
  assert.deepEqual(fixture.events, ['cancel']);
  assert.doesNotMatch(JSON.stringify([result, fixture.logs, fixture.owner.events]), /not-for-command-output/);
  const separate = await setup(testContext);
  separate.supervisor.run = () => { throw new Error('Provider unavailable token=not-for-output'); };
  assert.equal((await separate.start()).kind, 'success');
  await nextTurn();
  assert.match((await separate.execute('status')).text, /Provider unavailable/);
  assert.doesNotMatch(JSON.stringify(separate.logs), /not-for-output/);
});

test('request parser rejects prototype and permission injections before opening or creating a runner', async testContext => {
  const fixture = await setup(testContext);
  const valid = JSON.stringify(fixture.request);
  const cases = [
    '{"__proto__":{"polluted":true}}',
    valid.replace('{', '{"__proto__":{},'),
    valid.replace('{', '{"constructor":{"prototype":{"polluted":true}},'),
    JSON.stringify({ ...fixture.request, readRoots: ['/'] }),
    JSON.stringify({ ...fixture.request, permissions: { allowAll: true } }),
    JSON.stringify({ ...fixture.request, injections: ['agents'] }),
    JSON.stringify({ ...fixture.request, sources: [] }),
    JSON.stringify({ ...fixture.request, sources: undefined }),
    JSON.stringify({ ...fixture.request, sources: ['relative/path'] }),
    JSON.stringify({ ...fixture.request, sources: [{ constructor: {} }] }),
    JSON.stringify({ ...fixture.request, goal: '' }),
    JSON.stringify({ ...fixture.request, maxReplans: 1.5 }),
    JSON.stringify({ ...fixture.request, maxReplans: 11 }),
    JSON.stringify({ ...fixture.request, deadline: '2000-01-01T00:00:00Z' }),
    JSON.stringify({ ...fixture.request, deadline: '2099-01-01 (sk-test-secret)' }),
    'null', '[]', '{bad sk-test-secret}',
  ];
  for (const body of cases) {
    await writeFile(fixture.requestPath, body);
    const result = await fixture.start();
    assert.equal(result.kind, 'error', body);
    assert.doesNotMatch(result.text, /sk-test-secret/);
  }
  assert.equal(fixture.opened.length, 0);
  assert.equal(fixture.runnerArguments.length, 0);
  assert.equal({}.polluted, undefined);
});

test('request reading rejects relative paths, symlink files, directories and oversized files', async testContext => {
  const fixture = await setup(testContext);
  assert.equal((await fixture.execute('start relative.json')).kind, 'error');
  assert.equal((await fixture.execute(`start ${fixture.directory}`)).kind, 'error');
  const alias = join(fixture.directory, 'request-alias.json');
  await symlink(fixture.requestPath, alias);
  assert.equal((await fixture.execute(`start ${alias}`)).kind, 'error');
  await writeFile(fixture.requestPath, ' '.repeat(65_537));
  assert.equal((await fixture.start()).kind, 'error');
  assert.equal(fixture.opened.length, 0);
});

test('source authorization keeps exact canonical file paths without granting their parent directory', async testContext => {
  const fixture = await setup(testContext);
  const file = join(fixture.source, 'paper.md');
  const alias = join(fixture.directory, 'paper-alias.md');
  await writeFile(file, 'user-supplied source');
  await symlink(file, alias);
  await writeFile(fixture.requestPath, JSON.stringify({ ...fixture.request, sources: [alias] }));
  assert.equal((await fixture.start()).kind, 'success');
  assert.deepEqual(fixture.opened[0][2].sources, [await realpath(file)]);
  assert.ok(!fixture.opened[0][2].sources.includes(dirname(file)));
  assert.ok(!fixture.opened[0][2].sources.includes(fixture.root));
});

test('sources cannot expose state directly or through ancestor, descendant or symlink aliases', async testContext => {
  const fixture = await setup(testContext);
  await mkdir(fixture.root, { mode: 0o700 });
  const secret = join(fixture.root, 'secret');
  await writeFile(secret, 'private');
  const alias = join(fixture.source, 'state-alias');
  await symlink(fixture.root, alias);
  for (const source of [fixture.root, fixture.directory, secret, alias]) {
    await writeFile(fixture.requestPath, JSON.stringify({ ...fixture.request, sources: [source] }));
    const result = await fixture.start();
    assert.equal(result.kind, 'error');
    assert.match(result.text, /must not overlap/);
  }
  assert.equal(fixture.opened.length, 0);
});

test('start reattaches private persisted state without replacing its request or deadline', async testContext => {
  const fixture = await setup(testContext);
  await mkdir(fixture.root, { mode: 0o755 });
  await chmod(fixture.root, 0o755);
  assert.match((await fixture.start()).text, /must be private/);
  await chmod(fixture.root, 0o700);
  const path = join(fixture.root, 'project.json');
  await writeFile(path, 'existing-native-state');
  await writeFile(fixture.requestPath, JSON.stringify({ ...fixture.request, deadline: '2099-01-01T00:00:00Z' }));
  assert.equal((await fixture.start()).kind, 'success');
  assert.equal(fixture.opened[0][2], undefined);
  assert.equal(await readFile(path, 'utf8'), 'existing-native-state');
  assert.equal(fixture.state.request.deadline, fixture.request.deadline);
  assert.ok((await fixture.execute('status')).text.includes(fixture.request.deadline));
});

test('raw human input is not recorded, attachment payloads cannot grant permissions, and config has no model knobs', async testContext => {
  const fixture = await setup(testContext);
  const secret = 'sk-test-private-filename';
  await fixture.execute(`start /missing/${secret}.json`);
  assert.doesNotMatch(JSON.stringify(fixture.owner.events), new RegExp(secret));
  assert.ok(fixture.owner.events.filter(event => event.type === 'command/run').every(event => !Object.hasOwn(event.data, 'args')));
  const result = await fixture.execute('start /missing.json', fixture.owner, new AbortController().signal,
    [{ type: 'file', receiptId: 'untrusted-source-permission' }]);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /does not accept attachments/);
  assert.equal(fixture.opened.length, 0);
  assert.throws(() => Plugin.Config({ projectDirectory: './relative' }), /absolute/);
  assert.throws(() => Plugin.Config({}), /required/i);
  assert.deepEqual(Object.keys(Plugin.Config.dict), ['projectDirectory']);
});
