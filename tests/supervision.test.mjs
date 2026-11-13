import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchSupervisor } from '../lib/supervision.js';

const plan = () => ({ version: 1,
  claims: [{ id: 'C1', statement: 'Bounded fixture', required: true,
    source: { document: 'source.txt', locator: 'line 1' }, requires: ['E1', 'E2'] }],
  evidence: [{ id: 'E1', claimId: 'C1', description: 'First result', scope: 'fixture only' },
    { id: 'E2', claimId: 'C1', description: 'Second result', scope: 'fixture only' }],
  tasks: [{ id: 'T1', title: 'First', objective: 'Produce first fixture', produces: ['E1'], consumes: [], dependsOn: [], maxAttempts: 2 },
    { id: 'T2', title: 'Second', objective: 'Use accepted input', produces: ['E2'], consumes: ['E1'], dependsOn: ['T1'], maxAttempts: 1 }] });

async function cleanup(path) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await cleanup(join(path, entry.name));
  }
  await rm(path, { recursive: true, force: true });
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-supervision-test-'));
  const source = join(directory, 'source.txt');
  await writeFile(source, 'Engineering fixture, not a physics experiment');
  const jobs = [];
  const executions = new Map();
  const runner = {
    async run(job, submit) {
      jobs.push(job);
      await options.before?.(job);
      let result;
      if (job.role === 'planner') {
        await writeFile(join(job.cwd, 'plan.json'), JSON.stringify(options.plan?.() ?? plan()));
        await writeFile(join(job.cwd, 'README.md'), 'Plan from source.txt; no physics claim.');
        result = { path: 'plan.json' };
      } else if (job.role === 'plan-reviewer') {
        await writeFile(join(job.cwd, 'REVIEW.md'), 'The bounded fixture plan covers the source goal.');
        result = { decision: 'accept', accepted: ['E1', 'E2'], report: 'REVIEW.md', reason: 'Fixture plan reviewed' };
      } else if (job.role === 'executor') {
        executions.set(job.taskId, (executions.get(job.taskId) ?? 0) + 1);
        await writeFile(join(job.cwd, 'README.md'), 'See result.json and implementation.js; fixture only.');
        await writeFile(join(job.cwd, 'implementation.js'), 'export const value = 2;');
        await writeFile(join(job.cwd, 'result.json'), JSON.stringify({ value: 2 }));
        result = { readme: 'README.md', artifacts: [{ path: 'result.json', requirements: [job.taskId === 'T1' ? 'E1' : 'E2'] }], conclusion: 'Fixture result ready' };
      } else {
        const reject = options.rework && job.taskId === 'T1' && executions.get('T1') === 1;
        await writeFile(join(job.cwd, 'REVIEW.md'), reject ? 'Rework: add the missing method comparison.' : 'Checked README, implementation and result; accept only fixture scope.');
        result = { decision: reject ? 'rework' : 'accept', accepted: reject ? [] : [job.taskId === 'T1' ? 'E1' : 'E2'], report: 'REVIEW.md', reason: reject ? 'Missing method comparison' : 'Actual fixture inspected' };
      }
      await options.transform?.(job, result);
      try { await submit(result); } catch (error) {
        if (supervisor.status().status === 'paused') return { sessionId: job.sessionId ?? job.id, reason: 'cancelled' };
        throw error;
      }
      return { sessionId: job.sessionId ?? job.id, reason: 'completed' };
    },
    async closeSession() {},
    async cancel() {},
  };
  const supervisor = await ResearchSupervisor.open(join(directory, 'project'), runner,
    { goal: 'Reproduce the bounded fixture', sources: [source], deadline: new Date(Date.now() + 60000).toISOString(), maxReplans: 1 });
  t.after(async () => { await supervisor.close(); await cleanup(directory); });
  return { supervisor, directory, jobs, runner };
}

