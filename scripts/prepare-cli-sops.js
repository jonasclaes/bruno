'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const common = path.resolve(__dirname, '../packages/bruno-common');
const destination = path.resolve(__dirname, '../packages/bruno-cli/node_modules/@usebruno/common');
const marker = '.bruno-sops-bundle';

async function managed(directory) {
  try {
    return await fs.readFile(path.join(directory, marker), 'utf8') === 'Bruno SOPS packaging\n';
  } catch {
    return false;
  }
}

async function copyDependency(name, source, target) {
  const packageFile = require.resolve(`${name}/package.json`, { paths: [source] });
  const directory = path.dirname(packageFile);
  const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  if (name === 'js-yaml' && pkg.version !== '4.3.2') {
    throw new Error('Install the pinned patched js-yaml dependency before packaging the CLI.');
  }
  const output = path.join(target, 'node_modules', name);
  await fs.cp(directory, output, {
    recursive: true,
    filter: (entry) => !path.relative(directory, entry).split(path.sep).includes('node_modules')
  });
  for (const dependency of Object.keys(pkg.dependencies || {})) {
    await copyDependency(dependency, directory, output);
  }
}

async function prepare() {
  if (process.argv.includes('--clean')) {
    if (await managed(destination)) await fs.rm(destination, { recursive: true, force: true });
    return;
  }
  try {
    await fs.lstat(destination);
    if (!await managed(destination)) throw new Error('Refusing to overwrite an installed common package.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const staged = `${destination}.${randomUUID()}`;
  try {
    await fs.mkdir(staged, { recursive: true });
    const pkg = JSON.parse(await fs.readFile(path.join(common, 'package.json'), 'utf8'));
    for (const entry of [...pkg.files, 'package.json']) {
      await fs.cp(path.join(common, entry), path.join(staged, entry), { recursive: true });
    }
    for (const dependency of Object.keys(pkg.dependencies)) {
      await copyDependency(dependency, common, staged);
    }
    await fs.writeFile(path.join(staged, marker), 'Bruno SOPS packaging\n');
    if (await managed(destination)) await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(staged, destination);
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}

prepare().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
