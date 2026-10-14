const fs = require('fs');
const path = require('path');

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
  dialog: { showOpenDialog: jest.fn(), showSaveDialog: jest.fn() }
}));
jest.mock('../../store/global-environments', () => ({
  globalEnvironmentsStore: { getGlobalEnvironments: jest.fn(), saveGlobalEnvironment: jest.fn(async () => {}) }
}));
jest.mock('@usebruno/common/sops', () => ({
  resolveSecretsPath: (provider, base) => require('path').resolve(base || '.', provider.file),
  readSecrets: jest.fn(async () => ({ token: 'secret-value' })),
  getRecipients: jest.fn(async () => ['age1recipient']),
  readRecipientLabels: jest.fn(async () => ({ age1recipient: 'Alice' })),
  writeSecrets: jest.fn(async () => {}),
  updateRecipients: jest.fn(async () => {}),
  writeRecipientLabels: jest.fn(async () => {})
}), { virtual: true });

const { ipcMain, dialog } = require('electron');
const sops = require('@usebruno/common/sops');
const register = require('../global-environments');
const { resolveSecretsFile, normalizeSecretsProvider } = require('../../utils/sops');
const { globalEnvironmentsStore } = require('../../store/global-environments');

describe('desktop SOPS IPC', () => {
  let directory;
  let file;
  let handlers;
  beforeEach(() => {
    jest.clearAllMocks();
    directory = fs.mkdtempSync(path.join(__dirname, '.sops-'));
    file = path.join(directory, 'secrets.yaml');
    register({});
    handlers = Object.fromEntries(ipcMain.handle.mock.calls);
    globalEnvironmentsStore.getGlobalEnvironments.mockResolvedValue([{ uid: 'env', name: 'Dev', variables: [] }]);
    sops.readSecrets.mockResolvedValue({ token: 'secret-value' });
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('inspects missing files without trying to decrypt', async () => {
    expect(await handlers['renderer:sops-inspect']({}, { file })).toEqual({
      file, recipients: [], labels: {}, secretNames: []
    });
    expect(sops.readSecrets).not.toHaveBeenCalled();
  });

  it('resolves workspace-relative files and returns recipient labels and decrypted entries', async () => {
    fs.writeFileSync(file, 'encrypted');
    expect(await handlers['renderer:sops-inspect']({}, { file: 'secrets.yaml', workspacePath: directory })).toEqual({
      file, recipients: ['age1recipient'], labels: { age1recipient: 'Alice' },
      secretNames: ['token']
    });
  });

  it('updates recipients and labels without requiring plaintext secrets', async () => {
    fs.writeFileSync(file, 'encrypted');
    const result = await handlers['renderer:sops-save']({}, {
      file, recipients: ['age1recipient'], labels: { age1recipient: 'Alice' }
    });
    expect(sops.writeSecrets).not.toHaveBeenCalled();
    expect(sops.updateRecipients).toHaveBeenCalledWith(file, ['age1recipient']);
    expect(result).toEqual({
      file, recipients: ['age1recipient'], labels: { age1recipient: 'Alice' }, secretNames: ['token']
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('attaches existing authoritative secrets, preserving typed declarations and importing new keys', async () => {
    fs.writeFileSync(file, 'encrypted');
    globalEnvironmentsStore.getGlobalEnvironments.mockResolvedValue([{
      uid: 'env', name: 'Dev',
      variables: [
        { uid: 'count', name: 'count', value: '', secret: true, dataType: 'number', enabled: true, type: 'text' },
        { uid: 'host', name: 'host', value: 'localhost', secret: false, enabled: true, type: 'text' }
      ]
    }]);
    sops.readSecrets.mockResolvedValue({ count: 42, token: 'authoritative' });
    const result = await handlers['renderer:sops-configure-environment']({}, { environmentUid: 'env', file });
    expect(result.secretsProvider).toEqual({ type: 'sops', file });
    expect(result.variables).toEqual([
      expect.objectContaining({ uid: 'count', name: 'count', value: 42, dataType: 'number' }),
      expect.objectContaining({ name: 'host', value: 'localhost', secret: false }),
      expect.objectContaining({ name: 'token', value: 'authoritative', secret: true, type: 'text', uid: expect.any(String) })
    ]);
    expect(sops.writeSecrets).not.toHaveBeenCalled();
    expect(globalEnvironmentsStore.saveGlobalEnvironment).toHaveBeenCalledWith({
      environmentUid: 'env', secretsProvider: result.secretsProvider, variables: result.variables, skipSecretsWrite: true
    });
  });

  it('creates a new file using the current environment secret values only', async () => {
    globalEnvironmentsStore.getGlobalEnvironments.mockResolvedValue([{
      uid: 'env', name: 'Dev',
      variables: [
        { name: 'token', value: 'initial', secret: true },
        { name: 'host', value: 'localhost', secret: false }
      ]
    }]);
    await handlers['renderer:sops-configure-environment']({}, {
      environmentUid: 'env', file, recipients: ['age1recipient']
    });
    expect(sops.writeSecrets).toHaveBeenCalledWith(file, { token: 'initial' }, ['age1recipient']);
  });

  it('rejects secret/non-secret name collisions without writing any file or environment', async () => {
    fs.writeFileSync(file, 'encrypted');
    globalEnvironmentsStore.getGlobalEnvironments.mockResolvedValue([{
      uid: 'env', name: 'Dev', variables: [{ name: 'token', value: 'public', secret: false }]
    }]);
    await expect(handlers['renderer:sops-configure-environment']({}, {
      environmentUid: 'env', file
    })).rejects.toThrow('conflicts');
    expect(sops.writeSecrets).not.toHaveBeenCalled();
    expect(globalEnvironmentsStore.saveGlobalEnvironment).not.toHaveBeenCalled();
  });

  it('persists workspace declarations with a workspace-relative provider', async () => {
    fs.writeFileSync(file, 'encrypted');
    const manager = {
      getGlobalEnvironmentsByPath: jest.fn(async () => ({
        globalEnvironments: [{ uid: 'env', name: 'Dev', variables: [] }]
      })),
      saveGlobalEnvironmentByPath: jest.fn(async () => {})
    };
    ipcMain.handle.mockClear();
    register({}, manager);
    const configure = Object.fromEntries(ipcMain.handle.mock.calls)['renderer:sops-configure-environment'];
    const result = await configure({}, { environmentUid: 'env', file, workspacePath: directory });
    expect(result.secretsProvider).toEqual({ type: 'sops', file: 'secrets.yaml' });
    expect(manager.saveGlobalEnvironmentByPath).toHaveBeenCalledWith(directory, {
      environmentUid: 'env', variables: result.variables, secretsProvider: result.secretsProvider, skipSecretsWrite: true
    });
    expect(sops.writeSecrets).not.toHaveBeenCalled();
  });

  it('saves secrets and labels without logging plaintext', async () => {
    fs.writeFileSync(file, 'encrypted');
    const logger = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handlers['renderer:sops-save']({}, {
        file, recipients: ['age1recipient'], labels: { age1recipient: 'Alice' }, secrets: { token: 'secret-value' }
      });
      expect(sops.writeSecrets).toHaveBeenCalledWith(file, { token: 'secret-value' }, ['age1recipient']);
      expect(sops.updateRecipients).toHaveBeenCalledWith(file, ['age1recipient']);
      expect(sops.writeRecipientLabels).toHaveBeenCalledWith(file, { age1recipient: 'Alice' });
      expect(logger).not.toHaveBeenCalled();
    } finally {
      logger.mockRestore();
    }
  });

  it('uses native open/save dialogs and returns null on cancellation', async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
    expect(await handlers['renderer:sops-select-file']({}, { create: false })).toBe(file);
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: file });
    expect(await handlers['renderer:sops-select-file']({}, { create: true })).toBe(file);
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true });
    expect(await handlers['renderer:sops-select-file']({}, { create: false })).toBeNull();
  });

  it('rejects nonrepository files and relative app-local references', () => {
    expect(() => resolveSecretsFile('secrets.yaml')).toThrow('absolute');
    expect(() => resolveSecretsFile(path.parse(file).root)).toThrow('Git repository');
    expect(normalizeSecretsProvider({ type: 'sops', file }, directory)).toEqual({
      type: 'sops', file: 'secrets.yaml'
    });
  });
});
