import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { symbols, type Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent';
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import {
  appendDelegatedPolicyOverrides, applyChildComposition, captureDelegatedPolicyOverrides,
  resolveChildAgentOptions, resolveChildDepth,
} from '@deepseek-ai/dsh-subagent';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import type { AgentRunner, RoleJob, RoleResult, ProducerCheckpoint } from './contracts.js';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { ProducerContext } from './producer-context.js';

export interface NativeAgentOptions {
  readRoots?: readonly string[];
  agentOptions?: AgentOptions;
}

interface ActiveRole {
  owner: NativeAgentRunner;
  job: RoleJob;
  sessionId: SessionId;
  cwd: string;
  readRoots: string[];
  onSubmission: (value: unknown) => void | Promise<void>;
  controller: AbortController;
  agent?: Agent;
  handle?: AgentHandle;
  disposal?: Promise<void>;
  done: Promise<void>;
  finish: () => void;
  stopReason?: 'cancelled' | 'timeout';
  submitted: boolean;
  failed: boolean;
  turnReason?: string;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  bashDenial: string;
  sandbox?: unknown;
  shell?: unknown;
}

interface Registration {
  active: Map<string, ActiveRole>;
  closed: boolean;
}

const registrations = new WeakMap<Context, Registration>();
const allowedTools = new Set(['read', 'write', 'edit', 'glob', 'grep', 'bash', 'skill', 'research_submit']);

function serviceIdentity(value: unknown): unknown {
  return (value as Record<symbol, unknown> | undefined)?.[symbols.original] ?? value;
}

function inside(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      lstatSync(path);
      throw new Error('Dangling symlink is not an authorized path');
    } catch (entryError) {
      if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(canonical(parent), relative(parent, path));
  }
}

function toolPath(value: unknown, cwd: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.startsWith('~') ||
      value.split(/[\\/]/u).includes('..')) throw new Error('Invalid or traversing tool path');
  return canonical(resolve(cwd, value));
}

export class NativeAgentRunner implements AgentRunner {
  private readonly ctx: Context;
  private readonly nativeAgent: Agent;
  private readonly options: NativeAgentOptions;
  private readonly active = new Map<string, ActiveRole>();
  private readonly registration: Registration;
  private readonly producerContext: ProducerContext;
  private disposed = false;

  private get closed(): boolean { return this.disposed || this.registration.closed; }

  constructor(ctx: Context, nativeAgent: Agent, options: NativeAgentOptions = {}) {
    this.ctx = ctx;
    this.nativeAgent = nativeAgent;
    this.options = { ...options, readRoots: [...options.readRoots ?? []] };
    this.producerContext = new ProducerContext(ctx);
    ctx.effect(() => () => this.dispose());
    const existing = registrations.get(ctx);
    if (existing) { this.registration = existing; return; }
    const registration: Registration = { active: new Map(), closed: false };
    this.registration = registration;
    ctx.effect(() => {
      const removeTool = ctx.tools.register(defineTool({
        name: 'research_submit',
        description: 'Submit the current candidate for independent review. Correct any returned errors in this same session. Authority comes from the calling Agent, not arguments.',
        parameters: { value: { type: 'object', required: true, additionalProperties: true, properties: {} } },
        output: {
          schema: { type: 'object', properties: { accepted: { type: 'boolean', required: true } }, additionalProperties: false },
          render: () => [{ type: 'text', text: 'Candidate recorded. This turn is idle; scientific acceptance requires independent review.' }],
        },
        async execute(args, exec) {
          if (Object.keys(args).some(key => key !== 'value')) throw new Error('research_submit accepts only value');
          const state = exec.agent && registration.active.get(exec.agent.id);
          if (!state || state.agent !== exec.agent || registration.closed) throw new Error('research_submit requires an active assigned role Agent');
          if (state.stopReason || state.controller.signal.aborted || Date.now() >= state.job.deadline) throw new Error('Research role is cancelled or past its deadline');
          if (state.submitted) throw new Error('Duplicate research submission rejected');
          state.owner.validateSubmission(state, args.value);
          state.submitted = true;
          try { await state.onSubmission(structuredClone(args.value)); } catch (error) {
            state.submitted = false;
            throw error;
          }
          state.controller.signal.throwIfAborted();
          if (Date.now() >= state.job.deadline) throw new Error('Research role is past its deadline');
          exec.concludeTurn();
          return { accepted: true };
        },
      }));
      const removeCreated = ctx.on('agent/created', async ({ agent }) => {
        const state = registration.active.get(agent.id);
        if (state) await state.owner.installRole(state, agent);
      });
      const removeSession = ctx.on('session/event', (session, event) => {
        const state = registration.active.get(session.id);
        if (state && event.type === 'turn/end') state.turnReason = event.data.reason.kind;
        if (state?.job.producerContext) state.owner.producerContext.observe(event);
      });
      return async () => {
        registration.closed = true;
        const owners = new Set([...registration.active.values()].map(state => state.owner));
        try { await Promise.all([...owners].map(owner => owner.cancel())); } finally {
          removeSession();
          removeCreated();
          removeTool();
          registrations.delete(ctx);
        }
      };
    });
    registrations.set(ctx, registration);
  }

