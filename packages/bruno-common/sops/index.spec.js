const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sops = require('./index');

describe('SOPS provider configuration and public labels', () => {
  let directory;
  let file;
  beforeEach(async () => {
    directory = path.join(__dirname, `.test-${randomUUID()}`);
    await fs.mkdir(directory);
    file = path.join(directory, 'secrets.json');
  });
  afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

  test('resolves workspace files and requires absolute files without a workspace', () => {
    expect(sops.resolveSecretsPath({ type: 'sops', file: 'secrets/dev.json' }, directory))
      .toBe(path.join(directory, 'secrets/dev.json'));
    expect(sops.resolveSecretsPath({ type: 'sops', file })).toBe(file);
    expect(() => sops.resolveSecretsPath({ type: 'sops', file: 'relative.json' })).toThrow(/workspace root/);
    expect(() => sops.resolveSecretsPath({ type: 'vault', file })).toThrow(/provider/);
    expect(() => sops.resolveSecretsPath({ type: 'sops', file: '' })).toThrow(/provider/);
  });

  test('does not change environments without a provider', async () => {
    const env = { variables: [{ name: 'token', value: 'local' }] };
    expect(await sops.hydrateEnvironment(env)).toBe(env);
    await sops.saveEnvironmentSecrets(env);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  test('round-trips public display names independently of recipient metadata', async () => {
    const recipient = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(await sops.readRecipientLabels(file)).toEqual({});
    await sops.writeRecipientLabels(file, { [recipient]: 'Alice laptop' });
    expect(await sops.readRecipientLabels(file)).toEqual({ [recipient]: 'Alice laptop' });
    expect(await fs.readdir(directory)).toEqual(['secrets.json.recipients.json']);
    await expect(sops.getRecipients(file)).rejects.toThrow(/recipients/);
  });

  test('rejects private keys, non-string labels and prototype pollution', async () => {
    await expect(sops.writeRecipientLabels(file, { 'AGE-SECRET-KEY-PRIVATE': 'private' })).rejects.toThrow(/recipient/);
    await expect(sops.writeRecipientLabels(file, { age1abc: 'AGE-SECRET-KEY-PRIVATE' })).rejects.toThrow(/public/);
    await expect(sops.writeRecipientLabels(file, JSON.parse('{"__proto__":"polluted"}'))).rejects.toThrow();
    await expect(sops.writeSecrets(file, JSON.parse('{"__proto__":"polluted"}'), ['age1abc'])).rejects.toThrow();
    await expect(sops.writeSecrets(file, { token: { nested: undefined } }, ['age1abc'])).rejects.toThrow(/JSON-compatible/);
    await expect(sops.writeSecrets(file, { token: JSON.parse('{"__proto__":"polluted"}') }, ['age1abc'])).rejects.toThrow();
    await expect(sops.writeSecrets(file, { token: [Infinity] }, ['age1abc'])).rejects.toThrow(/JSON-compatible/);
    await expect(sops.writeSecrets(file, { 'path[0]': 'unsafe-path' }, ['age1abc'])).rejects.toThrow(/variable name/);
    const cyclic = {};
    cyclic.self = cyclic;
    await expect(sops.writeSecrets(file, { token: cyclic }, ['age1abc'])).rejects.toThrow(/structural limits/);
    expect({}.polluted).toBeUndefined();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  test('rejects final-recipient removal and non-public recipient inputs before spawning', async () => {
    await expect(sops.updateRecipients(file, [])).rejects.toThrow(/At least one/);
    await expect(sops.updateRecipients(file, ['AGE-SECRET-KEY-1PRIVATE'])).rejects.toThrow(/public/);
    await expect(sops.updateRecipients(file, ['age1abc,age1def'])).rejects.toThrow(/recipient/);
  });

  test('authoritative metadata accepts SSH and age recipients, not display names', async () => {
    const recipients = ['age1abc', 'ssh-ed25519 AAAA'];
    await fs.writeFile(file, JSON.stringify({
      token: 'ENC[AES256_GCM,data:test]',
      sops: { mac: 'ENC[AES256_GCM,data:mac]', age: recipients.map((recipient) => ({ recipient, enc: 'wrapped' })) }
    }));
    expect(await sops.getRecipients(file)).toEqual(recipients);
  });

  test('fails closed on plaintext files and malformed or unsafe metadata', async () => {
    await fs.writeFile(file, '{"token":"plain"}');
    await expect(sops.readSecrets(file)).rejects.toThrow(/encrypted/);
    await fs.writeFile(file, '{"token":"plain","sops":{"mac":"ENC[mac]","age":[]}}');
    await expect(sops.getRecipients(file)).rejects.toThrow(/encrypted/);
    await fs.writeFile(file, '{"__proto__":"ENC[data]","sops":{"mac":"ENC[mac]"}}');
    await expect(sops.getRecipients(file)).rejects.toThrow(/encrypted/);
  });

  test('reads authoritative YAML public metadata without decrypting or interpreting custom tags', async () => {
    const yamlFile = path.join(directory, 'secrets.yaml');
    await fs.writeFile(yamlFile, [
      'token: ENC[AES256_GCM,data:test]',
      'sops:',
      '  mac: ENC[AES256_GCM,data:mac]',
      '  age:',
      '    - recipient: ssh-ed25519 AAAA',
      '      enc: |',
      '        public wrapped data key'
    ].join('\n'));
    expect(await sops.getRecipients(yamlFile)).toEqual(['ssh-ed25519 AAAA']);
    await fs.writeFile(yamlFile, 'token: !!js/function "malicious"\nsops: {}');
    await expect(sops.getRecipients(yamlFile)).rejects.toThrow(/encrypted/);
    await fs.writeFile(yamlFile, '__proto__: ENC[data]\nsops:\n  mac: ENC[mac]');
    await expect(sops.getRecipients(yamlFile)).rejects.toThrow(/encrypted/);
  });

  test('rejects symbolic link destinations without touching the target', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(directory, 'target.json');
    await fs.writeFile(target, 'unchanged');
    await fs.symlink(target, file);
    await expect(sops.writeSecrets(file, { token: 'new' }, ['age1abc'])).rejects.toThrow(/Invalid/);
    expect(await fs.readFile(target, 'utf8')).toBe('unchanged');
  });

  test('rejects policies that could write new secrets unencrypted before spawning', async () => {
    const doc = { token: 'ENC[data]', sops: { mac: 'ENC[mac]', unencrypted_suffix: '_unencrypted' } };
    const original = JSON.stringify(doc);
    await fs.writeFile(file, original);
    await expect(sops.writeSecrets(file, { password_unencrypted: 'never write this' })).rejects.toThrow(/policy/);
    await expect(sops.writeSecrets(file, { token: { password_unencrypted: 'never write this either' } })).rejects.toThrow(/policy/);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect(await fs.readdir(directory)).toEqual(['secrets.json']);
  });
});
