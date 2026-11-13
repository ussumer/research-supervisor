import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = join(root, 'src');
const outputRoot = join(root, 'lib');
const outputs = [];

async function compile(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((first, second) => first.name.localeCompare(second.name));
  for (const entry of entries) {
    const source = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source symlinks are unsupported: ${source}`);
    if (entry.isDirectory()) {
      await compile(source);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const code = stripTypeScriptTypes(await readFile(source, 'utf8'), { mode: 'strip' });
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: code, stdio: ['pipe', 'pipe', 'pipe'] });
      outputs.push({ path: join(outputRoot, relative(sourceRoot, source).replace(/\.ts$/, '.js')), code });
    }
  }
}

await compile(sourceRoot);
if (!outputs.length) throw new Error('No TypeScript source files found');
await rm(outputRoot, { recursive: true, force: true });
for (const output of outputs) {
  await mkdir(dirname(output.path), { recursive: true });
  await writeFile(output.path, output.code);
}
console.log(`Built ${outputs.length} ESM modules in lib (type erasure and syntax checks; no type checking)`);
