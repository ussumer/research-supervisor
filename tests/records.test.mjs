import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { inside, ProjectStore, readRegular, sealDirectory, verifySnapshot } from '../lib/records.js';

const run = promisify(execFile);
const recordsUrl = new URL('../lib/records.js', import.meta.url).href;

function requestFixture() {
  return {
    goal: 'Reproduce the documented result without changing acceptance criteria',
    sources: ['paper.md'], deadline: '2099-01-01T00:00:00.000Z', maxReplans: 2,
  };
}

async function makeWritable(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
  } else if (stat.isFile()) {
    await chmod(path, 0o600);
  }
}

async function sandbox(context) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-supervisor-records-'));
  const stores = new Set();
  context.after(async () => {
    try {
      await Promise.all([...stores].map(store => store.close()));
    } finally {
      await makeWritable(directory);
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    directory,
    async openStore(...args) {
      const store = await ProjectStore.open(...args);
      stores.add(store);
      return store;
    },
    async closeStore(store) {
      await store.close();
      stores.delete(store);
    },
  };
}

async function writeTree(directory, files) {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(directory, name);
    const parent = join(target, '..');
    await mkdir(parent, { recursive: true });
    await writeFile(target, content);
  }
}

async function sealedFixture(context) {
  const fixture = await sandbox(context);
  const source = join(fixture.directory, 'source');
  const snapshot = join(fixture.directory, 'snapshot');
  const contents = {
    'README.md': 'Read the documented inputs and output mapping.\n',
    'results/curve.csv': 'coordinate,value\n1,2\n',
    'results/empty.txt': '',
    'results/数值.bin': Buffer.from([0, 255, 128, 10]),
  };
  await writeTree(source, contents);
  const files = await sealDirectory(source, snapshot);
  return { ...fixture, source, snapshot, contents, files };
}

async function assertAbsent(path) {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
}

async function assertFifoRejected(root, operation) {
  const script = `
    import assert from 'node:assert/strict';
    import { readRegular, verifySnapshot } from ${JSON.stringify(recordsUrl)};
    const root = process.argv[1];
    await assert.rejects(() => ${operation});
  `;
  await run(process.execPath, ['--input-type=module', '-e', script, root], {
    timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
}

test('project saves and explicitly resumes the persisted state with increasing revisions', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const request = requestFixture();
  const store = await fixture.openStore(root, request);
  assert.equal(store.state.revision, 0);
  assert.equal(store.state.status, 'planning');
  assert.deepEqual(store.state.request, request);
  assert.deepEqual(store.state.attempts, []);
  assert.deepEqual(store.state.evidence, []);
  await store.save();
  assert.equal(store.state.revision, 1);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')), store.state);
  store.state.reason = 'Waiting for independent review';
  await store.save();
  assert.equal(store.state.revision, 2);
  const expected = structuredClone(store.state);
  await fixture.closeStore(store);
  await assertAbsent(join(root, 'writer.lock'));
  const resumed = await fixture.openStore(root);
  assert.deepEqual(resumed.state, expected);
  assert.deepEqual((await readdir(root)).sort(), ['project.json', 'writer.lock']);
});

test('a second writer cannot acquire or remove the live writer lock', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const store = await fixture.openStore(root, requestFixture());
  await store.save();
  const lock = await readFile(join(root, 'writer.lock'), 'utf8');
  await assert.rejects(ProjectStore.open(root), { code: 'EEXIST' });
  assert.equal(await readFile(join(root, 'writer.lock'), 'utf8'), lock);
  await store.save();
  assert.equal(store.state.revision, 2);
});

test('concurrent opens elect exactly one project writer', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const results = await Promise.allSettled([
    fixture.openStore(root, requestFixture()),
    fixture.openStore(root, requestFixture()),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'EEXIST');
  await results.find(result => result.status === 'fulfilled').value.save();
});

test('a new request cannot silently reuse an existing project', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const store = await fixture.openStore(root, requestFixture());
  store.state.reason = 'Approved project context';
  await store.save();
  await fixture.closeStore(store);
  const original = await readFile(join(root, 'project.json'), 'utf8');
  await assert.rejects(ProjectStore.open(root, { ...requestFixture(), goal: 'A different goal' }), /already exists|resume explicitly/i);
  assert.equal(await readFile(join(root, 'project.json'), 'utf8'), original);
  await assertAbsent(join(root, 'writer.lock'));
  const resumed = await fixture.openStore(root);
  assert.equal(resumed.state.request.goal, requestFixture().goal);
});

test('resume of a missing project fails and releases the lock', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  await assert.rejects(ProjectStore.open(root), /does not exist/i);
  await assertAbsent(join(root, 'writer.lock'));
  const store = await fixture.openStore(root, requestFixture());
  await store.save();
});