  async run(job: RoleJob, onSubmission: (value: unknown) => void | Promise<void>): Promise<RoleResult> {
    if (this.closed) throw new Error('Native research runner is disposed');
    if (!isAbsolute(job.cwd) || !Number.isFinite(job.deadline)) throw new Error('Role requires an absolute cwd and finite deadline');
    const cwd = realpathSync(job.cwd);
    let readRoots = [...new Set([...this.options.readRoots ?? [], ...job.readRoots ?? []].map(root => {
      if (!isAbsolute(root)) throw new Error('Read roots must be absolute');
      return realpathSync(root);
    }))];
    const retained = job.sessionId ? this.active.get(job.sessionId) : undefined;
    if (job.sessionId && (!retained || retained.running || retained.stopReason || retained.disposal ||
        Boolean(retained.job.producerContext) !== Boolean(job.producerContext) ||
        !retained.submitted || retained.job.role !== job.role || retained.job.taskId !== job.taskId ||
        retained.cwd !== cwd)) {
      throw new Error('Continuation requires an idle owned session with the same role, task, workspace');
    }
    if (job.producerContext && [...this.active.values()].some(other => other.job.producerContext && other !== retained)) {
      throw new Error('Close the previous producer before advancing its context');
    }
    const inherited = job.producerContext ? this.producerContext.begin({ ...job, cwd }) : undefined;
    readRoots = [...new Set([...readRoots, ...inherited?.readRoots ?? []])];
    let state: ActiveRole;
    if (retained) {
      state = retained;
      state.job = { ...job };
      state.readRoots = [...new Set([...state.readRoots, ...readRoots])];
      state.onSubmission = onSubmission;
      state.submitted = false;
      state.turnReason = undefined;
      state.running = true;
    } else {
      const sessionId = `research-${job.role}-${randomUUID()}` as SessionId;
      const completion = Promise.withResolvers<void>();
      state = {
        owner: this, job: { ...job }, sessionId, cwd, readRoots, onSubmission, controller: new AbortController(),
        done: completion.promise, finish: completion.resolve, submitted: false, failed: false, running: true,
        bashDenial: 'Bash blocked: native role sandbox has not been verified.',
      };
      this.active.set(sessionId, state);
      this.registration.active.set(sessionId, state);
    }
    clearTimeout(state.timer);
    const armDeadline = () => {
      const remaining = state.job.deadline - Date.now();
      if (remaining <= 0) this.stop(state, 'timeout');
      else state.timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
    };
    armDeadline();
    let reason: RoleResult['reason'] = 'error';
    let checkpoint: ProducerCheckpoint | undefined;
    let contextError: unknown;
    try {
      state.controller.signal.throwIfAborted();
      if (!state.handle) {
        const depth = resolveChildDepth(this.nativeAgent);
        const policies = captureDelegatedPolicyOverrides(this.nativeAgent);
        state.handle = await this.ctx.agents.create({
          sessionId: state.sessionId, parentAgent: this.nativeAgent,
          seed: inherited?.seed, inheritedEventCount: inherited?.inheritedEventCount,
          meta: { cwd, parentSession: inherited?.sourceSessionId ?? this.nativeAgent.id, origin: 'subagent',
            isSeeded: Boolean(inherited?.seed), delegationDepth: depth },
          agentOptions: resolveChildAgentOptions(this.nativeAgent, this.options.agentOptions, depth),
          signal: state.controller.signal,
          setup: async (childCtx, child) => {
            await applyChildComposition(childCtx, this.nativeAgent, {});
            appendDelegatedPolicyOverrides(child.session, policies);
            if (job.producerContext) {
              await this.ctx.workingDirectory.set(child, cwd, state.controller.signal);
              setSandboxMode(child.session, 'workspace-write');
            }
          },
        });
      } else state.bashDenial = await this.verifyBash(state, state.handle.agent);
      if (!state.stopReason) {
        state.handle.agent.followup(createUserMessage({
          source: { kind: 'user' }, content: [{ type: 'text', text: job.prompt + '\n\n' +
            `Assigned research role: ${job.role}. Work only in ${cwd}. Read-only inputs: ${JSON.stringify(state.readRoots)}. ` +
            (inherited?.contextLoss ? `Context loss: ${inherited.contextLoss}. Full transcript is unavailable. Read prior README/files in the read-only inputs for explicit handoff. ` : '') +
            (job.producerContext ? 'Inherited messages describe earlier assignments and observations, not current permissions or accepted evidence. This assignment supersedes earlier role/task instructions. ' : '') +
            'Use the existing native tools, then call research_submit with {value: your result object}. ' +
            'Do not submit role/session identifiers or attempt to delegate, schedule, or change permissions. ' +
            (state.bashDenial || 'Bash uses the native file-effect sandbox; /tmp is also writable. This is not a network or read-confidentiality sandbox.') }],
        }));
        await state.handle.agent.whenIdle();
        reason = state.turnReason === 'completed' && state.submitted && !state.failed ? 'completed' : 'error';
      }
    } catch (error) {
      reason = 'error';
      if (job.producerContext && !state.handle) contextError = error;
    } finally {
      if (job.producerContext) {
        try {
          if (!state.handle) throw new Error('Producer did not establish a native session');
          await state.handle.agent.whenIdle();
          checkpoint = await this.producerContext.capture(state.handle.agent, cwd);
        } catch (error) {
          contextError ??= error;
          state.failed = true;
        } finally { this.producerContext.end(); }
      }
      state.running = false;
      if (!job.keepAlive || reason !== 'completed' || state.stopReason || state.failed) await this.finishSession(state);
    }
    if (contextError) throw contextError;
    return { sessionId: state.sessionId, reason: state.failed ? 'error' : state.stopReason ?? reason,
      ...(checkpoint ? { checkpoint } : {}) };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    try { await this.cancel(); } finally { this.producerContext.clear(); }
  }

