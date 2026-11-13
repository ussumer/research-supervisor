import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, lstat, readdir, chmod, stat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import type { Project, Request, SealedFile } from './contracts.js';

export function inside(root: string, name: string): string {
  if (!name || isAbsolute(name) || name.includes('\\') || name.split('/').includes('..')) throw new Error('Relative project path required');
  const path = resolve(root, name);
  const rel = relative(resolve(root), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path escapes the project');
  return path;
}

async function regular(root: string, name: string) {
  const path = inside(root, name);
  let current = resolve(root);
  for (const part of relative(resolve(root), path).split('/')) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${name}`);
  }
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Expected a regular file: ${name}`);
  return { path, info };
}

async function regularRoot(root: string) {
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Project root must be a real directory');
}

export async function checkRegular(root: string, name: string): Promise<void> {
  await regularRoot(root);
  await regular(root, name);
}

export async function readRegular(root: string, name: string, maxBytes = 1024 * 1024): Promise<string> {
  await regularRoot(root);
  const { path, info } = await regular(root, name);
  if (info.size > maxBytes) throw new Error('Expected a bounded regular file');
  return readFile(path, 'utf8');
}

export class ProjectStore {
  private root: string;
  private lock: Awaited<ReturnType<typeof open>>;
  state: Project;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private readonly lockToken: string;

  private constructor(root: string, lock: Awaited<ReturnType<typeof open>>, state: Project, lockToken: string) {
    this.lockToken = lockToken;
    this.root = root;
    this.lock = lock;
    this.state = state;
  }

  static async open(rootPath: string, request?: Request): Promise<ProjectStore> {
    const root = resolve(rootPath);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lockPath = join(root, 'writer.lock');
    let lock;
    while (!lock) {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let live = false;
        try {
          const record = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number };
          if (!Number.isSafeInteger(record.pid)) throw new Error('Invalid writer lock');
          try { process.kill(record.pid, 0); live = true; } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
          }
        } catch (lockError) {
          if (lockError instanceof SyntaxError || (lockError as NodeJS.ErrnoException).code === 'ENOENT') live = false;
          else if ((lockError as Error).message === 'Invalid writer lock') live = false;
          else throw lockError;
        }
        if (live) throw Object.assign(new Error('Project writer is still alive'), { code: 'EEXIST' });
        await rm(lockPath, { force: true });
      }
    }
    const lockToken = randomUUID();
    await lock.writeFile(JSON.stringify({ pid: process.pid, token: lockToken, created: new Date().toISOString() }));
    try {
      let state: Project;
      try {
        state = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'));
        if (request) throw new Error('Project already exists; resume explicitly');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!request) throw new Error('Project does not exist');
        state = { revision: 0, request, status: 'planning', plans: [], attempts: [], evidence: [],
                  replans: 0, reason: 'New project' };
      }
      return new ProjectStore(root, lock, state, lockToken);
    } catch (error) {
      await lock.close();
      await rm(join(root, 'writer.lock'));
      throw error;
    }
  }

  save(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Project store is closed'));
    const saving = this.pending.then(() => this.persist());
    this.pending = saving.catch(() => undefined);
    return saving;
  }

  private async persist(): Promise<void> {
    const next = { ...structuredClone(this.state), revision: this.state.revision + 1 };
    const content = JSON.stringify(next, null, 2);
    const path = join(this.root, 'project.json');
    const temporary = path + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(content); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path);
      this.state.revision = next.revision;
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.pending.then(async () => {
      await this.lock.close();
      try {
        const record = JSON.parse(await readFile(join(this.root, 'writer.lock'), 'utf8')) as { pid?: number; token?: string };
        if (record.pid === process.pid && record.token === this.lockToken) await rm(join(this.root, 'writer.lock'));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
    return this.closing;
  }
}

export async function sealDirectory(source: string, target: string,
                                    maxBytes = 256 * 1024 * 1024, maxFiles = 1024): Promise<SealedFile[]> {
  await regularRoot(source);
  await mkdir(target, { recursive: false, mode: 0o700 });
  const files: SealedFile[] = [];
  let total = 0;
  async function copy(directory: string): Promise<void> {
    for (const entry of await readdir(join(source, directory), { withFileTypes: true })) {
      const name = directory ? directory + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Delivery contains symbolic links');
      const destination = inside(target, name);
      if (entry.isDirectory()) {
        await mkdir(destination, { mode: 0o700 });
        await copy(name);
        await chmod(destination, 0o555);
      } else {
        if (!entry.isFile() || files.length >= maxFiles) throw new Error('Delivery contains unsupported files or too many files');
        const { path: inputPath, info: before } = await regular(source, name);
        total += before.size;
        if (total > maxBytes) throw new Error('Delivery exceeds the snapshot byte budget');
        const bytes = await readFile(inputPath);
        const after = await stat(inputPath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error('Delivery changed during snapshot');
        const output = await open(destination, 'wx', 0o400);
        try { await output.writeFile(bytes); } finally { await output.close(); }
        files.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      }
    }
  }
  try {
    await copy('');
    if (!files.length) throw new Error('Empty delivery');
    await chmod(target, 0o555);
    return files;
  } catch (error) {
    throw new Error('Snapshot failed; candidate not published', { cause: error });
  }
}

export async function verifySnapshot(root: string, files: SealedFile[]): Promise<void> {
  if (!files.length) throw new Error('No snapshot files');
  await regularRoot(root);
  for (const file of files) {
    const { path, info } = await regular(root, file.path);
    if (info.size !== file.bytes) throw new Error('Snapshot file identity changed');
    const bytes = await readFile(path);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Snapshot hash changed');
  }
}
