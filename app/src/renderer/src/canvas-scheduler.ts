// RAF can stop/slow when a native window is minimized even with backgroundThrottling=false.
// Race it with ONE bounded timer, never an interval. ACK still follows actual Canvas writes.
// Keep queue/display latency below a frame interval even when RAF is suspended.
export const CANVAS_DRAW_FALLBACK_MS=8;
type Scheduler={frame(callback:()=>void):number;cancelFrame(id:number):void;timer(callback:()=>void,delay:number):number;cancelTimer(id:number):void};
export function scheduleCanvasDraw(draw:()=>void,scheduler:Scheduler={
  frame:callback=>requestAnimationFrame(callback),cancelFrame:id=>cancelAnimationFrame(id),
  timer:(callback,delay)=>window.setTimeout(callback,delay),cancelTimer:id=>window.clearTimeout(id),
}):()=>void{
  let active=true,frame:number|undefined,timer:number|undefined;
  const cancel=()=>{active=false;if(frame!==undefined)scheduler.cancelFrame(frame);if(timer!==undefined)scheduler.cancelTimer(timer);};
  const finish=()=>{if(!active)return;cancel();draw();};
  frame=scheduler.frame(finish);timer=scheduler.timer(finish,CANVAS_DRAW_FALLBACK_MS);
  return cancel;
}
