// Explicit local selection only. Measures index parsing, NOT first-frame or playable latency.
// Packet oracles and full-file hashes happen outside timed index reads. No source writes.
import assert from 'node:assert/strict';
import {mkdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {readMp4SampleIndex} from '../src/main/media/mp4-sample-index.ts';
import {openSource,assertSource} from '../src/main/media/source.ts';
import {probeMedia} from '../src/main/media/probe.ts';
import {sha256} from '../src/main/motion/io.ts';
import {verifyMp4PacketIndex} from './lib/mp4-index-oracle.ts';
if(process.argv.length!==3)throw new Error('Usage: node scripts/measure-container-index.ts <explicit-local-selection.json>');
const manifestPath=resolve(process.argv[2]!);if((await stat(manifestPath)).size>65536)throw new Error('Selection exceeds bound');
const manifest=await readFile(manifestPath,'utf8');if(manifest.length>65536)throw new Error('Selection exceeds bound');
const selection=JSON.parse(manifest) as {cases:{name:string;path:string}[]};
if(!Array.isArray(selection.cases)||selection.cases.length<1||selection.cases.length>8)throw new Error('Bounded explicit selection required');
const roots=await Promise.all(['Downloads','Videos'].map(name=>realpath(join(process.env.USERPROFILE!,name))));
const root=resolve(`../artifacts/native-preview/container-index-${Date.now()}`);await mkdir(root,{recursive:true});
const reports:any[]=[],ffprobe=resolve('resources/bin/ffprobe.exe');
const json=(value:unknown)=>JSON.stringify(value,(_key,value)=>typeof value==='bigint'?value.toString():value,2);
for(const entry of selection.cases){
  if(typeof entry.name!=='string'||! /^[a-z0-9-]{1,64}$/.test(entry.name)||reports.some(row=>row.name===entry.name))throw new Error('Invalid/duplicate case name');
  const path=await realpath(entry.path);if(!roots.some(root=>path.toLowerCase().startsWith((root+sep).toLowerCase())))throw new Error('Source outside authorized roots');
  const source=await openSource(path),report:any={name:entry.name,path,indexReadMs:[],limitations:['Index timing only; no decoder/playback measurement',
    'OS cache state uncontrolled; repeated reads are not cold starts','Compressed samples and grouped PCM packets are not proof of decoded-frame identity',
    'Oracle covers one media edit with optional integral leading empty edits; unsupported mappings fail explicitly']};reports.push(report);
  try{
    let index:Awaited<ReturnType<typeof readMp4SampleIndex>>|undefined;
    for(let pass=0;pass<3;pass++){const began=performance.now();index=await readMp4SampleIndex(source);report.indexReadMs.push(performance.now()-began);}
    assert.ok(index);report.metadataBytes=index.metadataBytes;report.indexBytes=index.indexBytes;report.samplePayloadBytesRead=index.samplePayloadBytesRead;
    report.sourceSha256=await sha256(path);const probe=await probeMedia(path,{executable:ffprobe});
    report.tracks=index.tracks.map(track=>({trackId:track.trackId,handler:track.handler,codec:track.codec,sampleCount:track.sampleCount,
      fixedSampleSize:track.fixedSampleSize,timescale:track.timescale,edits:track.edits}));
    const began=performance.now();report.oracle=await verifyMp4PacketIndex({index,streams:probe.streams,source:path,ffprobe});report.oracleMs=performance.now()-began;
    report.status=report.oracle.passed?'passed':'mismatch';if(report.status!=='passed')process.exitCode=1;
  }catch(error){report.status='failed';report.error=String(error);process.exitCode=1;}
  finally{
    try{
      await assertSource(source);report.sourceFingerprintUnchanged=true;
      if(report.sourceSha256){report.sourceHashUnchanged=await sha256(path)===report.sourceSha256;if(!report.sourceHashUnchanged)throw new Error('Source hash changed');}
    }catch(error){report.status='failed';report.sourceError=String(error);process.exitCode=1;}
    await writeFile(join(root,`${entry.name}.json`),json(report),{flag:'wx'});
    console.log(`${entry.name}: ${report.status}; index ms ${report.indexReadMs.map((n:number)=>n.toFixed(2)).join('/')}; mismatches ${JSON.stringify(report.oracle?.mismatchCounts??{})}`);
  }
}
await writeFile(join(root,'summary.json'),json({scope:'Local read-only container metadata plus raw/edit-applied packet verification, not application playback acceptance',reports}),{flag:'wx'});
console.log(`Container index evidence: ${root}`);
