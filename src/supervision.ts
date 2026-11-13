import { cp, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectStore, checkRegular, readRegular, sealDirectory, verifySnapshot, inside } from './records.js';
import { validatePlan, validateDelivery, validateReview } from './contracts.js';
import type { AgentRunner, Role, Request, Plan, Review, Delivery, AttemptRecord, Project, ProducerCheckpoint } from './contracts.js';
import { plannerPrompt, planReviewPrompt, executorPrompt, taskReviewPrompt } from './roles.js';

export function validateRequest(request: Request): void {
  if (!request || typeof request.goal !== 'string' || !request.goal.trim() ||
      !Array.isArray(request.sources) || !request.sources.length ||
      request.sources.some(path => typeof path !== 'string' || !isAbsolute(path)) ||
      !Number.isFinite(Date.parse(request.deadline)) || Date.parse(request.deadline) <= Date.now() ||
      !Number.isSafeInteger(request.maxReplans) || request.maxReplans < 0 || request.maxReplans > 10 ||
      (request.producerContext !== undefined && !['isolated', 'full'].includes(request.producerContext))) {
    throw new Error('Request requires goal, absolute source paths, a future deadline and bounded replans');
  }
}

export class ResearchSupervisor {
  private store: ProjectStore;
  private runner: AgentRunner;
  private root: string;
  private stopped = false;
  private running?: Promise<void>;
  private readonly sessions = new Map<string, { sessionId: string; directory: string }>();
  private producerCheckpoint?: ProducerCheckpoint;

  private constructor(root: string, store: ProjectStore, runner: AgentRunner) {
    this.root = root; this.store = store; this.runner = runner;
  }

  static async open(root: string, runner: AgentRunner, request?: Request): Promise<ResearchSupervisor> {
    root = resolve(root);
    if (request) {
      validateRequest(request);
      for (const source of request.sources) {
        const canonical = await realpath(source);
        const toState = relative(canonical, root);
        const toSource = relative(root, canonical);
        const contains = (path: string) => path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
        if (contains(toState) || contains(toSource)) throw new Error('Sources must not expose supervisor storage');
        const info = await stat(source);
        if (!info.isFile() && !info.isDirectory()) throw new Error('Source must be a file or directory');
      }
    }
    const store = await ProjectStore.open(root, request);
    try {
      await mkdir(join(root, 'work'), { recursive: true });
      await mkdir(join(root, 'snapshots'), { recursive: true });
      if (store.state.active) {
        const interrupted = store.state.attempts.find(attempt => attempt.id === store.state.active!.id);
        if (interrupted && !interrupted.review) interrupted.error = 'Interrupted by host restart';
        delete store.state.active;
        store.state.status = 'paused';
        store.state.reason = 'Interrupted role recovered; resume from the last settled state';
      }
      if (store.state.producerCheckpoint) {
        delete store.state.producerCheckpoint;
        store.state.reason += '; producer transcript unavailable after host restart; using file/README handoff';
      }
      await store.save();
      return new ResearchSupervisor(root, store, runner);
    } catch (error) { await store.close(); throw error; }
  }

  status(): Project { return structuredClone(this.store.state); }

  async reconcile(): Promise<void> {
    if (this.running) throw new Error('Pause research before reconciling');
    if (!this.producerCheckpoint) delete this.store.state.producerCheckpoint;
    if (this.store.state.active) {
      const attempt = this.store.state.attempts.find(item => item.id === this.store.state.active!.id);
      if (attempt && !attempt.review) attempt.error = 'Interrupted by host restart';
      delete this.store.state.active;
    }
    if (this.store.state.status === 'blocked' || this.store.state.status === 'paused') {
      this.store.state.status = 'paused';
      this.store.state.reason = 'Reconciled; ready to resume';
    }
    await this.store.save();
  }

