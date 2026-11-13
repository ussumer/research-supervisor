import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import { NativeAgentRunner } from './agents.js';
import { ResearchSupervisor, validateRequest } from './supervision.js';
import type { AgentRunner, Request } from './contracts.js';

export const name = 'research-supervisor';
export const inject = ['commands', 'agents', 'tools', 'workingDirectory', 'agentLoop'];

export interface Config {
  projectDirectory: string;
}

export const Config = Schema.object({
  projectDirectory: Schema.transform(Schema.string().required(), value => {
    if (!isAbsolute(value) || value.includes('\0')) throw new Error('An absolute private project directory is required');
    return resolve(value);
  }).required().description('Private supervisor state directory, outside every user-provided source.'),
});

type Supervisor = Pick<ResearchSupervisor, 'run' | 'pause' | 'close' | 'status' | 'reconcile'>;
type PluginDependencies = {
  createRunner: (ctx: Context, parent: Agent) => AgentRunner;
  open: (root: string, runner: AgentRunner, request?: Request) => Promise<Supervisor>;
};

export function createPluginDependencies(overrides: Partial<PluginDependencies> = {}): PluginDependencies {
  return {
    createRunner: (ctx, parent) => new NativeAgentRunner(ctx, parent),
    open: (root, runner, request) => ResearchSupervisor.open(root, runner, request),
    ...overrides,
  };
}

class CommandFailure extends Error {}

function redact(message: string): string {
  return message
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/giu, '$1 <REDACTED>')
    .replace(/\b((?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|credential|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)(?:\s+<REDACTED>)?/giu, '$1<REDACTED>')
    .replace(/\bsk-[\w-]+/gu, '<REDACTED>')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1<REDACTED>@');
}

const usage = 'Use /research start <absolute-request.json>, /research status, /research pause, /research reconcile, or /research resume.';
const requestKeys = new Set(['goal', 'sources', 'deadline', 'maxReplans', 'producerContext']);
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const maxRequestBytes = 64 * 1024;

function contains(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference === '' || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith('..' + sep));
}

async function canonicalDirectory(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalDirectory(dirname(path)), relative(dirname(path), path));
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readRequest(input: string, root: string): Promise<Request> {
  let path = input;
  if (input.startsWith('"')) {
    try { path = JSON.parse(input); }
    catch { throw new CommandFailure('The request filename must be an absolute path or a JSON-quoted absolute path.'); }
  }
  if (typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/u.test(path)) {
    throw new CommandFailure('The request filename must be an absolute path.');
  }
  let request: Request;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxRequestBytes) throw new Error('Invalid request file');
      const buffer = Buffer.alloc(maxRequestBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxRequestBytes || bytesRead !== info.size) throw new Error('Invalid request size');
      request = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'), (key, value) => {
        if (unsafeKeys.has(key)) throw new Error('Unsafe request key');
        return value;
      });
    } finally { await file.close(); }
    if (!request || Object.getPrototypeOf(request) !== Object.prototype ||
        !['goal', 'sources', 'deadline', 'maxReplans'].every(key => Object.hasOwn(request, key)) ||
        Object.keys(request).some(key => !requestKeys.has(key))) {
      throw new Error('Invalid request fields');
    }
    validateRequest(request);
    if (typeof request.deadline !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(request.deadline)) {
      throw new Error('An ISO deadline is required');
    }
  } catch {
    throw new CommandFailure('Invalid request: provide goal, sources, deadline, maxReplans and optional producerContext (isolated or full) in a regular JSON file.');
  }
  try {
    const sources: string[] = [];
    for (const source of request.sources) {
      const canonical = await realpath(source);
      const info = await stat(canonical);
      if ((!info.isFile() && !info.isDirectory()) || contains(canonical, root) || contains(root, canonical)) {
        throw new Error('Source exposes private storage');
      }
      if (!sources.includes(canonical)) sources.push(canonical);
    }
    return { ...request, sources };
  } catch {
    throw new CommandFailure('Sources must exist and must not overlap the private project directory, including through symbolic links.');
  }
}

interface ActiveProject {
  owner: Agent;
  supervisor: Supervisor;
  deadline: string;
  running?: Promise<void>;
  failure?: string;
}

