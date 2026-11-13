import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Commands from '@deepseek-ai/dsh-commands';
import { interpolate } from '@deepseek-ai/cordis-plugin-loader';
import yaml from 'js-yaml';

// Uses the installed version-pinned host and pnpm (which may fetch dependencies).
// Isolated DSH_HOME; no model calls or user profile changes.
const root = fileURLToPath(new URL('../', import.meta.url));
const tarball = resolve(process.argv[2] ?? join(root, 'dist/ddd-research-dsh-research-supervisor-0.2.0-rc.2.tgz'));
const temporary = await mkdtemp(join(root, '.pack-smoke-'));
const ctx = new Context();
const originalDirectory = process.env.DSH_RESEARCH_PROJECT_DIRECTORY;
const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => ({ __jsExpr: value }),
}));
try {
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  for (const path of ['LICENSE', 'cordis.patch.yml', 'src/agents.ts', 'tests/agents.test.mjs', 'scripts/build.mjs']) {
    assert.ok(listing.includes(`package/${path}`));
  }
  assert.ok(listing.every(path => /^package\/(LICENSE|cordis\.patch\.yml|package\.json|README\.md|CHANGELOG\.md|INSTALL-AGENT\.md|lib\/[a-z-]+\.js|src\/[a-z-]+\.ts|tests\/[a-z0-9.-]+\.mjs|scripts\/[a-z0-9-]+\.mjs|examples\/[a-z.]+)$/.test(path)));
  execFileSync('tar', ['-xzf', tarball, '-C', temporary]);
  const pkg = join(temporary, 'package');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  assert.equal(manifest.license, 'MIT');
  assert.match(await readFile(join(pkg, 'LICENSE'), 'utf8'), /MIT License/);
  assert.equal(manifest.version, '0.2.0-rc.2');
  assert.equal(manifest.engines.dsh, '0.2.1-rc.5');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  const plugin = await import(pathToFileURL(join(pkg, 'lib/index.js')).href);
  const patch = yaml.load(await readFile(join(pkg, 'cordis.patch.yml'), 'utf8'), { schema });
  const row = patch[0].insert[0];
  assert.equal(row.id, 'research-supervisor');
  assert.equal(row.name, manifest.name);
  delete process.env.DSH_RESEARCH_PROJECT_DIRECTORY;
  assert.throws(() => plugin.Config(interpolate(ctx, row.config)), /required|absolute/i);
  process.env.DSH_RESEARCH_PROJECT_DIRECTORY = 'relative/path';
  assert.throws(() => plugin.Config(interpolate(ctx, row.config)), /absolute/i);
  process.env.DSH_RESEARCH_PROJECT_DIRECTORY = join(temporary, 'project');
  const resolved = plugin.Config(interpolate(ctx, row.config));
  assert.equal(resolved.projectDirectory, join(temporary, 'project'));
  for (const service of ['agents', 'tools', 'workingDirectory', 'agentLoop']) ctx.provide(service, {});
  await ctx.plugin(Commands);
  await ctx.plugin(plugin, resolved);
  const agent = { id: 'package-smoke', session: { append() { return { seq: 0 }; } } };
  const status = await ctx.commands.execute(agent, '/research status', [], new AbortController().signal);
  assert.match(JSON.stringify(status), /No project is active/);

  const home = join(temporary, 'home');
  const env = { ...process.env, DSH_HOME: home };
  const dsh = args => execFileSync(join(root, 'node_modules/.bin/dsh'), args, {
    env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  });
  const profile = join(home, 'profiles', 'research-supervisor');
  for (let install = 0; install < 2; install++) {
    dsh(['plugin', '--profile', 'research-supervisor', 'add', tarball]);
    const installed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
    assert.equal(installed.dsh.profile.bundles.filter(name => name === manifest.name).length, 1);
  }
  const config = dsh(['--profile', 'research-supervisor', '--dump-config']);
  assert.equal((config.match(/name: ['"]?@ddd-research\/dsh-research-supervisor/g) ?? []).length, 1, 'exactly one auto-loaded plugin row');
  const override = join(temporary, 'override-project');
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: research-supervisor\n  config:\n    projectDirectory: ${override}\n`);
  const overridden = dsh(['--profile', 'research-supervisor', '--dump-config']);
  assert.ok(overridden.includes(override));
  assert.equal((overridden.match(/name: ['"]?@ddd-research\/dsh-research-supervisor/g) ?? []).length, 1);
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  dsh(['plugin', '--profile', 'research-supervisor', 'remove', manifest.name]);
  const removed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.ok(!removed.dsh.profile.bundles.includes(manifest.name));
  assert.ok(!dsh(['--profile', 'research-supervisor', '--dump-config']).includes(manifest.name));
  console.log('PASS: MIT/source allowlist, required directory validation, /research status, auto bundle registration, idempotent install, profile override, removal.');
  console.log('Existing host dependencies used; no model calls or browser/UI test.');
} finally {
  if (originalDirectory === undefined) delete process.env.DSH_RESEARCH_PROJECT_DIRECTORY;
  else process.env.DSH_RESEARCH_PROJECT_DIRECTORY = originalDirectory;
  await ctx.fiber.dispose();
  await rm(temporary, { recursive: true, force: true });
}
