const path = require('path');

jest.mock('electron', () => ({ dialog: {} }));

const mockData = {};
jest.mock('electron-store', () => jest.fn().mockImplementation(() => ({
  get: (key, fallback) => mockData[key] === undefined ? fallback : structuredClone(mockData[key]),
  set: (key, value) => { mockData[key] = structuredClone(value); }
})));
jest.mock('../../utils/encryption', () => ({
  encryptStringSafe: jest.fn((value) => ({ value: `local:${value}` })),
  decryptStringSafe: jest.fn((value) => ({ value: value.replace(/^local:/, '') }))
}));
jest.mock('@usebruno/common/sops', () => ({
  resolveSecretsPath: (provider, base) => require('path').resolve(base || '.', provider.file),
  hydrateEnvironment: jest.fn(async (env) => ({
    ...env,
    variables: env.variables.map((variable) => variable.secret ? { ...variable, value: 42 } : variable)
  })),
  saveEnvironmentSecrets: jest.fn(async () => {})
}), { virtual: true });

const sops = require('@usebruno/common/sops');
const { GlobalEnvironmentsStore } = require('../global-environments');
const { encryptStringSafe, decryptStringSafe } = require('../../utils/encryption');

describe('app-local SOPS environments', () => {
  const dev = 'd'.repeat(21);
  const copy = 'c'.repeat(21);
  const local = 'l'.repeat(21);
  const file = path.resolve(__dirname, 'secrets.yaml');
  const provider = { type: 'sops', file };
  let store;
  beforeEach(() => {
    Object.keys(mockData).forEach((key) => delete mockData[key]);
    jest.clearAllMocks();
    store = new GlobalEnvironmentsStore();
  });

  it('hydrates typed secrets without the local encryption fallback or persisting values', async () => {
    await store.addGlobalEnvironment({
      uid: dev, name: 'Dev', secretsProvider: provider,
      variables: [{ uid: 'v'.repeat(21), name: 'token', value: 42, secret: true, enabled: true, type: 'text', dataType: 'number' }]
    });
    expect(mockData.environments[0].variables[0].value).toBe('');
    expect(mockData.environments[0].secretsProvider).toEqual(provider);
    const [env] = await store.getGlobalEnvironments();
    expect(env.variables[0]).toMatchObject({ value: 42, secret: true, dataType: 'number' });
    expect(sops.saveEnvironmentSecrets).toHaveBeenCalled();
    expect(encryptStringSafe).not.toHaveBeenCalled();
    expect(decryptStringSafe).not.toHaveBeenCalled();
  });

  it('preserves the provider during scripted saves, rename, copy, color and inheritance updates', async () => {
    await store.addGlobalEnvironment({ uid: dev, name: 'Dev', variables: [], secretsProvider: provider });
    await store.saveGlobalEnvironment({ environmentUid: dev, variables: [] });
    await store.renameGlobalEnvironment({ environmentUid: dev, name: 'Renamed' });
    await store.updateGlobalEnvironmentColor({ environmentUid: dev, color: '#fff' });
    await store.saveGlobalEnvironmentExtends({ environmentUid: dev, extends: 'Base' });
    const [env] = await store.getGlobalEnvironments();
    await store.copyGlobalEnvironment({ ...env, uid: copy, name: 'Copy' });
    expect(mockData.environments).toHaveLength(2);
    for (const saved of mockData.environments) expect(saved.secretsProvider).toEqual(provider);
  });

  it('serializes overlapping scripted saves without dropping changes', async () => {
    await store.addGlobalEnvironment({ uid: dev, name: 'Dev', variables: [], secretsProvider: provider });
    await Promise.all([
      store.saveGlobalEnvironment({ environmentUid: dev, color: '#123' }),
      store.saveGlobalEnvironment({ environmentUid: dev, extends: 'Base' })
    ]);
    expect(mockData.environments[0]).toMatchObject({ color: '#123', extends: 'Base', secretsProvider: provider });
  });

  it('rejects relative app-local refs and surfaces decrypt errors instead of local fallback', async () => {
    await expect(store.addGlobalEnvironment({
      uid: dev, name: 'Dev', variables: [], secretsProvider: { type: 'sops', file: 'secrets.yaml' }
    })).rejects.toThrow('absolute');
    await store.addGlobalEnvironment({ uid: dev, name: 'Dev', variables: [], secretsProvider: provider });
    sops.hydrateEnvironment.mockRejectedValueOnce(new Error('Cannot decrypt SOPS secrets'));
    await expect(store.getGlobalEnvironments()).rejects.toThrow('Unable to load SOPS');
    expect(decryptStringSafe).not.toHaveBeenCalled();
  });

  it('keeps the existing local secret encryption behavior', async () => {
    await store.addGlobalEnvironment({
      uid: local, name: 'Local',
      variables: [{ uid: 'v'.repeat(21), name: 'token', value: 'hello', secret: true, enabled: true, type: 'text' }]
    });
    expect(mockData.environments[0].variables[0].value).toBe('local:hello');
    expect((await store.getGlobalEnvironments())[0].variables[0].value).toBe('hello');
    expect(sops.saveEnvironmentSecrets).not.toHaveBeenCalled();
  });

  it('persists authoritative provider declarations without rewriting the encrypted file', async () => {
    await store.addGlobalEnvironment({ uid: dev, name: 'Dev', variables: [] });
    sops.saveEnvironmentSecrets.mockClear();
    await store.saveGlobalEnvironment({
      environmentUid: dev, variables: [], secretsProvider: provider, skipSecretsWrite: true
    });
    expect(mockData.environments[0].secretsProvider).toEqual(provider);
    expect(sops.saveEnvironmentSecrets).not.toHaveBeenCalled();
    await expect(store.saveGlobalEnvironment({
      environmentUid: dev, variables: [], secretsProvider: null
    })).rejects.toThrow('cannot be disabled');
    expect(mockData.environments[0].secretsProvider).toEqual(provider);
  });
});
