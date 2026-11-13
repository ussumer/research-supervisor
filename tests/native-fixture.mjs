import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionRegistry from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local';
import SandboxBash from '@deepseek-ai/dsh-bash-sandbox';
import LocalBash from '@deepseek-ai/dsh-bash-local';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search';
import * as BashTool from '@deepseek-ai/dsh-tool-bash';
import * as ShellEnv from '@deepseek-ai/dsh-shell-env';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as SkillTool from '@deepseek-ai/dsh-tool-skill';
import { NativeAgentRunner } from '../lib/agents.js';

export const textOf = message => message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
export const call = (tool, args) => ({ tool, args });
export const deferred = () => Promise.withResolvers();

class ScriptedProvider extends LlmAdapter {
  constructor(script, requests) {
    super();
    this.script = script;
    this.requests = requests;
    this.steps = new Map();
  }

  async *stream(options) {
    assert.equal(options.provider, 'local-scripted');
    options.signal?.throwIfAborted();
    const role = /^research-(planner|plan-reviewer|executor|reviewer)-/u.exec(options.sessionId)?.[1];
    assert.ok(role, 'only explicitly created research role sessions may call the fixture');
    const step = this.steps.get(options.sessionId) ?? 0;
    this.steps.set(options.sessionId, step + 1);
    const tools = options.messages.filter(message => message.role === 'tool');
    const request = { sessionId: options.sessionId, role, step, model: options.model,
      messages: options.messages, tools: options.tools, lastTool: tools.at(-1), toolResults: tools, signal: options.signal };
    this.requests.push(request);
    const action = await this.script(request);
    options.signal?.throwIfAborted();
    if (action?.text !== undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: action.text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: action.text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const actions = Array.isArray(action) ? action : [action];
    for (const [index, entry] of actions.entries()) {
      assert.equal(typeof entry?.tool, 'string', `script must choose a tool at ${role}/${step}`);
      const id = `${options.sessionId}-${step}-${index}`;
      const argumentsText = JSON.stringify(entry.args);
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id, name: entry.tool, argumentsDelta: argumentsText };
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: entry.tool, arguments: argumentsText } };
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

async function removeFixture(root) {
  async function writable(directory) {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(join(directory, entry.name));
    }
  }
  await writable(root);
  await rm(root, { recursive: true, force: true });
}

export async function nativeFixture({ script = () => ({ text: 'No submission' }), sandboxMode = 'workspace-write',
  nativeSandbox = true, runnerOptions = {}, parentOptions = {}, setup } = {}) {
  const root = await mkdtemp(fileURLToPath(new URL('../.native-test-', import.meta.url)));
  const paths = Object.fromEntries(['parent', 'inputs', 'planner', 'plan-reviewer', 'executor', 'reviewer', 'outside']
    .map(name => [name, join(root, name)]));
  await Promise.all(Object.values(paths).map(path => mkdir(path)));
  const ctx = new Context();
  const requests = [];
  const events = [];
  const results = [];
  const children = [];
  const errors = [];
  let parentHandle;
  let runnerFiber;
  try {
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionRegistry);
    await ctx.plugin(SessionProjections);
    await ctx.plugin(SessionQuery, { path: ':memory:', openAt: 'never' });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop);
    await ctx.plugin(WorkingDirectory, { defaultDirectory: paths.parent });
    await ctx.plugin(LocalFileSystem);
    await ctx.plugin(LocalSubprocess);
    await ctx.plugin(SandboxPolicy, { mode: sandboxMode, workspaceRoot: paths.parent });
    if (nativeSandbox) {
      await ctx.plugin(LocalSandbox);
      await ctx.plugin(SandboxBash);
    } else await ctx.plugin(LocalBash);
    await ctx.plugin(FileTools, { readImage: false });
    await ctx.plugin(SearchTools, { sampleOverCapGlobResults: false });
    await ctx.plugin(ShellEnv);
    await ctx.plugin(BashTool, { enableRunInBackground: false, promoteOnTimeout: false });
    await ctx.plugin(SkillRegistry);
    await ctx.plugin(SkillTool);
    ctx.llm.registerAdapter(['local-scripted'], new ScriptedProvider(script, requests));
    ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }));
    ctx.on('tools/result', (exec, result) => results.push({ sessionId: exec.agent?.id, name: exec.name, args: exec.arguments, ...result }));
    ctx.on('agent/error', payload => errors.push(payload.error));
    ctx.on('agent/created', ({ agent }) => { if (agent.id.startsWith('research-')) children.push(agent); });
    parentHandle = await ctx.agents.create({ sessionId: 'fixture-parent', meta: { cwd: paths.parent },
      agentOptions: { provider: 'local-scripted', model: 'scripted-fixture', ...parentOptions } });
    let runner;
    let runnerContext;
    runnerFiber = ctx.plugin({ name: 'native-research-fixture', inject: ['agents', 'tools', 'workingDirectory', 'sessionQuery'], apply(pluginCtx) {
      runnerContext = pluginCtx;
      runner = new NativeAgentRunner(pluginCtx, parentHandle.agent, runnerOptions);
    } });
    await runnerFiber;
    await setup?.({ ctx, paths, parent: parentHandle.agent, runner });
    return { ctx, root, paths, parent: parentHandle.agent, runner, runnerFiber, requests, events, results, children, errors,
      createRunner(parent = parentHandle.agent, options = {}) { return new NativeAgentRunner(runnerContext, parent, options); },
      job(role, overrides = {}) {
        return { id: `fixture-${role}`, role, cwd: paths[role], prompt: `Keyless engineering fixture for ${role}`,
          readRoots: [paths.inputs], deadline: Date.now() + 15_000, ...overrides };
      },
      async close() {
        try { await runnerFiber.dispose(); } finally {
          try { await parentHandle.dispose(); } finally {
            try { await ctx.fiber.dispose(); } finally { await removeFixture(root); }
          }
        }
      },
    };
  } catch (error) {
    try { await runnerFiber?.dispose(); await parentHandle?.dispose(); await ctx.fiber.dispose(); }
    finally { await removeFixture(root); }
    throw error;
  }
}

export function execute(ctx, agent, name, args = {}, extra = {}) {
  return ctx.tools.execute({ agent, name, arguments: args, callId: `manual-${name}-${crypto.randomUUID()}`,
    signal: new AbortController().signal, ...extra });
}

export function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
