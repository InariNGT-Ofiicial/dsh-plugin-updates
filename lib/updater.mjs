import { readFile, writeFile, mkdir, rename, unlink, open, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import semver from '../vendor/semver/index.js';
import { githubSource, packageNamePattern } from './inventory.mjs';
import { requestJson } from './github.mjs';
import { inspectTarball, validatePackage, snapshotPackage } from './archive.mjs';

async function atomic(path,value){const tmp=path+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,path);}finally{await unlink(tmp).catch(()=>{});}}
const readJson=async p=>JSON.parse(await readFile(p,'utf8'));
export async function downloadGithub(url,{token='',proxyUrl='',signal,request=requestJson}={}){
  for(let i=0;i<6;i++){
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||!['api.github.com','github.com','codeload.github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(parsed.hostname)||parsed.port||parsed.username||parsed.password)throw new Error('UNTRUSTED_DOWNLOAD_URL');
    const headers={'User-Agent':'dsh-plugin-updates/0.2.1',Accept:'application/octet-stream'};
    if(parsed.hostname==='api.github.com'&&token)headers.Authorization=`Bearer ${token}`;
    const response=await request(url,{headers,timeoutMs:60000,proxyUrl,signal,binary:true});
    if([301,302,303,307,308].includes(response.status)){
      if(!response.headers?.location)throw new Error('INVALID_DOWNLOAD_REDIRECT');
      url=new URL(response.headers.location,url).href;continue;
    }
    if(response.status!==200||!Buffer.isBuffer(response.data))throw new Error('DOWNLOAD_FAILED');
    return response.data;
  }
  throw new Error('DOWNLOAD_REDIRECT_LIMIT');
}

export class AutoUpdater {
  constructor(config,dependencies={}){
    this.config={autoUpdate:true,runtimeVersion:'0.2.1-rc.2',...config};this.dependencies=dependencies;this.dataDir=config.dataDir;this.history=[];this.enabled=this.config.autoUpdate;this.closed=false;this.abort=new AbortController();
  }
  async load(){
    if(this.loading)return this.loading;
    this.loading=(async()=>{
      try{const policy=await readJson(join(this.dataDir,'auto-update.json'));if(typeof policy.enabled==='boolean'){this.enabled=policy.enabled;this.override=true;}}catch{}
      try{const history=await readJson(join(this.dataDir,'update-history.json'));if(Array.isArray(history))this.history=history.slice(-50);}catch{}
    })();return this.loading;
  }
  async policy(action='get',enabled){
    await this.load();
    if(!['get','set','reset'].includes(action))throw new Error('INVALID_AUTO_UPDATE_ACTION');
    if(action==='set'){
      if(typeof enabled!=='boolean')throw new Error('INVALID_AUTO_UPDATE_SETTING');
      await mkdir(this.dataDir,{recursive:true,mode:0o700});await atomic(join(this.dataDir,'auto-update.json'),{enabled});this.enabled=enabled;this.override=true;
    }
    if(action==='reset'){await unlink(join(this.dataDir,'auto-update.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});this.enabled=this.config.autoUpdate;this.override=false;}
    return {enabled:this.enabled,source:this.override?'manual-override':'plugin-config',running:!!this.pending,history:this.history.slice(-10),appliesAfterCurrentInstall:!!this.pending};
  }
  async saveHistory(){await mkdir(this.dataDir,{recursive:true,mode:0o700});await atomic(join(this.dataDir,'update-history.json'),this.history.slice(-50));}
  async lock(){
    const dir=join(this.config.home,'plugin-updates');await mkdir(dir,{recursive:true,mode:0o700});const path=join(dir,'auto-update.lock');
    for(let attempt=0;attempt<2;attempt++){
      try{const file=await open(path,'wx',0o600);const token=randomUUID();await file.writeFile(JSON.stringify({pid:process.pid,token}));await file.close();return async()=>{try{if((await readJson(path)).token===token)await unlink(path);}catch{}};}
      catch(e){if(e.code!=='EEXIST')throw e;let prior;try{prior=await readJson(path);}catch{throw new Error('UPDATE_BUSY');}
        if(!Number.isInteger(prior.pid)||prior.pid<=0)throw new Error('UPDATE_BUSY');
        try{process.kill(prior.pid,0);throw new Error('UPDATE_BUSY');}catch(e){if(e.code!=='ESRCH')throw new Error('UPDATE_BUSY');}
        if((await readJson(path)).token!==prior.token)throw new Error('UPDATE_BUSY');await unlink(path);
      }
    }throw new Error('UPDATE_BUSY');
  }
  async reconcile(){
    let changed=false;
    for(const item of this.history.filter(x=>x.status==='installing')){
      let current;try{current=await readJson(join(this.config.home,'profiles',item.profile,'node_modules',item.name,'package.json'));}catch{}
      item.status=current?.version===item.to?'updated':current?.version===item.from?'interrupted':'needs_attention';item.installedVersion=current?.version||null;item.restartRequired=item.status==='updated';item.finishedAt=new Date().toISOString();item.code=item.status==='updated'?'RECOVERED_COMPLETED_INSTALL':'INTERRUPTED_INSTALL_CHECKED';changed=true;
    }
    if(changed)await this.saveHistory();
  }
  run(report,filter={}){
    if(this.pending)return this.pending;
    this.pending=this._run(report,filter).finally(()=>{this.pending=null;});return this.pending;
  }
  async _run(report,{packageName,profile}={}){
    await this.load();if(this.closed)throw new Error('UPDATER_CLOSED');
    const result={enabled:this.enabled,updated:0,failed:0,skipped:0,restartRequired:false,results:[]};
    if(!this.enabled)return result;
    const candidates=report.plugins.filter(p=>p.status==='update_available'&&(!packageName||p.name===packageName)&&(!profile||p.profile===profile)).sort((a,b)=>Number(a.name==='dsh-plugin-updates')-Number(b.name==='dsh-plugin-updates'));
    if(!candidates.length)return result;
    let release;
    try{
      release=await this.lock();await this.reconcile();
      for(const row of candidates){
        if(this.closed||!this.enabled)break;
        const outcome=await this.updateOne(row);result.results.push(outcome);
        if(outcome.status==='updated')result.updated++;else if(['failed','rolled_back','needs_attention'].includes(outcome.status))result.failed++;else result.skipped++;
        result.restartRequired ||= outcome.restartRequired===true;
      }
    }catch(e){result.results.push({status:'skipped',code:e.message==='UPDATE_BUSY'?'UPDATE_BUSY':'UPDATER_UNAVAILABLE'});result.skipped++;}
    finally{await release?.();}
    return result;
  }
  async prepare(row,profileDir){
    if(row.installKind==='local-link')throw new Error('LOCAL_SOURCE_LINK_PRESERVED');
    if(row.upstreamKind==='branch')throw new Error('DEVELOPMENT_BRANCH_REQUIRES_MANUAL_UPDATE');
    if(!['registry','github','tarball'].includes(row.installKind))throw new Error('UNSUPPORTED_INSTALL_SOURCE');
    const runner=this.dependencies.runner;if(!runner)throw new Error('DSH_INSTALLER_UNAVAILABLE');
    let manifest,target,hasFile=()=>true;
    if(row.installKind==='registry'){
      target=`${row.name}@${row.latestVersion}`;
      const response=await runner(['--profile',row.profile,'view',target,'--json']);
      if(response.exitCode!==0)throw new Error('REGISTRY_VERSION_UNAVAILABLE');
      try{manifest=JSON.parse(response.stdout);}catch{throw new Error('INVALID_REGISTRY_METADATA');}
      const origin=githubSource(typeof manifest.repository==='string'?manifest.repository:manifest.repository?.url);
      if(!origin||origin.url.toLowerCase()!==row.source.url.toLowerCase())throw new Error('REGISTRY_REPOSITORY_MISMATCH');
    }else{
      const assets=row.releaseAssets||[];const short=row.name.split('/').at(-1);
      const exact=assets.filter(a=>a.name===`${short}-${row.latestVersion}.tgz`||a.name===`${short}-v${row.latestVersion}.tgz`);
      const asset=exact.length===1?exact[0]:assets.length===1?assets[0]:null;
      if(!asset&&row.source.directory)throw new Error('MONOREPO_PACKAGE_ASSET_REQUIRED');
      const url=asset?`https://api.github.com/repos/${encodeURIComponent(row.source.owner)}/${encodeURIComponent(row.source.repo)}/releases/assets/${asset.id}`:`${row.source.url}/archive/refs/tags/${encodeURIComponent(row.latestRef)}.tar.gz`;
      const data=await (this.dependencies.download||downloadGithub)(url,{token:process.env[this.config.githubTokenEnv||'DSH_GITHUB_TOKEN']||'',proxyUrl:this.config.proxyUrl||process.env.HTTPS_PROXY||process.env.https_proxy||'',signal:this.abort.signal});
      const digest=createHash('sha256').update(data).digest('hex');if(asset?.digest&&asset.digest!==`sha256:${digest}`)throw new Error('ASSET_DIGEST_MISMATCH');
      const inspected=inspectTarball(data);manifest=inspected.manifest;hasFile=p=>inspected.files.has(p);
      const dir=join(this.dataDir,'downloads');await mkdir(dir,{recursive:true,mode:0o700});target=join(dir,digest+'.tgz');await writeFile(target,data,{mode:0o600});
    }
    this.validateManifest(manifest,row,hasFile);
    return {target,manifest};
  }
  validateManifest(manifest,row,hasFile){
    validatePackage(manifest,{name:row.packageName||row.name,version:row.latestVersion},hasFile);
    const requirement=manifest.engines?.dsh||manifest.peerDependencies?.['@deepseek-ai/dsh']||manifest.peerDependencies?.['@deepseek-ai/dsh-tools'];
    if(requirement&&(!semver.validRange(requirement)||!semver.satisfies(this.config.runtimeVersion,requirement,{includePrerelease:true})))throw new Error('INCOMPATIBLE_DSH_VERSION');
    if(manifest.engines?.node&&(!semver.validRange(manifest.engines.node)||!semver.satisfies(process.versions.node,manifest.engines.node)))throw new Error('INCOMPATIBLE_NODE_VERSION');
  }
  async updateOne(row){
    const base={profile:row.profile,name:row.name,from:row.currentVersion,to:row.latestVersion};let attempt,oldArchive,beforeManifest;
    try{
      if(!packageNamePattern.test(row.name)||!row.source||!semver.valid(row.latestVersion)||!semver.gt(row.latestVersion,row.currentVersion)||!/^[a-zA-Z0-9_-]+$/.test(row.profile))throw new Error('INVALID_UPDATE_TARGET');
      const unresolved=this.history.find(x=>x.profile===row.profile&&x.name===row.name&&x.status==='needs_attention');if(unresolved)throw new Error('PREVIOUS_UPDATE_NEEDS_ATTENTION');
      const dir=join(this.config.home,'profiles',row.profile),path=join(dir,'package.json');const before=await readJson(path);
      beforeManifest=before;
      if(!Object.hasOwn(before.dependencies||{},row.name))throw new Error('PLUGIN_NO_LONGER_INSTALLED');
      if(row.installationFingerprint&&createHash('sha256').update(String(before.dependencies[row.name])).digest('hex')!==row.installationFingerprint)throw new Error('INSTALL_SOURCE_CHANGED');
      if((row.packageName||row.name)!==row.name)throw new Error('ALIASED_PACKAGE_REQUIRES_MANUAL_UPDATE');
      const installed=await readJson(join(dir,'node_modules',row.name,'package.json'));if(installed.version!==row.currentVersion)throw new Error('LOCAL_VERSION_CHANGED');
      const prepared=await this.prepare(row,dir);
      if(this.closed||!this.enabled)throw new Error('AUTO_UPDATE_DISABLED');
      // Save a ready-to-install snapshot and profile files before the installer runs.
      const id=randomUUID(),backup=join(this.dataDir,'backups',id);await mkdir(backup,{recursive:true,mode:0o700});
      for(const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml']){try{await writeFile(join(backup,name),await readFile(join(dir,name)),{mode:0o600});}catch(e){if(e.code!=='ENOENT')throw e;}}
      oldArchive=join(backup,'previous.tgz');await writeFile(oldArchive,await snapshotPackage(await realpath(join(dir,'node_modules',row.name))),{mode:0o600});
      if(JSON.stringify(await readJson(path))!==JSON.stringify(before))throw new Error('PROFILE_CHANGED_DURING_PREPARATION');
      if(this.closed||!this.enabled)throw new Error('AUTO_UPDATE_DISABLED');
      attempt={...base,id,status:'installing',startedAt:new Date().toISOString(),backup,previousSource:row.installKind};this.history.push(attempt);await this.saveHistory();
      const response=await this.dependencies.runner(['--profile',row.profile,'add',prepared.target,'--save-exact','--ignore-scripts'],{logPath:join(backup,'install.log')});
      if(response.exitCode!==0)throw new Error('INSTALL_FAILED');
      const after=await readJson(path),current=await readJson(join(dir,'node_modules',row.name,'package.json'));
      if(Object.entries(before.dependencies).some(([name,spec])=>name!==row.name&&after.dependencies?.[name]!==spec)||JSON.stringify(before.dsh?.profile?.bundles||[])!==JSON.stringify(after.dsh?.profile?.bundles||[]))throw new Error('PROFILE_SELECTION_CHANGED');
      const packageDir=join(dir,'node_modules',row.name);this.validateManifest(current,row,p=>existsSync(join(packageDir,p)));
      Object.assign(attempt,{status:'updated',installedVersion:current.version,restartRequired:true,finishedAt:new Date().toISOString(),code:'INSTALLED_RESTART_REQUIRED'});
    }catch(e){
      const code=/^[A-Z_]+$/.test(e.message)?e.message:'UPDATE_FAILED';
      if(!attempt)return {...base,status:'skipped',code};
      let current;const packagePath=join(this.config.home,'profiles',row.profile,'node_modules',row.name,'package.json');try{current=await readJson(packagePath);}catch{}
      let currentProfile;try{currentProfile=await readJson(join(this.config.home,'profiles',row.profile,'package.json'));}catch{}
      if(current?.version===row.currentVersion&&currentProfile?.dependencies?.[row.name]===beforeManifest?.dependencies?.[row.name]){Object.assign(attempt,{status:'failed',code,installedVersion:current.version,finishedAt:new Date().toISOString()});}
      else{
        try{
          const rollbackTarget=row.installKind==='registry'?`${row.name}@${row.currentVersion}`:oldArchive;
          let rollback=await this.dependencies.runner(['--profile',row.profile,'add',rollbackTarget,'--save-exact','--ignore-scripts'],{logPath:join(attempt.backup,'rollback.log')});
          if(rollback.exitCode!==0&&rollbackTarget!==oldArchive)rollback=await this.dependencies.runner(['--profile',row.profile,'add',oldArchive,'--save-exact','--ignore-scripts'],{logPath:join(attempt.backup,'rollback-snapshot.log')});
          const restored=await readJson(packagePath);if(rollback.exitCode!==0||restored.version!==row.currentVersion)throw new Error('ROLLBACK_FAILED');
          Object.assign(attempt,{status:'rolled_back',code,installedVersion:restored.version,restartRequired:true,finishedAt:new Date().toISOString()});
        }catch{Object.assign(attempt,{status:'needs_attention',code,rollbackCode:'ROLLBACK_FAILED',finishedAt:new Date().toISOString()});}
      }
    }
    await this.saveHistory();return {...attempt,backup:undefined};
  }
  close(){this.closed=true;this.abort.abort();return this.pending?.catch(()=>{});}
}
