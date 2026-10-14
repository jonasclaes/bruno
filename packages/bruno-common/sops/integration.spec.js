const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const sops = require('./index');

// Test-only identities stay in memory; neither identities nor plaintext touch disk.
function bech32(hrp, bytes) {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const words = [];
  let bits = 0;
  let accumulator = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >>> bits) & 31);
    }
  }
  if (bits) words.push((accumulator << (5 - bits)) & 31);
  const expanded = [...hrp].map((char) => char.charCodeAt(0) >>> 5)
    .concat(0, [...hrp].map((char) => char.charCodeAt(0) & 31), words, [0, 0, 0, 0, 0, 0]);
  let checksum = 1;
  for (const word of expanded) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ word;
    [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3].forEach((generator, index) => {
      if ((top >>> index) & 1) checksum ^= generator;
    });
  }
  checksum ^= 1;
  for (let index = 0; index < 6; index++) words.push((checksum >>> (5 * (5 - index))) & 31);
  return `${hrp}1${words.map((word) => alphabet[word]).join('')}`;
}

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    recipient: bech32('age', publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)),
    key: bech32('age-secret-key-', privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)).toUpperCase()
  };
}

const binary = path.join(__dirname, 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'sops.exe' : 'sops');
const integration = existsSync(binary) ? describe : describe.skip;

integration('official bundled SOPS integration', () => {
  let directory;
  let file;
  let first;
  let second;
  let previousKey;
  beforeEach(async () => {
    directory = path.join(__dirname, `.test-${randomUUID()}`);
    await fs.mkdir(directory);
    file = path.join(directory, 'dev.sops.json');
    first = identity();
    second = identity();
    previousKey = process.env.SOPS_AGE_KEY;
    process.env.SOPS_AGE_KEY = first.key;
  });
  afterEach(async () => {
    if (previousKey === undefined) delete process.env.SOPS_AGE_KEY;
    else process.env.SOPS_AGE_KEY = previousKey;
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('creates fully encrypted JSON and preserves typed values', async () => {
    const values = { token: 'TOP-SECRET-TEST-VALUE', count: 7, enabled: true, empty: '', missing: null };
    await sops.writeSecrets(file, values, [first.recipient]);
    expect(await sops.readSecrets(file)).toEqual(values);
    expect(await sops.getRecipients(file)).toEqual([first.recipient]);
    expect(await fs.readFile(file, 'utf8')).not.toContain(values.token);
    expect(await fs.readdir(directory)).toEqual(['dev.sops.json']);
  });

  test('updates and deletes values while preserving wrapped recipients', async () => {
    await sops.writeSecrets(file, { token: 'before', removed: 'old' }, [first.recipient, second.recipient]);
    const before = JSON.parse(await fs.readFile(file, 'utf8')).sops.age;
    await sops.writeSecrets(file, { token: 'after', count: 4 }, [first.recipient]);
    expect(await sops.readSecrets(file)).toEqual({ token: 'after', count: 4 });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).sops.age).toEqual(before);
    expect(await fs.readdir(directory)).toEqual(['dev.sops.json']);
  });

  test('rotates the data key when removing a recipient and rejects their old identity', async () => {
    await sops.writeSecrets(file, { token: 'same-value' }, [first.recipient, second.recipient]);
    const before = JSON.parse(await fs.readFile(file, 'utf8')).token;
    await sops.updateRecipients(file, [second.recipient]);
    expect(await sops.getRecipients(file)).toEqual([second.recipient]);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).token).not.toBe(before);
    await expect(sops.readSecrets(file)).rejects.toThrow(/identities/);
    process.env.SOPS_AGE_KEY = second.key;
    expect(await sops.readSecrets(file)).toEqual({ token: 'same-value' });
  });

  test('can add a recipient and read using its standard SOPS identity', async () => {
    await sops.writeSecrets(file, { token: 'secret' }, [first.recipient]);
    await sops.updateRecipients(file, [first.recipient, second.recipient]);
    process.env.SOPS_AGE_KEY = second.key;
    expect(await sops.readSecrets(file)).toEqual({ token: 'secret' });
  });

  test('preserves standard SSH public recipients in authoritative SOPS age metadata', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const type = Buffer.from('ssh-ed25519');
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const size = (bytes) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      return Buffer.concat([header, bytes]);
    };
    const ssh = `ssh-ed25519 ${Buffer.concat([size(type), size(raw)]).toString('base64')}`;
    await sops.writeSecrets(file, { token: 'shared' }, [first.recipient, ssh]);
    expect(await sops.getRecipients(file)).toEqual([first.recipient, ssh]);
    await sops.writeSecrets(file, { token: 'updated' });
    expect(await sops.getRecipients(file)).toEqual([first.recipient, ssh]);
    await sops.updateRecipients(file, [first.recipient]);
    expect(await sops.getRecipients(file)).toEqual([first.recipient]);
    expect(await sops.readSecrets(file)).toEqual({ token: 'updated' });
  });

  test('hydrates and persists only secrets without changing ordinary variables', async () => {
    await sops.writeSecrets(file, { token: 'private', count: 12 }, [first.recipient]);
    const env = {
      secretsProvider: { type: 'sops', file: path.basename(file) },
      variables: [
        { name: 'token', value: '', secret: true, enabled: false },
        { name: 'public', value: 'ordinary', secret: false, enabled: true }
      ]
    };
    const hydrated = await sops.hydrateEnvironment(env, directory);
    expect(hydrated.variables).toEqual([
      { name: 'token', value: 'private', secret: true, enabled: false },
      { name: 'public', value: 'ordinary', secret: false, enabled: true },
      { name: 'count', value: 12, secret: true, enabled: true }
    ]);
    expect(env.variables[0].value).toBe('');
    hydrated.variables[0].value = 'updated';
    await sops.saveEnvironmentSecrets(hydrated, directory);
    expect(await sops.readSecrets(file)).toEqual({ token: 'updated', count: 12 });
  });

  test('fails closed if a configured secret is missing', async () => {
    await sops.writeSecrets(file, { token: 'private' }, [first.recipient]);
    await expect(sops.hydrateEnvironment({
      secretsProvider: { type: 'sops', file },
      variables: [{ name: 'missing', secret: true }]
    })).rejects.toThrow(/missing/);
  });

  test('serializes concurrent writers and never leaves staging or lock files', async () => {
    await sops.writeSecrets(file, { token: 'initial' }, [first.recipient]);
    await Promise.all([
      sops.writeSecrets(file, { token: 'writer-a' }),
      sops.writeSecrets(file, { token: 'writer-b' })
    ]);
    expect(['writer-a', 'writer-b']).toContain((await sops.readSecrets(file)).token);
    expect(await fs.readdir(directory)).toEqual(['dev.sops.json']);
  });

  test('retains encrypted original on failed decryption and sanitizes errors', async () => {
    await sops.writeSecrets(file, { token: 'NEVER-EXPOSE-IN-ERROR' }, [first.recipient]);
    const original = await fs.readFile(file, 'utf8');
    process.env.SOPS_AGE_KEY = second.key;
    await expect(sops.writeSecrets(file, { token: 'NEW-SECRET' })).rejects.toThrow(/identities/);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect(await fs.readdir(directory)).toEqual(['dev.sops.json']);
  });

  test('supports a fully empty secrets file without losing recipients', async () => {
    await sops.writeSecrets(file, { token: 'deleted' }, [first.recipient]);
    await sops.writeSecrets(file, {});
    expect(await sops.readSecrets(file)).toEqual({});
    expect(await sops.getRecipients(file)).toEqual([first.recipient]);
  });
});