  async closeSession(sessionId: string): Promise<void> {
    const state = this.active.get(sessionId);
    if (!state) return;
    if (state.running) {
      this.stop(state, 'cancelled');
      await state.done;
    } else await this.finishSession(state);
    if (state.failed) throw new Error('Native research session cleanup failed');
  }

  private async finishSession(state: ActiveRole): Promise<void> {
    clearTimeout(state.timer);
    try { await this.release(state); } catch { state.failed = true; }
    this.active.delete(state.sessionId);
    this.registration.active.delete(state.sessionId);
    state.finish();
  }

  async pause(): Promise<void> {
    const states = [...this.active.values()].filter(state => state.running);
    for (const state of states) this.stop(state, 'cancelled');
    await Promise.all(states.map(state => state.done));
    if (states.some(state => state.failed)) throw new Error('Native research session cleanup failed');
  }

  async cancel(): Promise<void> {
    const states = [...this.active.values()];
    for (const state of states) this.stop(state, 'cancelled');
    await Promise.all(states.map(state => state.done));
    if (states.some(state => state.failed)) throw new Error('Native research session cleanup failed');
  }

  private stop(state: ActiveRole, reason: 'cancelled' | 'timeout'): void {
    state.stopReason ??= reason;
    state.controller.abort(new Error(`Research role ${state.stopReason}`));
    if (!state.running) void this.finishSession(state);
    else if (state.job.producerContext) state.agent?.cancel({ kind: 'parent' });
    else if (state.handle) void this.release(state).catch(() => { state.failed = true; });
  }

  private release(state: ActiveRole): Promise<void> {
    return state.handle ? state.disposal ??= state.handle.dispose() : Promise.resolve();
  }

