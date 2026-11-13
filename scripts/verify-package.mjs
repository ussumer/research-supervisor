import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Commands from '@deepseek-ai/dsh-commands';

// Validate our own built tarball against the installed, version-pinned host.
// No network, model calls, real user profile, or credentials are involved.
const root = fileURLToPath(new URL('../', import.meta.url));
const tarball = resolve(process.argv[2] ?? join(root, 'dist/ddd-research-dsh-research-supervisor-0.2.0-rc.1.tgz'));
const temporary = await mkdtemp(join(root, '.pack-smoke-'));
const ctx = new Context();
try {
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(listing.length > 25);
  assert.ok(listing.some(path => path === 'package/src/agents.ts'));
  assert.ok(listing.some(path => path === 'package/tests/agents.test.mjs'));
  assert.ok(listing.some(path => path === 'package/scripts/build.mjs'));
  assert.ok(!listing.includes('package/src/src.zip'));
  assert.ok(listing.every(path => /^package\/(LICENSE|package\.json|README\.md|CHANGELOG\.md|INSTALL-AGENT\.md|lib\/[a-z-]+\.js|src\/[a-z-]+\.ts|tests\/[a-z0-9.-]+\.mjs|scripts\/[a-z0-9-]+\.mjs|examples\/[a-z.]+)$/.test(path)));
  execFileSync('tar', ['-xzf', tarball, '-C', temporary]);
  const pkg = join(temporary, 'package');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  assert.equal(manifest.license, 'MIT');
  assert.match(await readFile(join(pkg, 'LICENSE'), 'utf8'), /MIT License/);
  assert.equal(manifest.version, '0.2.0-rc.1');
  assert.equal(manifest.engines.dsh, '0.2.1-rc.5');
  const plugin = await import(pathToFileURL(join(pkg, 'lib/index.js')).href);
  assert.equal(plugin.name, 'research-supervisor');
  for (const key of ['Config', 'apply', 'createPluginDependencies']) assert.ok(plugin[key]);
  for (const service of ['agents', 'tools', 'workingDirectory', 'agentLoop']) ctx.provide(service, {});
  await ctx.plugin(Commands);
  await ctx.plugin(plugin, { projectDirectory: join(temporary, 'project') });
  assert.ok(ctx.commands, 'Cordis plugin mounts with host services');

  const home = join(temporary, 'home');
  const env = { ...process.env, DSH_HOME: home, DSH_RESEARCH_PROJECT_DIRECTORY: join(temporary, 'project') };
  execFileSync(join(root, 'node_modules/.bin/dsh'), ['plugin', '--profile', 'research-supervisor', 'add', tarball], {
    env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  const profile = join(home, 'profiles', 'research-supervisor');
  await writeFile(join(profile, 'cordis.patch.yml'), await readFile(join(pkg, 'examples/cordis.patch.yml')));
  const config = execFileSync(join(root, 'node_modules/.bin/dsh'), ['--profile', 'research-supervisor', '--dump-config'], {
    env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.match(config, /@ddd-research\/dsh-research-supervisor/);
  console.log('PASS: source-inclusive package allowlist, package import, Cordis mount, isolated DSH profile composition; no model calls.');
  console.log('This uses existing host dependencies, not a clean-machine network install or browser/UI test.');
} finally {
  await ctx.fiber.dispose();
  await rm(temporary, { recursive: true, force: true });
}
