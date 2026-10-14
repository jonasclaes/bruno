'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');
const release = require('../packages/bruno-common/sops/release.json');

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || redirects > 5) return reject(new Error('Invalid SOPS download redirect.'));
    const request = https.get(parsed, { headers: { 'User-Agent': 'Bruno-SOPS-build' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        return resolve(download(new URL(response.headers.location, parsed).href, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error('Unable to download official SOPS build asset.'));
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 150 * 1024 * 1024) response.destroy(new Error('SOPS asset exceeds size limit.'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(120000, () => request.destroy(new Error('SOPS build download timed out.')));
    request.on('error', reject);
  });
}

async function bundleSops(targets = Object.keys(release.targets)) {
  for (const target of targets) {
    const metadata = release.targets[target];
    if (!metadata) throw new Error('Unsupported SOPS build target.');
    const directory = path.resolve(__dirname, '../packages/bruno-common/sops/bin', target);
    const destination = path.join(directory, target.startsWith('win32-') ? 'sops.exe' : 'sops');
    await fs.mkdir(directory, { recursive: true });
    let bytes;
    try {
      bytes = await fs.readFile(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) {
      bytes = await download(`https://github.com/getsops/sops/releases/download/v${release.version}/${metadata.asset}`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) {
      throw new Error('Official SOPS checksum verification failed.');
    }
    const staged = `${destination}.${randomUUID()}`;
    try {
      await fs.writeFile(staged, bytes, { flag: 'wx', mode: 0o755 });
      await fs.rename(staged, destination);
      await fs.chmod(destination, 0o755);
    } finally {
      await fs.unlink(staged).catch(() => {});
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args[0] !== '--target' || args.length !== 2)) {
    console.error('Usage: node scripts/bundle-sops.js [--target platform-arch]');
    process.exitCode = 1;
  } else {
    bundleSops(args.length ? [args[1]] : undefined).catch(() => {
      console.error('SOPS bundling failed; refusing to package without verified binaries.');
      process.exitCode = 1;
    });
  }
}

module.exports = { bundleSops };
