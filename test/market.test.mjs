import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketIndex } from '../scripts/market-index.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
test('market install stays pinned to the release commit and uses exported display metadata', async () => {
  const commit = 'a'.repeat(40), timestamp = 1792713600;
  const index = await buildMarketIndex(root, commit, timestamp);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const plugin = index.plugins[0], version = plugin.versions[0];
  assert.equal(index.format, 1);
  assert.equal(plugin.title.zh, '插件自动更新');
  assert.equal(plugin.repository.url + '.git', pkg.repository.url);
  assert.deepEqual(version.source, {type:'git', url:plugin.repository.url, commit});
  assert.equal(version.version, pkg.version);
  assert.equal(version.engines.dsh, pkg.engines.dsh);
  assert.equal(version.publishTimestamp, timestamp);
  assert(Buffer.from(plugin.icon.split(',')[1], 'base64').includes(Buffer.from('<svg')));
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./package.json'], './package.json');
});
test('market builder rejects moving refs and millisecond timestamps', async () => {
  await assert.rejects(buildMarketIndex(root, 'main', 1792713600));
  await assert.rejects(buildMarketIndex(root, 'a'.repeat(40), 1792713600000));
});