test('corrupt persisted JSON is not replaced with a fresh request', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  await writeTree(root, { 'project.json': '{incomplete' });
  await assert.rejects(ProjectStore.open(root));
  await assert.rejects(ProjectStore.open(root, requestFixture()));
  assert.equal(await readFile(join(root, 'project.json'), 'utf8'), '{incomplete');
  await assertAbsent(join(root, 'writer.lock'));
});

test('save atomically replaces the file without rewriting an already-open previous revision', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const store = await fixture.openStore(root, requestFixture());
  await store.save();
  const previous = structuredClone(store.state);
  const reader = await open(join(root, 'project.json'), 'r');
  try {
    store.state.reason = 'The next complete revision';
    await store.save();
    assert.deepEqual(JSON.parse(await reader.readFile('utf8')), previous);
    const current = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'));
    assert.equal(current.revision, previous.revision + 1);
    assert.equal(current.reason, store.state.reason);
  } finally {
    await reader.close();
  }
});

test('failed serialization preserves the old durable state and revision', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const store = await fixture.openStore(root, requestFixture());
  await store.save();
  const previous = await readFile(join(root, 'project.json'), 'utf8');
  const revision = store.state.revision;
  const reason = store.state.reason;
  store.state.reason = store.state;
  try {
    await assert.rejects(store.save());
    assert.equal(store.state.revision, revision);
    assert.equal(await readFile(join(root, 'project.json'), 'utf8'), previous);
  } finally {
    store.state.reason = reason;
  }
  await store.save();
  assert.equal(store.state.revision, revision + 1);
});

test('save cannot overwrite a symlinked temporary-file target', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const store = await fixture.openStore(root, requestFixture());
  await store.save();
  const outside = join(fixture.directory, 'outside.txt');
  await writeFile(outside, 'Do not overwrite this file');
  await symlink(outside, join(root, 'project.json.tmp'));
  const previous = await readFile(join(root, 'project.json'), 'utf8');
  const revision = store.state.revision;
  let failure;
  try {
    await store.save();
  } catch (error) {
    failure = error;
  }
  assert.equal(await readFile(outside, 'utf8'), 'Do not overwrite this file');
  assert.equal((await lstat(join(root, 'project.json'))).isSymbolicLink(), false);
  if (failure) {
    assert.ok(failure instanceof Error);
    assert.equal(store.state.revision, revision);
    assert.equal(await readFile(join(root, 'project.json'), 'utf8'), previous);
  } else {
    assert.equal(store.state.revision, revision + 1);
  }
});

test('a closed store cannot save without owning the writer lock', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const store = await fixture.openStore(root, requestFixture());
  await store.save();
  await fixture.closeStore(store);
  const previous = await readFile(join(root, 'project.json'), 'utf8');
  store.state.reason = 'Must not reach disk';
  await assert.rejects(store.save(), /closed|lock/i);
  assert.equal(await readFile(join(root, 'project.json'), 'utf8'), previous);
});

test('closing an old store twice cannot remove a later writer lock', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const first = await fixture.openStore(root, requestFixture());
  await first.save();
  await fixture.closeStore(first);
  const second = await fixture.openStore(root);
  const lock = await readFile(join(root, 'writer.lock'), 'utf8');
  await first.close();
  assert.equal(await readFile(join(root, 'writer.lock'), 'utf8'), lock);
  await assert.rejects(ProjectStore.open(root), { code: 'EEXIST' });
  await second.save();
});

test('concurrent saves serialize into distinct complete revisions', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const store = await fixture.openStore(root, requestFixture());
  await store.save();
  await Promise.all([store.save(), store.save(), store.save()]);
  assert.equal(store.state.revision, 4);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')), store.state);
  assert.deepEqual((await readdir(root)).sort(), ['project.json', 'writer.lock']);
});

test('close waits for queued saves before releasing ownership', async context => {
  const fixture = await sandbox(context);
  const root = join(fixture.directory, 'project');
  const store = await fixture.openStore(root, requestFixture());
  const saves = [store.save(), store.save()];
  const closing = fixture.closeStore(store);
  await assert.rejects(store.save(), /closed|lock/i);
  await Promise.all([...saves, closing]);
  await assertAbsent(join(root, 'writer.lock'));
  const resumed = await fixture.openStore(root);
  assert.equal(resumed.state.revision, 2);
  assert.deepEqual(resumed.state.request, requestFixture());
});

test('inside resolves only descendants of the requested root', async context => {
  const { directory } = await sandbox(context);
  assert.equal(inside(directory, 'results/curve.csv'), join(directory, 'results', 'curve.csv'));
  for (const name of ['', '.', '..', '../outside', 'nested/../../outside', 'nested/../outside', '/absolute', 'nested\\file']) {
    assert.throws(() => inside(directory, name), /path/i);
  }
});

