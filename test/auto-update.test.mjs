import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,mkdtemp,rm,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {AutoUpdater,downloadGithub} from '../lib/updater.mjs';
import {snapshotPackage,inspectTarball} from '../lib/archive.mjs';
import {UpdateService,reportHtml} from '../lib/service.mjs';
import {makeDshRunner,resolveDshLauncher} from '../lib/executor.mjs';

const metadata=(version='2.0.0',extra={})=>({name:'example-plugin',version,main:'index.js',dsh:{bundle:{patch:'./cordis.patch.yml'}},repository:'https://github.com/example/plugin',engines:{dsh:'>=0.2.1-rc.2 <0.3.0'},...extra});
const source={owner:'example',repo:'plugin',url:'https://github.com/example/plugin',directory:'',ref:'',provenance:'package-repository'};
async function fixture(t,config={}){
  await mkdir('work/test-temp',{recursive:true});const home=await mkdtemp(join(process.cwd(),'work/test-temp/auto-update-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const profileDir=join(home,'profiles/desktop'),packageDir=join(profileDir,'node_modules/example-plugin'),dataDir=join(home,'plugin-updates/desktop');await mkdir(packageDir,{recursive:true});
  const profile={dependencies:{'example-plugin':'^1.0.0','other-plugin':'1.0.0'},dsh:{profile:{bundles:['other-plugin']}}};
  await writeFile(join(profileDir,'package.json'),JSON.stringify(profile));
  await writeFile(join(profileDir,'cordis.patch.yml'),'[]\n');
  await writePackage(metadata('1.0.0'));
  const row={profile:'desktop',name:'example-plugin',packageName:'example-plugin',installKind:'registry',installationFingerprint:createHash('sha256').update('^1.0.0').digest('hex'),source,currentVersion:'1.0.0',latestVersion:'2.0.0',latestRef:'v2.0.0',upstreamKind:'release',releaseAssets:[],status:'update_available',enabled:false};
  const calls=[];let view=metadata();let failInstall=false,missingEntry=false,failRollback=false;
  async function writePackage(pkg){await writeFile(join(packageDir,'package.json'),JSON.stringify(pkg));await writeFile(join(packageDir,'index.js'),'export const version='+JSON.stringify(pkg.version)+';\n');await writeFile(join(packageDir,'cordis.patch.yml'),'[]\n');}
  const runner=async args=>{
    calls.push(args);
    if(args[2]==='view')return {exitCode:0,stdout:JSON.stringify(view)};
    if(args[2]!=='add')throw new Error('unexpected runner operation');
    const target=args[3],rollback=target==='example-plugin@1.0.0'||target.endsWith('previous.tgz');
    if(rollback&&failRollback)return {exitCode:1,stdout:''};
    let pkg=target.startsWith('example-plugin@')?metadata(target.split('@').at(-1)):inspectTarball(await readFile(target)).manifest;
    const m=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'));m.dependencies['example-plugin']=target.startsWith('example-plugin@')?pkg.version:'file:'+target;await writeFile(join(profileDir,'package.json'),JSON.stringify(m));await writePackage(pkg);
    if(!rollback&&missingEntry)await unlink(join(packageDir,'index.js'));
    return {exitCode:!rollback&&failInstall?1:0,stdout:''};
  };
  const updater=new AutoUpdater({home,dataDir,...config},{runner});
  const report=()=>({plugins:[structuredClone(row)]});
  return {home,profileDir,packageDir,dataDir,profile,row,calls,runner,updater,report,writePackage,setView:v=>{view=v;},failAfterInstall:()=>{failInstall=true;},missingEntry:()=>{missingEntry=true;},failRollback:()=>{failRollback=true;}};
}

test('automatic updates are enabled by default; disable persists and reset restores true',async t=>{
  const f=await fixture(t);assert.equal((await f.updater.policy()).enabled,true);await f.updater.policy('set',false);
  const after=new AutoUpdater({home:f.home,dataDir:f.dataDir});assert.equal((await after.policy()).enabled,false);
  assert.equal((await after.policy('reset')).enabled,true);await f.updater.close();await after.close();
});
test('disabled automatic updating makes no installer or metadata request',async t=>{
  const f=await fixture(t,{autoUpdate:false});const r=await f.updater.run(f.report());assert.equal(r.enabled,false);assert.equal(f.calls.length,0);
});
test('registry update pins exact version, suppresses scripts and preserves other dependencies and disabled state',async t=>{
  const f=await fixture(t);const r=await f.updater.run(f.report());assert.equal(r.updated,1);assert.equal(r.restartRequired,true);
  assert.equal(f.calls[1][3],'example-plugin@2.0.0');assert(f.calls[1].includes('--ignore-scripts'));assert(f.calls[1].includes('--save-exact'));
  const m=JSON.parse(await readFile(join(f.profileDir,'package.json'),'utf8'));assert.equal(m.dependencies['other-plugin'],'1.0.0');assert.deepEqual(m.dsh.profile.bundles,['other-plugin']);
  const history=JSON.parse(await readFile(join(f.dataDir,'update-history.json'),'utf8'));assert.equal(history[0].status,'updated');assert.equal(inspectTarball(await readFile(join(history[0].backup,'previous.tgz'))).manifest.version,'1.0.0');
});
test('local development links and branch-only versions are preserved with explicit reasons',async t=>{
  const f=await fixture(t);
  for(const [change,code] of [[{installKind:'local-link'},'LOCAL_SOURCE_LINK_PRESERVED'],[{upstreamKind:'branch'},'DEVELOPMENT_BRANCH_REQUIRES_MANUAL_UPDATE']]){
    const r=await f.updater.run({plugins:[{...f.row,...change}]});assert.equal(r.results[0].code,code);
  }assert.equal(f.calls.length,0);
});
test('a registry repository mismatch never reaches installation',async t=>{
  const f=await fixture(t);f.setView(metadata('2.0.0',{repository:'https://github.com/other/plugin'}));
  const r=await f.updater.run(f.report());assert.equal(r.results[0].code,'REGISTRY_REPOSITORY_MISMATCH');assert.equal(f.calls.length,1);
});
test('incompatible DSH and Node requirements are refused before installation',async t=>{
  const f=await fixture(t);
  for(const [engines,code] of [[{dsh:'>=9.0.0'},'INCOMPATIBLE_DSH_VERSION'],[{node:'>=99.0.0'},'INCOMPATIBLE_NODE_VERSION']]){
    f.setView(metadata('2.0.0',{engines}));assert.equal((await f.updater.run(f.report())).results[0].code,code);
  }assert(f.calls.every(a=>a[2]==='view'));
});
test('wrong package identity and missing bundle metadata are refused',async t=>{
  const f=await fixture(t);
  for(const [value,code] of [[metadata('2.0.0',{name:'other-plugin'}),'PACKAGE_IDENTITY_MISMATCH'],[metadata('3.0.0'),'PACKAGE_IDENTITY_MISMATCH'],[metadata('2.0.0',{dsh:{}}),'NOT_A_DSH_BUNDLE']]){
    f.setView(value);assert.equal((await f.updater.run(f.report())).results[0].code,code);
  }
});
test('stale install source and local version changes are detected before updating',async t=>{
  const f=await fixture(t);await writeFile(join(f.profileDir,'package.json'),JSON.stringify({...f.profile,dependencies:{...f.profile.dependencies,'example-plugin':'github:example/other'}}));
  assert.equal((await f.updater.run(f.report())).results[0].code,'INSTALL_SOURCE_CHANGED');assert.equal(f.calls.length,0);
  await writeFile(join(f.profileDir,'package.json'),JSON.stringify(f.profile));await f.writePackage(metadata('1.1.0'));
  assert.equal((await f.updater.run(f.report())).results[0].code,'LOCAL_VERSION_CHANGED');
});
test('failed installation after changing the installed version restores the old registry version',async t=>{
  const f=await fixture(t);f.failAfterInstall();const r=await f.updater.run(f.report());assert.equal(r.failed,1);assert.equal(r.results[0].status,'rolled_back');assert.equal(r.results[0].installedVersion,'1.0.0');assert.equal(f.calls.at(-1)[3],'example-plugin@1.0.0');
});
test('missing installed entry triggers rollback instead of reporting success',async t=>{
  const f=await fixture(t);f.missingEntry();const r=await f.updater.run(f.report());assert.equal(r.results[0].status,'rolled_back');assert.equal(r.results[0].code,'READY_TO_RUN_ENTRY_MISSING');
});
test('rollback failure is durable and prevents blindly retrying that plugin',async t=>{
  const f=await fixture(t);f.failAfterInstall();f.failRollback();const r=await f.updater.run(f.report());assert.equal(r.results[0].status,'needs_attention');
  const calls=f.calls.length;assert.equal((await f.updater.run(f.report())).results[0].code,'PREVIOUS_UPDATE_NEEDS_ATTENTION');assert.equal(f.calls.length,calls);
});
test('an already-held update lock blocks the second instance without installer work',async t=>{
  const f=await fixture(t);await mkdir(join(f.home,'plugin-updates'),{recursive:true});await writeFile(join(f.home,'plugin-updates/auto-update.lock'),JSON.stringify({pid:process.pid,token:'synthetic'}));
  assert.equal((await f.updater.run(f.report())).results[0].code,'UPDATE_BUSY');assert.equal(f.calls.length,0);
});
test('interrupted write-ahead history is reconciled against installed files',async t=>{
  const f=await fixture(t);await mkdir(f.dataDir,{recursive:true});await writeFile(join(f.dataDir,'update-history.json'),JSON.stringify([{profile:'desktop',name:'example-plugin',from:'0.9.0',to:'1.0.0',status:'installing'}]));
  await f.updater.load();await f.updater.reconcile();assert.equal(f.updater.history[0].status,'updated');assert.equal(f.updater.history[0].code,'RECOVERED_COMPLETED_INSTALL');
});
test('ready-to-install snapshots retain package bytes and reject unsafe tar paths',async t=>{
  const f=await fixture(t);const tgz=await snapshotPackage(f.packageDir),view=inspectTarball(tgz);assert.equal(view.manifest.version,'1.0.0');assert(view.files.has('index.js'));
  const tar=gunzipSync(tgz),header=tar.subarray(0,512);header.fill(0,0,100);Buffer.from('package/../escape').copy(header);header.fill(32,148,156);const sum=header.reduce((a,b)=>a+b,0);Buffer.from(sum.toString(8).padStart(6,'0')+'\0 ').copy(header,148);
  assert.throws(()=>inspectTarball(gzipSync(tar)),/UNSAFE_ARCHIVE_PATH/);
});
test('a GitHub package archive is verified, staged and installed without scripts',async t=>{
  const f=await fixture(t);const temp=join(f.home,'upstream');await mkdir(temp);await writeFile(join(temp,'package.json'),JSON.stringify(metadata()));await writeFile(join(temp,'index.js'),'export const ready=true;');await writeFile(join(temp,'cordis.patch.yml'),'[]');
  const data=await snapshotPackage(temp);f.updater.dependencies.download=async url=>{assert.equal(url,'https://github.com/example/plugin/archive/refs/tags/v2.0.0.tar.gz');return data;};
  f.row.installKind='github';const r=await f.updater.run(f.report());assert.equal(r.updated,1);assert(f.calls[0][3].endsWith('.tgz'));assert(f.calls[0].includes('--ignore-scripts'));
});
test('release asset digest mismatch prevents any installer invocation',async t=>{
  const f=await fixture(t);f.row.installKind='tarball';f.row.releaseAssets=[{name:'example-plugin-2.0.0.tgz',id:12,digest:'sha256:wrong'}];f.updater.dependencies.download=async()=>Buffer.from('incorrect');
  assert.equal((await f.updater.run(f.report())).results[0].code,'ASSET_DIGEST_MISMATCH');assert.equal(f.calls.length,0);
});
test('unpackaged monorepo sources need a package-specific release artifact',async t=>{
  const f=await fixture(t);f.row.installKind='github';f.row.source={...source,directory:'packages/plugin'};assert.equal((await f.updater.run(f.report())).results[0].code,'MONOREPO_PACKAGE_ASSET_REQUIRED');
});
test('download token stays on GitHub API when redirected to a release asset host',async()=>{
  let call=0;const payload=Buffer.from('synthetic');const result=await downloadGithub('https://api.github.com/repos/example/plugin/releases/assets/1',{token:'SYNTHETIC_TOKEN',request:async(url,opts)=>{call++;if(call===1){assert.equal(opts.headers.Authorization,'Bearer SYNTHETIC_TOKEN');return{status:302,headers:{location:'https://release-assets.githubusercontent.com/synthetic'}};}assert(!opts.headers.Authorization);return{status:200,headers:{},data:payload};}});assert.equal(result,payload);
});
test('artifact download rejects untrusted redirect hosts',async()=>{
  await assert.rejects(downloadGithub('https://api.github.com/repos/example/plugin/releases/assets/1',{request:async()=>({status:302,headers:{location:'https://evil.test/archive.tgz'}})}),/UNTRUSTED_DOWNLOAD_URL/);
});
test('service automatic cycle installs once, persists outcomes and reports observed version',async t=>{
  const f=await fixture(t);const service=new UpdateService({home:f.home,dataDir:f.dataDir},{runner:f.runner,scan:async()=>({rows:[{...f.row,currentVersion:'1.0.0'}],warnings:[],scope:'current-profile'}),client:{request:async url=>({status:200,headers:{},data:url.includes('/releases?')?[{tag_name:'v2.0.0'}]:{type:'file',encoding:'base64',content:Buffer.from(JSON.stringify(metadata())).toString('base64')}})}});
  const [a,b]=await Promise.all([service.cycle(),service.cycle()]);assert.equal(a,b);assert.equal(a.autoUpdate.updated,1);assert.equal(a.plugins[0].currentVersion,'2.0.0');assert.equal(a.updates,0);
  assert((await readFile(join(f.dataDir,'latest.html'),'utf8')).includes('已安装，需重新加载'));await service.close();
});
test('read-only check remains read-only even when automatic updating is enabled',async t=>{
  const f=await fixture(t);const service=new UpdateService({home:f.home,dataDir:f.dataDir},{runner:f.runner,scan:async()=>({rows:[],warnings:[],scope:'current-profile'})});await service.check();assert.equal(f.calls.length,0);await service.close();
});
test('unavailable official launcher is explicit and never invokes an alternate shell',()=>{
  assert.equal(resolveDshLauncher(),null);assert.equal(makeDshRunner(),null);
});

test('installer resolves a sibling desktop host from the real dsh package anchor',async t=>{
  const f=await fixture(t),anchor=join(f.home,'runtime/node_modules/@deepseek-ai/dsh/package.json'),cli=join(f.home,'runtime/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
  await mkdir(join(f.home,'runtime/node_modules/@deepseek-ai/dsh'),{recursive:true});await mkdir(join(f.home,'runtime/node_modules/@deepseek-ai/dsh-desktop-host/lib'),{recursive:true});await writeFile(anchor,'{}');await writeFile(cli,'console.log("synthetic")');
  const launcher=resolveDshLauncher(anchor);assert.equal(launcher.args.at(-1),cli);assert.equal(launcher.command,process.execPath);
});
test('GitHub PAX metadata is supported while unsafe path overrides are rejected',async t=>{
  const f=await fixture(t),original=gunzipSync(await snapshotPackage(f.packageDir));
  function prefix(key,value){let length=key.length+value.length+4;while(String(length).length+key.length+value.length+3!==length)length=String(length).length+key.length+value.length+3;const data=Buffer.from(`${length} ${key}=${value}\n`);const header=Buffer.from(original.subarray(0,512));header.fill(0,0,100);Buffer.from('pax_global_header').copy(header);header[156]=key==='path'?120:103;header.fill(0,124,136);Buffer.from(data.length.toString(8).padStart(11,'0')+'\0').copy(header,124);header.fill(32,148,156);Buffer.from(header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ').copy(header,148);return gzipSync(Buffer.concat([header,data,Buffer.alloc((512-data.length%512)%512),original]));}
  assert.equal(inspectTarball(prefix('comment','synthetic commit')).manifest.version,'1.0.0');assert.throws(()=>inspectTarball(prefix('path','package/../escape')),/UNSAFE_ARCHIVE_PATH/);
});
test('closing during installation waits for its outcome and skips subsequent candidates',async t=>{
  const f=await fixture(t);let began,release;const started=new Promise(r=>began=r),gate=new Promise(r=>release=r);f.updater.dependencies.runner=async args=>{if(args[2]==='add'){began();await gate;}return f.runner(args);};
  const operation=f.updater.run({plugins:[...f.report().plugins,{...f.row,name:'another-plugin'}]});await started;let closed=false;const closing=f.updater.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);release();const report=await operation;await closing;assert.equal(report.updated,1);assert.equal(report.results.length,1);
});
