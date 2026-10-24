import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseNativeControl,parseNativePrepare,parseNativeCapture,parseNativeAck} from '../../src/main/media/native-requests.ts';
const assetId='12345678-1234-1234-1234-123456789abc';
test('native controls accept only bounded identities and declared fields, never paths',()=>{
  const seek={assetId,epoch:1,action:'seek',timeUs:100,boundary:'before',maximumEdge:640,final:false};
  assert.deepEqual(parseNativeControl([seek]),seek);
  for(const bad of [{...seek,path:'C:\\private.mp4'},{...seek,epoch:NaN},{...seek,timeUs:0.25},{...seek,maximumEdge:4096},
    {...seek,boundary:{toString:()=> 'before'}},{...seek,assetId:'../escape'},{...seek,final:'true'},{...seek,action:'shutdown'}]) {
    assert.throws(()=>parseNativeControl([bad]),{code:'INVALID_REQUEST'});
  }
  assert.throws(()=>parseNativeControl([Object.assign(Object.create({native:true}),seek)]),{code:'INVALID_REQUEST'});
  assert.throws(()=>parseNativeControl([seek,{}]),{code:'INVALID_REQUEST'});
  assert.deepEqual(parseNativeControl([{assetId,epoch:2,action:'play',startUs:0,endUs:100,audioTrack:null}]).action,'play');
  assert.throws(()=>parseNativeControl([{assetId,epoch:2,action:'play',startUs:100,endUs:100,audioTrack:1}]),{code:'INVALID_REQUEST'});
});
test('prepare/capture/paint acknowledgments reject arbitrary media and stale-shaped arguments',()=>{
  assert.deepEqual(parseNativePrepare([{assetId,hdrConsent:false}]),{assetId,hdrConsent:false});
  assert.deepEqual(parseNativeCapture([{assetId,frameId:1}]),{assetId,frameId:1});
  assert.deepEqual(parseNativeAck([{assetId,epoch:2,frameId:3,painted:true}]),{assetId,epoch:2,frameId:3,painted:true});
  assert.throws(()=>parseNativeCapture([{assetId,frameId:0}]),{code:'INVALID_REQUEST'});
  assert.throws(()=>parseNativeCapture([{assetId,frameId:1,pts:'999'}]),{code:'INVALID_REQUEST'});
  assert.throws(()=>parseNativeAck([{assetId,epoch:0,frameId:3,painted:true}]),{code:'INVALID_REQUEST'});
  assert.throws(()=>parseNativePrepare([{assetId,hdrConsent:true,executable:'ffmpeg'}]),{code:'INVALID_REQUEST'});
});
