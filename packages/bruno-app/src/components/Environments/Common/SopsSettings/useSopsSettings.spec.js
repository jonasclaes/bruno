import { act, renderHook } from '@testing-library/react';
import { useDispatch, useSelector } from 'react-redux';
import useSopsSettings from './useSopsSettings';

jest.mock('react-redux', () => ({ useDispatch: jest.fn(), useSelector: jest.fn() }));
jest.mock('providers/ReduxStore/slices/global-environments', () => ({
  updateGlobalEnvironments: (payload) => ({ type: 'refresh-environments', payload })
}));

describe('SOPS settings', () => {
  let state;
  let dispatch;

  beforeEach(() => {
    state = {
      workspaces: { activeWorkspaceUid: 'workspace', workspaces: [{ uid: 'workspace', pathname: '/repo' }] },
      globalEnvironments: { globalEnvironmentDraft: null }
    };
    dispatch = jest.fn();
    useDispatch.mockReturnValue(dispatch);
    useSelector.mockImplementation((selector) => selector(state));
    window.ipcRenderer = { invoke: jest.fn() };
  });

  it('loads authoritative recipients and optional names from the selected file', async () => {
    window.ipcRenderer.invoke.mockResolvedValue({
      file: '/repo/secrets.json',
      recipients: ['age1alice', 'ssh-ed25519 bob'],
      labels: { age1alice: 'Alice' }
    });
    const { result } = renderHook(() => useSopsSettings({
      uid: 'env',
      secretsProvider: { type: 'sops', file: 'secrets.json' }
    }));
    await act(async () => result.current.open());
    expect(result.current.settings.recipients).toEqual([
      { key: 'age1alice', label: 'Alice' },
      { key: 'ssh-ed25519 bob', label: '' }
    ]);
    expect(window.ipcRenderer.invoke).toHaveBeenCalledWith('renderer:sops-inspect', {
      file: 'secrets.json', workspaceUid: 'workspace', workspacePath: '/repo'
    });
  });

  it('requires saving or discarding drafts before attaching a provider', async () => {
    state.globalEnvironments.globalEnvironmentDraft = { environmentUid: 'env', variables: [] };
    const { result } = renderHook(() => useSopsSettings({ uid: 'env' }));
    await act(async () => result.current.open());
    expect(result.current.error).toMatch(/Save or discard/);
    expect(window.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('rejects removal of every recipient before writing', async () => {
    const { result } = renderHook(() => useSopsSettings({ uid: 'env' }));
    act(() => result.current.setSettings({ file: '/repo/secrets.json', recipients: [], loaded: true }));
    await act(async () => result.current.save());
    expect(result.current.error).toMatch(/At least one recipient/);
    expect(window.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('saves recipient changes without sending decrypted secret values', async () => {
    const refreshed = { globalEnvironments: [{ uid: 'env' }] };
    window.ipcRenderer.invoke.mockResolvedValueOnce({}).mockResolvedValueOnce(refreshed);
    const { result } = renderHook(() => useSopsSettings({ uid: 'env' }));
    act(() => result.current.setSettings({
      file: '/repo/secrets.json',
      recipients: [{ key: 'age1alice', label: 'Alice' }, { key: 'age1bob', label: '' }],
      loaded: true
    }));
    await act(async () => result.current.save());
    expect(window.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, 'renderer:sops-configure-environment', {
      environmentUid: 'env',
      workspaceUid: 'workspace',
      workspacePath: '/repo',
      file: '/repo/secrets.json',
      recipients: ['age1alice', 'age1bob'],
      labels: { age1alice: 'Alice' }
    });
    expect(dispatch).toHaveBeenCalledWith({ type: 'refresh-environments', payload: refreshed });
    expect(result.current.settings).toBeNull();
  });

  it('keeps the settings open when SOPS fails', async () => {
    window.ipcRenderer.invoke.mockRejectedValue(new Error('Cannot decrypt SOPS file'));
    const { result } = renderHook(() => useSopsSettings({ uid: 'env' }));
    act(() => result.current.setSettings({
      file: '/repo/secrets.json', recipients: [{ key: 'age1alice', label: '' }], loaded: true
    }));
    await act(async () => result.current.save());
    expect(result.current.error).toBe('Cannot decrypt SOPS file');
    expect(result.current.settings.file).toBe('/repo/secrets.json');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
