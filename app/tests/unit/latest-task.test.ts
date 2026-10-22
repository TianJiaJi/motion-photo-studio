import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatestTask } from '../../src/main/jobs/latest-task.ts';

test('latest-wins waits for cancelled work cleanup and skips superseded queued work', async () => {
  const lane = new LatestTask();
  let release!: () => void; let started!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const events: string[] = [];
  const first = lane.run(async signal => {
    events.push('first started'); started();
    await barrier;
    events.push('first cleanup'); signal.throwIfAborted();
    return 1;
  });
  const firstRejected = assert.rejects(first, { code: 'CANCELLED' });
  await entered;
  const second = lane.run(async () => { events.push('second started'); return 2; });
  const secondRejected = assert.rejects(second, { code: 'CANCELLED' });
  const third = lane.run(async () => { events.push('third started'); return 3; });
  assert.equal(lane.busy, true);
  assert.deepEqual(events, ['first started']);
  release();
  assert.equal(await third, 3);
  await Promise.all([firstRejected, secondRejected]);
  assert.deepEqual(events, ['first started', 'first cleanup', 'third started']);
  assert.equal(lane.busy, false);
  await lane.close();
  await assert.rejects(lane.run(async () => 4), { code: 'CANCELLED' });
});