test('independent roles finish, rework and automatically release evidence-dependent work', async t => {
  const { supervisor, jobs } = await fixture(t, { rework: true });
  await supervisor.run();
  const state = supervisor.status();
  assert.equal(state.status, 'completed');
  assert.deepEqual(jobs.map(job => job.role), ['planner', 'plan-reviewer', 'executor', 'reviewer', 'executor', 'reviewer', 'executor', 'reviewer']);
  assert.equal(new Set(jobs.map(job => job.id)).size, jobs.length);
  assert.deepEqual(state.attempts.map(item => item.review.decision), ['rework', 'accept', 'accept']);
  assert.match(jobs[4].prompt, /Missing method comparison/);
  assert.equal(state.evidence.length, 2);
  assert.ok(jobs[6].readRoots.some(path => path.includes('/snapshots/')));
  assert.ok(jobs[1].prompt.includes('Read original sources'));
});

test('a missing delivery artifact is rejected before handing it to a reviewer', async t => {
  const { supervisor, jobs } = await fixture(t, { async transform(job) {
    if (job.role === 'executor') await rm(join(job.cwd, 'result.json'));
  } });
  await assert.rejects(supervisor.run(), /result.json/);
  assert.equal(jobs.filter(job => job.role === 'reviewer').length, 0);
  assert.equal(supervisor.status().status, 'blocked');
  assert.equal(supervisor.status().evidence.length, 0);
});

test('review cannot publish an unrelated requirement', async t => {
  const { supervisor } = await fixture(t, { async transform(job, result) {
    if (job.role === 'reviewer') result.accepted = ['E2'];
  } });
  await assert.rejects(supervisor.run(), /Invalid review/);
  assert.equal(supervisor.status().evidence.length, 0);
});

test('modification of a snapshot during review blocks publication', async t => {
  const { supervisor } = await fixture(t, { async before(job) {
    if (job.role !== 'reviewer') return;
    const snapshot = job.readRoots.find(path => path.includes('/snapshots/'));
    await chmod(join(snapshot, 'result.json'), 0o600);
    await writeFile(join(snapshot, 'result.json'), '{"value":0}');
  } });
  await assert.rejects(supervisor.run(), /Snapshot/);
  assert.equal(supervisor.status().evidence.length, 0);
});

test('root source grant cannot expose the controller storage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'research-grant-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(ResearchSupervisor.open(join(directory, 'project'), {},
    { goal: 'fixture', sources: [directory], deadline: new Date(Date.now() + 10000).toISOString(), maxReplans: 1 }), /expose supervisor/);
});

test('publication validates every mapping before publishing any evidence', async t => {
  const { supervisor } = await fixture(t, { plan() {
    const value = plan();
    value.tasks = [{ ...value.tasks[0], produces: ['E1', 'E2'], maxAttempts: 1 }];
    return value;
  }, async transform(job, result) {
    if (job.role === 'reviewer') result.accepted = ['E1', 'E2'];
  } });
  await assert.rejects(supervisor.run(), /no explicit artifact mapping/);
  assert.equal(supervisor.status().evidence.length, 0);
  const attempt = supervisor.status().attempts[0];
  assert.equal(attempt.review, undefined, 'an invalid proposed acceptance is not a completed review');
  assert.equal(attempt.publicationError, undefined, 'validation fails before publication');
});

test('root filesystem cannot be granted as a research source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'root-source-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(ResearchSupervisor.open(join(directory, 'project'), {},
    { goal: 'fixture', sources: ['/'], deadline: new Date(Date.now() + 10000).toISOString(), maxReplans: 1 }), /expose supervisor/);
});

test('paused review resumes the same delivery without rerunning its executor', async t => {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  let first = true;
  const { supervisor, runner, jobs } = await fixture(t, { plan() {
    const value = plan(); value.tasks[0].maxAttempts = 1; return value;
  }, async before(job) {
    if (job.role === 'reviewer' && first) { first = false; reached.resolve(); await release.promise; }
  } });
  runner.cancel = async () => { release.resolve(); };
  const run = supervisor.run();
  await reached.promise;
  await supervisor.pause('Test pause during review');
  await run;
  assert.equal(supervisor.status().attempts.length, 1);
  assert.equal(supervisor.status().attempts[0].review, undefined);
  await supervisor.run();
  assert.equal(supervisor.status().status, 'completed');
  assert.equal(jobs.filter(job => job.role === 'executor' && job.taskId === 'T1').length, 1);
});

