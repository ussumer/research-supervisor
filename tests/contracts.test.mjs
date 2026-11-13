import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDelivery, validatePlan, validateReview } from '../lib/contracts.js';

function planFixture() {
  return {
    version: 1,
    claims: [
      {
        id: 'C-result', statement: 'Reproduce the documented result',
        source: { document: 'paper.md', locator: 'Figure 4' },
        required: true, requires: ['E-input', 'E-result'],
      },
      {
        id: 'C-audit', statement: 'Record the numerical uncertainty',
        source: { document: 'paper.md', locator: 'Section 3' },
        required: false, requires: ['E-audit'],
      },
    ],
    evidence: [
      { id: 'E-input', claimId: 'C-result', description: 'Source-grounded inputs', scope: 'Figure 4 parameters' },
      { id: 'E-result', claimId: 'C-result', description: 'Reproduced curve', scope: 'Figure 4 within its stated tolerance' },
      { id: 'E-audit', claimId: 'C-audit', description: 'Convergence table', scope: 'Three resolutions' },
    ],
    tasks: [
      {
        id: 'T-input', title: 'Prepare inputs', objective: 'Trace the source parameters',
        produces: ['E-input'], consumes: [], dependsOn: [], maxAttempts: 2,
      },
      {
        id: 'T-result', title: 'Reproduce result', objective: 'Compute and check the curve',
        produces: ['E-result', 'E-audit'], consumes: ['E-input'], dependsOn: ['T-input'], maxAttempts: 3,
      },
    ],
  };
}

function deliveryFixture() {
  return {
    readme: 'README.md',
    artifacts: [
      { path: 'results/curve.csv', requirements: ['E-result'] },
      { path: 'results/convergence.csv', requirements: ['E-audit'] },
    ],
    conclusion: 'The supplied files support the listed requirements, subject to independent review.',
  };
}

function reviewFixture(decision = 'accept', accepted = ['E-result', 'E-audit']) {
  return { decision, accepted, report: 'review.md', reason: 'Checked the submitted files against the task scope.' };
}

const scope = ['E-result', 'E-audit'];

test('plan accepts a connected DAG without mutating the contract', () => {
  const plan = planFixture();
  const original = structuredClone(plan);
  assert.doesNotThrow(() => validatePlan(plan));
  assert.deepEqual(plan, original);
  plan.tasks.reverse();
  assert.doesNotThrow(() => validatePlan(plan));
});

