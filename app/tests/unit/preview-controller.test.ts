import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Reply } from '../../src/shared/contracts.ts';
import type { PreviewControl, PreviewAck, PreviewPixels, PreviewStamp } from '../../src/shared/native-preview.ts';
import { PreviewController } from '../../src/renderer/src/preview-controller.ts';
const ok:Reply<null>={ok:true,value:null};
async function flush(){await new Promise<void>(resolve=>setImmediate(resolve));}
function harness(){
  const sent:PreviewControl[]=[],acks:PreviewAck[]=[],frames:PreviewPixels[]=[],displayed:PreviewStamp[]=[],errors:Error[]=[];
  const resolveSend:((reply:Reply<null>)=>void)[]=[];
  const controller=new PreviewController('asset',1_000_000,{
    send:request=>{sent.push(request);return new Promise(resolve=>resolveSend.push(resolve));},
    acknowledge:async ack=>{acks.push(ack);return ok;},frame:frame=>frames.push(frame),displayed:stamp=>displayed.push(stamp),error:error=>errors.push(error),
  });
  const frame=(epoch:number,id:number):PreviewPixels=>({assetId:'asset',epoch,frameId:id,sourceFrame:id,pts:String(id),timeUs:id*1000,timeBase:{numerator:1,denominator:1000},width:1,height:1,pixels:new Uint8Array([1,2,3,255])});
  return {controller,sent,acks,frames,displayed,errors,resolveSend,frame};
}
test('drag sends one command and retains only the latest pending target',async()=>{
  const h=harness(); h.controller.begin(0);
  for(let i=1;i<=100;i++)h.controller.move(i*1000);
  assert.equal(h.sent.length,1); assert.equal(h.controller.epoch,1);
  h.controller.receive(h.frame(1,1)); assert.equal(h.frames.length,1,'Completed intermediate frames remain displayable while dragging');
  h.resolveSend.shift()!(ok);await flush();assert.equal(h.sent.length,2);
  assert.deepEqual(h.sent[1],{assetId:'asset',epoch:1,action:'seek',timeUs:100000,boundary:'after',maximumEdge:640,final:false});
  h.controller.end(120000,'before'); assert.equal(h.controller.epoch,2);
  h.resolveSend.shift()!(ok);await flush();assert.equal(h.sent.length,3);
  assert.deepEqual(h.sent[2],{assetId:'asset',epoch:2,action:'seek',timeUs:120000,boundary:'before',maximumEdge:960,final:true});
  h.resolveSend.shift()!(ok);await flush();h.controller.dispose();
});
test('a newer gesture interrupts an unresolved final seek with at most two IPC calls and one latest target',async()=>{
  const h=harness();h.controller.seek(900000);h.controller.begin(1000);
  assert.equal(h.sent.length,2,'New epoch reaches main before obsolete final seek completes');
  for(let i=1;i<=10;i++){h.controller.begin(i*10000);h.controller.move(i*10000+1);}
  assert.equal(h.sent.length,2,'Rapid epoch changes cannot grow in-flight IPC');
  h.resolveSend.shift()!(ok);await flush();assert.equal(h.sent.length,3);
  assert.equal(h.sent[2]!.epoch,h.controller.epoch);
  assert.equal((h.sent[2] as Extract<PreviewControl,{action:'seek'}>).timeUs,100001);
  h.controller.move(115000);h.resolveSend.shift()!(ok);await flush();
  assert.equal(h.sent.length,3,'Same-epoch movement remains coalesced until its active command finishes');
  h.resolveSend.shift()!(ok);await flush();assert.equal(h.sent.length,4);
  assert.equal((h.sent[3] as Extract<PreviewControl,{action:'seek'}>).timeUs,115000);
  h.controller.dispose();h.resolveSend.shift()!(ok);await flush();assert.equal(h.sent.length,4);assert.equal(h.errors.length,0);
});
test('release fences queued Canvas frames and only actual paint acknowledgments confirm the cursor',async()=>{
  const h=harness();h.controller.begin(1000);const old=h.frame(1,1);h.controller.receive(old);
  assert.equal(h.displayed.length,0);h.controller.end(5000);assert.equal(h.controller.isCurrent(old),false);
  h.controller.receive(h.frame(1,2));assert.equal(h.frames.length,1);assert.equal(h.acks.at(-1)!.painted,false);
  const fresh=h.frame(2,3);h.controller.receive(fresh);assert.equal(h.displayed.length,0);
  h.controller.painted(fresh);assert.equal(h.controller.confirmed,null,'Do not capture pixels while their paint ACK is pending');
  await flush();assert.equal(h.displayed.length,1);assert.equal(h.displayed[0]!.frameId,3);assert.equal((h.controller.confirmed as PreviewStamp | null)?.frameId,3);
  assert.ok(!Object.hasOwn(h.displayed[0]!,'pixels'),'React metadata must not retain the per-frame binary payload');
  h.controller.dispose();assert.equal(h.controller.confirmed,null);for(const done of h.resolveSend.splice(0))done(ok);await flush();assert.equal(h.sent.length,2);
});
test('terminal helper failure is asset-wide, while ordinary status remains epoch-fenced',async()=>{
  const h=harness();h.controller.begin(0);h.controller.end(1000);
  assert.equal(h.controller.acceptsStatus({assetId:'asset',epoch:1,state:'paused'}),false);
  assert.equal(h.controller.acceptsStatus({assetId:'asset',epoch:2,state:'playing'}),true);
  assert.equal(h.controller.acceptsStatus({assetId:'asset',epoch:0,state:'preparing'}),true);
  assert.equal(h.controller.acceptsStatus({assetId:'asset',epoch:1,state:'failed'}),true);
  assert.equal(h.controller.acceptsStatus({assetId:'replaced',epoch:2,state:'failed'}),false);
  h.controller.dispose();assert.equal(h.controller.acceptsStatus({assetId:'asset',epoch:2,state:'failed'}),false);
  for(const done of h.resolveSend.splice(0))done(ok);await flush();assert.equal(h.sent.length,2);
});
test('cancel/invalid frames cannot leave dragging state or confirm malformed pixels',async()=>{
  const h=harness();h.controller.begin(1000,'before');h.controller.cancelDrag();assert.equal(h.controller.isDragging,false);
  h.controller.receive({...h.frame(h.controller.epoch,2),pixels:new Uint8Array(0)});assert.equal(h.errors.length,1);assert.equal(h.frames.length,0);
  h.resolveSend.shift()!(ok);await flush();h.resolveSend.shift()!(ok);await flush();
  h.controller.seek(900000);assert.equal(h.sent.at(-1)!.action,'seek');
  h.controller.dispose();h.resolveSend.shift()!(ok);await flush();
});
