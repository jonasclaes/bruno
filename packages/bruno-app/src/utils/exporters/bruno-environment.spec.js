jest.mock('nanoid', () => ({
  nanoid: () => 'aaaaaaaaaaaaaaaaaaaa1',
  customAlphabet: () => () => 'aaaaaaaaaaaaaaaaaaaa1'
}));

import os from 'os';
import path from 'path';
import { exportBrunoEnvironment } from './bruno-environment';

const exportFilePath = path.join(os.tmpdir(), 'export');

const exportedEnvironments = async (environments) => {
  const invoke = jest.fn().mockResolvedValue(undefined);
  window.ipcRenderer = { invoke };

  await exportBrunoEnvironment({ environments, environmentType: 'collection', filePath: exportFilePath });

  return invoke.mock.calls[0][1].environments;
};

describe('exportBrunoEnvironment — inheritance', () => {
  it('passes workspace context when exporting portable CLI descriptors', async () => {
    const invoke = jest.fn().mockResolvedValue({ filePaths: ['/repo/export/shared.yml'] });
    window.ipcRenderer = { invoke };
    await exportBrunoEnvironment({
      environments: [{ name: 'shared', variables: [], secretsProvider: { type: 'sops', file: 'secrets.json' } }],
      environmentType: 'global',
      filePath: '/repo/export',
      exportFormat: 'yaml-descriptor',
      workspacePath: '/repo'
    });
    expect(invoke).toHaveBeenCalledWith('renderer:export-environment', expect.objectContaining({
      exportFormat: 'yaml-descriptor', workspacePath: '/repo'
    }));
  });

  it('preserves a SOPS file reference without exporting decrypted values', async () => {
    const [environment] = await exportedEnvironments([{
      name: 'shared',
      secretsProvider: { type: 'sops', file: '/repo/secrets.json' },
      variables: [{ name: 'TOKEN', value: 'decrypted-value', secret: true }]
    }]);
    expect(environment.secretsProvider).toEqual({ type: 'sops', file: '/repo/secrets.json' });
    expect(environment.variables[0].value).toBe('');
    expect(JSON.stringify(environment)).not.toContain('decrypted-value');
  });

  it('carries the extends reference of an inheriting environment', async () => {
    const [environment] = await exportedEnvironments([{ name: 'dev', variables: [], extends: 'Base' }]);

    expect(environment.extends).toBe('Base');
  });

  it('leaves out extends for an environment that inherits from nothing', async () => {
    const [environment] = await exportedEnvironments([{ name: 'dev', variables: [], extends: null }]);

    expect(environment.extends).toBeUndefined();
  });

  it('carries a list of extends references', async () => {
    const [environment] = await exportedEnvironments([{ name: 'dev', variables: [], extends: ['base', 'shared'] }]);

    expect(environment.extends).toEqual(['base', 'shared']);
  });
});
