import { act, renderHook } from '@testing-library/react';
import { useDispatch, useSelector } from 'react-redux';
import { addGlobalEnvironment } from 'providers/ReduxStore/slices/global-environments';
import { useEnvironmentTarget } from './index';

jest.mock('react-redux', () => ({ useDispatch: jest.fn(), useSelector: jest.fn() }));
jest.mock('providers/ReduxStore/slices/collections/actions', () => ({
  importEnvironment: jest.fn(), saveEnvironment: jest.fn(), saveEnvironmentExtends: jest.fn(), updateEnvironmentColor: jest.fn()
}));
jest.mock('providers/ReduxStore/slices/global-environments', () => ({
  addGlobalEnvironment: jest.fn((payload) => ({ type: 'add', payload })),
  saveGlobalEnvironment: jest.fn(), saveGlobalEnvironmentExtends: jest.fn(), updateGlobalEnvironmentColor: jest.fn()
}));
jest.mock('utils/environments', () => ({ normalizeEnvName: (name) => name.toLowerCase() }));

describe('SOPS environment import targets', () => {
  const provider = { type: 'sops', file: '/repo/secrets.json' };
  let dispatch;

  beforeEach(() => {
    dispatch = jest.fn().mockResolvedValue(undefined);
    useDispatch.mockReturnValue(dispatch);
    useSelector.mockImplementation((selector) => selector({ globalEnvironments: { globalEnvironments: [] } }));
  });

  it('passes the provider reference when creating a global environment', async () => {
    const { result } = renderHook(() => useEnvironmentTarget('global'));
    await act(async () => result.current.createEnv('shared', { variables: [], secretsProvider: provider }));
    expect(addGlobalEnvironment).toHaveBeenCalledWith(expect.objectContaining({ secretsProvider: provider }));
    expect(dispatch).toHaveBeenCalled();
  });

  it('rejects overwriting a SOPS environment with blank imported secrets', async () => {
    const { result } = renderHook(() => useEnvironmentTarget('global'));
    await expect(result.current.saveEnv({ variables: [] }, { uid: 'env', secretsProvider: provider })).rejects.toThrow(/new name/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects silently dropping the provider on a collection import', async () => {
    const { result } = renderHook(() => useEnvironmentTarget('collection', { uid: 'collection' }));
    await expect(result.current.createEnv('shared', { variables: [], secretsProvider: provider })).rejects.toThrow(/workspace or global/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
