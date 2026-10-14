import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useDispatch, useSelector } from 'react-redux';
import { exportBrunoEnvironment } from 'utils/exporters/bruno-environment';
import ExportEnvironmentModal from './index';

jest.mock('react-redux', () => ({ useDispatch: jest.fn(), useSelector: jest.fn() }));
jest.mock('utils/exporters/bruno-environment', () => ({ exportBrunoEnvironment: jest.fn().mockResolvedValue(undefined) }));
jest.mock('providers/ReduxStore/slices/collections/actions', () => ({ browseDirectory: jest.fn() }));
jest.mock('@usebruno/common/utils', () => ({ getInheritedEnvironments: () => ({ inheritedEnvironments: [] }) }));
jest.mock('components/Portal', () => ({ children }) => <>{children}</>);
jest.mock('components/Modal', () => ({ children }) => <>{children}</>);
jest.mock('./StyledWrapper', () => ({ children }) => <div>{children}</div>);
jest.mock('ui/Button', () => ({ children, onClick, disabled, type }) => <button type={type} onClick={onClick} disabled={disabled}>{children}</button>);
jest.mock('react-hot-toast', () => ({ success: jest.fn(), error: jest.fn() }));

describe('CLI environment descriptor export', () => {
  beforeEach(() => {
    useDispatch.mockReturnValue(jest.fn());
    useSelector.mockImplementation((selector) => selector({
      workspaces: { activeWorkspaceUid: 'workspace', workspaces: [{ uid: 'workspace', pathname: '/repo' }] }
    }));
  });

  it('offers YAML descriptors and passes the source workspace for relative SOPS references', async () => {
    const environment = {
      uid: 'env', name: 'shared', variables: [], secretsProvider: { type: 'sops', file: 'secrets.json' }
    };
    const onClose = jest.fn();
    render(<ExportEnvironmentModal environments={[environment]} environmentType="global" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('radio', { name: /CLI YAML descriptors/ }));
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '/repo/export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export 1 Environment' }));
    await waitFor(() => expect(exportBrunoEnvironment).toHaveBeenCalledWith({
      environments: [environment],
      environmentType: 'global',
      filePath: '/repo/export',
      exportFormat: 'yaml-descriptor',
      workspacePath: '/repo'
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not offer the global-only descriptor option for a collection export', () => {
    render(<ExportEnvironmentModal environments={[{ uid: 'env', name: 'dev', variables: [] }]} environmentType="collection" onClose={jest.fn()} />);
    expect(screen.queryByRole('radio', { name: /CLI YAML descriptors/ })).not.toBeInTheDocument();
  });
});
