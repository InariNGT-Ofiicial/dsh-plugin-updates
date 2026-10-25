// Real official modules; only unrelated prompt/profile/agent services are fixtures.
// No live profiles, credentials, model calls, media downloads or GPU jobs are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.env.DSH_TEST_PLUGIN_ROOT || '.');
const hostRoot = path.resolve(process.env.DSH_HOST_MODULE_ROOT || 'work/dsh-host');
const hostURL = pathToFileURL(path.join(hostRoot, 'host-test.mjs')).href;
const requireHost = createRequire(hostURL);
const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
const scratch = path.resolve(process.env.DSH_TEST_WORKSPACE || 'work/host-tests');
fs.mkdirSync(scratch, { recursive: true });
const work = fs.mkdtempSync(path.join(scratch, 'dsh-compat-'));
process.env.DSH_HOME = path.join(work, 'home');
process.env.DSH_AGENTS_HOME = path.join(work, 'agents');
process.env.DSH_COVER_ROOT = path.join(work, 'audio');
process.env.DSH_TRAIN_ROOT = path.join(work, 'training');
fs.mkdirSync(process.env.DSH_COVER_ROOT, { recursive: true });
// Resolve the tested plugin's DSH imports to exactly the selected native host.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, { ...context, parentURL: hostURL });
  return nextResolve(specifier, context);
} });
const [{ Context, Service }, tools, boot, skills] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-tools'),
  load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-skill'),
]);
const version = boot.getDshRuntimeVersion();
assert.ok(['0.2.1-rc.2', '0.2.1-rc.3'].includes(version), `Untested host: ${version}`);
if (process.env.DSH_TEST_VERSION) assert.equal(version, process.env.DSH_TEST_VERSION);
for (const name of ['dsh-tools', 'dsh-skill', 'dsh-app-boot']) {
  const pkg = JSON.parse(fs.readFileSync(requireHost.resolve(`@deepseek-ai/${name}/package.json`), 'utf8'));
  assert.equal(pkg.version, version, `Mixed host modules: ${name}`);
}
class Prompt extends Service { constructor(ctx) { super(ctx, 'systemPrompt'); } tools() { return () => {}; } }
class Profile extends Service { constructor(ctx) { super(ctx, 'profileContext'); this.dir = path.join(work, 'home/profiles/compat'); } }
class Agents extends Service { constructor(ctx) { super(ctx, 'agents'); } }
class WorkingDirectory extends Service { constructor(ctx) { super(ctx, 'workingDirectory'); } async ensure() { return work; } }
const ctx = new Context();
let fiber;
let calls = 0;
const execute = async (name, args = {}) => {
  const result = await ctx.tools.execute({ name, arguments: args, callId: `compat-${++calls}`, signal: new AbortController().signal });
  assert.equal(result.isError, false, JSON.stringify(result.error));
  assert.ok(result.content.some(block => block.type === 'text' && block.text.length));
  assert.notEqual(result.value, undefined, 'Canonical output survived native schema validation');
  return result.value;
};
const manifestPath = path.join(root, 'package.json');
let identity = 'dsh-anime-voice';
try {
  for (const service of [Prompt, Profile, Agents, WorkingDirectory, tools.ToolRuntime, skills.SkillRegistry]) await ctx.plugin(service).await();
  if (fs.existsSync(manifestPath)) {
    const manifest = boot.readProfileManifest('compat', root);
    identity = manifest.name;
    assert.equal(boot.evaluatePluginCompatibility(manifest), undefined, 'No version exemption is needed');
    for (const supported of ['0.2.1-rc.2', '0.2.1-rc.3']) {
      assert.equal(boot.evaluatePluginCompatibility(manifest, {}, supported), undefined);
      assert.equal(boot.evaluatePluginCompatibility({ ...manifest, engines: {} }, {}, supported), undefined, 'DSH peers support both hosts');
    }
    for (const unsupported of ['0.2.1-rc.1', '0.3.0', '1.0.0']) assert.ok(boot.evaluatePluginCompatibility(manifest, {}, unsupported));
    const entries = boot.composeEntries([boot.bundlePatchPaths(root, manifest.dsh.bundle).flatMap(file => boot.loadOverlayPatches('compat', file))]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, identity);
    const plugin = await import(pathToFileURL(path.join(root, manifest.main)).href);
    const config = {
      ...entries[0].config, songRoot: process.env.DSH_COVER_ROOT, probeDir: path.join(work, 'probe'),
      trainRoot: process.env.DSH_TRAIN_ROOT, dataDir: path.join(work, 'data'),
      pythonPath: identity === 'dsh-research-toolkit' ? (process.env.DSH_TEST_PYTHON || 'python') : '', workspaceRoot: path.join(work, 'jobs'),
      // Persisted defaults remain unchanged. This isolated test prevents background network activity.
      checkOnStart: false, intervalHours: 0,
    };
    fiber = ctx.plugin(plugin, plugin.Config ? plugin.Config(config) : config);
    await fiber.await();
    const schemas = ctx.tools.schemas();
    const expected = { 'dsh-cover-pipeline': 9, 'dsh-train-pipeline': 19, 'dsh-bili-humanism': 14, 'dsh-plugin-updates': 4, 'dsh-research-toolkit': 5 };
    assert.equal(schemas.length, expected[identity]);
    for (const schema of schemas) tools.assertSupportedJsonSchema(schema.parameters);
    if (identity === 'dsh-cover-pipeline') assert.ok((await execute('cover_plan', { request: 'Synthetic compatibility check' })).flow.length);
    if (identity === 'dsh-train-pipeline') assert.equal((await execute('train_plan', { goal: 'Synthetic compatibility check' })).ok, true);
    if (identity === 'dsh-bili-humanism') {
      const status = JSON.parse(await execute('bili_humanism_status'));
      assert.deepEqual(status.platformWriteTools, []);
      assert.equal(status.dailyFetching.enabled, false);
      const guide = JSON.parse(await execute('bili_humanism_guide'));
      assert.ok(guide.length);
    }
    if (identity === 'dsh-plugin-updates') {
      await execute('plugin_updates_status');
      const policy = JSON.parse(await execute('plugin_updates_auto_update', { action: 'get' }));
      assert.equal(policy.enabled, true);
      const schedule = JSON.parse(await execute('plugin_updates_schedule', { action: 'get' }));
      assert.ok(schedule);
    }
    if (identity === 'dsh-research-toolkit') {
      const catalog = await execute('research_catalog');
      assert.equal(catalog.ok, true, catalog.diagnostics);
      assert.ok((await ctx.skills.get('research-toolkit', { cwd: work })).content.includes('research_compile'));
    }
    const unguard = ctx.tools.guard(() => 'compatibility test denial');
    try {
      const denied = await ctx.tools.execute({ name: schemas[0].name, arguments: {}, callId: 'guarded-compat', signal: new AbortController().signal });
      assert.equal(denied.isError, true);
      assert.match(denied.error.message, /compatibility test denial/);
    } finally { unguard(); }
    await fiber.dispose();
    assert.equal(ctx.tools.schemas().length, 0, 'Plugin disposal unregisters tools');
  } else {
    const filesystem = await load('@deepseek-ai/dsh-skill-filesystem');
    fiber = ctx.plugin(filesystem, { includeDefaultRoots: false, customSkillDirs: [path.join(root, 'skills')], watch: false });
    await fiber.await();
    await ctx.plugin(await load('@deepseek-ai/dsh-tool-skill')).await();
    const names = ['anime-voice-clone-training', 'anime-voice-line-extractor'];
    assert.deepEqual((await ctx.skills.list({ cwd: work })).map(row => row.name).sort(), names);
    for (const name of names) {
      const result = await execute('skill', { name });
      assert.equal(result.name, name);
      assert.deepEqual(result.resourceBase, { kind: 'directory', path: path.join(root, 'skills', name) });
      assert.ok(result.content.includes('scripts/'));
    }
    await fiber.dispose();
    assert.equal((await ctx.skills.list({ cwd: work })).length, 0);
  }
  console.log(JSON.stringify({ status: 'passed', plugin: identity, host: version, nativeCalls: calls,
    checks: 'native manifest/bundle gates, registration, parameter schemas, output validation, policy denial, rendering, disposal; skill-only repositories use the official filesystem provider and skill tool' }));
} finally {
  await ctx.fiber.dispose();
  fs.rmSync(work, { recursive: true, force: true });
}
