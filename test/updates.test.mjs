import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { githubSource, safeDirectory, scanInstalled } from '../lib/inventory.mjs';
import { GitHubClient, CheckError, requestJson } from '../lib/github.mjs';
import { checkPlugin } from '../lib/versions.mjs';
import { UpdateService, reportHtml } from '../lib/service.mjs';
import { nextAutomaticDelay } from '../lib/schedule.mjs';

const b64 = object => ({type:'file',encoding:'base64',content:Buffer.from(JSON.stringify(object)).toString('base64')});
const row = (extra={})=>({profile:'synthetic',name:'example-plugin',packageName:'example-plugin',currentVersion:'1.2.0',enabled:true,source:{owner:'example',repo:'plugin',url:'https://github.com/example/plugin',directory:'',ref:'',provenance:'package-repository'},...extra});
const client = (handler,options={})=>new GitHubClient({request:async url=>({status:200,headers:{},data:handler(new URL(url).pathname+new URL(url).search)}),...options});
function releaseFixture(version='1.3.0',name='example-plugin') {
  return path=>path.includes('/releases?') ? [{tag_name:'v'+version,draft:false,prerelease:false}] : path.includes('/contents/') ? b64({name,version}) : [];
}
async function fixture(t) {
  await mkdir('work/test-temp',{recursive:true});
  const dir=await mkdtemp(join(process.cwd(),'work/test-temp/dsh-updates-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true})); return dir;
}
async function installed(home,profile,name,pkg,spec='^1.0.0') {
  const dir=join(home,'profiles',profile); await mkdir(join(dir,'node_modules',name),{recursive:true});
  let manifest={name:'dsh-profile-'+profile,dependencies:{},dsh:{profile:{bundles:[]}}};
  try{manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));}catch{}
  manifest.dependencies[name]=spec;manifest.dsh.profile.bundles.push(name);
  await writeFile(join(dir,'package.json'),JSON.stringify(manifest));
  await writeFile(join(dir,'node_modules',name,'package.json'),JSON.stringify({name,version:'1.0.0',...pkg}));
  return join(dir,'node_modules',name);
}

