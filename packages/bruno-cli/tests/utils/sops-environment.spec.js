const fs = require('fs');
const path = require('path');

jest.mock('@usebruno/common/sops', () => ({
  hydrateEnvironment: jest.fn(),
  saveEnvironmentSecrets: jest.fn()
}));

const { hydrateEnvironment, saveEnvironmentSecrets } = require('@usebruno/common/sops');
const { parseEnvironment } = require('@usebruno/filestore');
const { loadGlobalEnvironmentFromFile, loadEnvironments, parseEnvironmentJson } = require('../../src/utils/environment');
const { persistVariableUpdates } = require('../../src/utils/persist-variables');

describe('CLI SOPS global environments', () => {
  let directory;
  const write = (name, content) => {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(__dirname, '.sops-test-'));
    jest.resetAllMocks();
    hydrateEnvironment.mockImplementation(async (environment) => {
      return {
        ...environment,
        variables: (environment.variables || []).map((variable) => variable.secret
          ? { ...variable, value: variable.name === 'count' ? 12 : { token: 'decrypted' } }
          : variable)
      };
    });
    saveEnvironmentSecrets.mockResolvedValue(undefined);
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('hydrates ancestors using the workspace root before inheritance and child shadowing', async () => {
    write('base.yml', 'name: base\nsecretsProvider:\n  type: sops\n  file: secrets/base.enc.yaml\nvariables:\n  - name: count\n    secret: true\n    type: number\n  - name: auth\n    secret: true\n    type: object\n');
    const filePath = write('production.yml', 'name: production\nextends: base\nvariables:\n  - name: count\n    value: child\n');
    const loaded = await loadGlobalEnvironmentFromFile({ filePath, basePath: directory });
    expect(loaded.variables).toMatchObject({ count: 12, auth: { token: 'decrypted' } });
    expect(hydrateEnvironment).toHaveBeenCalledWith(expect.objectContaining({ name: 'base' }), directory);
    expect(loaded.inheritedVariables.find((v) => v.name === 'count').value).toBe(12);
  });

  it('rejects decryption failure rather than using blank secret placeholders', async () => {
    const filePath = write('production.yml', 'name: production\nvariables: []\n');
    hydrateEnvironment.mockRejectedValue(new Error('decryption failed'));
    await expect(loadGlobalEnvironmentFromFile({ filePath, basePath: directory })).rejects.toThrow();
  });

  it('saves typed secret updates encrypted while retaining only declarations in YAML', async () => {
    const filePath = write('production.yml', 'name: production\nsecretsProvider:\n  type: sops\n  file: secrets/prod.enc.yaml\nvariables:\n  - name: auth\n    secret: true\n    type: object\n  - name: host\n    value: old\n');
    await persistVariableUpdates({ globalEnvironmentVariables: { auth: { token: 'rotated' }, host: 'new' } }, {
      globalEnvFile: { path: filePath, format: 'yml', basePath: directory }
    });
    expect(saveEnvironmentSecrets).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.arrayContaining([expect.objectContaining({ name: 'auth', secret: true, value: { token: 'rotated' }, dataType: 'object' })])
    }), directory, expect.objectContaining({
      variables: expect.arrayContaining([expect.objectContaining({ name: 'auth', value: { token: 'decrypted' }, secret: true })])
    }));
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).not.toContain('rotated');
    expect(parseEnvironment(content, { format: 'yml' }).secretsProvider.file).toBe('secrets/prod.enc.yaml');
  });

  it('does not send unchanged CLI secret overrides to encrypted storage', async () => {
    const filePath = write('production.yml', 'name: production\nsecretsProvider:\n  type: sops\n  file: secrets/prod.enc.yaml\nvariables:\n  - name: count\n    secret: true\n    type: number\n');
    await persistVariableUpdates({ globalEnvironmentVariables: { count: 'transient' } }, {
      globalEnvFile: { path: filePath, format: 'yml', basePath: directory },
      globalEnvVarOverrides: new Map([['count', 'transient']])
    });
    expect(saveEnvironmentSecrets.mock.calls[0][0].variables[0].value).toBe(12);
  });

  it('passes previous secret declarations so encrypted storage can remove only owned deleted keys', async () => {
    const filePath = write('production.yml', 'name: production\nsecretsProvider:\n  type: sops\n  file: secrets/prod.enc.yaml\nvariables:\n  - name: count\n    secret: true\n    type: number\n  - name: host\n    value: old\n');
    await persistVariableUpdates({ globalEnvironmentVariables: { host: 'new' } }, {
      globalEnvFile: { path: filePath, format: 'yml', basePath: directory }
    });
    const [next, basePath, previous] = saveEnvironmentSecrets.mock.calls[0];
    expect(basePath).toBe(directory);
    expect(next.variables.some((variable) => variable.name === 'count')).toBe(false);
    expect(previous.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'count', secret: true, value: 12 })
    ]));
  });

  it('fails closed and hides provider diagnostics on encryption failure', async () => {
    const original = 'name: production\nsecretsProvider:\n  type: sops\n  file: secrets/prod.enc.yaml\nvariables:\n  - name: count\n    secret: true\n    type: number\n';
    const filePath = write('production.yml', original);
    saveEnvironmentSecrets.mockRejectedValue(new Error('sensitive provider output'));
    await expect(persistVariableUpdates({ globalEnvironmentVariables: { count: 99 } }, {
      globalEnvFile: { path: filePath, format: 'yml', basePath: directory }
    })).rejects.toMatchObject({ code: 'SOPS_ENVIRONMENT_ERROR', message: 'Failed to persist SOPS environment secrets.' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('hydrates typed secrets from a single-environment JSON export and preserves metadata on save', async () => {
    const secretsProvider = { type: 'sops', file: 'secrets/prod.enc.json' };
    const filePath = write('global.json', JSON.stringify({
      name: 'exported', secretsProvider, color: '#abcdef',
      variables: [{ name: 'count', value: '', secret: true, enabled: true, type: 'text', dataType: 'number' }]
    }));
    const loaded = await loadGlobalEnvironmentFromFile({ filePath, basePath: directory });
    expect(loaded.variables.count).toBe(12);
    expect(loaded.ownVariables[0].dataType).toBe('number');
    await persistVariableUpdates({ globalEnvironmentVariables: { count: 99 } }, {
      globalEnvFile: { path: filePath, format: 'json', basePath: directory }
    });
    expect(saveEnvironmentSecrets.mock.calls[0][0].variables[0]).toMatchObject({ secret: true, value: 99, dataType: 'number' });
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(persisted).toMatchObject({ secretsProvider, color: '#abcdef' });
    expect(persisted.variables[0]).toMatchObject({ secret: true, value: '', dataType: 'number' });
  });

  it.each(['missing', 'cycle'])('rejects %s global inheritance without logging references', async (mode) => {
    const filePath = write('global.json', JSON.stringify({ name: 'global', extends: mode === 'cycle' ? 'global' : 'sensitive-parent', variables: [] }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(loadGlobalEnvironmentFromFile({ filePath, basePath: directory })).rejects.toThrow('Unable to resolve global environment inheritance.');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('skips encrypted YAML documents in environment discovery without logging ciphertext', async () => {
    fs.mkdirSync(path.join(directory, 'environments'));
    write('environments/prod.yml', 'name: production\nvariables: []\n');
    write('environments/prod.enc.yml', 'token: ENC[AES256_GCM,data:ciphertext]\nsops:\n  mac: ENC[mac]\n');
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const environments = await loadEnvironments(directory, 'yml');
      expect(environments.map((environment) => environment.name)).toEqual(['prod']);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect(() => parseEnvironmentJson({ sops: {}, variables: [] })).toThrow('Encrypted SOPS documents are not environment descriptors.');
  });
});