test('readRegular enforces a byte limit without truncating UTF-8 text', async context => {
  const { directory } = await sandbox(context);
  const content = '数值结果\n';
  await writeTree(directory, { 'results/report.txt': content, 'empty.txt': '' });
  const bytes = Buffer.byteLength(content);
  assert.equal(await readRegular(directory, 'results/report.txt', bytes), content);
  assert.equal(await readRegular(directory, 'empty.txt', 0), '');
  await assert.rejects(readRegular(directory, 'results/report.txt', bytes - 1), /bounded|budget|large|limit/i);
  await assert.rejects(readRegular(directory, '../outside'), /path/i);
  await assert.rejects(readRegular(directory, 'results'), /regular|file/i);
});

for (const kind of ['file', 'directory', 'root', 'dangling']) {
  test(`readRegular rejects a ${kind} symlink`, async context => {
    const { directory } = await sandbox(context);
    const root = join(directory, 'root');
    const outside = join(directory, 'outside');
    await writeTree(root, { 'plain.txt': 'plain' });
    await writeTree(outside, { 'report.txt': 'must not be followed' });
    if (kind === 'directory') {
      await symlink(outside, join(root, 'link'));
      await assert.rejects(readRegular(root, 'link/report.txt'));
    } else if (kind === 'root') {
      await symlink(outside, join(directory, 'root-link'));
      await assert.rejects(readRegular(join(directory, 'root-link'), 'report.txt'));
    } else {
      await symlink(join(outside, kind === 'dangling' ? 'missing.txt' : 'report.txt'), join(root, 'link.txt'));
      await assert.rejects(readRegular(root, 'link.txt'));
    }
  });
}

test('readRegular rejects a FIFO promptly instead of blocking on open', { skip: process.platform === 'win32' }, async context => {
  const { directory } = await sandbox(context);
  await run('mkfifo', [join(directory, 'pipe')]);
  await assertFifoRejected(directory, "readRegular(root, 'pipe')");
});

