#!/usr/bin/env node
import { resolve } from 'node:path';
import { UpdateService } from '../lib/service.mjs';
import { scanInstalled } from '../lib/inventory.mjs';
const args = process.argv.slice(2), config = { intervalHours: 0 };
const flags = new Set(['--current-profile','--prerelease','--refresh','--offline','--help']);
for (let i=0;i<args.length;i++) {
  const key = args[i];
  if (['--home','--profile','--data-dir','--proxy'].includes(key)) {
    const val=args[++i]; if (!val || val.startsWith('--')) throw new Error(`Missing ${key}`);
    if (key==='--home') config.home=resolve(val);
    if (key==='--profile') { if (!/^[a-zA-Z0-9_-]+$/.test(val)) throw new Error('Invalid profile'); config.profile=val; }
    if (key==='--data-dir') config.dataDir=resolve(val);
    if (key==='--proxy') config.proxyUrl=val;
  } else if (!flags.has(key)) throw new Error(`Unknown option: ${key}`);
}
if(args.includes('--help')) {
  console.log('dsh-plugin-updates [--home PATH] [--profile desktop] [--current-profile] [--prerelease] [--refresh] [--offline] [--data-dir PATH] [--proxy URL]');
} else {
  config.allProfiles=!args.includes('--current-profile'); config.includePrereleases=args.includes('--prerelease');
  const service=new UpdateService(config);
  try {
    const result=args.includes('--offline') ? await scanInstalled(service.config) : await service.check({refresh:args.includes('--refresh')});
    console.log(JSON.stringify(result,null,2));
    if (result.failures) process.exitCode=2;
  } catch { console.error('检查失败：请核对 DSH 主目录、网络连接及本地目录权限。'); process.exitCode=1; }
  finally { await service.close(); }
}