for (const [name, mutate] of [
  ['missing claims', plan => { plan.claims = []; }],
  ['missing evidence', plan => { plan.evidence = []; }],
  ['missing tasks', plan => { plan.tasks = []; }],
  ['no required claim', plan => { plan.claims[0].required = false; }],
  ['nonboolean required flag', plan => { plan.claims[1].required = 'true'; }],
  ['blank statement', plan => { plan.claims[0].statement = '  '; }],
  ['missing source document', plan => { delete plan.claims[0].source.document; }],
  ['missing source locator', plan => { delete plan.claims[0].source.locator; }],
  ['blank node ID', plan => { plan.tasks[0].id = ' '; }],
  ['duplicate claim IDs', plan => { plan.claims[1].id = plan.claims[0].id; }],
  ['IDs shared across node types', plan => { plan.tasks[0].id = plan.evidence[0].id; }],
  ['unknown claim requirement', plan => { plan.claims[0].requires.push('E-missing'); }],
  ['duplicate claim requirement', plan => { plan.claims[0].requires.push('E-input'); }],
  ['claim without evidence', plan => { plan.claims[0].requires = []; }],
  ['requirement belonging to another claim', plan => { plan.claims[0].requires.push('E-audit'); }],
  ['evidence with unknown claim', plan => { plan.evidence[0].claimId = 'C-missing'; }],
  ['evidence not listed by its claim', plan => { plan.claims[0].requires = ['E-result']; }],
  ['evidence without producer', plan => { plan.tasks[1].produces = ['E-result']; }],
  ['blank evidence description', plan => { plan.evidence[0].description = ''; }],
  ['blank evidence scope', plan => { plan.evidence[0].scope = '\t'; }],
  ['task without title', plan => { plan.tasks[0].title = ''; }],
  ['task without objective', plan => { plan.tasks[0].objective = ''; }],
  ['task without outputs', plan => { plan.tasks[0].produces = []; }],
  ['unknown produced evidence', plan => { plan.tasks[0].produces.push('E-missing'); }],
  ['unknown consumed evidence', plan => { plan.tasks[1].consumes.push('E-missing'); }],
  ['duplicate produced evidence', plan => { plan.tasks[0].produces.push('E-input'); }],
  ['duplicate consumed evidence', plan => { plan.tasks[1].consumes.push('E-input'); }],
  ['duplicate dependency', plan => { plan.tasks[1].dependsOn.push('T-input'); }],
  ['unknown dependency', plan => { plan.tasks[1].dependsOn.push('T-missing'); }],
  ['self-dependency', plan => { plan.tasks[0].dependsOn = ['T-input']; plan.tasks[0].consumes = ['E-input']; }],
  ['consumption without dependency', plan => { plan.tasks[1].dependsOn = []; }],
  ['dependency without consumed evidence', plan => { plan.tasks[1].consumes = []; }],
  ['consumption not produced by the parent', plan => { plan.tasks[1].consumes = ['E-audit']; }],
]) {
  test(`plan rejects ${name}`, () => {
    const plan = planFixture();
    mutate(plan);
    assert.throws(() => validatePlan(plan));
  });
}

for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1']) {
  test(`plan rejects invalid version and attempt budget ${String(invalid)}`, () => {
    const plan = planFixture();
    plan.version = invalid;
    assert.throws(() => validatePlan(plan));
    plan.version = 1;
    plan.tasks[0].maxAttempts = invalid;
    assert.throws(() => validatePlan(plan));
  });
}