test('an executor is charged as an attempt before it can be cancelled', async t => {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  let first = true;
  const { supervisor, runner, jobs } = await fixture(t, { plan() {
    const value = plan(); value.tasks[0].maxAttempts = 1; return value;
  }, async before(job) {
    if (job.role === 'executor' && first) { first = false; reached.resolve(); await release.promise; }
  }, async transform(job, result) {
    if (job.role === 'reviewer') { result.decision = 'blocked'; result.accepted = []; }
  } });
  const execute = runner.run;
  runner.run = async (job, submit) => {
    const result = await execute(job, submit);
    if (job.role === 'executor') result.reason = 'cancelled';
    return result;
  };
  runner.cancel = async () => { release.resolve(); };
  const run = supervisor.run();
  await reached.promise;
  assert.equal(supervisor.status().attempts.length, 1);
  await supervisor.pause('Test cancel during executor');
  await run;
  await supervisor.run();
  assert.equal(supervisor.status().status, 'blocked');
  assert.equal(jobs.filter(job => job.role === 'executor').length, 1);
  assert.equal(supervisor.status().attempts.length, 1);
});

for (const method of ['closeSession', 'cancel']) {
  test(`${method} cleanup failure prevents reporting a completed project`, async t => {
    const { supervisor, runner } = await fixture(t);
    runner[method] = async () => { throw new Error('Native research session cleanup failed'); };
    await assert.rejects(supervisor.run(), /cleanup failed/);
    assert.equal(supervisor.status().status, 'blocked');
    assert.match(supervisor.status().reason, /cleanup failed/);
  });
}

test('binary evidence above the README text limit is a valid artifact', async t => {
  const { supervisor } = await fixture(t, { async transform(job) {
    if (job.role === 'executor') await writeFile(join(job.cwd, 'result.json'), Buffer.alloc(2 * 1024 * 1024, 0x80));
  } });
  await supervisor.run();
  assert.equal(supervisor.status().status, 'completed');
  assert.equal(supervisor.status().evidence.length, 2);
});

test('reviewer receives the exact proposed evidence-to-file mapping', async t => {
  const { supervisor, jobs } = await fixture(t);
  await supervisor.run();
  const prompt = jobs.find(job => job.role === 'reviewer').prompt;
  assert.match(prompt, /proposed evidence-to-file mapping/);
  assert.match(prompt, /"path":"result.json","requirements":\["E1"\]/);
});

test('interrupted executor is recorded and retries from its files after review', async t => {
  let firstReview = true;
  const { supervisor, directory, runner, jobs } = await fixture(t, { async transform(job, result) {
    if (job.role === 'reviewer' && firstReview) {
      firstReview = false;
      result.decision = 'rework'; result.accepted = [];
    }
  }, async before(job) {
    if (job.role === 'executor' && job.taskId === 'T1') {
      assert.equal(await readFile(join(job.cwd, 'incremental.txt'), 'utf8'), 'previous edits');
    }
    if (job.role === 'reviewer') {
      assert.deepEqual(await readdir(job.cwd), [], 'reviewer workspace must start fresh');
    }
  } });
  await supervisor.close();
  const path = join(directory, 'project', 'project.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  const work = join(directory, 'project', 'work', 'interrupted');
  await mkdir(work);
  await writeFile(join(work, 'incremental.txt'), 'previous edits');
  state.plan = plan();
  state.attempts = [{ id: 'interrupted', taskId: 'T1', directory: work, inputEvidence: [], error: 'Execution has not yet settled' }];
  state.active = { id: 'interrupted', role: 'executor', taskId: 'T1', directory: work };
  state.status = 'active';
  await writeFile(path, JSON.stringify(state));
  const reopened = await ResearchSupervisor.open(join(directory, 'project'), runner);
  try {
    assert.equal(reopened.status().status, 'paused');
    assert.equal(reopened.status().active, undefined);
    assert.equal(reopened.status().attempts[0].error, 'Interrupted by host restart');
    await reopened.run();
    assert.equal(reopened.status().status, 'completed');
    assert.equal(jobs[0].role, 'reviewer');
    assert.equal(reopened.status().attempts.filter(item => item.taskId === 'T1').length, 2);
  } finally { await reopened.close(); }
});