test('GitHub source recognizes HTTPS, Git, SSH, shorthand and archive forms',()=>{
  for(const spec of ['git+https://github.com/example/plugin.git#v1.0.0','git@github.com:example/plugin.git','ssh://git@github.com/example/plugin.git','github:example/plugin#main','example/plugin','https://github.com/example/plugin/archive/refs/tags/v1.0.0.tar.gz']) assert.equal(githubSource(spec)?.url,'https://github.com/example/plugin');
});
test('sources reject look-alike hosts, credentials, arbitrary pages and malformed inputs',()=>{
  for(const spec of ['https://github.com.evil.test/example/plugin','https://user:secret@github.com/example/plugin','http://github.com/example/plugin','https://github.com/example/plugin/issues/1','file:///example/plugin','npm:example','https://github.com/example','https://github.com:8443/example/plugin',null]) assert.equal(githubSource(spec),null);
});
test('monorepo directory rejects traversal and URL ambiguity',()=>{
  assert.equal(safeDirectory('packages/plugin'),'packages/plugin'); assert.equal(safeDirectory(''),'');
  for(const p of ['../private','/etc','D:/private','packages/../../x','packages\\x','packages/x?ref=main','./../secret','a//b']) assert.throws(()=>safeDirectory(p));
});
test('inventory scans all profiles and preserves disabled direct installs',async t=>{
  const home=await fixture(t);
  await installed(home,'desktop','example-plugin',{repository:'github:example/plugin'});
  await installed(home,'qqbot','other-plugin',{repository:'https://github.com/example/other'});
  const path=join(home,'profiles/qqbot/package.json');const m=JSON.parse(await readFile(path,'utf8'));m.dsh.profile.bundles=[];await writeFile(path,JSON.stringify(m));
  const all=await scanInstalled({home});assert.equal(all.rows.length,2);assert.equal(all.rows[1].enabled,false);
  assert.equal((await scanInstalled({home,allProfiles:false})).rows.length,1);
});
test('explicit original GitHub install source takes precedence over manifest repository',async t=>{
  const home=await fixture(t);await installed(home,'desktop','example-plugin',{repository:'github:fork/plugin'},'github:original/plugin#main');
  const p=(await scanInstalled({home})).rows[0];assert.equal(p.source.owner,'original');assert.equal(p.source.provenance,'install-source');
});
test('local Git origin is recognized without executing Git',async t=>{
  const home=await fixture(t),dir=await installed(home,'desktop','example-plugin',{},'link:some-local-folder');
  await mkdir(join(dir,'.git'));await writeFile(join(dir,'.git/config'),'[remote "origin"]\n  url = git@github.com:example/original.git\n');
  const p=(await scanInstalled({home})).rows[0];assert.equal(p.source.repo,'original');assert.equal(p.source.provenance,'git-origin');
});
test('missing repository is reported; homepage is not guessed as original source',async t=>{
  const home=await fixture(t);await installed(home,'desktop','example-plugin',{homepage:'https://github.com/example/plugin'});
  assert.equal((await scanInstalled({home})).rows[0].issue,'NO_GITHUB_SOURCE');
});
test('configuration can supply a scoped repository and monorepo directory',async t=>{
  const home=await fixture(t);await installed(home,'desktop','example-plugin',{});
  const p=(await scanInstalled({home,repositories:[{packageName:'example-plugin',repository:'github:example/mono',directory:'packages/plugin',profile:'desktop'}]})).rows[0];
  assert.equal(p.source.directory,'packages/plugin');assert.equal(p.source.provenance,'configuration');
});
test('a missing installed package is not mistaken for current',async t=>{
  const home=await fixture(t);const dir=join(home,'profiles/desktop');await mkdir(dir,{recursive:true});await writeFile(join(dir,'package.json'),JSON.stringify({dependencies:{'missing-plugin':'1.0.0'}}));
  assert.equal((await scanInstalled({home})).rows[0].issue,'PACKAGE_NOT_INSTALLED');
});
test('release is validated against upstream package name and version',async()=>{
  const result=await checkPlugin(row(),client(releaseFixture()));assert.equal(result.status,'update_available');assert.equal(result.latestVersion,'1.3.0');assert.equal(result.upstreamKind,'release');
});
test('semantic ordering handles 1.10 versus 1.9',async()=>{
  const r=await checkPlugin(row({currentVersion:'1.9.0'}),client(releaseFixture('1.10.0')));assert.equal(r.status,'update_available');
});
test('equal versions, local-ahead versions and invalid local versions are distinguished',async()=>{
  for(const [currentVersion,status] of [['1.3.0','version_current'],['2.0.0','local_ahead'],['development','unknown_current_version']]) assert.equal((await checkPlugin(row({currentVersion}),client(releaseFixture()))).status,status);
});
test('draft and prerelease releases are excluded by default',async()=>{
  const handler=path=>path.includes('/releases?') ? [{tag_name:'v9.0.0',draft:true},{tag_name:'v2.0.0-rc.1',prerelease:true},{tag_name:'v1.3.0'}] : path.includes('ref=v1.3.0') ? b64({name:'example-plugin',version:'1.3.0'}) : null;
  assert.equal((await checkPlugin(row(),client(handler))).latestVersion,'1.3.0');
});
test('pre-release opt-in compares semantic prerelease versions',async()=>{
  const handler=path=>path.includes('/releases?') ? [{tag_name:'v2.0.0-rc.2',prerelease:true}] : b64({name:'example-plugin',version:'2.0.0-rc.2'});
  const r=await checkPlugin(row({currentVersion:'2.0.0-rc.1'}),client(handler),{includePrereleases:true});assert.equal(r.status,'update_available');
});
test('package mismatch never yields an update',async()=>{
  const r=await checkPlugin(row(),client(releaseFixture('99.0.0','unrelated-plugin')));assert.equal(r.status,'uncheckable');assert.equal(r.issue,'UPSTREAM_PACKAGE_NOT_FOUND');
});
test('monorepo uses repository.directory and package-specific tags',async()=>{
  const seen=[];const handler=path=>{seen.push(path);return path.includes('/releases?') ? [{tag_name:'unrelated@9.0.0'},{tag_name:'example-plugin@1.4.0'}] : path.includes('/contents/packages/plugin/package.json') ? b64({name:'example-plugin',version:'1.4.0'}) : null;};
  const r=await checkPlugin(row({source:{...row().source,directory:'packages/plugin'}}),client(handler));assert.equal(r.latestVersion,'1.4.0');assert(seen.some(p=>p.includes('/contents/packages/plugin/package.json')));
});
test('tag fallback works when no Release exists',async()=>{
  const handler=path=>path.includes('/releases?') ? [] : path.includes('/tags?') ? [{name:'v1.4.0'}] : b64({name:'example-plugin',version:'1.4.0'});
  assert.equal((await checkPlugin(row(),client(handler))).upstreamKind,'tag');
});
test('branch fallback reports development version explicitly',async()=>{
  const handler=path=>path.includes('/contents/') ? b64({name:'example-plugin',version:'1.5.0'}) : [];
  const r=await checkPlugin(row(),client(handler));assert.equal(r.status,'update_available');assert.equal(r.upstreamKind,'branch');assert.match(r.note,/尚未确认正式发布/);
});
test('branch refs are encoded while fixed tags check newer upstream versions',async()=>{
  for(const [ref,query] of [['feature/new','?ref=feature%2Fnew'],['v1.2.0','']]){
    const seen=[];const c=client(path=>{seen.push(path);return path.includes('/contents/') ? b64({name:'example-plugin',version:'1.5.0'}) : [];});
    await checkPlugin(row({source:{...row().source,ref}}),c);assert(seen.includes('/repos/example/plugin/contents/package.json'+query));
  }
});
test('HTTP timeout is reported as failure and does not leak remote error strings',async()=>{
  const c=new GitHubClient({request:async()=>{throw new Error('secret-url-and-token');}});const r=await checkPlugin(row(),c);assert.equal(r.status,'check_failed');assert(!JSON.stringify(r).includes('secret-url'));
});
test('ETag 304 reuses saved content and refreshes its timestamp',async()=>{
  let time=1,requests=0;const state={};const c=new GitHubClient({state,now:()=>time,request:async(_url,options)=>{requests++;if(requests===1)return{status:200,headers:{etag:'test-etag'},data:[]};assert.equal(options.headers['If-None-Match'],'test-etag');return{status:304,headers:{}};}});
  await c.get('/repos/example/plugin/releases');time+=1000000;assert.deepEqual(await c.get('/repos/example/plugin/releases',{refresh:true}),[]);assert.equal(state.cache['/repos/example/plugin/releases'].time,time);
});
test('concurrent same-endpoint checks share one HTTP request',async()=>{
  let count=0;const c=new GitHubClient({request:async()=>{count++;return{status:200,headers:{},data:[]};}});await Promise.all([c.get('/repos/example/plugin/tags'),c.get('/repos/example/plugin/tags')]);assert.equal(count,1);
});
test('rate limit stops subsequent requests and persists retry time',async()=>{
  let count=0;const state={};const c=new GitHubClient({state,now:()=>1000,request:async()=>{count++;return{status:429,headers:{'retry-after':'120'},data:null};}});
  await assert.rejects(c.get('/repos/example/plugin/releases'),CheckError);await assert.rejects(c.get('/repos/example/plugin/tags'),e=>e.code==='GITHUB_RATE_LIMIT');assert.equal(count,1);assert.equal(state.blockedUntil,121000);
});
test('cross-host redirects are rejected and same-host redirect cycles are bounded',async()=>{
  const c=new GitHubClient({request:async()=>({status:302,headers:{location:'https://evil.test/repos/a/b'}})});await assert.rejects(c.get('/repos/example/plugin/releases'),e=>e.code==='UNTRUSTED_REDIRECT');
  const loop=new GitHubClient({request:async()=>({status:301,headers:{location:'https://api.github.com/repos/example/plugin/releases'}})});await assert.rejects(loop.get('/repos/example/plugin/releases'),e=>e.code==='UNTRUSTED_REDIRECT');assert.equal(loop.requests,4);
});
test('request budget bounds API use',async()=>{
  const c=client(()=>[],{maxRequests:1});await c.get('/repos/example/plugin/releases');await assert.rejects(c.get('/repos/example/plugin/tags'),e=>e.code==='REQUEST_BUDGET_EXHAUSTED');
});
test('transport refuses arbitrary hosts without connecting',async()=>{
  await assert.rejects(requestJson('https://evil.test/x',{timeoutMs:1000}),e=>e.code==='UNTRUSTED_API_URL');
});
test('HTML report escapes plugin-controlled markup',()=>{
  const html=reportHtml({total:1,updates:0,failures:0,checkedAt:'now',warnings:[],plugins:[{...row(),name:'<img src=x onerror=alert(1)>',status:'version_current'}]});assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert(html.includes("default-src 'none'"));
});
test('service creates persistent reports and reloads them without a request',async t=>{
  const dataDir=await fixture(t),inventory={rows:[row()],warnings:[],scope:'all-profiles'};let calls=0;
  const service=new UpdateService({dataDir,intervalHours:6},{scan:async()=>inventory,client:{request:async url=>{calls++;const u=new URL(url);return{status:200,headers:{},data:releaseFixture()(u.pathname+u.search)};}}});
  const [a,b]=await Promise.all([service.check(),service.check()]);assert.equal(a,b);assert.equal(a.updates,1);assert.equal(calls,2);
  const stored=JSON.parse(await readFile(join(dataDir,'latest.json'),'utf8'));assert.equal(stored.plugins[0].latestVersion,'1.3.0');assert((await readFile(join(dataDir,'latest.html'),'utf8')).includes('发现新版本'));
  const after=new UpdateService({dataDir});assert.equal((await after.status()).report.updates,1);await after.close();await service.close();
});
test('service disposal aborts a pending request and writes no incomplete report',async t=>{
  const dataDir=await fixture(t);let began;const started=new Promise(r=>{began=r;});
  const service=new UpdateService({dataDir},{scan:async()=>({rows:[row()],warnings:[],scope:'all-profiles'}),client:{request:async(_url,{signal})=>{began();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new CheckError('CANCELLED')),{once:true}));}}});
  const running=service.check();await started;const done=service.close();await assert.rejects(running,/CANCELLED/);await done;await assert.rejects(readFile(join(dataDir,'latest.json')));await assert.rejects(service.check(),/SERVICE_CLOSED/);
});

