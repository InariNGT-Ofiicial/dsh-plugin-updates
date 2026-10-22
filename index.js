import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { dirname } from 'node:path';
import { UpdateService } from './lib/service.mjs';
import { nextAutomaticDelay } from './lib/schedule.mjs';
import { makeDshRunner } from './lib/executor.mjs';
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot';

export const name = 'plugin-updates';
export const inject = ['tools', 'profileContext'];
export const Config = z.object({
  checkOnStart: z.boolean().default(true).description('启动后自动检查已安装插件'),
  startupDelaySeconds: z.natural().max(300).default(15),
  intervalHours: z.number().min(0).max(168).default(24).description('检查间隔（小时），默认 24；0 暂停所有自动检查，可用 plugin_updates_schedule 设置'),
  allProfiles: z.boolean().default(true).description('检查此 DSH 主目录下所有 profile 的直接安装插件'),
  autoUpdate: z.boolean().default(true).description('默认自动安装通过核对的正式新版；在 profile 重新加载后生效'),
  includePrereleases: z.boolean().default(false),
  timeoutMs: z.natural().min(1000).max(60000).default(12000),
  maxRequests: z.natural().min(1).max(200).default(40),
  githubTokenEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).default('DSH_GITHUB_TOKEN'),
  proxyUrl: z.string().default('').description('可选 HTTP/HTTPS 代理；未设置时读取 HTTPS_PROXY'),
  dataDir: z.string().default(''),
  repositories: z.array(z.object({ packageName: z.string(), repository: z.string(), directory: z.string().default(''), profile: z.string().default(''), ref: z.string().default('') })).default([]),
});

export function apply(ctx, config) {
  const profileDir = ctx.profileContext.dir;
  const profile = profileDir.split(/[\\/]/).at(-1);
  const home=dirname(dirname(profileDir));
  const service = new UpdateService({ ...config, profileDir, profile, home,runtimeVersion:getDshRuntimeVersion() },{runner:makeDshRunner({home,installAnchor:ctx.profileContext.installAnchor})});
  const log = (message) => ctx.logger.info(`[plugin-updates] ${message}`);
  let timer, disposed = false;
  const schedule = delay => { if (!disposed) { timer = setTimeout(background, delay); timer.unref?.(); } };
  async function arm(initial = false) {
    await service.load(); clearTimeout(timer);
    const delay = nextAutomaticDelay({ intervalHours: service.config.intervalHours, checkedAt: service.report?.checkedAt, checkOnStart: config.checkOnStart, startupDelaySeconds: config.startupDelaySeconds, initial });
    if (delay !== null) schedule(delay);
  }
  async function background() {
    try {
      const report = await service.cycle();
      log(`检查 ${report.total} 个插件，${report.updates} 个新版本，${report.failures} 个失败。报告：${service.paths().html}`);
      for (const row of report.plugins.filter(p=>p.status==='update_available')) log(`${row.profile}/${row.name}: ${row.currentVersion} → ${row.latestVersion} ${row.updateUrl}`);
      log(`自动更新${report.autoUpdate.enabled?'开启':'关闭'}：已安装 ${report.autoUpdate.updated}，失败 ${report.autoUpdate.failed}，跳过 ${report.autoUpdate.skipped}。${report.autoUpdate.restartRequired?'重新加载对应 profile 后生效。':''}`);
    } catch { if (!disposed) log('检查未完成；请使用 plugin_updates_status 查看状态，核对插件目录与报告目录是否可访问。'); }
    finally { if (!disposed && service.config.intervalHours > 0) schedule(Math.max(60000, service.config.intervalHours * 3600000)); }
  }
  ctx.effect(() => () => { disposed = true; clearTimeout(timer); return service.close(); });
  const register = (name, description, execute) => ctx.tools.register(defineTool({
    name, description,
    parameters: { packageName: { type: 'string', description: '可选：按已安装插件名筛选结果。留空返回全部。' } },
    output: { schema: { type: 'string' }, render: (_args,value)=>[{type:'text',text:value}] },
    async execute(args) {
      if (Object.keys(args).some(k=>k!=='packageName')) return JSON.stringify({ error: 'UNKNOWN_PARAMETER' });
      try {
        const value = await execute();
        if (value.report) {
          const rows = value.report.plugins.filter(p=>!args.packageName || p.name===args.packageName);
          value.report = { ...value.report, plugins: rows.slice(0,100), matchingTotal: rows.length, truncated: rows.length > 100 };
        }
        return JSON.stringify(value,null,2);
      } catch { return JSON.stringify({ error: disposed ? 'SERVICE_CLOSED' : 'CHECK_FAILED', message: '检查未完成，请核对本地 profile 与报告目录。' }); }
    },
  }));
  register('plugin_updates_check', '读取已安装插件的原 GitHub 仓库检查版本更新。仅访问 GitHub API，不安装或执行远程代码；结果按 packageName 可选筛选。', async()=>{ const report=await service.check(); await arm(); return { report, files: service.paths() }; });
  register('plugin_updates_status', '查看最近一次插件更新报告与自动检查状态；不发网络请求。', ()=>service.status());
  ctx.tools.register(defineTool({
    name:'plugin_updates_schedule',
    description:'人工设置插件更新自动检查的间隔。仅在用户要求调整时调用 set/reset；get 只读。intervalHours 默认 24，0 暂停，最大 168。设置持久化且立即生效；reset 恢复插件配置值。',
    parameters:{ action:{type:'string',enum:['get','set','reset'],required:true}, intervalHours:{type:'number',description:'set 必填，检查间隔小时数，0 到 168'} },
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    async execute(args){
      if(Object.keys(args).some(k=>!['action','intervalHours'].includes(k)))return JSON.stringify({error:'UNKNOWN_PARAMETER'});
      try{const schedule=await service.setSchedule(args.action,args.intervalHours);if(args.action!=='get')await arm();return JSON.stringify(schedule,null,2);}catch{return JSON.stringify({error:'INVALID_OR_UNWRITABLE_SCHEDULE',message:'间隔必须为 0 到 168 的小时数，且报告目录应可写。'});}
    },
  }));
  ctx.tools.register(defineTool({
    name:'plugin_updates_auto_update',
    description:'人工查看或设置自动更新开关，默认开启。set/reset 仅在用户要求时调用；run 按当前开关立即检查并更新，可限定已安装 packageName/profile。安装不会自动重启 DSH。',
    parameters:{action:{type:'string',enum:['get','set','reset','run'],required:true},enabled:{type:'boolean',description:'set 必填'},packageName:{type:'string',description:'run 可选：已安装插件名'},profile:{type:'string',description:'run 可选：本地 profile 名'}},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    async execute(args){
      if(Object.keys(args).some(k=>!['action','enabled','packageName','profile'].includes(k)))return JSON.stringify({error:'UNKNOWN_PARAMETER'});
      try{
        if(args.action==='run'){const report=await service.cycle({packageName:args.packageName,profile:args.profile});await arm();return JSON.stringify({report,files:service.paths()},null,2);}
        return JSON.stringify(await service.updater.policy(args.action,args.enabled),null,2);
      }catch{return JSON.stringify({error:'AUTO_UPDATE_FAILED',message:'请查看自动更新历史与本地目录权限。'});}
    },
  }));
  void arm(true).catch(()=>log('无法读取自动检查设置。'));
}
