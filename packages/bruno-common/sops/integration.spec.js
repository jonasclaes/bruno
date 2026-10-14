const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const sops = require('./index');
const yaml = require('js-yaml');

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

  test('creates and updates standard encrypted YAML while preserving typed values and recipient metadata', async () => {
    file = path.join(directory, 'dev.sops.yaml');
    await sops.writeSecrets(file, { token: 'YAML-SECRET', count: 5, enabled: false, missing: null }, [first.recipient]);
    const original = await fs.readFile(file, 'utf8');
    expect(original.trimStart()).not.toMatch(/^\{/);
    expect(original).not.toContain('YAML-SECRET');
    expect(await sops.readSecrets(file)).toEqual({ token: 'YAML-SECRET', count: 5, enabled: false, missing: null });
    const recipients = yaml.load(original).sops.age;
    await sops.writeSecrets(file, { token: 'updated', count: 9 });
    expect(yaml.load(await fs.readFile(file, 'utf8')).sops.age).toEqual(recipients);
    expect(await sops.readSecrets(file)).toEqual({ token: 'updated', count: 9 });
    await sops.updateRecipients(file, [first.recipient, second.recipient]);
    process.env.SOPS_AGE_KEY = second.key;
    expect(await sops.getRecipients(file)).toEqual([first.recipient, second.recipient]);
    expect(await sops.readSecrets(file)).toEqual({ token: 'updated', count: 9 });
  });

  test.each(['json', 'yaml'])('preserves nested JSON-compatible object and array values in %s secrets', async (extension) => {
    const phase = (name, operation) => operation.catch((error) => {
      error.message = `${name}: ${error.message}`;
      throw error;
    });
    file = path.join(directory, `objects.sops.${extension}`);
    const values = {
      object: { credentials: { password: 'NESTED-SECRET', retries: 3 }, active: false, sops: 'nested-value' },
      array: ['ARRAY-SECRET', 7, true, null, { password: 'another-secret' }],
      empty: {}
    };
    await phase('create', sops.writeSecrets(file, values, [first.recipient]));
    expect(await phase('read', sops.readSecrets(file))).toEqual(values);
    const encrypted = await fs.readFile(file, 'utf8');
    expect(encrypted).not.toContain('NESTED-SECRET');
    expect(encrypted).not.toContain('ARRAY-SECRET');
    const env = {
      secretsProvider: { type: 'sops', file },
      variables: [
        { name: 'object', value: {}, secret: true, dataType: 'object' },
        { name: 'array', value: [], secret: true, dataType: 'array' }
      ]
    };
    const hydrated = await phase('hydrate', sops.hydrateEnvironment(env));
    expect(hydrated.variables[0].value).toEqual(values.object);
    expect(hydrated.variables[1].value).toEqual(values.array);
    hydrated.variables[1].value = [9, { updated: true }, ['nested-array'], []];
    await phase('save-object', sops.saveEnvironmentSecrets({ ...hydrated, variables: [hydrated.variables[0]] }));
    await phase('save-array', sops.saveEnvironmentSecrets({ ...hydrated, variables: [hydrated.variables[1]] }));
    expect(await sops.readSecrets(file)).toEqual({ ...values, array: [9, { updated: true }, ['nested-array'], []] });
    await phase('rotate', sops.updateRecipients(file, [second.recipient]));
    process.env.SOPS_AGE_KEY = second.key;
    expect((await sops.readSecrets(file)).object).toEqual(values.object);
    hydrated.variables[1].value = [];
    await sops.saveEnvironmentSecrets(hydrated);
    expect((await sops.readSecrets(file)).array).toEqual([]);
  });

  test('preserves quoted and backslash variable names without SOPS path escaping corruption', async () => {
    const values = { 'quoted"name': 'one', 'back\\slash': 'two' };
    await sops.writeSecrets(file, values, [first.recipient]);
    await sops.writeSecrets(file, { 'quoted"name': 'updated', 'back\\slash': 'updated-again' });
    expect(await sops.readSecrets(file)).toEqual({ 'quoted"name': 'updated', 'back\\slash': 'updated-again' });
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
    await sops.writeSecrets(file, { token: 'private', count: 12, unrelated: 'other-environment' }, [first.recipient]);
    const env = {
      secretsProvider: { type: 'sops', file: path.basename(file) },
      variables: [
        { name: 'token', value: '', secret: true, enabled: false },
        { name: 'public', value: 'ordinary', secret: false, enabled: true },
        { name: 'count', value: '', secret: true, enabled: true, dataType: 'number', uid: 'existing-uid' }
      ]
    };
    const hydrated = await sops.hydrateEnvironment(env, directory);
    expect(hydrated.variables).toEqual([
      { name: 'token', value: 'private', secret: true, enabled: false },
      { name: 'public', value: 'ordinary', secret: false, enabled: true },
      { name: 'count', value: 12, secret: true, enabled: true, dataType: 'number', uid: 'existing-uid' }
    ]);
    expect(env.variables[0].value).toBe('');
    hydrated.variables[0].value = 'updated';
    await sops.saveEnvironmentSecrets(hydrated, directory);
    expect(await sops.readSecrets(file)).toEqual({ token: 'updated', count: 12, unrelated: 'other-environment' });
  });

  test('fails closed if a configured secret is missing', async () => {
    await sops.writeSecrets(file, { token: 'private' }, [first.recipient]);
    await expect(sops.hydrateEnvironment({
      secretsProvider: { type: 'sops', file },
      variables: [{ name: 'missing', secret: true }]
    })).rejects.toThrow(/missing/);
  });

  test('environment persistence merges only provided secret values into shared files', async () => {
    await sops.writeSecrets(file, { first: 'one', second: 'two' }, [first.recipient]);
    const provider = { type: 'sops', file };
    await Promise.all([
      sops.saveEnvironmentSecrets({
        secretsProvider: provider,
        variables: [{ name: 'first', value: 'updated-one', secret: true, enabled: false }]
      }),
      sops.saveEnvironmentSecrets({
        secretsProvider: provider,
        variables: [
          { name: 'second', value: 'updated-two', secret: true },
          { name: 'public', value: 'do-not-write', secret: false }
        ]
      })
    ]);
    expect(await sops.readSecrets(file)).toEqual({ first: 'updated-one', second: 'updated-two' });
    expect(await fs.readdir(directory)).toEqual(['dev.sops.json']);
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