for (const invalid of [undefined, null, [], {}, 'not a plan']) {
  test(`plan rejects malformed top-level input ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => validatePlan(invalid));
  });
}

test('plan rejects a cycle even when every edge names real consumed evidence', () => {
  const plan = planFixture();
  plan.tasks[0].dependsOn = ['T-result'];
  plan.tasks[0].consumes = ['E-result'];
  assert.throws(() => validatePlan(plan), /cycle/i);
});

test('replanning permits changed execution tasks but preserves approved goals', () => {
  const previous = planFixture();
  const original = structuredClone(previous);
  const revised = structuredClone(previous);
  revised.version += 1;
  revised.tasks[1].objective = 'Use a revised implementation to meet the same evidence criteria';
  revised.tasks[1].maxAttempts += 1;
  assert.doesNotThrow(() => validatePlan(revised, previous));
  assert.deepEqual(previous, original);
});

for (const [name, mutate] of [
  ['unchanged version', revised => { revised.version = 1; }],
  ['changed claim statement', revised => { revised.claims[0].statement = 'Only demonstrate a plausible curve'; }],
  ['changed source document', revised => { revised.claims[0].source.document = 'different-paper.md'; }],
  ['changed source locator', revised => { revised.claims[0].source.locator = 'Figure 1'; }],
  ['downgraded required claim', revised => { revised.claims[0].required = false; revised.claims[1].required = true; }],
  ['changed evidence description', revised => { revised.evidence[1].description = 'A qualitative plot'; }],
  ['relaxed evidence scope', revised => { revised.evidence[1].scope = 'Any broadly similar curve'; }],
  ['removed optional goal', revised => {
    revised.claims.pop();
    revised.evidence.pop();
    revised.tasks[1].produces = ['E-result'];
  }],
]) {
  test(`replanning rejects ${name} rather than silently changing goals`, () => {
    const previous = planFixture();
    const revised = structuredClone(previous);
    revised.version += 1;
    mutate(revised);
    assert.throws(() => validatePlan(revised, previous), /preserve approved/i);
  });
}

test('delivery accepts explicit many-to-many artifact mappings', () => {
  const delivery = deliveryFixture();
  delivery.artifacts.push({ path: 'results/summary.json', requirements: ['E-result', 'E-audit'] });
  const original = structuredClone(delivery);
  assert.doesNotThrow(() => validateDelivery(delivery, planFixture().tasks[1]));
  assert.deepEqual(delivery, original);
});

test('delivery can submit a subset without claiming the task is accepted', () => {
  const delivery = deliveryFixture();
  delivery.artifacts.pop();
  assert.doesNotThrow(() => validateDelivery(delivery, planFixture().tasks[1]));
});

for (const [name, mutate] of [
  ['missing README', delivery => { delete delivery.readme; }],
  ['blank conclusion', delivery => { delivery.conclusion = ' '; }],
  ['no artifacts', delivery => { delivery.artifacts = []; }],
  ['missing artifact path', delivery => { delete delivery.artifacts[0].path; }],
  ['filename instead of explicit mapping', delivery => { delivery.artifacts[0] = { path: 'E-result' }; }],
  ['empty mapping', delivery => { delivery.artifacts[0].requirements = []; }],
  ['duplicate mapping', delivery => { delivery.artifacts[0].requirements = ['E-result', 'E-result']; }],
  ['unknown evidence mapping', delivery => { delivery.artifacts[0].requirements = ['E-missing']; }],
  ['claim ID instead of evidence ID', delivery => { delivery.artifacts[0].requirements = ['C-result']; }],
  ['consumed evidence instead of task output', delivery => { delivery.artifacts[0].requirements = ['E-input']; }],
  ['null artifact', delivery => { delivery.artifacts[0] = null; }],
]) {
  test(`delivery rejects ${name}`, () => {
    const delivery = deliveryFixture();
    mutate(delivery);
    assert.throws(() => validateDelivery(delivery, planFixture().tasks[1]));
  });
}

test('review accepts exactly its declared scope regardless of order', () => {
  const review = reviewFixture('accept', [...scope].reverse());
  const original = structuredClone(review);
  assert.doesNotThrow(() => validateReview(review, scope));
  assert.deepEqual(review, original);
});

test('review permits a proper task subset, but never partial plan approval', () => {
  const review = reviewFixture('partial', ['E-result']);
  assert.doesNotThrow(() => validateReview(review, scope));
  assert.throws(() => validateReview(review, scope, true), /partial/i);
  assert.doesNotThrow(() => validateReview(reviewFixture('accept', ['C-result', 'C-audit']), ['C-result', 'C-audit'], true));
});

for (const [name, review] of [
  ['acceptance missing one output', reviewFixture('accept', ['E-result'])],
  ['empty acceptance', reviewFixture('accept', [])],
  ['empty partial acceptance', reviewFixture('partial', [])],
  ['full scope disguised as partial', reviewFixture('partial', scope)],
  ['out-of-scope evidence', reviewFixture('partial', ['E-input'])],
  ['duplicate accepted IDs', reviewFixture('accept', ['E-result', 'E-result'])],
  ['unknown decision', reviewFixture('approve', scope)],
  ['blank report', { ...reviewFixture(), report: '' }],
  ['blank reason', { ...reviewFixture(), reason: '\n' }],
  ['non-list accepted IDs', { ...reviewFixture(), accepted: 'E-result' }],
]) {
  test(`review rejects ${name}`, () => {
    assert.throws(() => validateReview(review, scope));
  });
}

for (const decision of ['rework', 'replan', 'blocked']) {
  test(`${decision} records the decision without publishing accepted evidence`, () => {
    assert.doesNotThrow(() => validateReview(reviewFixture(decision, []), scope));
    assert.throws(() => validateReview(reviewFixture(decision, ['E-result']), scope), /publishes no evidence/i);
  });
}
