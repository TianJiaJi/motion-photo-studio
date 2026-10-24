import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {ffmpeg,ffprobe} from '../../src/main/media/runner.ts';
test('development media helpers use fixed bundled paths, ignoring PATH and legacy environment overrides',()=>{
  const before=[process.env.FFMPEG_PATH,process.env.FFPROBE_PATH];
  try{
    process.env.FFMPEG_PATH='C:\\untrusted\\ffmpeg.exe';process.env.FFPROBE_PATH='C:\\untrusted\\ffprobe.exe';
    assert.equal(ffmpeg(),resolve('resources/bin/ffmpeg.exe'));assert.equal(ffprobe(),resolve('resources/bin/ffprobe.exe'));
  }finally{
    for(const [index,key] of ['FFMPEG_PATH','FFPROBE_PATH'].entries())if(before[index]===undefined)delete process.env[key];else process.env[key]=before[index];
  }
});
