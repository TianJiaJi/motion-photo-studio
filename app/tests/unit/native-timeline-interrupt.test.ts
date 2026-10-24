import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {tempFiles} from '../helpers.ts';
import {NativeTimeline} from '../../src/main/media/native-timeline.ts';
import type {PreparedNativeMedia} from '../../src/main/media/native-import.ts';
import type {PreviewStatus} from '../../src/shared/native-preview.ts';
import {openSource} from '../../src/main/media/source.ts';
import {AppFailure} from '../../src/main/errors.ts';

for(const code of ['CANCELLED','NATIVE_EXIT'] as const)test(`overlapping epoch stop ${code} is ${code==='CANCELLED'?'replaced without fatal failure':'not swallowed'}`,async()=>{
  const temp=await tempFiles();let timeline:NativeTimeline|undefined;
  try{
    const path=temp.file('source.bin');await writeFile(path,'source');const source=await openSource(path);
    let stops=0,rejectStop!:(error:unknown)=>void,exit!:(code:number)=>void;
    const states:PreviewStatus[]=[];
    const native={
      terminated:new Promise<number>(resolve=>{exit=resolve;}),advanceEpoch(){},
      request(command:{command:string;count?:number}){
        if(command.command==='prefetch'){assert.equal(command.count,2);return Promise.resolve({});}
        assert.equal(command.command,'audioStop');stops++;
        return stops===1?new Promise((_resolve,reject)=>{rejectStop=reject;}):Promise.resolve({});
      },
      async shutdown(){exit(0);},
    };
    const media={native,index:{async close(){}}} as unknown as PreparedNativeMedia;
    timeline=new NativeTimeline('asset',source,media,{frame(){assert.fail('Pause must not invent a frame');},status(value){states.push(value);}});
    const first=timeline.control({assetId:'asset',epoch:1,action:'pause'});
    // Observe both requests before delivering a deterministic transport rejection.
    const firstResult=first.then(()=>null,error=>error);
    const second=timeline.control({assetId:'asset',epoch:2,action:'pause'});
    const secondResult=second.then(()=>null,error=>error);
    rejectStop(new AppFailure(code,'controlled stop failure'));
    const results=await Promise.all([firstResult,secondResult]);
    assert.ok(results[0] instanceof AppFailure);
    if(code==='CANCELLED'){
      assert.equal(results[1],null);assert.equal(stops,2);assert.equal(states.some(state=>state.state==='failed'),false);
    }else{
      assert.ok(results[1] instanceof AppFailure);assert.equal(stops,1);assert.equal(states.some(state=>state.state==='failed'),true);
    }
  }finally{await timeline?.dispose();await temp.cleanup();}
});
