const fs = require('fs');
const path = require('path');
const mockValues = { token: 'decrypted-secret' };

jest.mock('@usebruno/common/sops', () => ({
  resolveSecretsPath: (provider, base) => require('path').resolve(base || '.', provider.file),
  hydrateEnvironment: jest.fn(async (env, base) => {
    const file = require('path').resolve(base || '.', env.secretsProvider.file);
    if (!require('fs').existsSync(file)) throw new Error('Missing encrypted file');
    return {
      ...env,
      variables: env.variables.map((variable) => {
        if (!variable.secret) return variable;
        if (!Object.hasOwn(mockValues, variable.name)) throw new Error('Missing configured secret');
        return { ...variable, value: mockValues[variable.name] };
      })
    };
  })
}), { virtual: true });

const { prepareEnvironmentForExport, relativeEnvironmentReference } = require('../environment-export');
const { stringifyEnvironment, parseEnvironment } = require('@usebruno/filestore');
const sops = require('@usebruno/common/sops');

describe('SOPS environment exports', () => {
  let directory;
  let file;
  beforeEach(() => {
    jest.clearAllMocks();
    directory = fs.mkdtempSync(path.join(__dirname, '.environment-export-'));
    file = path.join(directory, 'secrets.json');
    fs.writeFileSync(file, 'encrypted ciphertext');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  const environment = (secretsProvider) => ({
    name: 'Dev', secretsProvider,
    variables: [
      { name: 'token', value: 'decrypted-secret', secret: true, dataType: 'string', enabled: true, type: 'text' },
      { name: 'host', value: 'localhost', enabled: true, type: 'text' }
    ]
  });

  it('preserves app-local global provider refs while excluding decrypted values', async () => {
    const exported = await prepareEnvironmentForExport(environment({ type: 'sops', file }));
    expect(exported.secretsProvider).toEqual({ type: 'sops', file });
    expect(exported.variables[0]).toMatchObject({ value: '', secret: true, dataType: 'string' });
    expect(exported.variables[1].value).toBe('localhost');
    expect(JSON.stringify(exported)).not.toContain('decrypted-secret');
  });

  it('resolves workspace-root refs and emits refs relative to the exported descriptor directory', async () => {
    const exported = await prepareEnvironmentForExport(environment({ type: 'sops', file: 'secrets.json' }), directory);
    const descriptorRoot = path.join(directory, 'exports');
    fs.mkdirSync(descriptorRoot);
    const descriptor = relativeEnvironmentReference(exported, descriptorRoot);
    expect(descriptor.secretsProvider).toEqual({ type: 'sops', file: '../secrets.json' });
    expect(path.resolve(descriptorRoot, descriptor.secretsProvider.file)).toBe(file);
  });

  it('fails closed for dangling provider files and missing declared secret names', async () => {
    await expect(prepareEnvironmentForExport(environment({
      type: 'sops', file: path.join(directory, 'missing.json')
    }))).rejects.toThrow('Unable to load SOPS');
    const env = environment({ type: 'sops', file });
    env.variables[0].name = 'missing';
    await expect(prepareEnvironmentForExport(env)).rejects.toThrow('Unable to load SOPS');
  });

  it('also strips local secret values at the backend export boundary', async () => {
    const exported = await prepareEnvironmentForExport(environment(undefined));
    expect(exported.variables[0].value).toBe('');
    expect(exported.secretsProvider).toBeUndefined();
  });

  it('serializes a CLI-compatible YAML descriptor with only secret declarations', async () => {
    const exported = await prepareEnvironmentForExport(environment({ type: 'sops', file }));
    const descriptor = relativeEnvironmentReference(exported, directory);
    const content = await stringifyEnvironment(descriptor, { format: 'yml' });
    expect(content).not.toContain('decrypted-secret');
    const parsed = await parseEnvironment(content, { format: 'yml' });
    expect(parsed.secretsProvider).toEqual({ type: 'sops', file: 'secrets.json' });
    expect(parsed.variables[0]).toMatchObject({ name: 'token', secret: true });
  });

  it('preserves original JSON references when no workspace source context is supplied', async () => {
    const provider = { type: 'sops', file: 'secrets.json' };
    const exported = await prepareEnvironmentForExport(environment(provider), undefined, { preserveReferences: true });
    expect(exported.secretsProvider).toEqual(provider);
    expect(exported.variables[0].value).toBe('');
    expect(sops.hydrateEnvironment).not.toHaveBeenCalled();
    const absolute = await prepareEnvironmentForExport(environment({ type: 'sops', file }), undefined, { preserveReferences: true });
    expect(absolute.secretsProvider.file).toBe(file);
    expect(sops.hydrateEnvironment).toHaveBeenCalled();
  });
});
