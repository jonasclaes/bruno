const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({ dialog: {} }));

jest.mock('../env-secrets', () =>
  class EnvironmentSecretsStoreStub {
    getEnvSecrets() {
      return [];
    }

    storeEnvSecrets() {}
  }
);
jest.mock('@usebruno/common/sops', () => ({
  resolveSecretsPath: (provider, base) => require('path').resolve(base || '.', provider.file),
  hydrateEnvironment: jest.fn(async (env) => ({
    ...env,
    variables: env.variables.map((variable) => variable.secret ? { ...variable, value: 7 } : variable)
  })),
  saveEnvironmentSecrets: jest.fn(async () => {})
}), { virtual: true });

const { GlobalEnvironmentsManager } = require('../workspace-environments');

describe('workspace environments - saveGlobalEnvironment', () => {
  let workspacePath;
  let manager;

  const findEnvironment = async (name) => {
    const { globalEnvironments } = await manager.getGlobalEnvironments(workspacePath);
    return globalEnvironments.find((env) => env.name === name);
  };

  beforeEach(async () => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-workspace-envs-'));
    fs.mkdirSync(path.join(workspacePath, '.git'));
    manager = new GlobalEnvironmentsManager();

    await manager.createGlobalEnvironment(workspacePath, {
      name: 'Child',
      variables: [{ name: 'host', value: 'localhost', enabled: true }],
      color: '#ff0000',
      extends: 'Base'
    });
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('keeps the existing parent when the save omits extends', async () => {
    const { uid } = await findEnvironment('Child');

    await manager.saveGlobalEnvironment(workspacePath, {
      environmentUid: uid,
      variables: [{ name: 'host', value: '127.0.0.1', enabled: true }]
    });

    const saved = await findEnvironment('Child');
    expect(saved.extends).toBe('Base');
    expect(saved.variables[0].value).toBe('127.0.0.1');
  });

  it('replaces the parent when the save sets extends', async () => {
    const { uid } = await findEnvironment('Child');

    await manager.saveGlobalEnvironment(workspacePath, {
      environmentUid: uid,
      variables: [],
      extends: 'OtherBase'
    });

    const saved = await findEnvironment('Child');
    expect(saved.extends).toBe('OtherBase');
  });

  it('clears the parent when the save passes an empty extends', async () => {
    const { uid } = await findEnvironment('Child');

    await manager.saveGlobalEnvironment(workspacePath, {
      environmentUid: uid,
      variables: [],
      extends: null
    });

    const saved = await findEnvironment('Child');
    expect(saved.extends).toBeUndefined();
  });

  it('keeps the existing color when the save omits color', async () => {
    const { uid } = await findEnvironment('Child');

    await manager.saveGlobalEnvironment(workspacePath, {
      environmentUid: uid,
      variables: []
    });

    const saved = await findEnvironment('Child');
    expect(saved.color).toBe('#ff0000');
  });

  it('clears the color when the save passes an empty color', async () => {
    const { uid } = await findEnvironment('Child');

    await manager.saveGlobalEnvironment(workspacePath, {
      environmentUid: uid,
      variables: [],
      color: null
    });

    const saved = await findEnvironment('Child');
    expect(saved.color).toBeNull();
  });

  it('keeps external secrets when the save omits them', async () => {
    const environmentsDir = path.join(workspacePath, 'environments');
    fs.writeFileSync(
      path.join(environmentsDir, 'External.yml'),
      [
        'name: External',
        'externalSecrets:',
        '  type: vault',
        '  variables:',
        '    - name: token',
        '      path: secret/data/app',
        'variables:',
        '  - name: host',
        '    value: localhost'
      ].join('\n')
    );

    const { uid } = await findEnvironment('External');

    await manager.saveGlobalEnvironment(workspacePath, {
      environmentUid: uid,
      variables: [{ name: 'host', value: '127.0.0.1', enabled: true }]
    });

    const saved = await findEnvironment('External');
    expect(saved.externalSecrets).toEqual({
      type: 'vault',
      variables: [{ name: 'token', path: 'secret/data/app' }]
    });
    expect(saved.variables[0].value).toBe('127.0.0.1');
  });

  it('normalizes workspace SOPS refs and preserves them on script saves and renames', async () => {
    const { uid } = await manager.createGlobalEnvironment(workspacePath, {
      name: 'Sops',
      secretsProvider: { type: 'sops', file: path.join(workspacePath, 'secrets.yaml') },
      variables: [{ name: 'token', value: 7, secret: true, dataType: 'number', enabled: true }]
    });
    expect((await findEnvironment('Sops')).secretsProvider).toEqual({ type: 'sops', file: 'secrets.yaml' });
    await manager.saveGlobalEnvironment(workspacePath, { environmentUid: uid, variables: [
      { name: 'token', value: 8, secret: true, dataType: 'number', enabled: true }
    ] });
    await manager.renameGlobalEnvironment(workspacePath, { environmentUid: uid, name: 'RenamedSops' });
    const saved = await findEnvironment('RenamedSops');
    expect(saved.secretsProvider).toEqual({ type: 'sops', file: 'secrets.yaml' });
    expect(saved.variables[0]).toMatchObject({ value: 7, secret: true, dataType: 'number' });
    expect(fs.readFileSync(path.join(workspacePath, 'environments', 'RenamedSops.yml'), 'utf8')).not.toContain('value: 8');
    await manager.createGlobalEnvironment(workspacePath, { ...saved, name: 'CopiedSops' });
    expect((await findEnvironment('CopiedSops')).secretsProvider).toEqual(saved.secretsProvider);
  });

  it('fails loading SOPS environments without using the local secret fallback', async () => {
    await manager.createGlobalEnvironment(workspacePath, {
      name: 'Locked', variables: [], secretsProvider: { type: 'sops', file: 'secrets.yaml' }
    });
    const { hydrateEnvironment } = require('@usebruno/common/sops');
    hydrateEnvironment.mockRejectedValueOnce(new Error('private details must not be logged'));
    const environmentsDir = path.join(workspacePath, 'environments');
    const filesBefore = Object.fromEntries(fs.readdirSync(environmentsDir).map((file) => [
      file, fs.readFileSync(path.join(environmentsDir, file), 'utf8')
    ]));
    const logger = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(manager.getGlobalEnvironments(workspacePath)).rejects.toThrow('Unable to load SOPS');
      expect(JSON.stringify(logger.mock.calls)).not.toContain('private details');
      expect(Object.fromEntries(fs.readdirSync(environmentsDir).map((file) => [
        file, fs.readFileSync(path.join(environmentsDir, file), 'utf8')
      ]))).toEqual(filesBefore);
    } finally {
      logger.mockRestore();
    }
  });

  it('imports blank secret declarations from the authoritative file without modifying its values', async () => {
    const sops = require('@usebruno/common/sops');
    sops.saveEnvironmentSecrets.mockClear();
    const created = await manager.createGlobalEnvironment(workspacePath, {
      name: 'ImportedSops',
      secretsProvider: { type: 'sops', file: 'secrets.yaml' },
      variables: [{ name: 'token', value: '', secret: true, dataType: 'number', enabled: true }]
    });
    expect(created.variables[0].value).toBe(7);
    expect(sops.saveEnvironmentSecrets).not.toHaveBeenCalled();
  });

  it('saves an empty secret map when the last workspace secret is deleted', async () => {
    const { uid } = await manager.createGlobalEnvironment(workspacePath, {
      name: 'EmptySops',
      secretsProvider: { type: 'sops', file: 'secrets.yaml' },
      variables: [{ name: 'token', value: '', secret: true, enabled: true }]
    });
    const sops = require('@usebruno/common/sops');
    sops.saveEnvironmentSecrets.mockClear();
    await manager.saveGlobalEnvironment(workspacePath, { environmentUid: uid, variables: [] });
    expect(sops.saveEnvironmentSecrets).toHaveBeenCalledWith(expect.objectContaining({
      secretsProvider: { type: 'sops', file: 'secrets.yaml' }, variables: []
    }), workspacePath, expect.objectContaining({
      secretsProvider: { type: 'sops', file: 'secrets.yaml' },
      variables: [expect.objectContaining({ name: 'token', secret: true })]
    }));
    expect((await findEnvironment('EmptySops')).secretsProvider).toEqual({ type: 'sops', file: 'secrets.yaml' });
  });
});
