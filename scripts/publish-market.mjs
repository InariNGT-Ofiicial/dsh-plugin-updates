import { readFile } from 'node:fs/promises';
import semver from '../vendor/semver/index.js';
const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
if (!token || repo !== 'InariNGT-Ofiicial/dsh-plugin-updates') throw new Error('Expected the repository-owned release workflow');
const content = await readFile('dist/market-index.json');
async function api(method, body) {
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/market/index.json`, {
    method,
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  if (response.status === 404 && method === 'GET') return undefined;
  if (!response.ok) throw new Error(`Market index publication failed: HTTP ${response.status}`);
  return response.json();
}
const existing = await api('GET');
if (existing) {
  const oldIndex = JSON.parse(Buffer.from(existing.content, 'base64'));
  const oldVersion = oldIndex.plugins.find(p => p.name === 'dsh-plugin-updates')?.versions[0];
  const nextVersion = JSON.parse(content).plugins[0].versions[0];
  if (oldVersion && semver.gt(oldVersion.version, nextVersion.version)) throw new Error('Refusing to publish an older market version');
  if (oldVersion?.version === nextVersion.version && oldVersion.source.commit !== nextVersion.source.commit) throw new Error('Refusing to move a published market version to another commit');
}
if (existing && Buffer.from(existing.content, 'base64').equals(content)) {
  console.log('Market index already current');
} else {
  const version = JSON.parse(content).plugins[0].versions[0].version;
  await api('PUT', {message: `chore: publish market index for v${version}`, content: content.toString('base64'), branch: 'main', ...(existing ? {sha: existing.sha} : {})});
  console.log(`Published market index for v${version}`);
}
