'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const release = require('./release.json');

const TIMEOUT = 30000;
const MAX_BYTES = 16 * 1024 * 1024;
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'sops']);
const format = ['--input-type', 'json', '--output-type', 'json'];
const failure = (message) => Object.assign(new Error(message), { code: 'SOPS_ERROR' });

function safeObject(value, scalarOnly = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('SOPS values must be an object.');
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key) || !key || key.includes('\0')) {
      throw failure('Invalid SOPS variable name.');
    }
    if (item !== null && !['string', 'boolean', 'number'].includes(typeof item)) {
      if (scalarOnly) throw failure('SOPS secrets must be flat JSON values.');
      throw failure('Invalid SOPS display label.');
    }
    if (typeof item === 'number' && !Number.isFinite(item)) throw failure('Invalid SOPS value.');
    result[key] = item;
  }
  return result;
}

function recipientsList(recipients) {
  if (!Array.isArray(recipients) || !recipients.length) {
    throw failure('At least one SOPS recipient is required.');
  }
  return [...new Set(recipients.map((recipient) => {
    if (typeof recipient !== 'string' || /[\r\n,\0]/.test(recipient)) {
      throw failure('Invalid SOPS public recipient.');
    }
    const value = recipient.trim();
    if (!/^(age1[023456789acdefghjklmnpqrstuvwxyz]+|ssh-(?:ed25519|rsa) [A-Za-z0-9+/]+={0,2}(?: [^\r\n,]+)?)$/.test(value)) {
      throw failure('Only age or SSH public recipients are supported.');
    }
    return value;
  }))];
}

function resolveSecretsPath(provider, basePath) {
  if (!provider || provider.type !== 'sops' || typeof provider.file !== 'string'
      || !provider.file.trim() || provider.file.includes('\0')) {
    throw failure('Invalid SOPS secrets provider.');
  }
  if (path.isAbsolute(provider.file)) return path.normalize(provider.file);
  if (typeof basePath !== 'string' || !path.isAbsolute(basePath)) {
    throw failure('Relative SOPS files require an absolute workspace root.');
  }
  return path.resolve(basePath, provider.file);
}

async function binaryPath() {
  const target = `${process.platform}-${process.arch}`;
  const metadata = release.targets[target];
  if (!metadata) throw failure('SOPS is not bundled for this platform.');
  const name = process.platform === 'win32' ? 'sops.exe' : 'sops';
  const binary = process.resourcesPath && !process.defaultApp
    ? path.join(process.resourcesPath, 'sops', target, name)
    : path.join(__dirname, 'bin', target, name);
  try {
    // Packaging verifies the upstream checksum before platform code signing.
    await fs.access(binary, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return binary;
  } catch (error) {
    throw failure('Bundled SOPS is unavailable. Rebuild or reinstall Bruno.');
  }
}

async function run(args, input = '') {
  const binary = await binaryPath();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      // Standard SOPS age/SSH identity discovery is deliberately left untouched.
      env: process.env
    });
    let output = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(failure('SOPS operation timed out.'));
    }, TIMEOUT);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(output).toString('utf8'));
      output = [];
    }
    child.stdout.on('data', (bytes) => {
      size += bytes.length;
      if (size > MAX_BYTES) {
        child.kill();
        finish(failure('SOPS output exceeds the supported size.'));
      } else output.push(bytes);
    });
    // SOPS diagnostics may contain decrypted values; never surface or retain them.
    child.stderr.resume();
    child.on('error', () => finish(failure('Unable to execute bundled SOPS.')));
    child.on('close', (code) => finish(code === 0 ? null : failure(
      'SOPS operation failed. Verify the encrypted file, recipients and local age/SSH identities.'
    )));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function parseDocument(text) {
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)
        || !Object.hasOwn(doc, 'sops') || !doc.sops || typeof doc.sops !== 'object'
        || typeof doc.sops.mac !== 'string' || !doc.sops.mac.startsWith('ENC[')) {
      throw new Error();
    }
    for (const [key, value] of Object.entries(doc)) {
      if (key === 'sops') continue;
      // SOPS deliberately leaves null and empty strings unchanged.
      if (forbidden.has(key) || (value !== null && value !== '' && (typeof value !== 'string' || !value.startsWith('ENC[')))) {
        throw new Error();
      }
    }
    return doc;
  } catch {
    throw failure('Expected a fully encrypted, flat SOPS JSON file.');
  }
}