export function apply(ctx: Context, config: Config, dependencies = createPluginDependencies()): void {
  if (!config || typeof config.projectDirectory !== 'string' || !isAbsolute(config.projectDirectory) || config.projectDirectory.includes('\0')) {
    throw new Error('An absolute private project directory is required');
  }
  const logger = ctx.logger(name);
  let active: ActiveProject | undefined;
  let pending: Promise<void> = Promise.resolve();
  let disposed = false;

  function report(project: ActiveProject | undefined, error: unknown): string {
    const message = redact(error instanceof Error ? error.message : String(error));
    if (project) project.failure = message;
    logger.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
    return message;
  }

  function launch(project: ActiveProject): void {
    project.failure = undefined;
    project.running = Promise.resolve().then(() => project.supervisor.run()).catch(error => {
      report(project, error);
    }).finally(() => { project.running = undefined; });
  }

  function status(project: ActiveProject): string {
    const state = project.supervisor.status();
    return `Research ${state.status}; running=${Boolean(project.running)}; deadline=${project.deadline}; ` +
      `attempts=${state.attempts.length}; evidence=${state.evidence.length}; replans=${state.replans}. ` +
      `producerContext=${state.request.producerContext ?? 'isolated'}; generation=${state.producerCheckpoint?.generation ?? 0}.` +
      (project.failure ? ` ${project.failure}` : '');
  }

  async function dispatch(invocation: CommandInvocation): Promise<CommandResult> {
    if (disposed || invocation.signal.aborted) throw new CommandFailure('Research command cancelled; no new work was started.');
    if (active && active.owner !== invocation.agent) throw new CommandFailure('This project is bound to a different parent Agent.');
    const match = /^(start|status|pause|resume|reconcile)(?:\s+([\s\S]+))?$/u.exec(invocation.rawInput.trim());
    if (!match || (match[1] !== 'start' && match[2])) throw new CommandFailure(usage);
    const action = match[1];
    if (action === 'start') {
      if (active) throw new CommandFailure('This plugin instance already owns a project; use status, pause, reconcile or resume.');
      if (!match[2]) throw new CommandFailure(usage);
      const root = await canonicalDirectory(resolve(config.projectDirectory));
      const request = await readRequest(match[2].trim(), root);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())) {
        throw new CommandFailure('The project directory must be private, owned by the current user, and inaccessible to group/others.');
      }
      if (disposed || invocation.signal.aborted) throw new CommandFailure('Research start cancelled before opening a project.');
      const runner = dependencies.createRunner(ctx, invocation.agent);
      const persisted = await exists(join(root, 'project.json'));
      let supervisor: Supervisor;
      try { supervisor = await dependencies.open(root, runner, persisted ? undefined : request); }
      catch (error) {
        await runner.cancel().catch(cancelError => report(undefined, cancelError));
        throw error;
      }
      active = { owner: invocation.agent, supervisor, deadline: supervisor.status().request.deadline };
      if (disposed || invocation.signal.aborted) {
        await supervisor.pause('Start cancelled before background execution');
        await supervisor.close();
        active = undefined;
        throw new CommandFailure('Research start cancelled before background execution.');
      }
      launch(active);
      return { kind: 'success', text: 'Research started in the background for this parent Agent. Use /research status to inspect progress.' };
    }
    if (!active && (action === 'reconcile' || action === 'resume')) {
      const root = await canonicalDirectory(resolve(config.projectDirectory));
      const runner = dependencies.createRunner(ctx, invocation.agent);
      let supervisor: Supervisor;
      try { supervisor = await dependencies.open(root, runner); }
      catch (error) {
        await runner.cancel().catch(cancelError => report(undefined, cancelError));
        throw error;
      }
      active = { owner: invocation.agent, supervisor, deadline: supervisor.status().request.deadline };
      if (disposed || invocation.signal.aborted) {
        await supervisor.close();
        active = undefined;
        throw new CommandFailure('Research attachment cancelled before background execution.');
      }
    }
    if (!active) {
      if (action === 'status') return { kind: 'success', text: 'No project is active in this plugin instance.' };
      throw new CommandFailure('No project is active in this plugin instance. Use /research reconcile to recover persisted state.');
    }
    if (action === 'status') return { kind: 'success', text: status(active) };
    if (action === 'reconcile') {
      if (active.running) throw new CommandFailure('Pause research before reconciling.');
      await active.supervisor.reconcile();
      active.failure = undefined;
      return { kind: 'success', text: status(active) };
    }
    if (action === 'pause') {
      if (!active.running && active.supervisor.status().status !== 'paused') {
        throw new CommandFailure('Only a running or paused project can be paused; a terminal or blocked project requires explicit reconciliation.');
      }
      await active.supervisor.pause('Paused by the bound parent user');
      await active.running;
      return { kind: 'success', text: status(active) };
    }
    if (active.running) throw new CommandFailure('Research is already running.');
    const state = active.supervisor.status();
    if (state.active) throw new CommandFailure('An unfinished native role session requires reconciliation; it will not be rerun automatically.');
    if (state.status !== 'paused' || active.failure) throw new CommandFailure('Only a cleanly paused, known native session can resume. Inspect project status first.');
    if (Date.now() >= Date.parse(active.deadline)) throw new CommandFailure('The original project deadline has expired; resume cannot reset it.');
    launch(active);
    return { kind: 'success', text: 'Research resumed with the original project deadline and source permissions.' };
  }

  ctx.commands.register({
    name: 'research',
    description: 'Start, inspect, pause, reconcile or resume a supervised native research project.',
    input: { hint: 'start <absolute-request.json> | status | pause | reconcile | resume' },
    recordInput: false,
    handler(invocation) {
      const result = pending.then(async (): Promise<CommandResult> => {
        try { return await dispatch(invocation); }
        catch (error) {
          if (error instanceof CommandFailure) return { kind: 'error', text: redact(error.message) };
          return { kind: 'error', text: report(active, error) };
        }
      });
      pending = result.then(() => undefined);
      return result;
    },
  });

  ctx.effect(() => async () => {
    disposed = true;
    await pending;
    if (!active) return;
    try {
      if (active.running) {
        await active.supervisor.pause('Plugin unloaded; no automatic restart');
        await active.running;
      }
      await active.supervisor.close();
    } catch (error) {
      report(active, error);
      throw new CommandFailure(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
    }
  });
}
