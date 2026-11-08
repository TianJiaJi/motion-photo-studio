import { readFile, writeFile, stat, cp, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [mode, directory] = process.argv.slice(2), root = resolve(directory || '../artifacts/release-engine');
const pkg = JSON.parse(await readFile('package.json','utf8'));
const sourceFile = `MotionPhotoStudio-${pkg.version}-third-party-sources.tar.gz`;
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const pins = JSON.parse(await readFile('release/sources.json','utf8'));
const names = ['ffmpeg.exe','ffprobe.exe'];
if (mode === 'seal') {
  const files = [];
  for (const path of [...names.map(name=>`bundle/bin/${name}`),sourceFile]) files.push({path,size:(await stat(join(root,path))).size,sha256:await sha(join(root,path))});
  if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) throw new Error('Missing CI source commit');
  await writeFile(join(root,'BUILD-MANIFEST.json'),JSON.stringify({schemaVersion:1,commit:process.env.GITHUB_SHA,pins,files},null,2));
} else if (mode === 'install') {
  if (process.env.CI !== 'true' || process.platform !== 'win32') throw new Error('Only the Windows release CI may install this artifact');
  const manifest=JSON.parse(await readFile(join(root,'BUILD-MANIFEST.json'),'utf8'));
  if (manifest.schemaVersion!==1 || manifest.commit!==process.env.GITHUB_SHA || JSON.stringify(manifest.pins)!==JSON.stringify(pins)) throw new Error('Engine artifact source mismatch');
  const expected=[...names.map(name=>`bundle/bin/${name}`),sourceFile];
  if (JSON.stringify(manifest.files.map(row=>row.path))!==JSON.stringify(expected)) throw new Error('Unexpected engine artifact contents');
  for(const file of manifest.files) if((await stat(join(root,file.path))).size!==file.size || await sha(join(root,file.path))!==file.sha256)throw new Error(`Engine/source hash mismatch: ${file.path}`);
  await mkdir('resources/bin',{recursive:true});await mkdir('resources/licenses',{recursive:true});
  for(const name of names)await cp(join(root,'bundle/bin',name),join('resources/bin',name));
  await cp(join(root,'bundle/licenses'),'resources/licenses',{recursive:true});
  const version=execFileSync(resolve('resources/bin/ffmpeg.exe'),['-version'],{encoding:'utf8'}).split(/\r?\n/)[0];
  const match=/^ffmpeg version (.+) Copyright/.exec(version);if(!match)throw new Error('Invalid built engine version');
  const license=execFileSync(resolve('resources/bin/ffmpeg.exe'),['-L'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(!license.includes('GNU General Public License')||!license.includes('version 3'))throw new Error('Unexpected FFmpeg license');
  const binaries=manifest.files.slice(0,2).map((row,index)=>({name:names[index],size:row.size,sha256:row.sha256}));
  await writeFile('resources/engine-manifest.json',JSON.stringify({schemaVersion:1,platform:'win32',arch:'x64',build:match[1],binaries,releaseStatus:'public-preview',provenance:`Source-built in GitHub Actions from ${manifest.commit}; exact component pins and matching source archive in resources/licenses and this release.`},null,2));
  await writeFile('resources/licenses/DISTRIBUTION-STATUS.txt',`Source-built preview; no nonfree FFmpeg components. Corresponding sources:\nhttps://github.com/TianJiaJi/motion-photo-studio/releases/download/v${pkg.version}/${sourceFile}\nSee SOURCE-README.md and THIRD-PARTY-SOURCE-SHA256.txt. Not a legal certification or phone acceptance.\n`);
  const image=JSON.parse(await readFile('resources/licenses/IMAGE-SOURCE-PROVENANCE.json','utf8'));
  if(await sha('node_modules/@img/sharp-win32-x64/lib/libvips-42.dll')!==image.vipsDllSha256)throw new Error('Installed image DLL differs from reviewed source SDK');
  await mkdir('../artifacts/desktop',{recursive:true});
  await cp(join(root,sourceFile),join('../artifacts/desktop',sourceFile));
  await cp(join(root,'BUILD-MANIFEST.json'),'../artifacts/desktop/ENGINE-BUILD-MANIFEST.json');
} else throw new Error('Use seal or install');
