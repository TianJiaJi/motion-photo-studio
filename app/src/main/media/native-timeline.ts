import {AppFailure,publicError} from '../errors.ts';
import type {PreviewAck,PreviewControl,PreviewPixels,PreviewReady,PreviewStatus} from '../../shared/native-preview.ts';
import type {PreparedNativeMedia} from './native-import.ts';
import {assertSource,type SourceFile} from './source.ts';
import type {IndexedFrame} from './frame-index.ts';
import {nativeInteger} from './native-preview.ts';
type Ticket={request:PreviewControl;resolve():void;reject(error:unknown):void};
type Image=Omit<PreviewPixels,'assetId'|'epoch'|'frameId'>;
type Presentation={frame:PreviewPixels;done:Promise<boolean>;settle(painted:boolean):void;timer?:NodeJS.Timeout};
type Playback={epoch:number;startUs:number;endUs:number;started:number;audio:boolean;lastDecoded:number};
type AudioStatus={running:boolean;timeHns:string;error:string|null};
const cancelled=()=>new AppFailure('CANCELLED','预览操作已被替代。');

// One active + one latest control, one IPC frame + one latest unsent image. A stalled
// renderer cannot grow the Electron IPC queue, even across repeated interaction epochs.
export class NativeTimeline {
  private epoch=0;
  private sequence=0;
  private mode:'drag'|'other'='other';
  private edge=0;
  private closed=false;
  private failure?:unknown;
  private queued?:Ticket;
  private work?:Promise<void>;
  private interruptNeeded=false;
  private interruptWork?:Promise<void>;
  private tickWork?:Promise<void>;
  private timer?:NodeJS.Timeout;
  private prefetchWork?:Promise<void>;
  private playing?:Playback;
  private flight?:Presentation;
  private waiting?:Presentation;
  private displayed?:PreviewPixels;
  private closing?:Promise<void>;
  private counters={generated:0,sent:0,replaced:0,late:0};
  readonly assetId:string;
  readonly media:PreparedNativeMedia;
  private source:SourceFile;
  private hooks:{frame(frame:PreviewPixels):void;status(status:PreviewStatus):void};
  constructor(assetId:string,source:SourceFile,media:PreparedNativeMedia,hooks:{frame(frame:PreviewPixels):void;status(status:PreviewStatus):void}) {
    this.assetId=assetId;this.source=source;this.media=media;this.hooks=hooks;
    void media.native.terminated.then(()=>{if(!this.closed)this.fail(new AppFailure('NATIVE_EXIT','原生预览进程意外退出，请重新导入素材。'));});
  }
  get ready():PreviewReady {
    this.check();
    const {index,nativeInfo,compatibility,warnings}=this.media;
    return {assetId:this.assetId,frameCount:index.count,compatibility,warnings:[...warnings],sourceWidth:index.info.displayWidth,sourceHeight:index.info.displayHeight,
      previewWidth:nativeInfo.width,previewHeight:nativeInfo.height,hardwareDecodeVerified:nativeInfo.hardwareDecodeVerified};
  }
  get stats(){return {...this.counters,pendingControls:Number(Boolean(this.queued)),activeControl:Boolean(this.work),inFlight:Number(Boolean(this.flight)),pendingImages:Number(Boolean(this.waiting)),
    pixelBytes:(this.flight?.frame.pixels.byteLength??0)+(this.waiting?.frame.pixels.byteLength??0)+(this.displayed?.pixels.byteLength??0)};}
  private status(state:PreviewStatus['state'],error?:unknown){
    if(this.closed||this.failure&&state!=='failed')return;
    try{this.hooks.status({assetId:this.assetId,epoch:this.epoch,state,...(error?{error:publicError(error)}:{})});}catch{/* Window teardown must not strand native cleanup. */}
  }
  private check(epoch=this.epoch){if(this.closed)throw cancelled();if(this.failure)throw this.failure;if(epoch!==this.epoch)throw cancelled();}
  private stopClock(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.playing=undefined;}
  private settle(presentation:Presentation|undefined,painted=false){if(presentation?.timer)clearTimeout(presentation.timer);if(presentation)presentation.settle(painted);}
  private fail(error:unknown){
    if(this.closed||this.failure)return;this.failure=error;this.stopClock();this.queued?.reject(error);this.queued=undefined;
    this.settle(this.flight);this.settle(this.waiting);this.waiting=undefined;this.status('failed',error);
    // Fatal renderer/protocol failures must not leave WASAPI playing unattended.
    void this.media.native.shutdown().catch(()=>{/* dispose must confirm exit before any owned-file deletion. */});
  }
  private interrupt():Promise<void>{
    this.interruptNeeded=true;
    if(!this.interruptWork){
      const work=(async()=>{while(this.interruptNeeded&&!this.closed){
        this.interruptNeeded=false;
        try{await this.media.native.request({command:'audioStop'});}
        catch(error){
          // A newer epoch may supersede the queued stop. Drain its replacement rather
          // than treating this expected cancellation as an asset-wide helper failure.
          if(!(error instanceof AppFailure&&error.code==='CANCELLED'&&this.interruptNeeded))throw error;
        }
      }})();
      this.interruptWork=work;
      void work.catch(error=>{if(!this.closed)this.fail(error);}).finally(()=>{if(this.interruptWork===work)this.interruptWork=undefined;});
    }
    return this.interruptWork;
  }
  control(request:PreviewControl):Promise<void>{
    try {
      this.check();if(request.assetId!==this.assetId)throw cancelled();
      if(request.epoch<this.epoch||request.epoch===this.epoch&&!(this.mode==='drag'&&request.action==='seek'&&!request.final))throw cancelled();
      if(request.epoch>this.epoch){
        this.epoch=request.epoch;this.media.native.advanceEpoch();this.stopClock();
        // Keep the already-sent slot until its ACK, otherwise a hidden renderer could accumulate frames.
        this.flight?.settle(false);this.settle(this.waiting);this.waiting=undefined;
        this.mode=request.action==='seek'&&!request.final?'drag':'other';void this.interrupt();
      }
      this.queued?.reject(cancelled());
      const result=new Promise<void>((resolve,reject)=>{this.queued={request,resolve,reject};});this.pump();return result;
    }catch(error){return Promise.reject(error);}
  }
  private pump(){
    if(this.work||this.closed||!this.queued)return;
    const work=(async()=>{
      while(this.queued&&!this.closed){
        const ticket=this.queued;this.queued=undefined;
        try{await this.interruptWork;await this.tickWork?.catch(()=>{});this.check(ticket.request.epoch);await this.perform(ticket.request);ticket.resolve();}
        catch(error){ticket.reject(error);if(ticket.request.epoch===this.epoch&&!this.closed&&!(error instanceof AppFailure&&['CANCELLED','FRAME_BOUNDARY'].includes(error.code)))this.status('paused',error);}
      }
    })();
    this.work=work;void work.finally(()=>{if(this.work===work)this.work=undefined;this.pump();this.prefetch();});
  }
  private async quality(edge:number,epoch:number){
    if(this.edge!==edge){this.edge=0;await this.media.native.request({command:'quality',maximumEdge:edge});this.edge=edge;}
    this.check(epoch);
  }
  private async image(row:IndexedFrame,epoch:number,playback=false):Promise<Image>{
    await assertSource(this.source);this.check(epoch);
    const result=await this.media.index.locate(this.media.native,row.index,undefined,playback);this.check(epoch);
    const actual=await this.media.index.fromNative(result.value.timestampHns);this.check(epoch);
    if(actual.index!==row.index||!result.pixels.length)throw new AppFailure('FRAME_INDEX','原生预览返回了错误的源帧。');
    return {sourceFrame:row.index,pts:row.pts,timeUs:row.timeUs,timeBase:this.media.index.info.timeBase,width:result.value.width,height:result.value.height,pixels:result.pixels};
  }
  private publish(image:Image,epoch:number):Presentation {
    this.check(epoch);if(this.sequence>=Number.MAX_SAFE_INTEGER)throw new AppFailure('NATIVE_PROTOCOL','预览帧编号已耗尽。');
    let settle!:(value:boolean)=>void;const done=new Promise<boolean>(resolve=>{settle=resolve;});
    const frame:PreviewPixels={...image,assetId:this.assetId,epoch,frameId:++this.sequence};
    const presentation:Presentation={frame,done,settle};this.counters.generated++;
    if(this.waiting){this.settle(this.waiting);this.counters.replaced++;}this.waiting=presentation;this.flush();return presentation;
  }
  private flush(){
    if(this.closed||this.failure||this.flight||!this.waiting)return;
    const next=this.waiting;this.waiting=undefined;
    if(next.frame.epoch!==this.epoch){this.settle(next);return;}
    this.flight=next;next.timer=setTimeout(()=>{
      if(this.flight!==next||this.closed)return;
      next.settle(false);this.waiting?.settle(false);
      const wasPlaying=Boolean(this.playing);this.stopClock();if(wasPlaying)void this.interrupt();
      this.status('paused',new AppFailure('NATIVE_TIMEOUT','窗口未确认预览画面，已暂停播放。'));
      // Do not free the transport slot until the renderer actually acknowledges this message.
    },1500);
    this.counters.sent++;
    try{this.hooks.frame(next.frame);}catch(error){this.fail(error);throw error;}
  }
  acknowledge(ack:PreviewAck):void {
    this.check();const current=this.flight;
    if(ack.assetId!==this.assetId||!current||ack.frameId!==current.frame.frameId||ack.epoch!==current.frame.epoch)throw cancelled();
    this.flight=undefined;
    const accepted=ack.painted&&ack.epoch===this.epoch;
    if(accepted)this.displayed=current.frame;this.settle(current,accepted);this.flush();
    if(ack.painted&&!accepted)throw cancelled();
  }
  capture(frameId:number):PreviewPixels {
    this.check();if(!this.displayed||this.displayed.frameId!==frameId)throw new AppFailure('FRAME_BOUNDARY','封面必须来自已确认显示的当前帧。');
    return this.displayed;
  }
  private async perform(request:PreviewControl){
    const {index,native}=this.media;const epoch=request.epoch;await assertSource(this.source);this.check(epoch);
    if(request.action==='pause'){
      // Republish the last confirmed image in the new epoch, including an ACK/pause race.
      const last=this.displayed??this.flight?.frame;if(last)this.publish(last,epoch);this.status('paused');return;
    }
    if(request.action==='seek'){
      await this.quality(request.maximumEdge,epoch);const row=await index.at(request.timeUs,request.boundary);
      this.publish(await this.image(row,epoch),epoch);this.status('paused');return;
    }
    if(request.action==='step'){
      const current=this.capture(request.frameId);const number=current.sourceFrame+request.direction;
      if(number<0||number>=index.count)throw new AppFailure('FRAME_BOUNDARY','已到素材首尾帧。');
      await this.quality(960,epoch);this.publish(await this.image(await index.get(number),epoch),epoch);this.status('paused');return;
    }
    if(request.startUs<0||request.endUs>index.info.durationUs||request.endUs<=request.startUs)throw new AppFailure('INVALID_REQUEST','播放区间超出素材范围。');
    const track=request.audioTrack===null?undefined:this.media.audio.find(track=>track.sourceIndex===request.audioTrack);
    if(request.audioTrack!==null&&!track)throw new AppFailure('INVALID_REQUEST','所选音轨没有完成导入准备。');
    const first=await index.at(request.startUs,'after');if(first.timeUs>=request.endUs)throw new AppFailure('FRAME_BOUNDARY','播放区间内没有源帧。');
    await this.quality(960,epoch);
    const presentation=this.publish(await this.image(first,epoch),epoch);
    if(!await presentation.done)throw cancelled();this.check(epoch);
    const audio=Boolean(track&&track.kind!=='silent');
    if(audio&&track){
      await native.request({command:'audioStart',path:track.path,streamIndex:track.streamIndex,offsetHns:track.offsetHns,timeUs:first.timeUs,endUs:request.endUs});this.check(epoch);
    }
    const playback:Playback={epoch,startUs:first.timeUs,endUs:request.endUs,started:performance.now(),audio,lastDecoded:first.index};
    this.playing=playback;this.status('playing');this.schedule(playback,0);
  }
  private schedule(playback:Playback,delay:number){
    if(this.closed||this.playing!==playback)return;
    this.timer=setTimeout(()=>{
      this.timer=undefined;const began=performance.now();const work=this.tick(playback);this.tickWork=work;
      void work.catch(error=>{
        if(this.playing!==playback||this.closed)return;
        this.stopClock();void this.interrupt();this.status('paused',error);
      }).finally(()=>{if(this.tickWork===work)this.tickWork=undefined;this.schedule(playback,Math.max(0,16-(performance.now()-began)));});
    },delay);
  }
  private async clock(playback:Playback):Promise<number>{
    if(!playback.audio)return Math.min(playback.endUs,playback.startUs+Math.floor((performance.now()-playback.started)*1000));
    const {value:audio}=await this.media.native.request<AudioStatus>({command:'audioStatus'});this.check(playback.epoch);
    if(!audio||typeof audio.running!=='boolean'||audio.error!==null&&typeof audio.error!=='string')throw new AppFailure('NATIVE_PROTOCOL','原生音频时钟响应不合法。');
    if(audio.error)throw new AppFailure('NATIVE_MEDIA','音频设备播放失败，已暂停预览。');
    const time=Number(nativeInteger(audio.timeHns)/10n);
    if(!Number.isSafeInteger(time)||time<playback.startUs||time>playback.endUs)throw new AppFailure('NATIVE_PROTOCOL','原生音频时钟超出源区间。');
    return audio.running?time:playback.endUs;
  }
  private async tick(playback:Playback){
    if(this.playing!==playback||this.closed)return;
    if(this.flight&&this.waiting)return;
    const now=await this.clock(playback);if(this.playing!==playback)return;
    const row=await this.media.index.at(Math.min(playback.endUs,now+1),'before');this.check(playback.epoch);
    if(row.index!==playback.lastDecoded){
      const image=await this.image(row,playback.epoch,true);if(this.playing!==playback)return;
      const fresh=await this.clock(playback);if(this.playing!==playback)return;
      const duration=Number(BigInt(row.durationPts)*BigInt(this.media.index.info.timeBase.numerator)*1_000_000n/BigInt(this.media.index.info.timeBase.denominator));
      if(fresh<playback.endUs&&fresh-row.timeUs>Math.max(50_000,duration*2)){this.counters.late++;return;}
      playback.lastDecoded=row.index;this.publish(image,playback.epoch);
    }
    if(now>=playback.endUs){
      this.stopClock();await this.media.native.request({command:'audioStop'});this.check(playback.epoch);this.status('paused');
    }
  }
  private prefetch(){
    if(this.closed||this.failure||this.work||this.queued||this.playing||this.prefetchWork||this.media.native.busy)return;
    const work=this.media.native.request({command:'prefetch',count:2}).then(()=>{},error=>{
      if(!this.closed&&!(error instanceof AppFailure&&['CANCELLED','NATIVE_BUSY'].includes(error.code)))this.status('paused',error);
    });this.prefetchWork=work;void work.finally(()=>{if(this.prefetchWork===work)this.prefetchWork=undefined;});
  }
  dispose():Promise<void>{
    if(this.closing)return this.closing;
    this.closed=true;this.stopClock();this.queued?.reject(cancelled());this.queued=undefined;
    this.settle(this.flight);this.settle(this.waiting);this.flight=undefined;this.waiting=undefined;this.displayed=undefined;
    this.closing=(async()=>{
      try{await this.media.native.shutdown();}
      finally{await Promise.allSettled([this.work,this.tickWork,this.interruptWork,this.prefetchWork]);await this.media.index.close();}
    })();return this.closing;
  }
}
