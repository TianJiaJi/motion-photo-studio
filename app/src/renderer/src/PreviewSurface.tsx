import { useLayoutEffect, useImperativeHandle, useRef } from 'react';
import type { Ref } from 'react';
import type { PreviewPixels } from '../../shared/native-preview.ts';
import type { PreviewController } from './preview-controller.ts';
import { scheduleCanvasDraw } from './canvas-scheduler.ts';
export type PreviewSurfaceHandle = { enqueue(frame: PreviewPixels): void };
export function PreviewSurface({ controller, enabled, ref }: { controller: PreviewController | null; enabled: boolean; ref?: Ref<PreviewSurfaceHandle> }) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const latest=useRef({controller,enabled});latest.current={controller,enabled};
  const pending=useRef<{frame:PreviewPixels;owner:PreviewController}|null>(null);
  const cancelDraw=useRef<(()=>void)|null>(null);
  useImperativeHandle(ref,()=>({enqueue(frame){
    const {controller:owner,enabled}=latest.current;if(!owner)return;
    if(!enabled||!owner.isCurrent(frame)){owner.drop(frame);return;}
    if(pending.current)pending.current.owner.drop(pending.current.frame);
    pending.current={frame,owner};
    if(cancelDraw.current)return;
    cancelDraw.current=scheduleCanvasDraw(()=>{
      cancelDraw.current=null;const next=pending.current;pending.current=null;if(!next)return;
      const element=canvas.current;
      // A frame accepted before pointerup/source replacement may already be stale at RAF time.
      if(!element||!latest.current.enabled||latest.current.controller!==next.owner||!next.owner.isCurrent(next.frame)){next.owner.drop(next.frame);return;}
      const context=element.getContext('2d');if(!context){next.owner.drop(next.frame);return;}
      const {frame}=next;
      if(element.width!==frame.width)element.width=frame.width;
      if(element.height!==frame.height)element.height=frame.height;
      context.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels),frame.width,frame.height),0,0);
      element.dataset.frameId=String(frame.frameId);element.dataset.epoch=String(frame.epoch);
      element.dataset.pts=frame.pts;element.dataset.timeUs=String(frame.timeUs);
      next.owner.painted(frame);
    });
  }}),[]);
  useLayoutEffect(()=>{
    const element=canvas.current;
    if(element){element.getContext('2d')?.clearRect(0,0,element.width,element.height);delete element.dataset.frameId;delete element.dataset.pts;delete element.dataset.timeUs;delete element.dataset.epoch;}
    return()=>{
      cancelDraw.current?.();cancelDraw.current=null;
      if(pending.current)pending.current.owner.drop(pending.current.frame);pending.current=null;
    };
  },[controller,enabled]);
  return <canvas ref={canvas} data-testid="native-preview" className="native-preview-surface" role="img" aria-label="视频原生预览" />;
}