  run(): Promise<void> {
    if (this.running) throw new Error('Research is already advancing');
    if (this.store.state.active) throw new Error('Reconcile the interrupted native role before running');
    if (this.store.state.status === 'completed') return Promise.resolve();
    if (this.store.state.status === 'blocked') throw new Error('Reconcile the blocked project before running');
    if (this.store.state.request.producerContext === 'full' && !this.producerCheckpoint &&
        this.store.state.producerCheckpoint) {
      throw new Error('Full producer context unavailable; reconcile before resuming');
    }
    this.stopped = false;
    this.running = this.advance().finally(async () => {
      try {
        if (this.store.state.status === 'paused') await this.runner.pause?.();
        else {
          await this.runner.cancel();
          if (this.store.state.status === 'completed' || this.store.state.status === 'budget-stop') await this.runner.dispose?.();
        }
      } finally {
        if (this.store.state.status !== 'paused') this.sessions.clear();
      }
    }).catch(async error => {
      if (!this.stopped) {
        if (this.store.state.status !== 'budget-stop') this.store.state.status = 'blocked';
        this.store.state.reason = error instanceof Error ? error.message : 'Research role failed';
        await this.store.save();
      }
      throw error;
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  async pause(reason: string): Promise<void> {
    this.stopped = true;
    this.store.state.status = 'paused';
    this.store.state.reason = reason;
    await (this.runner.pause?.() ?? this.runner.cancel());
    await this.running?.catch(() => undefined);
    await this.store.save();
  }

  async close(): Promise<void> {
    if (this.running) await this.pause('Plugin closed; no automatic restart');
    try { await this.runner.dispose?.(); } finally { await this.store.close(); }
  }

  private available(): boolean {
    if (this.stopped) return false;
    if (Date.now() >= Date.parse(this.store.state.request.deadline)) {
      this.store.state.status = 'budget-stop';
      this.store.state.reason = 'Fixed project deadline reached';
      return false;
    }
    return true;
  }

  private async role(role: Role, prompt: string, readRoots: string[], taskId?: string,
                     checkSubmission?: (value: unknown, directory: string) => Promise<void>) {
    if (!this.available()) throw new Error('Project paused or deadline reached');
    const id = `research-${role}-${randomUUID()}`;
    const key = `${role}:${taskId ?? ''}`;
    const task = taskId ? this.store.state.plan?.tasks.find(item => item.id === taskId) : undefined;
    const deadline = task?.timeoutMinutes ? Math.min(Date.parse(this.store.state.request.deadline), Date.now() + task.timeoutMinutes * 60_000) : Date.parse(this.store.state.request.deadline);
    let continuation = this.sessions.get(key);
    const keepAlive = role === 'planner' || role === 'executor';
    const fullContext = keepAlive && this.store.state.request.producerContext === 'full';
    if (fullContext && continuation && continuation.sessionId !== this.producerCheckpoint?.sessionId) {
      await this.closeRole(role, taskId);
      continuation = undefined;
    }
    if (fullContext) {
      for (const [otherKey, other] of this.sessions) {
        if (otherKey === key) continue;
        await this.runner.closeSession(other.sessionId);
        this.sessions.delete(otherKey);
      }
    }
    const directory = continuation?.directory ?? join(this.root, 'work', id);
    if (!continuation) {
      const previous = role === 'executor' && taskId ? this.store.state.attempts.findLast(item => item.taskId === taskId) : undefined;
      if (previous?.directory) await cp(previous.directory, directory, { recursive: true, force: false });
      else await mkdir(directory, { mode: 0o700 });
    }
    if (fullContext) {
      if (!this.producerCheckpoint && (this.store.state.plans.length || this.store.state.attempts.length)) {
        const handoff = this.store.state.attempts.map(item => item.directory);
        readRoots = [...readRoots, ...handoff];
        prompt += `\nProducer transcript unavailable after restart. Use explicit file/README handoff, not assumed full context: ${JSON.stringify(handoff)}`;
      }
      const feedback = [...this.store.state.plans, ...this.store.state.attempts]
        .filter(item => item.review)
        .map(item => 'taskId' in item
          ? { taskId: item.taskId, review: item.review, report: item.reviewReport }
          : { planVersion: item.plan.version, review: item.review, report: item.report });
      prompt += `\nCompleted review feedback (historical decisions, not permission to publish other evidence): ${JSON.stringify(feedback)}`;
      if (keepAlive) readRoots = [...readRoots, ...feedback.flatMap(item => item.report ? [item.report] : [])];
    }
    readRoots = [...new Set(readRoots)].filter(path => path !== directory && !path.startsWith(directory + '/'));
    this.store.state.active = { id, role, directory, ...(taskId ? { taskId } : {}) };
    if (role === 'executor' && taskId) {
      const task = this.store.state.plan!.tasks.find(item => item.id === taskId)!;
      this.store.state.attempts.push({ id, taskId, directory,
        inputEvidence: this.store.state.evidence.filter(item => task.consumes.includes(item.requirementId)).map(item => item.id),
        error: 'Execution has not yet settled' });
    }
    await this.store.save();
    let submission: unknown;
    try {
      const result = await this.runner.run({ id, role, cwd: directory, prompt,
        readRoots, deadline, taskId,
        keepAlive, sessionId: continuation?.sessionId,
        ...(fullContext ? { producerContext: { projectId: this.root, previous: this.producerCheckpoint } } : {}) }, async value => {
        if (submission !== undefined) throw new Error('Role already handed off a result');
        if (checkSubmission) await checkSubmission(value, directory);
        if (!this.available()) throw new Error('Project paused or deadline reached');
        submission = structuredClone(value);
      });
      if (fullContext) {
        if (!result.checkpoint) throw new Error('Full producer context did not return a checkpoint');
        this.producerCheckpoint = result.checkpoint;
        this.store.state.producerCheckpoint = { ...result.checkpoint };
      }
      if (keepAlive && result.reason === 'completed') this.sessions.set(key, { sessionId: result.sessionId, directory });
      else this.sessions.delete(key);
      this.available();
      return { ...result, directory, id, submission };
    } finally {
      delete this.store.state.active;
      await this.store.save();
    }
  }

  private async closeRole(role: Role, taskId?: string): Promise<void> {
    const key = `${role}:${taskId ?? ''}`;
    const retained = this.sessions.get(key);
    if (!retained) return;
    await this.runner.closeSession(retained.sessionId);
    this.sessions.delete(key);
  }

  private checkPlan(plan: unknown, previous?: Plan): asserts plan is Plan {
    validatePlan(plan, previous);
    for (const task of previous?.tasks ?? []) {
      if (this.store.state.attempts.some(attempt => attempt.taskId === task.id) &&
          JSON.stringify(plan.tasks.find(item => item.id === task.id)) !== JSON.stringify(task)) {
        throw new Error('Replan cannot change tasks with recorded attempts; append a replacement task');
      }
    }
  }

  private async preparePlan(previous?: Plan, feedback?: Review, report?: string): Promise<boolean> {
    const state = this.store.state;
    while (this.available()) {
      state.status = 'planning';
      const availableEvidence = state.evidence.map(item => ({ ...item,
        directory: join(this.root, 'snapshots', item.attemptId) }));
      const planning = await this.role('planner', plannerPrompt(state.request, previous, feedback, report) +
        `\nAccepted evidence index; inspect these actual files before proposing duplicate work: ${JSON.stringify(availableEvidence)}`,
        [...state.request.sources, ...availableEvidence.map(item => item.directory), ...(report ? [report] : [])],
        undefined, async (value, directory) => {
          const path = (value as { path?: string })?.path;
          if (typeof path !== 'string') throw new Error('Planner must submit its plan file path');
          this.checkPlan(JSON.parse(await readRegular(directory, path)), previous);
          await readRegular(directory, 'README.md');
        });
      if (!this.available()) return false;
      if (planning.reason !== 'completed' || !planning.submission) throw new Error('Planner did not complete a native handoff');
      const planPath = (planning.submission as { path?: string }).path;
      if (typeof planPath !== 'string') throw new Error('Planner must submit its plan file path');
      const plan = JSON.parse(await readRegular(planning.directory, planPath));
      this.checkPlan(plan, previous);
      await readRegular(planning.directory, 'README.md');
      const snapshot = join(this.root, 'snapshots', planning.id);
      const files = await sealDirectory(planning.directory, snapshot);
      const reviewed = await this.role('plan-reviewer', planReviewPrompt(state.request, join(snapshot, planPath), previous),
        [...state.request.sources, snapshot], undefined, async (value, directory) => {
          validateReview(value, plan.evidence.map(item => item.id), true);
          await readRegular(directory, value.report);
        });
      if (!this.available()) return false;
      if (reviewed.reason !== 'completed') throw new Error('Plan reviewer did not finish');
      const review = reviewed.submission;
      validateReview(review, plan.evidence.map(item => item.id), true);
      await readRegular(reviewed.directory, review.report);
      await verifySnapshot(snapshot, files);
      const reportPath = join(reviewed.directory, review.report);
      state.plans.push({ plan, sessionId: planning.sessionId, review,
        reviewSessionId: reviewed.sessionId, report: reportPath });
      await this.store.save();
      if (review.decision === 'accept') {
        state.plan = plan; state.status = 'active'; state.reason = 'Independent native plan review accepted';
        await this.store.save();
        await this.closeRole('planner');
        return true;
      }
      if (review.decision === 'blocked' || state.replans >= state.request.maxReplans) {
        state.status = 'blocked'; state.reason = review.reason;
        await this.store.save();
        return false;
      }
      state.replans++;
      feedback = review; report = reportPath;
    }
    return false;
  }

  private async advance(): Promise<void> {
    const state = this.store.state;
    if (!state.plan && !await this.preparePlan()) return;
    state.status = 'active';
    while (this.available()) {
      const plan = state.plan!;
      const supported = new Set(state.evidence.map(item => item.requirementId));
      const required = plan.claims.filter(claim => claim.required).flatMap(claim => claim.requires);
      if (required.every(id => supported.has(id))) {
        for (const attempt of state.attempts.filter(item => item.files)) {
          await verifySnapshot(join(this.root, 'snapshots', attempt.id), attempt.files!);
        }
        state.status = 'completed'; state.reason = 'Required claims supported by independently reviewed evidence';
        break;
      }
      let attempt = state.attempts.find(item => !item.review);
      const task = attempt ? plan.tasks.find(item => item.id === attempt!.taskId) : plan.tasks.find(item => {
        const attempts = state.attempts.filter(candidate => candidate.taskId === item.id);
        const lastDecision = attempts.at(-1)?.review?.decision;
        return !item.produces.every(id => supported.has(id)) &&
          item.consumes.every(id => supported.has(id)) && attempts.length < item.maxAttempts &&
          lastDecision !== 'replan';
      });
      if (!task) {
        state.status = 'blocked'; state.reason = 'No ready bounded task; unresolved evidence remains';
        break;
      }
      const inputs = state.evidence.filter(item => attempt ? attempt.inputEvidence.includes(item.id) : task.consumes.includes(item.requirementId));
      for (const input of inputs) await verifySnapshot(join(this.root, 'snapshots', input.attemptId), input.files);
      const history = state.attempts.filter(item => item.taskId === task.id && item.id !== attempt?.id)
        .map(item => ({ ...item, directory: item.files ? join(this.root, 'snapshots', item.id) : item.directory }));
      const inputsWithPaths = inputs.map(item => ({ ...item, directory: join(this.root, 'snapshots', item.attemptId) }));
      const readRoots = [...state.request.sources, ...inputsWithPaths.map(item => item.directory),
        ...history.flatMap(item => [item.directory, ...(item.reviewReport ? [item.reviewReport] : [])])];
      if (!attempt) {
        const executed = await this.role('executor', executorPrompt(state.request, plan, task, inputsWithPaths, history), readRoots, task.id,
          async (value, directory) => {
            validateDelivery(value, task);
            await readRegular(directory, value.readme);
            for (const artifact of value.artifacts) await checkRegular(directory, artifact.path);
          });
        attempt = state.attempts.find(item => item.id === executed.id)!;
        attempt.sessionId = executed.sessionId;
        try {
          if (executed.reason !== 'completed') throw new Error(`Executor ended: ${executed.reason}`);
          validateDelivery(executed.submission, task);
          attempt.delivery = executed.submission;
          await readRegular(executed.directory, attempt.delivery.readme);
          attempt.files = await sealDirectory(executed.directory, join(this.root, 'snapshots', attempt.id));
          if (attempt.delivery.artifacts.some(item => !attempt!.files!.some(file => file.path === item.path))) throw new Error('Declared artifact missing');
          delete attempt.error;
        } catch (error) {
          attempt.error = error instanceof Error ? error.message : 'Delivery check failed';
        }
        await this.store.save();
      }
      if (!this.available()) break;
      const snapshot = join(this.root, 'snapshots', attempt.id);
      const reviewRoot = attempt.files ? snapshot : attempt.directory;
      const reviewed = await this.role('reviewer', taskReviewPrompt(state.request, plan, task,
        attempt.delivery ?? { readme: 'README.md', artifacts: [], conclusion: 'No complete handoff' }, reviewRoot,
        { integrity: attempt.error ?? 'snapshot verified', files: attempt.files ?? [], sessionId: attempt.sessionId }, history),
        [...readRoots, reviewRoot], task.id, async (value, directory) => {
          validateReview(value, task.produces);
          await readRegular(directory, value.report);
          if (value.accepted.length && (attempt!.error || !attempt!.delivery || !attempt!.files)) {
            throw new Error('Quality approval cannot bypass missing/changed delivery; report rework or a genuine blocker');
          }
          for (const requirementId of value.accepted) {
            if (!attempt!.delivery!.artifacts.some(item => item.requirements.includes(requirementId))) {
              throw new Error(`Approved evidence ${requirementId} has no explicit artifact mapping; inspect the delivery and revise the decision`);
            }
          }
        });
      if (!this.available()) break;
      if (reviewed.reason !== 'completed') throw new Error('Independent task reviewer did not finish');
      const review = reviewed.submission;
      validateReview(review, task.produces);
      await readRegular(reviewed.directory, review.report);
      attempt.review = review; attempt.reviewSessionId = reviewed.sessionId;
      attempt.reviewReport = inside(reviewed.directory, review.report);
      const publications: Project['evidence'] = [];
      try {
        if (attempt.files) await verifySnapshot(snapshot, attempt.files);
        for (const input of inputs) await verifySnapshot(join(this.root, 'snapshots', input.attemptId), input.files);
        if (review.accepted.length) {
          if (attempt.error || !attempt.delivery || !attempt.files) throw new Error('Quality approval cannot bypass missing/changed delivery');
          for (const requirementId of review.accepted) {
            const paths = attempt.delivery.artifacts.filter(item => item.requirements.includes(requirementId)).map(item => item.path);
            const files = attempt.files.filter(file => paths.includes(file.path));
            if (!files.length) throw new Error('Approved evidence has no explicit artifact mapping');
            if (!state.evidence.some(item => item.requirementId === requirementId)) {
              publications.push({ id: `${attempt.id}:${requirementId}`, requirementId, attemptId: attempt.id, files });
            }
          }
        }
      } catch (error) {
        attempt.publicationError = error instanceof Error ? error.message : 'Publication check failed';
        throw error;
      }
      state.evidence.push(...publications);
      state.reason = review.reason;
      await this.store.save();
      if (['accept', 'blocked', 'replan'].includes(review.decision) ||
          state.attempts.filter(item => item.taskId === task.id).length >= task.maxAttempts) {
        await this.closeRole('executor', task.id);
      }
      if (review.decision === 'blocked') { state.status = 'blocked'; break; }
      if (review.decision === 'replan') {
        if (state.replans >= state.request.maxReplans) { state.status = 'blocked'; break; }
        state.replans++;
        if (!await this.preparePlan(plan, review, attempt.reviewReport)) break;
      }
    }
    await this.store.save();
  }
}
