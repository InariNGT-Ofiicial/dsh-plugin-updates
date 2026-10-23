import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildMarketIndex(root, commit, publishTimestamp) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Market installs must pin a lowercase 40-character Git commit');
  if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= 1e11) throw new Error('Pass Unix seconds, not milliseconds');
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const locales = {};
  for (const lang of ['en', 'zh']) locales[lang] = JSON.parse(await readFile(resolve(root, `locale/${lang}.json`), 'utf8')).meta;
  const icon = await readFile(resolve(root, 'icon.svg'));
  if (icon.length > 32 * 1024) throw new Error('Inline market icon exceeds 32 KiB');
  const repository = pkg.repository.url.replace(/\.git$/, '');
  return {
    format: 1,
    title: {en: 'Inari DSH Plugins', zh: 'Inari 的 DSH 插件'},
    description: {en: 'Release-pinned plugins maintained by InariNGT-Ofiicial.', zh: '由 InariNGT-Ofiicial 维护，安装源固定到已发布版本提交。'},
    metadata: {categories: {automation: {title: {en: 'Automation', zh: '自动化'}}}},
    plugins: [{
      name: pkg.name,
      title: Object.fromEntries(Object.entries(locales).map(([lang, meta]) => [lang, meta.title])),
      description: Object.fromEntries(Object.entries(locales).map(([lang, meta]) => [lang, meta.description])),
      author: pkg.author,
      icon: `data:image/svg+xml;base64,${icon.toString('base64')}`,
      homepage: pkg.homepage,
      repository: {url: repository},
      metadata: {category: 'automation', keywords: pkg.keywords},
      versions: [{version: pkg.version, publishTimestamp, source: {type: 'git', url: repository, commit}, engines: {dsh: pkg.engines.dsh}}],
    }],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [commit, seconds, target] = process.argv.slice(2);
  if (!target) throw new Error('Usage: node scripts/market-index.mjs <commit> <Unix-seconds> <output.json>');
  const index = await buildMarketIndex(process.cwd(), commit, Number(seconds));
  await mkdir(dirname(resolve(target)), {recursive: true});
  await writeFile(target, JSON.stringify(index, null, 2) + '\n');
  console.log(JSON.stringify({version: index.plugins[0].versions[0].version, commit, output: target}));
}
