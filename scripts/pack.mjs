import {createHash} from 'node:crypto';import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {dirname,join,resolve,relative,isAbsolute} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
const root=dirname(dirname(fileURLToPath(import.meta.url))),output=resolve(root,'artifacts'),staging=await mkdtemp(join(tmpdir(),'dsh-rp-gm-pack-')),local=relative(tmpdir(),staging);
if(isAbsolute(local)||local.startsWith('..')||!local.startsWith('dsh-rp-gm-pack-'))throw Error('Unexpected staging path');
try{
  await mkdir(output,{recursive:true});for(const file of ['dist','cordis.patch.yml','README.md','LICENSE'])await cp(join(root,file),join(staging,file),{recursive:true});
  const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));for(const key of ['dependencies','devDependencies','peerDependencies','scripts'])delete manifest[key];await writeFile(join(staging,'package.json'),JSON.stringify(manifest,null,2)+'\n');
  const packageCli=process.env.npm_execpath;if(!packageCli)throw Error('Run packaging through pnpm package');
  const result=spawnSync(process.execPath,[packageCli,'pack','--pack-destination',output],{cwd:staging,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)throw Error(`Package manager exited ${result.status}`);
  const name=`${manifest.name}-${manifest.version}.tgz`,hash=createHash('sha256').update(await readFile(join(output,name))).digest('hex');await writeFile(join(output,'SHA256SUMS.txt'),`${hash}  ${name}\n`);
}finally{await rm(staging,{recursive:true,force:true});}
