export type Role = 'planner' | 'plan-reviewer' | 'executor' | 'reviewer';

export interface Claim {
  id: string;
  statement: string;
  source: { document: string; locator: string };
  required: boolean;
  requires: string[];
}

export interface EvidenceRequirement {
  id: string;
  claimId: string;
  description: string;
  scope: string;
}

export interface Task {
  id: string;
  title: string;
  objective: string;
  produces: string[];
  consumes: string[];
  dependsOn: string[];
  maxAttempts: number;
  timeoutMinutes?: number;
}

export interface Plan {
  version: number;
  claims: Claim[];
  evidence: EvidenceRequirement[];
  tasks: Task[];
}

export interface Delivery {
  readme: string;
  artifacts: { path: string; requirements: string[] }[];
  conclusion: string;
}

export interface Review {
  decision: 'accept' | 'partial' | 'rework' | 'replan' | 'blocked';
  accepted: string[];
  report: string;
  reason: string;
}

export interface Request {
  goal: string;
  sources: string[];
  deadline: string;
  maxReplans: number;
  producerContext?: ProducerContextMode;
}

export type ProducerContextMode = 'isolated' | 'full';

export interface ProducerCheckpoint {
  sessionId: string;
  boundary: number;
  generation: number;
  contextLoss?: string;
}

export interface RoleJob {
  id: string;
  role: Role;
  cwd: string;
  prompt: string;
  deadline: number;
  readRoots: string[];
  taskId?: string;
  sessionId?: string;
  keepAlive?: boolean;
  producerContext?: { projectId: string; previous?: ProducerCheckpoint };
}

export interface RoleResult {
  sessionId: string;
  reason: 'completed' | 'cancelled' | 'error' | 'timeout';
  checkpoint?: ProducerCheckpoint;
}

export interface AgentRunner {
  run(job: RoleJob, onSubmission: (value: unknown) => void | Promise<void>): Promise<RoleResult>;
  closeSession(sessionId: string): Promise<void>;
  cancel(): Promise<void>;
  pause?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface SealedFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface AttemptRecord {
  id: string;
  taskId: string;
  sessionId?: string;
  directory: string;
  inputEvidence: string[];
  delivery?: Delivery;
  files?: SealedFile[];
  review?: Review;
  reviewSessionId?: string;
  reviewReport?: string;
  publicationError?: string;
  error?: string;
}

export interface Project {
  revision: number;
  request: Request;
  status: 'planning' | 'active' | 'paused' | 'blocked' | 'completed' | 'budget-stop';
  plan?: Plan;
  plans: { plan: Plan; sessionId: string; review: Review; reviewSessionId: string; report: string }[];
  attempts: AttemptRecord[];
  evidence: { id: string; requirementId: string; attemptId: string; files: SealedFile[] }[];
  active?: { id: string; role: Role; directory: string; taskId?: string };
  replans: number;
  reason: string;
  producerCheckpoint?: ProducerCheckpoint;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function list(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
}

export function validatePlan(value: unknown, previous?: Plan): asserts value is Plan {
  const plan = value as Plan;
  if (!plan || !Number.isSafeInteger(plan.version) || plan.version < 1 ||
      !Array.isArray(plan.claims) || !plan.claims.length ||
      !Array.isArray(plan.evidence) || !plan.evidence.length ||
      !Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error('Plan requires claims, evidence and tasks');
  const ids = new Set<string>();
  for (const item of [...plan.claims, ...plan.evidence, ...plan.tasks]) {
    if (!item || !text(item.id) || ids.has(item.id)) throw new Error('Node IDs must be unique');
    ids.add(item.id);
  }
  const claims = new Map(plan.claims.map(claim => [claim.id, claim]));
  const evidence = new Map(plan.evidence.map(item => [item.id, item]));
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  if (!plan.claims.some(claim => claim.required === true)) throw new Error('At least one claim must be required');
  for (const claim of plan.claims) {
    if (!text(claim.statement) || typeof claim.required !== 'boolean' || !text(claim.source?.document) ||
        !text(claim.source?.locator) || !list(claim.requires) || !claim.requires.length ||
        claim.requires.some(id => evidence.get(id)?.claimId !== claim.id)) throw new Error(`Invalid claim ${claim.id}: require statement, source document/locator, boolean required and at least one evidence ID belonging to this claim; put unsupported investigation notes in README rather than evidence-free claims`);
  }
  for (const item of plan.evidence) {
    if (!text(item.description) || !text(item.scope) || !claims.get(item.claimId)?.requires.includes(item.id) ||
        !plan.tasks.some(task => task.produces?.includes(item.id))) throw new Error('Evidence must belong to a claim and have a producer');
  }
  for (const task of plan.tasks) {
    if (!text(task.title) || !text(task.objective) || !list(task.produces) || !task.produces.length ||
        !list(task.consumes) || !list(task.dependsOn) || !Number.isSafeInteger(task.maxAttempts) || task.maxAttempts < 1 ||
        [...task.produces, ...task.consumes].some(id => !evidence.has(id)) ||
        task.dependsOn.some(id => id === task.id || !tasks.has(id)) ||
        (task.timeoutMinutes !== undefined && (!Number.isFinite(task.timeoutMinutes) || task.timeoutMinutes <= 0))) throw new Error('Invalid task contract');
    if (task.consumes.some(id => !task.dependsOn.some(parent => tasks.get(parent)!.produces.includes(id))) ||
        task.dependsOn.some(parent => !tasks.get(parent)!.produces.some(id => task.consumes.includes(id)))) {
      throw new Error('Every dependency must name consumed evidence');
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error('Execution dependencies contain a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of tasks.get(id)!.dependsOn) visit(parent);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of plan.tasks) visit(task.id);
  if (previous && (plan.version <= previous.version ||
      JSON.stringify(plan.claims) !== JSON.stringify(previous.claims) ||
      JSON.stringify(plan.evidence) !== JSON.stringify(previous.evidence))) {
    throw new Error('Replanning must preserve approved claims and evidence criteria');
  }
}

export function validateDelivery(value: unknown, task: Task): asserts value is Delivery {
  const delivery = value as Delivery;
  if (!delivery || !text(delivery.readme) || !text(delivery.conclusion) ||
      !Array.isArray(delivery.artifacts) || !delivery.artifacts.length ||
      delivery.artifacts.some(item => !text(item.path) || !list(item.requirements) || !item.requirements.length ||
        item.requirements.some(id => !task.produces.includes(id)))) throw new Error('Delivery requires README and explicit evidence mapping');
}

export function validateReview(value: unknown, expected: string[], planning = false): asserts value is Review {
  const review = value as Review;
  if (!review || !['accept', 'partial', 'rework', 'replan', 'blocked'].includes(review.decision) ||
      !text(review.report) || !text(review.reason) || !list(review.accepted)) throw new Error('Invalid review decision');
  const outside = review.accepted.filter(id => !expected.includes(id));
  if (outside.length) throw new Error(`Invalid review scope: allowed evidence IDs ${JSON.stringify(expected)}; outside this review ${JSON.stringify(outside)}. Reassess the decision and report; do not publish other tasks' evidence.`);
  if (review.decision === 'accept' && (review.accepted.length !== expected.length)) throw new Error('Acceptance must cover the task scope');
  if (review.decision === 'partial' && (planning || !review.accepted.length || review.accepted.length === expected.length)) {
    throw new Error('Partial acceptance requires a proper task subset');
  }
  if (!['accept', 'partial'].includes(review.decision) && review.accepted.length) throw new Error('Rejected work publishes no evidence');
}
