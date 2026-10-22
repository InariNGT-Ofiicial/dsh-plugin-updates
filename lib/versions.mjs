import semver from '../vendor/semver/index.js';
import { CheckError } from './github.mjs';

function tagVersion(tag, name, directory) {
  if (typeof tag !== 'string') return null;
  const short = name.split('/').at(-1);
  const prefixes = [`${name}@`, `${short}@`, `${short}-`, `${short}/`];
  const prefix = prefixes.find(p => tag.startsWith(p));
  if (prefix) return semver.valid(tag.slice(prefix.length));
  // Bare vX.Y.Z tags are ambiguous in a monorepo; only use package-specific ones there.
  return directory ? null : semver.valid(tag);
}
const enc = encodeURIComponent;
export async function checkPlugin(row, client, { includePrereleases = false, refresh = false } = {}) {
  const base = { ...row, latestVersion: null, status: row.issue ? 'uncheckable' : 'unknown' };
  if (!row.source) return base;
  const source = row.source;
  const root = `/repos/${enc(source.owner)}/${enc(source.repo)}`;
  const packagePath = [source.directory, 'package.json'].filter(Boolean).join('/').split('/').map(enc).join('/');
  const readManifest = async ref => {
    const data = await client.get(`${root}/contents/${packagePath}${ref ? `?ref=${enc(ref)}` : ''}`, { refresh });
    if (!data || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') return null;
    let manifest; try { manifest = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')); } catch { throw new CheckError('INVALID_UPSTREAM_MANIFEST'); }
    if (manifest.name !== (row.packageName || row.name)) return null;
    const version = semver.valid(manifest.version);
    if (!version || (!includePrereleases && semver.prerelease(version))) return null;
    return { version, engines: typeof manifest.engines?.dsh === 'string' ? manifest.engines.dsh : null };
  };
  try {
    const releases = await client.get(`${root}/releases?per_page=30`, { refresh });
    if (releases !== null && !Array.isArray(releases)) throw new CheckError('INVALID_GITHUB_RESPONSE');
    const candidates = (releases || []).filter(r => !r.draft && (includePrereleases || !r.prerelease)).map(r => ({ tag: r.tag_name, version: tagVersion(r.tag_name, row.packageName || row.name, source.directory), type: 'release' })).filter(r => r.version && (includePrereleases || !semver.prerelease(r.version))).sort((a,b) => semver.rcompare(a.version,b.version));
    let latest = null;
    for (const c of candidates.slice(0,3)) {
      const manifest = await readManifest(c.tag);
      if (manifest && manifest.version === c.version) {
        const release=(releases||[]).find(r=>r.tag_name===c.tag);
        const assets=(release?.assets||[]).filter(a=>typeof a.name==='string'&&/\.tgz$/i.test(a.name)&&Number.isSafeInteger(a.id)&&a.id>0).map(a=>({name:a.name,id:a.id,digest:typeof a.digest==='string'?a.digest:null}));
        latest = { ...manifest, ref: c.tag, kind: c.type, assets }; break;
      }
    }
    if (!latest) {
      const tags = await client.get(`${root}/tags?per_page=30`, { refresh });
      if (tags !== null && !Array.isArray(tags)) throw new CheckError('INVALID_GITHUB_RESPONSE');
      const versions = (tags || []).map(t => ({ tag: t.name, version: tagVersion(t.name, row.packageName || row.name, source.directory) })).filter(t => t.version && (includePrereleases || !semver.prerelease(t.version))).sort((a,b) => semver.rcompare(a.version,b.version));
      for (const c of versions.slice(0,3)) {
        const manifest = await readManifest(c.tag);
        if (manifest && manifest.version === c.version) { latest = { ...manifest, ref: c.tag, kind: 'tag' }; break; }
      }
    }
    if (!latest) {
      // Follow a named installation branch. A fixed tag/SHA still checks the default branch for newer versions.
      const fixedRef = /^(?:v?\d+\.\d+\.\d+|[a-f\d]{7,40}$|semver:)/i.test(source.ref || '') || source.ref?.includes('@');
      const ref = source.ref && !fixedRef ? source.ref : '';
      const manifest = await readManifest(ref);
      if (manifest) latest = { ...manifest, ref: ref || 'HEAD', kind: 'branch' };
    }
    if (!latest) return { ...base, status: 'uncheckable', issue: 'UPSTREAM_PACKAGE_NOT_FOUND', checkedAt: new Date(client.now()).toISOString() };
    const current = semver.valid(row.currentVersion);
    const status = !current ? 'unknown_current_version' : semver.gt(latest.version,current) ? 'update_available' : semver.lt(latest.version,current) ? 'local_ahead' : 'version_current';
    return { ...base, latestVersion: latest.version, latestRef: latest.ref, releaseAssets: latest.assets || [], upstreamKind: latest.kind, dshRequirement: latest.engines, status, issue: null, updateUrl: latest.kind === 'release' ? `${source.url}/releases/tag/${enc(latest.ref)}` : `${source.url}/tree/${enc(latest.ref)}`, checkedAt: new Date(client.now()).toISOString(), note: latest.kind === 'branch' ? '分支 package.json 版本；尚未确认正式发布。相同版本不表示提交相同。' : '已核对上游 package.json 的包名及版本。仅覆盖最近 30 条发布或标签。' };
  } catch (e) {
    return { ...base, status: 'check_failed', issue: e instanceof CheckError ? e.code : 'CHECK_FAILED', retryAt: e.retryAt ? new Date(e.retryAt).toISOString() : null, checkedAt: new Date(client.now()).toISOString() };
  }
}
