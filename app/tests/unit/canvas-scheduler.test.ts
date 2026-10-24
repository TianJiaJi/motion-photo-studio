import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scheduleCanvasDraw,CANVAS_DRAW_FALLBACK_MS} from '../../src/renderer/src/canvas-scheduler.ts';
function harness(){
  let next=0,draws=0;const pending=new Map<number,()=>void>(),callbacks:(()=>void)[]=[];
  const add=(callback:()=>void)=>{const id=next++;pending.set(id,callback);callbacks.push(callback);return id;};
  const cancel=scheduleCanvasDraw(()=>{draws++;},{frame:add,cancelFrame:id=>{pending.delete(id);},
    timer:(callback,delay)=>{assert.equal(delay,CANVAS_DRAW_FALLBACK_MS);return add(callback);},cancelTimer:id=>{pending.delete(id);}});
  return {cancel,pending,callbacks,draws:()=>draws};
}
test('Canvas RAF wins and cancels fallback, including stale queued callbacks',()=>{
  const h=harness();assert.equal(h.pending.size,2);h.callbacks[0]!();h.callbacks[1]!();
  assert.equal(h.draws(),1);assert.equal(h.pending.size,0);
});
test('Canvas timer paints once when RAF is suspended without an unbounded loop',()=>{
  const h=harness();h.callbacks[1]!();h.callbacks[0]!();h.callbacks[1]!();
  assert.equal(h.draws(),1);assert.equal(h.pending.size,0);
});
test('Canvas cancellation on source/consent change fences both callbacks',()=>{
  const h=harness();h.cancel();h.callbacks[0]!();h.callbacks[1]!();
  assert.equal(h.draws(),0);assert.equal(h.pending.size,0);
});
