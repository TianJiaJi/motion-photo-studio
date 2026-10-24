import {randomUUID} from 'node:crypto';
import {mkdir,lstat,opendir,realpath,rmdir,unlink} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {basename,join,resolve,relative,isAbsolute} from 'node:path';
import {AppFailure} from '../errors.ts';
import {CLEANUP_REASONS,type CleanupIssue,type CleanupReason} from '../../shared/cleanup.ts';
import {CleanupFailure,CleanupJournal,JOB_NAME,checkedJson,directoryIdentity,identity,missing,sameDirectory,unlinkedAncestors,unlinkIdentity,writeNewJson} from './cleanup-journal.ts';

// Call only for a file this operation successfully reserved/created, never for an arbitrary input.
export async function unlinkCreatedFile(path:string):Promise<void>{
  try{await unlink(path);}catch(error){if(!missing(error))throw new AppFailure('TEMP_CLEANUP','临时文件被占用，无法完成清理。');}
}
const LEGACY_OWNER='android-motion-photo.jobs.v1';
const OWNER='android-motion-photo.jobs.v2';
export type CleanupStage='create-marker'|'journal'|'contents'|'marker'|'directory';
type Options={checkpoint?:(stage:CleanupStage,directory:string)=>Promise<void>};
type Node={path:string;id:string;directory:boolean};
function reason(error:unknown):CleanupReason{
  if(error instanceof CleanupFailure)return error.reason;
  const code=(error as NodeJS.ErrnoException).code;
  if(code==='EBUSY'||code==='ENOTEMPTY')return 'in-use';
  if(code==='EPERM'||code==='EACCES')return 'permission';
  return 'io';
}
async function retry(operation:()=>Promise<void>):Promise<void>{
  for(let attempt=0;;attempt++){
    try{return await operation();}catch(error){
      if(attempt>=2||!['EBUSY','ENOTEMPTY','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;
      await delay(100*(attempt+1));
    }
  }
}
export class TempFiles {
  readonly root:string;
  private readonly journal:CleanupJournal;
  private readonly options:Options;
  private rootId?:string;
  private readonly problems=new Map<string,CleanupIssue>();
  private readonly removing=new Map<string,Promise<void>>();
  constructor(root:string,options:Options={}){this.root=resolve(root);this.journal=new CleanupJournal(this.root);this.options=options;}
  get issues():CleanupIssue[]{return [...this.problems.values()].map(issue=>({...issue}));}
  private note(job:string,error:unknown):void{
    const code=reason(error);
    this.problems.set(job,{area:basename(this.root),directory:job,reason:code,message:CLEANUP_REASONS[code],retryable:['in-use','permission','io'].includes(code)});
  }
  private async rootReady():Promise<void>{
    const id=await directoryIdentity(this.root);
    if(this.rootId&&this.rootId!==id)throw new CleanupFailure('unsafe-path');this.rootId??=id;
  }
  private job(directory:string):string{
    const rel=relative(this.root,resolve(directory));
    if(isAbsolute(rel)||!JOB_NAME.test(rel)||rel.includes('/')||rel.includes('\\'))throw new CleanupFailure('unsafe-path');return rel;
  }
  private async checkpoint(stage:CleanupStage,directory:string){await this.options.checkpoint?.(stage,directory);}
  async initialize():Promise<string[]>{
    await unlinkedAncestors(this.root,true);await mkdir(this.root,{recursive:true});await this.rootReady();this.problems.clear();
    const jobs=new Set<string>();
    for await(const entry of await opendir(this.root)){
      if(JOB_NAME.test(entry.name))jobs.add(entry.name);
      if(jobs.size>10000)throw new CleanupFailure('unsafe-path');
    }
    try{for(const job of await this.journal.jobs())jobs.add(job);}catch(error){this.note(basename(this.journal.directory),error);}
    for(const job of jobs){try{await this.remove(join(this.root,job));}catch{/* Classified by remove; unknown directories are never adopted. */}}
    const counts=new Map<CleanupReason,number>();for(const issue of this.problems.values())counts.set(issue.reason,(counts.get(issue.reason)??0)+1);
    return [...counts].map(([code,count])=>`${basename(this.root)}：${count} 项缓存未清理；${CLEANUP_REASONS[code]}。`);
  }
  async create():Promise<string>{
    await this.rootReady();const job=`job-${randomUUID()}`,directory=join(this.root,job);
    await mkdir(directory); // An EEXIST failure grants no cleanup authority.
    const id=await directoryIdentity(directory);let recorded=false;
    try{
      // A record also covers an interrupted create before the marker is written, but
      // can recover an unmarked directory ONLY while it is still empty and identical.
      await this.journal.ensure(job,id);recorded=true;await this.checkpoint('create-marker',directory);
      await writeNewJson(join(directory,'.owner.json'),{owner:OWNER,job,root:await realpath(this.root)});
      await this.journal.forget(job);return directory;
    }catch(error){
      try{
        await sameDirectory(directory,id);
        if(await this.empty(directory)){await rmdir(directory);if(recorded)await this.journal.forget(job);}
        else throw new CleanupFailure('unsafe-path');
      }catch(cleanupError){this.note(job,cleanupError);throw new AppFailure('TEMP_CLEANUP','任务目录创建失败且无法安全回滚，已保留恢复信息。',{cause:cleanupError});}
      throw error;
    }
  }
  private async empty(directory:string,exceptMarker=false):Promise<boolean>{
    for await(const entry of await opendir(directory))if(!exceptMarker||entry.name!=='.owner.json')return false;return true;
  }
  private async owner(directory:string,job:string):Promise<string>{
    let data;
    try{data=await checkedJson(join(directory,'.owner.json'),2048,'invalid-marker');}
    catch(error){if(missing(error))throw new CleanupFailure('missing-marker');throw error;}
    if(!data.value||typeof data.value!=='object'||Array.isArray(data.value))throw new CleanupFailure('invalid-marker');
    const value=data.value as {owner?:unknown;job?:unknown;root?:unknown};
    const keys=Object.keys(value).sort().join(',');
    const valid=value.owner===LEGACY_OWNER&&keys==='owner'
      ||value.owner===OWNER&&keys==='job,owner,root'&&value.job===job&&value.root===await realpath(this.root);
    if(!valid)throw new CleanupFailure('invalid-marker');return data.identity;
  }
  private async inventory(directory:string):Promise<Node[]>{
    const result:Node[]=[];
    const walk=async(path:string,depth:number):Promise<void>=>{
      if(depth>32)throw new CleanupFailure('unsafe-path');
      for await(const entry of await opendir(path)){
        if(path===directory&&entry.name==='.owner.json')continue;
        const child=join(path,entry.name),stat=await lstat(child,{bigint:true});
        if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile()||stat.isFile()&&stat.nlink!==1n)throw new CleanupFailure('unsafe-path');
        if(result.length>=10000)throw new CleanupFailure('unsafe-path');
        // Reserve the count before descent; order is reversed for child-first removal.
        result.push({path:child,id:identity(stat),directory:stat.isDirectory()});
        if(stat.isDirectory()){await sameDirectory(child,identity(stat));await walk(child,depth+1);}
      }
    };
    await walk(directory,0);return result.reverse();
  }
  remove(directory:string):Promise<void>{
    let job:string;try{job=this.job(directory);}catch(error){return Promise.reject(error);}
    const active=this.removing.get(job);if(active)return active;
    const result=this.removeOwned(job).then(()=>{this.problems.delete(job);},error=>{this.note(job,error);throw error;}).finally(()=>{this.removing.delete(job);});
    this.removing.set(job,result);return result;
  }
  private async removeOwned(job:string):Promise<void>{
    await this.rootReady();const directory=join(this.root,job),record=await this.journal.read(job);
    let id:string;
    try{id=await directoryIdentity(directory);}catch(error){
      if(missing(error)){if(record)await this.journal.forget(job);return;}throw error;
    }
    if(record&&record.identity!==id)throw new CleanupFailure('invalid-journal');
    let marker:string;
    try{marker=await this.owner(directory,job);}catch(error){
      if(error instanceof CleanupFailure&&error.reason==='missing-marker'&&record&&await this.empty(directory)){
        await retry(async()=>{await this.rootReady();await sameDirectory(directory,id);await rmdir(directory);});
        await this.checkpoint('directory',directory);await this.journal.forget(job);return;
      }
      throw error;
    }
    const nodes=await this.inventory(directory);
    await sameDirectory(directory,id);await this.journal.ensure(job,id);await this.checkpoint('journal',directory);
    for(const node of nodes){
      await retry(async()=>{
        await this.rootReady();await sameDirectory(directory,id);
        if(await this.owner(directory,job)!==marker)throw new CleanupFailure('invalid-marker');
        if(node.directory){await sameDirectory(node.path,node.id);await rmdir(node.path);}
        else await unlinkIdentity(node.path,node.id);
      });
    }
    await this.checkpoint('contents',directory);
    await retry(async()=>{
      await this.rootReady();await sameDirectory(directory,id);
      if(!await this.empty(directory,true)||await this.owner(directory,job)!==marker)throw new CleanupFailure('unsafe-path');
      await unlinkIdentity(join(directory,'.owner.json'),marker);
    });
    await this.checkpoint('marker',directory);
    await retry(async()=>{await this.rootReady();await sameDirectory(directory,id);await rmdir(directory);});
    await this.checkpoint('directory',directory);await this.journal.forget(job);
  }
}
