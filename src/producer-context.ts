import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { buildForkSeed, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-query';
import type { ProducerCheckpoint, RoleJob } from './contracts.js';

export class ProducerContext {
  private projectId?: string;
  private head?: ProducerCheckpoint;
  private events: readonly SessionEvent[] = [];
  private busy = false;
  private readonly directories = new Set<string>();
  private problem?: string;
  private readonly ctx: Context;

  constructor(ctx: Context) { this.ctx = ctx; }

  begin(job: RoleJob) {
    const context = job.producerContext!;
    if (job.role !== 'planner' && job.role !== 'executor') throw new Error('Reviewers cannot inherit producer context');
    if (!context.projectId || (this.projectId && this.projectId !== context.projectId)) throw new Error('Producer context belongs to another project');
    if (this.busy) throw new Error('A producer context advance is already running');
    if (context.previous !== this.head || (job.sessionId && job.sessionId !== this.head?.sessionId)) {
      throw new Error('Producer continuation requires the current owned checkpoint');
    }
    let seed: ReturnType<typeof buildForkSeed> | undefined;
    if (this.head && !this.problem && !job.sessionId) {
      try { seed = buildForkSeed(this.events, SessionSeq(this.head.boundary)); }
      catch (error) {
        this.ctx.logger('research-supervisor').error(error);
        this.problem = `Producer fork failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.projectId = context.projectId;
    this.busy = true;
    return { seed, inheritedEventCount: seed ? SessionLogOffset(this.head!.boundary + 1) : undefined,
      sourceSessionId: seed ? this.head!.sessionId as SessionId : undefined,
      contextLoss: this.problem, readRoots: [...this.directories].filter(directory => directory !== job.cwd) };
  }

  observe(event: SessionEvent): void {
    if (event.type.startsWith('compaction/') || (typeof event.surfaceOp === 'object' && event.surfaceOp?.op === 'replace')) {
      this.problem = 'Producer history was compacted or replaced';
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'error' &&
        event.data.reason.error.code === 'CONTEXT_WINDOW_EXCEEDED') {
      this.problem = 'Producer history exceeded the model context window';
    }
  }

  async capture(agent: Agent, cwd: string): Promise<ProducerCheckpoint> {
    let boundary = -1;
    try {
      const query = this.ctx.get('sessionQuery');
      if (!query) throw new Error('Native sessionQuery is unavailable');
      const observation = await query.observeSession(agent.id, { projectionMode: 'none' });
      try {
        this.events = structuredClone(observation.events);
        for (const event of this.events) this.observe(event);
        boundary = observation.cursor;
        if (observation.header.id !== agent.id || boundary < 0 || this.events.length !== boundary + 1 ||
            this.events.some((event, index) => event.seq !== index)) {
          this.problem ??= 'Producer history is incomplete or non-contiguous';
        }
      } finally { observation[Symbol.dispose](); }
    } catch (error) {
      this.ctx.logger('research-supervisor').error(error);
      this.events = [];
      this.problem = `Producer history capture failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (this.problem) this.ctx.logger('research-supervisor').warn(`${this.problem}; next producer uses explicit file/README handoff, not full transcript`);
    this.head = Object.freeze({ sessionId: agent.id, boundary, generation: (this.head?.generation ?? 0) + 1,
      ...(this.problem ? { contextLoss: this.problem } : {}) });
    this.directories.add(cwd);
    return this.head;
  }

  end(): void { this.busy = false; }

  clear(): void {
    this.events = [];
    this.head = undefined;
    this.directories.clear();
    this.problem = undefined;
  }
}