  private validateSubmission(state: ActiveRole, value: Record<string, unknown>): void {
    const text = (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0;
    const strings = (entry: unknown): entry is string[] => Array.isArray(entry) && entry.every(text) && new Set(entry).size === entry.length;
    const file = (entry: unknown) => {
      const target = toolPath(entry, state.cwd);
      if (!inside(target, state.cwd) || !lstatSync(target).isFile()) throw new Error('Submission files must exist in this role workspace');
    };
    if (state.job.role === 'planner') {
      file(value.path);
    } else if (state.job.role === 'executor') {
      if (!text(value.conclusion) || !Array.isArray(value.artifacts) || !value.artifacts.length) throw new Error('Delivery requires artifacts and a conclusion');
      file(value.readme);
      for (const artifact of value.artifacts) {
        if (!artifact || !strings(artifact.requirements) || !artifact.requirements.length) throw new Error('Artifacts require evidence IDs');
        file(artifact.path);
      }
    } else {
      if (!['accept', 'partial', 'rework', 'replan', 'blocked'].includes(value.decision as string) ||
          !strings(value.accepted) || !text(value.reason)) throw new Error('Review requires a decision, accepted IDs and a reason');
      file(value.report);
    }
  }

  private async installRole(state: ActiveRole, agent: Agent): Promise<void> {
    if (state.agent) throw new Error('Duplicate role Agent creation');
    state.agent = agent;
    agent.ctx.effect(() => agent.ctx.tools.presentAs('native'));
    agent.ctx.effect(() => agent.ctx.tools.guard(exec => this.guard(state, exec)));
    const visible = this.ctx.tools.schemas().map(tool => tool.name).filter(name => allowedTools.has(name));
    agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: visible }));
    state.bashDenial = await this.verifyBash(state, agent);
  }

  private async verifyBash(state: ActiveRole, agent: Agent): Promise<string> {
    const blocked = (detail: string) => `Bash blocked: ${detail} No shell command was executed.`;
    const shell = agent.ctx.get('shell');
    const sandbox = agent.ctx.get('sandbox');
    const policy = agent.ctx.get('sandboxPolicy');
    if (!(shell instanceof SandboxBashExecutor) || !sandbox || !policy) return blocked('a native sandbox bash executor and policy are required.');
    const resolved = policy.resolve({ session: agent.session });
    if (resolved.mode !== 'workspace-write') return blocked('native policy must be workspace-write.');
    state.sandbox = serviceIdentity(sandbox);
    state.shell = serviceIdentity(shell);
    return '';
  }

  private guard(state: ActiveRole, exec: Readonly<ToolExecution>): string | undefined {
    if (exec.agent?.id !== state.sessionId || exec.agent !== state.agent) return 'Research tool actor does not match its assigned Agent';
    if (this.closed || state.stopReason || state.controller.signal.aborted || Date.now() >= state.job.deadline) return 'Research role is no longer active';
    if (!allowedTools.has(exec.name)) return `Tool ${exec.name} is not permitted for a research role`;
    if (state.submitted && exec.name !== 'research_submit') return 'Research role already submitted';
    const args = exec.arguments as Record<string, unknown>;
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Tool arguments must be an object';
      if (exec.name === 'research_submit') return undefined;
      const current = state.agent!.ctx.get('workingDirectory')!.get(state.agent!.session);
      if (current !== state.cwd) return 'Research workspace changed after role binding';
      if (args.sandbox_permissions !== undefined) return 'Research roles cannot escalate sandbox permissions';
      if (exec.name === 'skill') return undefined;
      if (exec.name === 'bash') {
        if (state.bashDenial) return state.bashDenial;
        if (args.run_in_background === true) return 'Research roles cannot create unmanaged background jobs';
        const policy = state.agent!.ctx.get('sandboxPolicy')?.resolve({ session: state.agent!.session });
        if (serviceIdentity(state.agent!.ctx.get('shell')) !== state.shell || serviceIdentity(state.agent!.ctx.get('sandbox')) !== state.sandbox ||
            policy?.mode !== 'workspace-write' || canonical(policy.workspaceRoot) !== state.cwd) return 'Native sandbox changed after verification';
        const workdir = toolPath(args.workdir ?? state.cwd, state.cwd);
        if (!inside(workdir, state.cwd)) return 'Bash workdir must remain in this role workspace';
        return undefined;
      }
      const writing = exec.name === 'write' || exec.name === 'edit';
      const target = toolPath(exec.name === 'glob' || exec.name === 'grep' ? args.path ?? state.cwd : args.file_path, state.cwd);
      if (writing) {
        if (!inside(target, state.cwd) || state.readRoots.some(root => inside(target, root))) return 'Writes are confined to this role workspace; inputs are read-only';
        try {
          const entry = lstatSync(target);
          if (!entry.isFile()) return 'Writes require an ordinary workspace file';
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      } else if (![state.cwd, ...state.readRoots].some(root => inside(target, root))) return 'Reads are confined to this role workspace and declared inputs';
      return undefined;
    } catch (error) { return `Tool path or native sandbox could not be verified: ${(error as Error).message}`; }
  }
}
