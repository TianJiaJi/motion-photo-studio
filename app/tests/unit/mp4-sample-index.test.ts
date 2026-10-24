import {test} from 'node:test';
import assert from 'node:assert/strict';
import {open,writeFile} from 'node:fs/promises';
import {tempFiles} from '../helpers.ts';
import {openSource} from '../../src/main/media/source.ts';
import {readMp4SampleIndex,selectMp4Track} from '../../src/main/media/mp4-sample-index.ts';
const atom=(name:string,...parts:Buffer[])=>{const body=Buffer.concat(parts),header=Buffer.alloc(8);header.writeUInt32BE(body.length+8);header.write(name,4,'latin1');return Buffer.concat([header,body]);};
function table(name:string,rows:number[][],version=0){const b=Buffer.alloc(8+rows.reduce((n,row)=>n+row.length*4,0));b[0]=version;b.writeUInt32BE(rows.length,4);let at=8;for(const row of rows)for(const n of row){b.writeUInt32BE(n>>>0,at);at+=4;}return atom(name,b);}
function fixture(options:{wide?:boolean;external?:boolean;badChunk?:boolean;duration64?:bigint;duplicate?:boolean;fragment?:boolean;payloadBytes?:number;pcmSamples?:number}={}){
  const ftyp=atom('ftyp',Buffer.from('isom\0\0\0\0','latin1')),payload=Buffer.alloc(options.payloadBytes??Math.max(14,(options.pcmSamples??0)*4),0xab),mdat=atom('mdat',payload),begin=ftyp.length+8;
  const mvhd=Buffer.alloc(100);mvhd.writeUInt32BE(1000,12);mvhd.writeUInt32BE(60,16);
  const tkhd=Buffer.alloc(84);tkhd[3]=3;tkhd.writeUInt32BE(7,12);
  const mdhd=Buffer.alloc(24);mdhd.writeUInt32BE(1000,12);mdhd.writeUInt32BE(50,16);
  const hdlr=Buffer.alloc(24);hdlr.write('vide',8);
  const entry=Buffer.alloc(78);entry.writeUInt16BE(1,6);const stsd=atom('stsd',Buffer.from([0,0,0,0,0,0,0,1]),atom('avc1',entry));
  const sizes=Buffer.alloc(28);sizes.writeUInt32BE(4,8);[3,4,2,5].forEach((size,i)=>sizes.writeUInt32BE(size,12+i*4));
  const offsetRows=Buffer.alloc(options.wide?24:16);offsetRows.writeUInt32BE(2,4);
  [options.badChunk?0:begin,begin+7].forEach((value,i)=>options.wide?offsetRows.writeBigUInt64BE(BigInt(value),8+i*8):offsetRows.writeUInt32BE(value,8+i*4));
  const stbl=atom('stbl',stsd,atom('stsz',sizes),table('stts',[[2,10],[2,15]]),table('ctts',[[1,0],[1,20],[2,-10]],1),
    table('stsc',[[1,2,1]]),atom(options.wide?'co64':'stco',offsetRows),table('stss',[[1],[4]]));
  const dref=atom('dref',Buffer.from([0,0,0,0,0,0,0,1]),atom('url ',Buffer.from([0,0,0,options.external?0:1])));
  const edit=Buffer.alloc(48);edit[0]=1;edit.writeUInt32BE(2,4);
  edit.writeBigUInt64BE(options.duration64??10n,8);edit.writeBigInt64BE(-1n,16);edit.writeInt16BE(1,24);
  edit.writeBigUInt64BE(40n,28);edit.writeBigInt64BE(5n,36);edit.writeInt16BE(1,44);
  const trak=atom('trak',atom('tkhd',tkhd),atom('edts',atom('elst',edit)),atom('mdia',atom('mdhd',mdhd),atom('hdlr',hdlr),atom('minf',atom('dinf',dref),stbl)));
  const extras:Buffer[]=[];
  if(options.pcmSamples!==undefined){
    const count=options.pcmSamples,audioTkhd=Buffer.from(tkhd),audioMdhd=Buffer.from(mdhd),audioHdlr=Buffer.from(hdlr),audioEntry=Buffer.alloc(28),audioSizes=Buffer.alloc(12);
    audioTkhd.writeUInt32BE(9,12);audioMdhd.writeUInt32BE(48000,12);audioMdhd.writeUInt32BE(count,16);audioHdlr.write('soun',8);audioEntry.writeUInt16BE(1,6);
    audioSizes.writeUInt32BE(4,4);audioSizes.writeUInt32BE(count,8);
    const audioTable=atom('stbl',atom('stsd',Buffer.from([0,0,0,0,0,0,0,1]),atom('ipcm',audioEntry)),atom('stsz',audioSizes),
      table('stts',[[count,1]]),table('stsc',[[1,count,1]]),table('stco',[[begin]]));
    extras.push(atom('trak',atom('tkhd',audioTkhd),atom('mdia',atom('mdhd',audioMdhd),atom('hdlr',audioHdlr),atom('minf',atom('dinf',dref),audioTable))));
  }
  return Buffer.concat([ftyp,mdat,atom('moov',atom('mvhd',mvhd),trak,...extras,...(options.duplicate?[trak]:[]),...(options.fragment?[atom('mvex')]:[]))]);
}
async function withFile(bytes:Buffer,run:(source:Awaited<ReturnType<typeof openSource>>)=>Promise<void>){const temp=await tempFiles();try{const path=temp.file('sample.mp4');await writeFile(path,bytes);await run(await openSource(path));}finally{await temp.cleanup();}}
test('container index preserves decode order, signed composition offsets, VFR durations and raw edits',async()=>{
  for(const wide of [false,true])await withFile(fixture({wide}),async source=>{
    const index=await readMp4SampleIndex(source),track=index.tracks[0]!;
    assert.equal(index.samplePayloadBytesRead,0);assert.equal(track.trackId,7);assert.equal(track.codec,'avc1');assert.equal(track.sampleCount,4);
    assert.deepEqual([0,1,2,3].map(i=>track.sample(i).dts),[0n,10n,20n,35n]);
    assert.deepEqual([0,1,2,3].map(i=>track.sample(i).pts),[0n,30n,10n,25n]);
    assert.deepEqual([0,1,2,3].map(i=>track.sample(i).duration),[10,10,15,15]);
    assert.deepEqual([0,1,2,3].map(i=>track.sample(i).offset),[24n,27n,31n,33n]);
    assert.deepEqual([0,1,2,3].map(i=>track.sample(i).sync),[true,false,false,true]);
    assert.deepEqual(track.edits,[{duration:10n,mediaTime:-1n},{duration:40n,mediaTime:5n}]);
    assert.throws(()=>track.sample(-1),RangeError);assert.throws(()=>track.sample(4),RangeError);assert.throws(()=>track.sample(NaN),RangeError);
  });
});
test('multiple mdat ranges and extended headers reject gaps and chunk spillover',async()=>{
  for(const extended of [false,true])for(const invalid of [undefined,'gap','spill'] as const){
    const original=fixture(),moov=Buffer.from(original.subarray(38)),payload=original.subarray(24,38),position=moov.indexOf('stco','latin1');
    const header=Buffer.alloc(extended?16:8);header.writeUInt32BE(extended?1:15);header.write('mdat',4);if(extended)header.writeBigUInt64BE(23n,8);
    const secondOffset=39+header.length;moov.writeUInt32BE(invalid==='spill'?25:24,position+12);moov.writeUInt32BE(invalid==='gap'?32:secondOffset,position+16);
    const bytes=Buffer.concat([original.subarray(0,16),atom('mdat',payload.subarray(0,7)),atom('free'),header,payload.subarray(7),moov]);
    await withFile(bytes,async source=>{
      if(invalid)await assert.rejects(readMp4SampleIndex(source),{kind:'invalid'});
      else{const track=(await readMp4SampleIndex(source)).tracks[0]!;assert.equal(track.sample(2).offset,BigInt(secondOffset));assert.equal(track.sample(3).offset,BigInt(secondOffset+2));}
    });
  }
});
test('a final zero-sized mdat extends to EOF without hiding preceding movie metadata',async()=>{
  const original=fixture(),moov=Buffer.from(original.subarray(38)),mdat=Buffer.from(original.subarray(16,38)),at=moov.indexOf('stco','latin1'),begin=16+moov.length+8;
  mdat.writeUInt32BE(0);moov.writeUInt32BE(begin,at+12);moov.writeUInt32BE(begin+7,at+16);
  await withFile(Buffer.concat([original.subarray(0,16),moov,mdat]),async source=>assert.equal((await readMp4SampleIndex(source)).tracks[0]!.sample(0).offset,BigInt(begin)));
});
test('track selection uses explicit container ID, never stream ordinal or same-shaped track guesses',async()=>{
  await withFile(fixture(),async source=>{
    const index=await readMp4SampleIndex(source);
    assert.equal(selectMp4Track(index,'0x7','vide').trackId,7);assert.equal(selectMp4Track(index,'7','vide').trackId,7);
    for(const id of [undefined,0,7,'','0x','-1','1e0','0x100000000'])assert.throws(()=>selectMp4Track(index,id,'vide'));
    for(const id of ['0','1','4294967296'])assert.throws(()=>selectMp4Track(index,id,'vide'));
    assert.throws(()=>selectMp4Track(index,'7','soun'));
  });
});
test('fixed-size PCM uses implicit offsets instead of allocating per-sample prefixes',async()=>{
  const count=1_000_001;
  await withFile(fixture({pcmSamples:count}),async source=>{
    const index=await readMp4SampleIndex(source,{indexBytes:2048}),track=selectMp4Track(index,'9','soun');
    assert.equal(track.codec,'ipcm');assert.equal(track.sampleCount,count);assert.equal(track.fixedSampleSize,4);assert.ok(index.indexBytes<2048);
    assert.equal(track.sample(count-1).offset,24n+BigInt(count-1)*4n);assert.equal(track.sample(count-1).dts,BigInt(count-1));
    assert.equal(track.sample(count-1).size,4);assert.equal(track.sample(count-1).chunkIndex,0);
    await assert.rejects(readMp4SampleIndex(source,{fixedSamples:count-1}),{kind:'limit'});
  });
});
test('cancellation scheduled after metadata I/O is delivered during table parsing',async()=>{
  await withFile(fixture(),async source=>{
    const handle=await open(source.path,'r'),proto=Object.getPrototypeOf(handle),original=proto.read;await handle.close();
    const control=new AbortController();let armed=false;
    proto.read=async function(...args:any[]){
      const value:unknown=await Reflect.apply(original,this,args);
      if(args[2]>64&&!armed){armed=true;setImmediate(()=>control.abort());}return value;
    };
    try{await assert.rejects(readMp4SampleIndex(source,{signal:control.signal}),{name:'AbortError'});assert.equal(armed,true);}finally{proto.read=original;}
  });
});
test('64-bit edit fields never round through Number',async()=>{
  await withFile(fixture({duration64:9007199254740995n}),async source=>assert.equal((await readMp4SampleIndex(source)).tracks[0]!.edits[0]!.duration,9007199254740995n));
});
test('fragmented, external references, invalid sample extents and duplicate IDs fail closed',async()=>{
  for(const [options,kind] of [[{fragment:true},'unsupported'],[{external:true},'unsupported'],[{badChunk:true},'invalid'],[{duplicate:true},'invalid']] as const)
    await withFile(fixture(options),source=>assert.rejects(readMp4SampleIndex(source),{kind}));
});
test('metadata/sample/allocation budgets and cancellation are enforced before returning an index',async()=>{
  await withFile(fixture(),async source=>{
    for(const options of [{metadataBytes:8},{indexBytes:8},{samples:3}])await assert.rejects(readMp4SampleIndex(source,options),{kind:'limit'});
    const control=new AbortController();control.abort();await assert.rejects(readMp4SampleIndex(source,{signal:control.signal}),{name:'AbortError'});
  });
});
test('oversized table counts, zero duration, bad references and truncations are rejected',async()=>{
  for(const [name,relative,value] of [['stsz',12,0xffffffff],['stts',16,0],['stsc',20,2],['stss',8,99]] as const){
    const bytes=fixture(),at=bytes.indexOf(name,'latin1');assert.ok(at>0);bytes.writeUInt32BE(value,at+relative);
    await withFile(bytes,source=>assert.rejects(readMp4SampleIndex(source)));
  }
  const bytes=fixture();for(const length of [0,7,bytes.length-1])await withFile(bytes.subarray(0,length),source=>assert.rejects(readMp4SampleIndex(source)));
});
test('source replacement is rejected and parsing does not read mdat payload',async()=>{
  await withFile(fixture({payloadBytes:8*1024*1024}),async source=>{
    // Record actual reads, not only the index's declared payload counter.
    const handle=await open(source.path,'r');const proto=Object.getPrototypeOf(handle),original=proto.read;await handle.close();
    const reads:{position:number;length:number}[]=[];
    proto.read=function(...args:any[]){reads.push({position:args[3],length:args[2]});return Reflect.apply(original,this,args);};
    try{await readMp4SampleIndex(source);}finally{proto.read=original;}
    assert.ok(reads.length>0);for(const read of reads)assert.ok(read.position+read.length<=24||read.position>=24+8*1024*1024,'No read overlaps mdat payload');
    await writeFile(source.path,fixture());await assert.rejects(readMp4SampleIndex(source),{code:'SOURCE_CHANGED'});
  });
});
