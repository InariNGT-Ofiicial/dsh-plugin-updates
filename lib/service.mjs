import { readFile, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { scanInstalled } from './inventory.mjs';
import { GitHubClient } from './github.mjs';
import { checkPlugin } from './versions.mjs';
import { AutoUpdater } from './updater.mjs';

import { reportHtml } from "./report.mjs";
export { reportHtml, labels } from "./report.mjs";
async function atomicFile(path, data) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, path); } finally { await unlink(tmp).catch(()=>{}); }
}

export class UpdateService {
  constructor(config = {}, dependencies = {}) {
    this.config = { home: process.env.DSH_HOME || join(homedir(), '.dsh'), profile: 'desktop', allProfiles: true, autoUpdate: true, includePrereleases: false, intervalHours: 24, timeoutMs: 12000, maxRequests: 40, repositories: [], ...config };
    this.baseIntervalHours = this.config.intervalHours;
    this.dataDir = config.dataDir || join(this.config.home, 'plugin-updates', this.config.profile);
    this.dependencies = dependencies; this.abort = new AbortController(); this.state = {}; this.report = null; this.pending = null; this.closed = false;
    this.updater = new AutoUpdater({...this.config,dataDir:this.dataDir},{runner:dependencies.runner,download:dependencies.download});
  }
  async load() {
    if (this.loading) return this.loading;
    this.loading = (async()=>{
      try { this.state = JSON.parse(await readFile(join(this.dataDir,'cache.json'),'utf8')); } catch {}
      if (!this.state || typeof this.state !== 'object' || Array.isArray(this.state)) this.state = {};
      try { this.report = JSON.parse(await readFile(join(this.dataDir,'latest.json'),'utf8')); } catch {}
      try {
        const schedule = JSON.parse(await readFile(join(this.dataDir,'schedule.json'),'utf8'));
        if (typeof schedule.intervalHours === 'number' && Number.isFinite(schedule.intervalHours) && schedule.intervalHours >= 0 && schedule.intervalHours <= 168) {
          this.config.intervalHours = schedule.intervalHours; this.scheduleOverride = true;
        }
      } catch {}
    })();
    return this.loading;
  }
  paths() { return { json: join(this.dataDir,'latest.json'), html: join(this.dataDir,'latest.html') }; }
  schedule() {
    const intervalHours = this.config.intervalHours;
    const last = Date.parse(this.report?.checkedAt || '');
    return { intervalHours, automaticEnabled: intervalHours > 0, source: this.scheduleOverride ? 'manual-override' : 'plugin-config', nextCheckAt: intervalHours > 0 && Number.isFinite(last) ? new Date(last + intervalHours * 3600000).toISOString() : null };
  }
  async setSchedule(action, intervalHours) {
    await this.load();
    if (!['get','set','reset'].includes(action)) throw new Error('INVALID_SCHEDULE_ACTION');
    if (action==='set') {
      if (typeof intervalHours !== 'number' || !Number.isFinite(intervalHours) || intervalHours < 0 || intervalHours > 168) throw new Error('INVALID_INTERVAL_HOURS');
      await mkdir(this.dataDir,{recursive:true,mode:0o700});
      await atomicFile(join(this.dataDir,'schedule.json'),JSON.stringify({intervalHours}));
      this.config.intervalHours=intervalHours;this.scheduleOverride=true;
    }
    if (action==='reset') {
      await unlink(join(this.dataDir,'schedule.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});
      this.config.intervalHours=this.baseIntervalHours;this.scheduleOverride=false;
    }
    return this.schedule();
  }
  async status() { await this.load(); return { running: !!this.pending || !!this.cyclePending, scope: this.config.allProfiles ? 'all-profiles' : 'current-profile', schedule: this.schedule(), autoUpdate:await this.updater.policy(), report: this.report, files: this.paths() }; }
  check({ refresh = false, fromCycle = false } = {}) {
    if (this.closed) return Promise.reject(new Error('SERVICE_CLOSED'));
    if(this.cyclePending&&!fromCycle)return this.cyclePending;
    if (this.pending) return this.pending;
    this.pending = this.run(refresh).finally(()=>{ this.pending = null; }); return this.pending;
  }
  cycle(filter={}){
    if(this.closed)return Promise.reject(new Error('SERVICE_CLOSED'));
    if(this.cyclePending)return this.cyclePending;
    this.cyclePending=(async()=>{
      const report=await this.check({fromCycle:true});
      const outcome=await this.updater.run(report,filter);report.autoUpdate={...outcome,executed:true};
      for(const update of outcome.results.filter(r=>r.status==='updated')){
        const row=report.plugins.find(p=>p.profile===update.profile&&p.name===update.name);
        if(row){row.previousVersion=row.currentVersion;row.currentVersion=update.installedVersion;row.status='version_current';}
      }
      report.updates=report.plugins.filter(p=>p.status==='update_available').length;
      await this.saveReport(report);return report;
    })().finally(()=>{this.cyclePending=null;});return this.cyclePending;
  }
  async run(refresh) {
    await this.load();
    const inventory = await (this.dependencies.scan || scanInstalled)(this.config);
    const client = new GitHubClient({ state: this.state, token: process.env[this.config.githubTokenEnv || 'DSH_GITHUB_TOKEN'] || '', timeoutMs: this.config.timeoutMs, proxyUrl: this.config.proxyUrl || process.env.HTTPS_PROXY || process.env.https_proxy || '', maxRequests: this.config.maxRequests, signal: this.abort.signal, ...this.dependencies.client });
    const plugins = [];
    for (const row of inventory.rows) {
      if (this.abort.signal.aborted) break;
      plugins.push(await checkPlugin(row, client, { includePrereleases: this.config.includePrereleases, refresh }));
    }
    if (this.abort.signal.aborted) throw new Error('CANCELLED');
    const now = new Date();
    const report = { schemaVersion: 2, checkedAt: now.toISOString(), nextCheckAt: this.config.intervalHours > 0 ? new Date(now.getTime() + this.config.intervalHours * 3600000).toISOString() : null, scope: inventory.scope, total: plugins.length, updates: plugins.filter(p=>p.status==='update_available').length, failures: plugins.filter(p=>p.status==='check_failed').length, requests: client.requests, warnings: inventory.warnings, plugins,autoUpdate:{enabled:(await this.updater.policy()).enabled,executed:false,results:[]} };
    await mkdir(this.dataDir,{ recursive: true, mode: 0o700 });
    // Bound persisted HTTP cache. Unknown fields and token/proxy strings are never saved.
    this.state.cache = Object.fromEntries(Object.entries(this.state.cache || {}).filter(([,v])=>v && now.getTime()-v.time < 7*86400000).sort((a,b)=>b[1].time-a[1].time).slice(0,100));
    await atomicFile(join(this.dataDir,'cache.json'), JSON.stringify({ cache: this.state.cache, blockedUntil: this.state.blockedUntil || 0 }));
    await this.saveReport(report);return report;
  }
  async saveReport(report){await mkdir(this.dataDir,{recursive:true,mode:0o700});await atomicFile(this.paths().html,reportHtml(report));await atomicFile(this.paths().json,JSON.stringify(report,null,2));this.report=report;}
  close() { this.closed = true; this.abort.abort();const updating=this.updater.close();return Promise.allSettled([this.pending,this.cyclePending,updating]); }
}
