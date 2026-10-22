import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineTime, trimKeyValue, trimSelection } from '../../src/shared/timeline.ts';

test('timeline maps full and zoomed viewports to integer microseconds without 32-bit truncation', () => {
  assert.equal(timelineTime(150, 100, 200, 0, 12000000), 3000000);
  assert.equal(timelineTime(150, 100, 200, 6000000, 10000000), 7000000);
  assert.equal(timelineTime(-10, 100, 200, 6000000, 10000000), 6000000);
  assert.equal(timelineTime(900, 100, 200, 6000000, 10000000), 10000000);
  assert.equal(timelineTime(200, 100, 200, 0, 1000000000000), 500000000000);
  assert.throws(() => timelineTime(0, 0, 0, 0, 10));
});
test('trim edges clamp to source and cannot cross, retaining at least interaction precision', () => {
  const initial = { startUs: 2000000, endUs: 8000000 };
  assert.deepEqual(trimSelection(initial, 'start', -1000000, 12000000), { startUs: 0, endUs: 8000000 });
  assert.deepEqual(trimSelection(initial, 'start', 9000000, 12000000), { startUs: 7999000, endUs: 8000000 });
  assert.deepEqual(trimSelection(initial, 'end', 1000000, 12000000), { startUs: 2000000, endUs: 2001000 });
  assert.deepEqual(trimSelection(initial, 'end', 19000000, 12000000), { startUs: 2000000, endUs: 12000000 });
  assert.deepEqual(initial, { startUs: 2000000, endUs: 8000000 });
  assert.deepEqual(trimSelection({ startUs: 0, endUs: 80 }, 'start', 50, 80), { startUs: 0, endUs: 80 });
  assert.throws(() => trimSelection(initial, 'end', NaN, 12000000));
});
test('trim and independent playhead support keyboard nudging, endpoints and coarse steps', () => {
  assert.equal(trimKeyValue('ArrowRight', 1000, 0, 20000), 2000);
  assert.equal(trimKeyValue('ArrowRight', 1000, 0, 20000, true), 11000);
  assert.equal(trimKeyValue('ArrowLeft', 500, 0, 20000), 0);
  assert.equal(trimKeyValue('End', 1000, 0, 20000), 20000);
  assert.equal(trimKeyValue('Home', 1000, 500, 20000), 500);
  assert.equal(trimKeyValue('Tab', 1000, 0, 20000), null);
});
