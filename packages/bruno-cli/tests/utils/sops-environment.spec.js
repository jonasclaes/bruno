const fs = require('fs');
const path = require('path');

jest.mock('@usebruno/common/sops', () => ({
  hydrateEnvironment: jest.fn(),
  saveEnvironmentSecrets: jest.fn()
}));

const { hydrateEnvironment, saveEnvironmentSecrets } = require('@usebruno/common/sops');
const { parseEnvironment } = require('@usebruno/filestore');
const { loadGlobalEnvironmentFromFile } = require('../../src/utils/environment');
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
    }), directory);
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

  it('fails closed and hides provider diagnostics on encryption failure', async () => {
    const original = 'name: production\nsecretsProvider:\n  type: sops\n  file: secrets/prod.enc.yaml\nvariables:\n  - name: count\n    secret: true\n    type: number\n';
    const filePath = write('production.yml', original);
    saveEnvironmentSecrets.mockRejectedValue(new Error('sensitive provider output'));
    await expect(persistVariableUpdates({ globalEnvironmentVariables: { count: 99 } }, {
      globalEnvFile: { path: filePath, format: 'yml', basePath: directory }
    })).rejects.toMatchObject({ code: 'SOPS_ENVIRONMENT_ERROR', message: 'Failed to persist SOPS environment secrets.' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });
});