async function encryptedDocument(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) {
    throw failure('Invalid SOPS encrypted file.');
  }
  return parseDocument(await fs.readFile(file, 'utf8'));
}

async function readSecrets(file) {
  try {
    await encryptedDocument(file);
    const text = await run(['decrypt', ...format, path.resolve(file)]);
    return safeObject(JSON.parse(text), true);
  } catch (error) {
    if (error.code === 'SOPS_ERROR') throw error;
    throw failure('Unable to read SOPS secrets.');
  }
}

function metadataRecipients(doc) {
  if (doc.sops.key_groups) throw failure('SOPS key groups are not supported.');
  return (doc.sops.age || []).map((entry) => {
    if (!entry || typeof entry.recipient !== 'string') throw failure('Invalid SOPS recipient metadata.');
    return entry.recipient;
  });
}

async function getRecipients(file) {
  try {
    return metadataRecipients(await encryptedDocument(file));
  } catch (error) {
    if (error.code === 'SOPS_ERROR') throw error;
    throw failure('Unable to read SOPS recipients.');
  }
}

async function withLock(file, operation) {
  let lock;
  let lockPath;
  try {
    const absolute = path.resolve(file);
    file = path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute));
    lockPath = `${file}.sops.lock`;
    const start = Date.now();
    while (!lock) {
      try {
        lock = await fs.open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() - start >= TIMEOUT) throw failure('SOPS file is busy. Retry after the other writer completes.');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return await operation(file);
  } catch (error) {
    if (error.code === 'SOPS_ERROR') throw error;
    throw failure('Unable to safely update the SOPS file.');
  } finally {
    if (lock) {
      await lock.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

async function atomicWrite(file, text, original) {
  const staged = `${file}.${randomUUID()}.encrypted`;
  let handle;
  try {
    handle = await fs.open(staged, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    let current;
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw failure('Invalid SOPS destination.');
      current = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== original) throw failure('SOPS file changed concurrently. Retry the operation.');
    await fs.rename(staged, file);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(staged).catch(() => {});
  }
}

async function existingText(file) {
  try {
    await encryptedDocument(file);
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeSecrets(file, values, recipients) {
  values = safeObject(values, true);
  return withLock(file, async (destination) => {
    const original = await existingText(destination);
    let text;
    if (original === undefined) {
      const list = recipientsList(recipients);
      text = await run(['encrypt', ...format, '--filename-override', destination,
        '--age', list.join(','), '--unencrypted-suffix', `_${randomUUID()}`], JSON.stringify(values));
    } else {
      const metadata = parseDocument(original).sops;
      // Reject selective encryption before SOPS can write any plaintext to staging.
      if (metadata.unencrypted_regex || metadata.encrypted_regex
          || metadata.unencrypted_comment_regex || metadata.encrypted_comment_regex
          || Object.keys(values).some((key) =>
            (metadata.unencrypted_suffix && key.endsWith(metadata.unencrypted_suffix))
            || (metadata.encrypted_suffix && !key.endsWith(metadata.encrypted_suffix)))) {
        throw failure('SOPS encryption policy would leave a secret unencrypted.');
      }
      const staged = `${destination}.${randomUUID()}.json`;
      try {
        await fs.writeFile(staged, original, { flag: 'wx', mode: 0o600 });
        // set/unset retain the original wrapped data key and recipient metadata.
        for (const [key, value] of Object.entries(values)) {
          await run(['set', ...format, '--value-stdin', staged, JSON.stringify([key])], JSON.stringify(value));
          parseDocument(await fs.readFile(staged, 'utf8'));
        }
        for (const key of Object.keys(parseDocument(original))) {
          if (key !== 'sops' && !Object.hasOwn(values, key)) {
            await run(['unset', ...format, staged, JSON.stringify([key])]);
          }
        }
        text = await fs.readFile(staged, 'utf8');
      } finally {
        await fs.unlink(staged).catch(() => {});
      }
    }
    parseDocument(text);
    await atomicWrite(destination, text, original);
  });
}

async function updateRecipients(file, recipients) {
  const list = recipientsList(recipients);
  return withLock(file, async (destination) => {
    const original = await existingText(destination);
    if (original === undefined) throw failure('SOPS secrets file does not exist.');
    const old = metadataRecipients(parseDocument(original));
    const args = ['rotate', ...format];
    const added = list.filter((key) => !old.includes(key));
    const removed = old.filter((key) => !list.includes(key));
    if (added.length) args.push('--add-age', added.join(','));
    if (removed.length) args.push('--rm-age', removed.join(','));
    const text = await run([...args, destination]);
    const actual = metadataRecipients(parseDocument(text));
    if (actual.length !== list.length || list.some((key) => !actual.includes(key))) {
      throw failure('SOPS recipient rotation could not be verified.');
    }
    await atomicWrite(destination, text, original);
  });
}

async function readRecipientLabels(file) {
  try {
    const labels = safeObject(JSON.parse(await fs.readFile(`${file}.recipients.json`, 'utf8')));
    if (Object.values(labels).some((value) => typeof value !== 'string')) throw new Error();
    return labels;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw failure('Unable to read SOPS public recipient labels.');
  }
}

async function writeRecipientLabels(file, labels) {
  labels = safeObject(labels);
  if (Object.values(labels).some((value) => typeof value !== 'string' || value.length > 256
      || /AGE-SECRET-KEY-|BEGIN .*PRIVATE KEY/.test(value))) {
    throw failure('Recipient labels must contain public display names only.');
  }
  if (Object.keys(labels).length) recipientsList(Object.keys(labels));
  return withLock(`${file}.recipients.json`, async (destination) => {
    let original;
    try {
      original = await fs.readFile(destination, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await atomicWrite(destination, `${JSON.stringify(labels, null, 2)}\n`, original);
  });
}

async function hydrateEnvironment(env, basePath) {
  if (!env?.secretsProvider) return env;
  const values = await readSecrets(resolveSecretsPath(env.secretsProvider, basePath));
  const variables = (env.variables || []).map((variable) => {
    if (variable.secret !== true) return { ...variable };
    if (!Object.hasOwn(values, variable.name)) throw failure('A configured SOPS secret is missing.');
    return { ...variable, value: values[variable.name] };
  });
  for (const [name, value] of Object.entries(values)) {
    if (!variables.some((variable) => variable.name === name && variable.secret === true)) {
      variables.push({ name, value, enabled: true, secret: true });
    }
  }
  return { ...env, variables };
}

async function saveEnvironmentSecrets(env, basePath) {
  if (!env?.secretsProvider) return;
  const values = Object.create(null);
  for (const variable of env.variables || []) {
    if (variable.secret !== true) continue;
    if (typeof variable.name !== 'string' || forbidden.has(variable.name)) throw failure('Invalid SOPS variable name.');
    values[variable.name] = variable.value;
  }
  await writeSecrets(resolveSecretsPath(env.secretsProvider, basePath), values);
}

module.exports = {
  readSecrets, writeSecrets, getRecipients, updateRecipients,
  readRecipientLabels, writeRecipientLabels, resolveSecretsPath,
  hydrateEnvironment, saveEnvironmentSecrets
};
