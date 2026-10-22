import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
async function walk(dir) {
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const file=join(dir,entry.name);
    if(entry.isDirectory()) { if(!['node_modules','.git','work','outputs','dist','coverage'].includes(entry.name)) await walk(file); }
    else if (/\.(mjs|js)$/.test(file)) { const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true}); if(r.status!==0) throw new Error(r.stderr); }
  }
}
await walk('.'); console.log('JavaScript syntax checks passed.');
