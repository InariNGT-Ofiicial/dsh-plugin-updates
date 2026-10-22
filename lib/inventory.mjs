import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const packageNamePattern = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i;
const json = async p => JSON.parse(await readFile(p, 'utf8'));

// Never turn homepage links, URL credentials, or look-alike hosts into a source.
export function githubSource(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let text = value.trim().replace(/^git\+/, '');
  text = text.replace(/^git@github\.com:/i, 'https://github.com/');
  text = text.replace(/^github:/i, 'https://github.com/');
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(text)) text = `https://github.com/${text}`;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.hostname.toLowerCase() !== 'github.com' || url.port || (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) || url.password || !['https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) return null;
  // Repository URL, release tarball, or GitHub archive URL only.
  if (parts.length > 2 && !['archive', 'releases', 'tree'].includes(parts[2])) return null;
  const repo = parts[1].replace(/\.git$/i, '');
  if (!repo || [parts[0], repo].some(p => p === '.' || p === '..')) return null;
  return { owner: parts[0], repo, url: `https://github.com/${parts[0]}/${repo}`, ref: decodeURIComponentSafe(url.hash.slice(1)) };
}
function decodeURIComponentSafe(value) { try { return decodeURIComponent(value); } catch { return ''; } }
export function safeDirectory(value = '') {
  if (typeof value !== 'string' || value.length > 512 || /^[\\/]|^[a-z]:/i.test(value) || value.includes('\\')) throw new Error('INVALID_REPOSITORY_DIRECTORY');
  const parts = value.replace(/^\.\//, '').replace(/\/$/, '').split('/');
  if (parts.some(p => p === '..' || p === '.' || /[\x00-\x1f?#]/.test(p)) || (parts.length > 1 && parts.some(p => !p))) throw new Error('INVALID_REPOSITORY_DIRECTORY');
  return value.replace(/^\.\//, '').replace(/\/$/, '');
}
async function gitOrigin(dir) {
  try {
    let gitDir = join(dir, '.git');
    try {
      const pointer = await readFile(gitDir, 'utf8');
      const match = /^gitdir:\s*(.+)/m.exec(pointer);
      if (match) gitDir = resolve(dir, match[1].trim());
    } catch {}
    const text = await readFile(join(gitDir, 'config'), 'utf8');
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1];
    return githubSource(/^\s*url\s*=\s*(.+)$/m.exec(section || '')?.[1]);
  } catch { return null; }
}

export async function scanInstalled({ home = process.env.DSH_HOME || join(homedir(), '.dsh'), profile = 'desktop', profileDir, allProfiles = true, repositories = [] } = {}) {
  const current = profileDir || join(resolve(home), 'profiles', profile);
  const profilesRoot = dirname(current);
  const dirs = allProfiles ? (await readdir(profilesRoot, { withFileTypes: true })).filter(d => d.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)).map(d => join(profilesRoot, d.name)) : [current];
  const rows = [], warnings = [];
  for (const dir of dirs) {
    const profileName = dir.split(/[\\/]/).at(-1);
    let manifest;
    try { manifest = await json(join(dir, 'package.json')); } catch { warnings.push({ profile: profileName, code: 'PROFILE_MANIFEST_UNREADABLE' }); continue; }
    for (const [name, spec] of Object.entries(manifest.dependencies || {})) {
      if (!packageNamePattern.test(name)) { warnings.push({ profile: profileName, code: 'INVALID_PACKAGE_NAME' }); continue; }
      const installKind = /^(link:|workspace:)/i.test(spec) || (/^file:/i.test(spec) && !/\.(tgz|tar\.gz)$/i.test(spec)) ? 'local-link' : githubSource(spec) ? 'github' : /\.(tgz|tar\.gz)$/i.test(spec) ? 'tarball' : /^npm:/i.test(spec) ? 'alias' : /^(?:[~^<>=*\d]|latest$|next$|beta$|rc$)/i.test(spec) ? 'registry' : 'unknown';
      const row = { profile: profileName, name, installKind, installationFingerprint:createHash('sha256').update(String(spec)).digest('hex'),currentVersion: null, enabled: (manifest.dsh?.profile?.bundles || []).includes(name) };
      let pkg, packageDir;
      try { packageDir = await realpath(join(dir, 'node_modules', name)); pkg = await json(join(packageDir, 'package.json')); }
      catch { rows.push({ ...row, source: null, issue: 'PACKAGE_NOT_INSTALLED' }); continue; }
      row.packageName = typeof pkg.name === 'string' ? pkg.name : name;
      row.currentVersion = typeof pkg.version === 'string' ? pkg.version : null;
      const override = repositories.find(r => r.packageName === name && (!r.profile || r.profile === profileName));
      const declared = githubSource(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url);
      const explicit = githubSource(spec);
      const git = await gitOrigin(packageDir);
      const source = override ? githubSource(override.repository) : explicit || git || declared;
      if (!source) { rows.push({ ...row, source: null, issue: override ? 'INVALID_REPOSITORY_OVERRIDE' : 'NO_GITHUB_SOURCE' }); continue; }
      try {
        const sameDeclaredRepo = declared && declared.url.toLowerCase() === source.url.toLowerCase();
        row.source = { ...source, directory: safeDirectory(override?.directory ?? (sameDeclaredRepo ? pkg.repository?.directory : '') ?? ''), provenance: override ? 'configuration' : explicit ? 'install-source' : git ? 'git-origin' : 'package-repository' };
        if (override?.ref) row.source.ref = override.ref;
        rows.push(row);
      } catch { rows.push({ ...row, source: null, issue: 'INVALID_REPOSITORY_DIRECTORY' }); }
    }
  }
  return { rows, warnings, scope: allProfiles ? 'all-profiles' : 'current-profile' };
}
