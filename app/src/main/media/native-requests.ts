import type { PreviewAck, PreviewControl } from '../../shared/native-preview.ts';
import { AppFailure } from '../errors.ts';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function invalid():never {throw new AppFailure('INVALID_REQUEST','原生预览请求参数不合法。');}
function object(args:unknown[]):Record<string,unknown> {
  if(args.length!==1||!args[0]||typeof args[0]!=='object'||Array.isArray(args[0]))invalid();
  const value=args[0] as Record<string,unknown>,prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)invalid();
  if(typeof value.assetId!=='string'||!uuid.test(value.assetId))invalid();
  return value;
}
function exact(value:Record<string,unknown>,keys:string[]) {
  if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))invalid();
}
function integer(value:unknown,minimum=0):value is number {return Number.isSafeInteger(value)&&(value as number)>=minimum;}
export function parseNativePrepare(args:unknown[]):{assetId:string;hdrConsent:boolean} {
  const value=object(args);exact(value,['assetId','hdrConsent']);if(typeof value.hdrConsent!=='boolean')invalid();
  return value as {assetId:string;hdrConsent:boolean};
}
export function parseNativeCapture(args:unknown[]):{assetId:string;frameId:number} {
  const value=object(args);exact(value,['assetId','frameId']);if(!integer(value.frameId,1))invalid();
  return value as {assetId:string;frameId:number};
}
export function parseNativeAck(args:unknown[]):PreviewAck {
  const value=object(args);exact(value,['assetId','epoch','frameId','painted']);
  if(!integer(value.epoch,1)||!integer(value.frameId,1)||typeof value.painted!=='boolean')invalid();
  return value as PreviewAck;
}
export function parseNativeControl(args:unknown[]):PreviewControl {
  const value=object(args);if(!integer(value.epoch,1))invalid();
  const base=['assetId','epoch','action'];
  switch(value.action) {
    case 'seek':
      exact(value,[...base,'timeUs','boundary','maximumEdge','final']);
      if(!integer(value.timeUs)||value.boundary!=='after'&&value.boundary!=='before'
        ||value.maximumEdge!==640&&value.maximumEdge!==960||typeof value.final!=='boolean')invalid();
      break;
    case 'step':
      exact(value,[...base,'frameId','direction']);if(!integer(value.frameId,1)||value.direction!==1&&value.direction!==-1)invalid();break;
    case 'play':
      exact(value,[...base,'startUs','endUs','audioTrack']);
      if(!integer(value.startUs)||!integer(value.endUs)||value.startUs>=value.endUs||value.audioTrack!==null&&!integer(value.audioTrack))invalid();break;
    case 'pause':exact(value,base);break;
    default:invalid();
  }
  return value as PreviewControl;
}