test('default interval is 24 hours and restarting before it expires waits until due',()=>{
  assert.equal(new UpdateService().config.intervalHours,24);
  const now=Date.parse('2026-01-02T00:00:00Z');
  assert.equal(nextAutomaticDelay({intervalHours:24,checkedAt:'2026-01-01T12:00:00Z',now}),12*3600000);
  assert.equal(nextAutomaticDelay({intervalHours:24,checkedAt:'2026-01-01T00:00:00Z',now}),15000);
  assert.equal(nextAutomaticDelay({intervalHours:0,checkedAt:null,now}),null);
});
test('human-set interval persists across restart, can pause, rejects invalid values and resets to native config',async t=>{
  const dataDir=await fixture(t),service=new UpdateService({dataDir});
  assert.equal((await service.setSchedule('get')).intervalHours,24);
  assert.equal((await service.setSchedule('set',48)).source,'manual-override');
  const restarted=new UpdateService({dataDir});await restarted.load();assert.equal(restarted.config.intervalHours,48);
  assert.equal((await restarted.setSchedule('set',0)).automaticEnabled,false);
  for(const n of [-1,169,NaN,'24'])await assert.rejects(restarted.setSchedule('set',n));
  assert.equal((await restarted.setSchedule('reset')).intervalHours,24);
  const reset=new UpdateService({dataDir});await reset.load();assert.equal(reset.config.intervalHours,24);
  await Promise.all([service.close(),restarted.close(),reset.close()]);
});