test('sealDirectory records exact binary hashes and seals a separate read-only tree', async context => {
  const { snapshot, contents, files } = await sealedFixture(context);
  const expected = Object.entries(contents).map(([path, content]) => {
    const bytes = Buffer.from(content);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const byPath = (first, second) => first.path.localeCompare(second.path);
  assert.deepEqual([...files].sort(byPath), expected.sort(byPath));
  for (const [path, content] of Object.entries(contents)) {
    const target = join(snapshot, path);
    assert.deepEqual(await readFile(target), Buffer.from(content));
    assert.equal((await lstat(target)).mode & 0o222, 0);
  }
  assert.equal((await lstat(snapshot)).mode & 0o222, 0);
  assert.equal((await lstat(join(snapshot, 'results'))).mode & 0o222, 0);
  await verifySnapshot(snapshot, files);
});

test('changing executor files after sealing cannot change the review snapshot', async context => {
  const { source, snapshot, files, contents } = await sealedFixture(context);
  await writeFile(join(source, 'results/curve.csv'), 'rewritten result');
  await rm(join(source, 'README.md'));
  assert.equal(await readRegular(snapshot, 'results/curve.csv'), contents['results/curve.csv']);
  await verifySnapshot(snapshot, files);
});

test('sealDirectory refuses to reuse a pre-existing snapshot directory', async context => {
  const { directory } = await sandbox(context);
  const source = join(directory, 'source');
  const target = join(directory, 'target');
  await writeTree(source, { 'README.md': 'new contents' });
  await writeTree(target, { 'existing.txt': 'Keep the existing snapshot' });
  await assert.rejects(sealDirectory(source, target));
  assert.equal(await readFile(join(target, 'existing.txt'), 'utf8'), 'Keep the existing snapshot');
  await assertAbsent(join(target, 'README.md'));
});

test('sealDirectory rejects empty output instead of publishing an empty manifest', async context => {
  const { directory } = await sandbox(context);
  const source = join(directory, 'source');
  await mkdir(source);
  await assert.rejects(sealDirectory(source, join(directory, 'snapshot')));
});

for (const kind of ['file', 'directory', 'root', 'dangling']) {
  test(`sealDirectory rejects a ${kind} source symlink`, async context => {
    const { directory } = await sandbox(context);
    const source = join(directory, 'source');
    const outside = join(directory, 'outside');
    await writeTree(outside, { 'report.txt': 'Not an owned artifact' });
    if (kind === 'root') {
      await symlink(outside, source);
    } else {
      await mkdir(source);
      await symlink(kind === 'directory' ? outside : join(outside, kind === 'dangling' ? 'missing.txt' : 'report.txt'), join(source, 'link'));
    }
    await assert.rejects(sealDirectory(source, join(directory, 'snapshot')));
  });
}

test('sealDirectory rejects special files without reading them', { skip: process.platform === 'win32' }, async context => {
  const { directory } = await sandbox(context);
  const source = join(directory, 'source');
  await mkdir(source);
  await run('mkfifo', [join(source, 'pipe')]);
  await assert.rejects(sealDirectory(source, join(directory, 'snapshot')));
});

test('sealDirectory bounds aggregate bytes, including multiple individually small files', async context => {
  const { directory } = await sandbox(context);
  const source = join(directory, 'source');
  await writeTree(source, { 'first.txt': '1234', 'second.txt': '5678' });
  await assert.rejects(sealDirectory(source, join(directory, 'too-large'), 7, 2));
  const files = await sealDirectory(source, join(directory, 'exact-budget'), 8, 2);
  assert.equal(files.length, 2);
  assert.equal(files.reduce((total, file) => total + file.bytes, 0), 8);
});

test('sealDirectory rejects oversized individual files before publication', async context => {
  const { directory } = await sandbox(context);
  const source = join(directory, 'source');
  await writeTree(source, { 'oversized.bin': Buffer.alloc(4097) });
  await assert.rejects(sealDirectory(source, join(directory, 'snapshot'), 4096));
});

test('sealDirectory enforces the file-count budget even for zero-byte files', async context => {
  const { directory } = await sandbox(context);
  const source = join(directory, 'source');
  await writeTree(source, { 'first.txt': '', 'second.txt': '' });
  await assert.rejects(sealDirectory(source, join(directory, 'too-many'), 0, 1));
  assert.equal((await sealDirectory(source, join(directory, 'exact-count'), 0, 2)).length, 2);
});

test('verifySnapshot detects same-length content tampering', async context => {
  const { snapshot, files, contents } = await sealedFixture(context);
  const path = join(snapshot, 'results/curve.csv');
  await chmod(path, 0o600);
  await writeFile(path, contents['results/curve.csv'].replace('1,2', '1,3'));
  await assert.rejects(verifySnapshot(snapshot, files), /hash|identity/i);
});

test('verifySnapshot detects file-length changes', async context => {
  const { snapshot, files } = await sealedFixture(context);
  const path = join(snapshot, 'results/curve.csv');
  await chmod(path, 0o600);
  await writeFile(path, 'short');
  await assert.rejects(verifySnapshot(snapshot, files), /identity|size|bytes/i);
});

test('verifySnapshot rejects missing files and an empty manifest', async context => {
  const { snapshot, files } = await sealedFixture(context);
  await chmod(snapshot, 0o700);
  await rm(join(snapshot, 'README.md'));
  await assert.rejects(verifySnapshot(snapshot, files));
  await assert.rejects(verifySnapshot(snapshot, []), /snapshot|files/i);
});

test('verifySnapshot rejects path traversal even if the outside bytes and hash match', async context => {
  const { directory, snapshot, files } = await sealedFixture(context);
  const content = 'matching outside bytes';
  await writeFile(join(directory, 'outside.txt'), content);
  const escaped = [{ ...files[0], path: '../outside.txt', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }];
  await assert.rejects(verifySnapshot(snapshot, escaped), /path/i);
});

for (const kind of ['file', 'directory', 'root']) {
  test(`verifySnapshot rejects a ${kind} symlink even when content and hashes match`, async context => {
    const { directory, snapshot, contents, files } = await sealedFixture(context);
    const outside = join(directory, 'outside');
    await writeTree(outside, contents);
    await chmod(snapshot, 0o700);
    if (kind === 'file') {
      await rm(join(snapshot, 'README.md'));
      await symlink(join(outside, 'README.md'), join(snapshot, 'README.md'));
    } else if (kind === 'directory') {
      await makeWritable(join(snapshot, 'results'));
      await rm(join(snapshot, 'results'), { recursive: true });
      await symlink(join(outside, 'results'), join(snapshot, 'results'));
    } else {
      await makeWritable(snapshot);
      await rm(snapshot, { recursive: true });
      await symlink(outside, snapshot);
    }
    await assert.rejects(verifySnapshot(snapshot, files));
  });
}

test('verifySnapshot rejects a FIFO promptly instead of blocking', { skip: process.platform === 'win32' }, async context => {
  const { directory } = await sandbox(context);
  await run('mkfifo', [join(directory, 'pipe')]);
  await assertFifoRejected(directory, "verifySnapshot(root, [{ path: 'pipe', bytes: 0, sha256: '0'.repeat(64) }])");
});
