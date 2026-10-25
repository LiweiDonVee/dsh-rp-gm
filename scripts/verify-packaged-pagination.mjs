// Runs the public-reader export regressions against the host extracted from the actual tgz.
// Gateway and owner fixtures remain synthetic; this is a packaged adapter probe, not native E2E.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';import {gunzipSync} from 'node:zlib';import {spawnSync} from 'node:child_process';import {tmpdir} from 'node:os';import {join,relative,isAbsolute} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),archive=join(root,'artifacts/dsh-rp-gm-0.1.0.tgz'),bytes=await readFile(archive),tar=gunzipSync(bytes),files=new Map();
for(let offset=0;offset+512<=tar.length;){const header=tar.subarray(offset,offset+512),name=header.subarray(0,100).toString().split('\0')[0];if(!name)break;const size=parseInt(header.subarray(124,136).toString().replace(/\0/g,'').trim(),8)||0;if(['package/dist/host.js','package/package.json'].includes(name))files.set(name,tar.subarray(offset+512,offset+512+size));offset+=512+Math.ceil(size/512)*512;}
for(const name of ['package/dist/host.js','package/package.json'])assert.ok(files.has(name),name);
const staging=await mkdtemp(join(tmpdir(),'dsh-rp-gm-pagination-')),local=relative(tmpdir(),staging);if(isAbsolute(local)||local.startsWith('..')||!local.startsWith('dsh-rp-gm-pagination-'))throw Error('Unexpected owned staging path');
try{
  await writeFile(join(staging,'package.json'),files.get('package/package.json'));await writeFile(join(staging,'host.js'),files.get('package/dist/host.js'));
  process.stdout.write(JSON.stringify({probe:'packaged public-pagination adapter',archive,sha256:createHash('sha256').update(bytes).digest('hex'),hostTarget:'extracted tarball dist/host.js',nativeE2E:false})+'\n');
  const result=spawnSync(process.execPath,['--test',join(root,'tests/transfer-pagination.test.mjs')],{cwd:root,env:{...process.env,GM_PAGINATION_HOST:pathToFileURL(join(staging,'host.js')).href},stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)process.exitCode=result.status??1;
}finally{await rm(staging,{recursive:true,force:true});}
