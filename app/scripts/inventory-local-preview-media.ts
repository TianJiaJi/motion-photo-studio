// Explicitly user-authorized local discovery. Metadata only; never modifies source files or uploads data.
import {lstat,mkdir,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {runProcess} from '../src/main/media/runner.ts';
const root=resolve(`../artifacts/native-preview/local-inventory-${Date.now()}`);await mkdir(root,{recursive:true});
const home=process.env.USERPROFILE;if(!home)throw new Error('Missing Windows user profile');
const queue=[{path:join(home,'Downloads'),depth:0},{path:join(home,'Videos'),depth:0}],candidates:string[]=[];
while(queue.length&&candidates.length<100){
  const directory=queue.shift()!;
  for(const entry of await readdir(directory.path,{withFileTypes:true})){
    if(entry.isSymbolicLink())continue;
    const path=join(directory.path,entry.name);
    if(entry.isDirectory()&&directory.depth<2&&!/Adobe|Preview|cache|node_modules|TestData/i.test(entry.name))queue.push({path,depth:directory.depth+1});
    if(entry.isFile()&&/\.(mp4|mov|mkv|m4v|avi|webm|mts|m2ts)$/i.test(entry.name)&&candidates.length<100)candidates.push(path);
  }
}
const records:unknown[]=[];
for(const path of candidates){
  try{
    const before=await lstat(path);if(!before.isFile()||before.size<1024*1024)continue;
    const result=await runProcess(resolve('resources/bin/ffprobe.exe'),['-v','error','-show_entries','format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,pix_fmt,color_transfer,color_primaries,color_space,sample_rate,channels','-of','json',path],{timeoutMs:10000});
    const after=await lstat(path);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('Source changed during metadata read');
    const metadata=JSON.parse(result.stdout);records.push({path,size:before.size,mtimeMs:before.mtimeMs,...metadata});
  }catch(error){records.push({path,error:String(error)});}
}
await writeFile(join(root,'inventory.json'),JSON.stringify({roots:[join(home,'Downloads'),join(home,'Videos')],metadataOnly:true,limit:100,records},null,2),{flag:'wx'});
console.log(`Private local inventory: ${join(root,'inventory.json')}`);
console.log(`Inspected ${records.length} candidate files; source bytes were not rewritten.`);
