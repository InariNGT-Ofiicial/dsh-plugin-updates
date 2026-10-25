// Install only the runtime modules used by test-dsh-host.mjs, never a user profile.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const version = process.argv[2];
if (!['0.2.1-rc.2', '0.2.1-rc.3'].includes(version)) throw new Error('Pass a supported DSH version');
const root = path.resolve(process.env.DSH_HOST_MODULE_ROOT || 'work/dsh-host');
fs.mkdirSync(root, { recursive: true });
const packages = ['dsh-tools', 'dsh-skill', 'dsh-app-boot', 'dsh-tool-skill', 'dsh-skill-filesystem', 'dsh-scope', 'dsh-llm', 'dsh-sandbox', 'dsh-home-paths', 'dsh-launch-environment'].map(name => `@deepseek-ai/${name}@${version}`);
packages.push('@deepseek-ai/cordis@4.0.5', '@deepseek-ai/cordis-plugin-loader@1.0.6', '@deepseek-ai/cordis-plugin-group@1.0.5', '@deepseek-ai/cordis-plugin-include@1.0.10');
const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(file => file && fs.existsSync(file));
if (!npm) throw new Error('Cannot locate npm CLI; invoke this installer through npm exec -- node scripts/install-dsh-test-host.mjs <version>');
const result = spawnSync(process.execPath, [npm, 'install', '--prefix', root, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--no-package-lock', ...packages], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
