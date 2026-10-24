import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {resourceSnapshot,checkPackagedResources} from './lib/package-resources.ts';

if(process.argv.slice(2).some(arg=>arg!=='--dir'))throw new Error('Only the --dir packaging switch is accepted');
const expected=await resourceSnapshot(resolve('resources'));
const tag=new Date().toISOString().replace(/[-:.TZ]/g,'')+'-'+randomUUID().slice(0,8);
const parent=resolve('../artifacts/desktop');await mkdir(parent,{recursive:true});
const output=join(parent,`native-internal-${tag}`);await mkdir(output);
await writeFile(join(output,'INTERNAL-BUILD.txt'),'Internal development build. Not approved for public redistribution.\nA package/resource check is not clean-machine, hardware decode, real-material or phone acceptance.\n',{flag:'wx'});
console.log(`Unique internal package output: ${output}`);
try{
  await new Promise<void>((done,reject)=>{
    const child=spawn(process.execPath,[resolve('node_modules/electron-builder/cli.js'),'--win','--x64',
      ...(process.argv.includes('--dir')?['--dir']:[]),`-c.directories.output=${output}`,'--publish','never'],
      {shell:false,windowsHide:true,stdio:'inherit'});
    child.once('error',reject);child.once('close',code=>code===0?done():reject(new Error(`electron-builder exited ${code}`)));
  });
  const resources=join(output,'win-unpacked','resources');
  const result=await checkPackagedResources(resources,expected);
  await writeFile(join(output,'RESOURCE-VERIFICATION.json'),JSON.stringify({resources,...result},null,2),{flag:'wx',flush:true});
  console.log(`Packaged resources verified: ${resources}`);
}catch(error){
  await writeFile(join(output,'BUILD-FAILURE.json'),JSON.stringify({error:String(error)},null,2),{flag:'wx',flush:true});
  throw error; // Keep partial output and evidence; never substitute an older package.
}
