import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {inspectTarball} from '../lib/archive.mjs';
const path=process.argv[2];
if(!path)throw new Error('Pass a package tarball path');
const root=process.cwd(),pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const archive=inspectTarball(await readFile(path));
assert.equal(archive.manifest.version,pkg.version);assert.equal(archive.manifest.name,pkg.name);
assert.equal(archive.manifest.repository?.url,pkg.repository.url);
const allowed=new Set([...pkg.files,'package.json']);
for(const [name,bytes] of archive.files){
  assert(!/(^|\/)(work|outputs|node_modules|profiles|backups|credentials|\.git)(\/|$)/.test(name),`Private path in package: ${name}`);
  assert(allowed.has(name)||allowed.has(name.split('/')[0]),`Unexpected package path: ${name}`);
  assert.deepEqual(bytes,await readFile(join(root,name)),`Package differs from source: ${name}`);
}
for(const name of ['index.js','cordis.patch.yml','lib/updater.mjs','lib/inventory.mjs','vendor/semver/LICENSE','README.md','LICENSE','icon.svg','locale/en.json','locale/zh.json'])assert(archive.files.has(name),`Missing ${name}`);
console.log(JSON.stringify({passed:true,version:pkg.version,files:archive.files.size,sha256:archive.sha256}));
