import type { Reply } from '../../shared/contracts.ts';
import type { PreviewAck, PreviewBoundary, PreviewControl, PreviewPixels, PreviewStamp, PreviewStatus } from '../../shared/native-preview.ts';
type Seek = Extract<PreviewControl,{action:'seek'}>;
type Hooks = {
  send(request: PreviewControl): Promise<Reply<null>>;
  acknowledge(request: PreviewAck): Promise<Reply<null>>;
  frame(frame: PreviewPixels): void;
  displayed(stamp: PreviewStamp): void;
  error(error: Error): void;
};
function failure(reply: Reply<null>): Error | null {
  return reply.ok ? null : Object.assign(new Error(reply.error.message),{code:reply.error.code});
}
// This controller contains no React state or pixel cache. A drag keeps one epoch so a slow
// completed frame remains displayable; release/seek/step/play start a new epoch and fence old work.
export class PreviewController {
  private readonly assetId: string;
  private readonly durationUs: number;
  private readonly hooks: Hooks;
  private epochValue = 0;
  private pending: PreviewControl | null = null;
  // One same-epoch command, plus at most one newer epoch to interrupt obsolete work.
  private sending = new Set<number>();
  private disposed = false;
  private dragging = false;
  private lastFrame = -1;
  private confirmedValue: PreviewStamp | null = null;
  get confirmed() { return this.disposed ? null : this.confirmedValue; }
  private target: {timeUs:number; boundary:PreviewBoundary} = {timeUs:0,boundary:'after'};
  constructor(assetId: string, durationUs: number, hooks: Hooks) { this.assetId=assetId; this.durationUs=durationUs; this.hooks=hooks; }
  get epoch() { return this.epochValue; }
  get isDragging() { return this.dragging; }
  acceptsStatus(status:PreviewStatus) {
    // A helper's terminal failure applies to the whole asset, even if a newer
    // local gesture has not reached main yet. Ordinary old-epoch status is stale.
    return !this.disposed&&status.assetId===this.assetId&&(status.state==='failed'||status.epoch===0||status.epoch===this.epochValue);
  }
  isCurrent(frame:PreviewStamp) { return !this.disposed&&frame.assetId===this.assetId&&frame.epoch===this.epochValue; }
  private nextEpoch() { this.lastFrame=-1; return ++this.epochValue; }
  private at(timeUs:number) {
    if(!Number.isSafeInteger(timeUs)||timeUs<0||timeUs>this.durationUs) throw new Error('Invalid preview time');
    return timeUs;
  }
  private enqueue(request:PreviewControl) {
    if(this.disposed)return;
    this.pending=request; this.pump();
  }
  private pump() {
    if(this.disposed||!this.pending||this.sending.size>=2)return;
    if(this.sending.size&&this.pending.epoch<=Math.max(...this.sending))return;
    const request=this.pending;this.pending=null;this.sending.add(request.epoch);
    void this.hooks.send(request).then(reply=>{
      const error=failure(reply);
      if(error&&!this.disposed&&request.epoch===this.epochValue&&(error as {code?:string}).code!=='CANCELLED')this.hooks.error(error);
    }).catch(error=>{if(!this.disposed&&request.epoch===this.epochValue)this.hooks.error(error as Error);})
      .finally(()=>{this.sending.delete(request.epoch);this.pump();});
  }
  private seekRequest(timeUs:number,boundary:PreviewBoundary,final:boolean):Seek {
    this.target={timeUs:this.at(timeUs),boundary};
    return {assetId:this.assetId,epoch:this.epochValue,action:'seek',timeUs,boundary,maximumEdge:final?960:640,final};
  }
  begin(timeUs:number,boundary:PreviewBoundary='after') {
    this.dragging=true;this.nextEpoch();this.enqueue(this.seekRequest(timeUs,boundary,false));
  }
  move(timeUs:number,boundary:PreviewBoundary=this.target.boundary) {
    if(!this.dragging)return;
    this.enqueue(this.seekRequest(timeUs,boundary,false));
  }
  end(timeUs:number=this.target.timeUs,boundary:PreviewBoundary=this.target.boundary) {
    this.dragging=false;this.nextEpoch();this.enqueue(this.seekRequest(timeUs,boundary,true));
  }
  cancelDrag() { if(this.dragging)this.end(); }
  seek(timeUs:number,boundary:PreviewBoundary='after') {
    this.dragging=false;this.nextEpoch();this.enqueue(this.seekRequest(timeUs,boundary,true));
  }
  step(frameId:number,direction:-1|1) {
    this.dragging=false;this.nextEpoch();
    this.enqueue({assetId:this.assetId,epoch:this.epochValue,action:'step',frameId,direction});
  }
  play(startUs:number,endUs:number,audioTrack:number|null) {
    this.at(startUs);this.at(endUs);if(startUs>=endUs)throw new Error('Empty playback interval');
    this.dragging=false;this.nextEpoch();this.enqueue({assetId:this.assetId,epoch:this.epochValue,action:'play',startUs,endUs,audioTrack});
  }
  pause() {
    this.dragging=false;this.nextEpoch();this.enqueue({assetId:this.assetId,epoch:this.epochValue,action:'pause'});
  }
  receive(frame:PreviewPixels) {
    if(!this.isCurrent(frame)||frame.frameId<=this.lastFrame) {this.drop(frame);return;}
    if(!Number.isSafeInteger(frame.frameId)||frame.frameId<0||!Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)
      ||frame.width<1||frame.height<1||frame.width>1280||frame.height>1280||!(frame.pixels instanceof Uint8Array)
      ||frame.pixels.byteLength!==frame.width*frame.height*4) {
      this.drop(frame);this.hooks.error(new Error('Invalid preview pixel payload'));return;
    }
    this.lastFrame=frame.frameId;this.hooks.frame(frame);
  }
  private ack(frame:PreviewStamp,painted:boolean):Promise<boolean> {
    return this.hooks.acknowledge({assetId:frame.assetId,epoch:frame.epoch,frameId:frame.frameId,painted}).then(reply=>{
      const error=failure(reply);
      if(error&&!this.disposed&&frame.assetId===this.assetId&&frame.epoch===this.epochValue&&(error as {code?:string}).code!=='CANCELLED')this.hooks.error(error);
      return !error;
    }).catch(error=>{if(!this.disposed&&frame.assetId===this.assetId&&frame.epoch===this.epochValue)this.hooks.error(error as Error);return false;});
  }
  drop(frame:PreviewStamp) {void this.ack(frame,false);}
  painted(frame:PreviewStamp) {
    // Only a real Canvas paint followed by a main-process acknowledgment confirms the cover/step cursor.
    this.confirmedValue=null;
    const {assetId,epoch,frameId,sourceFrame,pts,timeUs,timeBase,width,height}=frame;
    const stamp={assetId,epoch,frameId,sourceFrame,pts,timeUs,timeBase,width,height};
    void this.ack(stamp,true).then(ok=>{if(ok&&!this.disposed&&assetId===this.assetId&&epoch===this.epochValue&&frameId===this.lastFrame){this.confirmedValue=stamp;this.hooks.displayed(stamp);}});
  }
  dispose(){this.disposed=true;this.pending=null;this.dragging=false;this.confirmedValue=null;}
}
