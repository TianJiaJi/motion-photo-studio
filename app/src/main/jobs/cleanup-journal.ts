import {lstat,mkdir,open,opendir,realpath,unlink} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {AppFailure} from '../errors.ts';
import {CLEANUP_REASONS,type CleanupReason} from '../../shared/cleanup.ts';

export const JOB_NAME=/^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER='motion-photo-studio.cleanup.v1';
export class CleanupFailure extends AppFailure {
  readonly reason:CleanupReason;
  constructor(reason:CleanupReason,options?:ErrorOptions){super('TEMP_CLEANUP',CLEANUP_REASONS[reason],options);this.reason=reason;}
}
export function missing(error:unknown):boolean{return (error as NodeJS.ErrnoException).code==='ENOENT';}
export function identity(stat:BigIntStats):string{return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;}
// Do not traverse a junction in any existing ancestor, including before mkdir.
// These checks defend against detected replacement, not a hostile privileged process
// continuously racing path-based Windows operations (which would require handle-relative APIs).
export async function unlinkedAncestors(path:string,allowMissing=false):Promise<void>{
  let cursor=resolve(path);
  for(;;){
    try{const stat=await lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink())throw new CleanupFailure('unsafe-path');}
    catch(error){if(!allowMissing||!missing(error))throw error;}
    const parent=dirname(cursor);if(parent===cursor)return;cursor=parent;
  }
}
export async function directoryIdentity(path:string):Promise<string>{
  await unlinkedAncestors(path);const stat=await lstat(path,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new CleanupFailure('unsafe-path');return identity(stat);
}
export async function sameDirectory(path:string,expected:string):Promise<void>{
  if(await directoryIdentity(path)!==expected)throw new CleanupFailure('unsafe-path');
}
export async function checkedJson(path:string,limit:number,reason:CleanupReason):Promise<{value:unknown;identity:string}>{
  const before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(limit))throw new CleanupFailure(reason);
  const file=await open(path,'r');
  try{
    const stat=await file.stat({bigint:true});
    if(identity(stat)!==identity(before)||stat.size!==before.size||stat.size>BigInt(limit)||stat.nlink!==1n)throw new CleanupFailure(reason);
    const buffer=Buffer.alloc(limit+1);let length=0;
    while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}
    const after=await file.stat({bigint:true});
    if(length!==Number(stat.size)||after.size!==stat.size||after.mtimeNs!==stat.mtimeNs)throw new CleanupFailure(reason);
    try{return {value:JSON.parse(buffer.subarray(0,length).toString('utf8')),identity:identity(stat)};}
    catch(error){throw new CleanupFailure(reason,{cause:error});}
  }finally{await file.close();}
}
export async function unlinkIdentity(path:string,expected:string):Promise<void>{
  await unlinkedAncestors(dirname(path));
  const stat=await lstat(path,{bigint:true});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||identity(stat)!==expected)throw new CleanupFailure('unsafe-path');
  await unlink(path);
}
// A failed exclusive reservation never authorizes deleting an existing record.
export async function writeNewJson(path:string,value:unknown):Promise<void>{
  const parent=dirname(path),parentId=await directoryIdentity(parent);
  const file=await open(path,'wx');let id:string|undefined,failure:unknown;
  try{id=identity(await file.stat({bigint:true}));await file.writeFile(JSON.stringify(value));await file.sync();}catch(error){failure=error;}
  try{await file.close();}catch(error){failure??=error;}
  if(failure){
    if(id){await sameDirectory(parent,parentId);await unlinkIdentity(path,id);}
    throw failure;
  }
}
export type CleanupRecord={owner:string;root:string;rootIdentity:string;job:string;identity:string};

// Journal is a sibling of the cache root so an interrupted workspace deletion
// cannot erase its authority. Records never carry arbitrary file paths.
export class CleanupJournal {
  readonly root:string;
  readonly directory:string;
  constructor(root:string){this.root=resolve(root);this.directory=`${this.root}.cleanup-journal`;}
  private path(job:string):string{if(!JOB_NAME.test(job))throw new CleanupFailure('unsafe-path');return join(this.directory,`${job}.json`);}
  private async existing():Promise<boolean>{
    await directoryIdentity(this.root);
    try{await directoryIdentity(this.directory);return true;}catch(error){if(missing(error))return false;throw error;}
  }
  async jobs():Promise<string[]>{
    if(!await this.existing())return [];
    const jobs:string[]=[];
    for await(const entry of await opendir(this.directory)){
      const name=entry.name.endsWith('.json')?entry.name.slice(0,-5):'';
      if(!JOB_NAME.test(name))continue;
      if(jobs.length>=10000)throw new CleanupFailure('invalid-journal');
      jobs.push(name);
    }
    return jobs;
  }
  private async load(job:string):Promise<{record:CleanupRecord;fileIdentity:string}|undefined>{
    const path=this.path(job);if(!await this.existing())return undefined;
    let data;
    try{data=await checkedJson(path,8192,'invalid-journal');}catch(error){if(missing(error))return undefined;throw error;}
    const value=data.value;
    if(!value||typeof value!=='object'||Array.isArray(value))throw new CleanupFailure('invalid-journal');
    const record=value as CleanupRecord;
    if(Object.keys(record).sort().join(',')!=='identity,job,owner,root,rootIdentity'||record.owner!==OWNER||record.job!==job
      ||record.root!==await realpath(this.root)||record.rootIdentity!==await directoryIdentity(this.root)
      ||typeof record.identity!=='string'||!/^\d+:\d+:\d+$/.test(record.identity))throw new CleanupFailure('invalid-journal');
    return {record,fileIdentity:data.identity};
  }
  async read(job:string):Promise<CleanupRecord|undefined>{return (await this.load(job))?.record;}
  async ensure(job:string,jobIdentity:string):Promise<void>{
    const path=this.path(job),existing=await this.read(job);
    if(existing){if(existing.identity!==jobIdentity)throw new CleanupFailure('invalid-journal');return;}
    await unlinkedAncestors(this.directory,true);
    try{await mkdir(this.directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    await directoryIdentity(this.directory);
    const record:CleanupRecord={owner:OWNER,root:await realpath(this.root),rootIdentity:await directoryIdentity(this.root),job,identity:jobIdentity};
    try{await writeNewJson(path,record);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const raced=await this.read(job);if(!raced||raced.identity!==jobIdentity)throw new CleanupFailure('invalid-journal');
    }
  }
  async forget(job:string):Promise<void>{
    const data=await this.load(job);if(!data)return;
    await unlinkIdentity(this.path(job),data.fileIdentity);
  }
}
