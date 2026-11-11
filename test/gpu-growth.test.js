// The GPU-memory plateau rule (test/helpers/gpu-growth.js) on synthetic series,
// no GPU needed. The leak series and the old rule's rejection of the pool step
// are the controls: they show the rule can fail and why it was replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tailSlope, plateauProblem, oldRuleProblem } from './helpers/gpu-growth.js';

const series = (fn, frames = 6000, every = 250) =>
  Array.from({ length: frames / every }, (_, i) => ({ frame: (i + 1) * every, mib: fn((i + 1) * every) }));

const flat = series(f => 50 + (f % 500 === 0 ? 3 : 0));
const poolStep = series(f => (f < 3500 ? 100 : 170));   // a driver pool growing 70 MiB late
const leak = series(f => (f <= 3000 ? 100 : 100 + (f - 3000) * 1.3));

test('a flat series passes', () => {
  assert.equal(plateauProblem(flat), null);
  assert.ok(Math.abs(tailSlope(flat)) < 0.01);
});

test('a pool step of 70 MiB at frame 3500 passes (about 0.03 MiB per frame)', () => {
  assert.equal(plateauProblem(poolStep), null);
  assert.ok(tailSlope(poolStep) < 0.1);
});

test('a leak of 1.3 MiB per frame over the second half FAILS (control)', () => {
  assert.ok(tailSlope(leak) > 1, `slope ${tailSlope(leak)}`);
  assert.match(plateauProblem(leak), /still growing/);
});

test('the old rule rejects the pool-step series, which is why it was replaced (control)', () => {
  assert.ok(oldRuleProblem(poolStep), 'old rule fails a series that is not a leak');
  assert.equal(oldRuleProblem(flat), null);
  assert.ok(oldRuleProblem(leak), 'and still catches the leak');
});
