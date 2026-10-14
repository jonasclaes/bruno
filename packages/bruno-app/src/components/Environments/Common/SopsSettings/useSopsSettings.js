import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { updateGlobalEnvironments } from 'providers/ReduxStore/slices/global-environments';

export default function useSopsSettings(environment) {
  const dispatch = useDispatch();
  const workspace = useSelector((state) => state.workspaces.workspaces.find((item) => item.uid === state.workspaces.activeWorkspaceUid));
  const draft = useSelector((state) => state.globalEnvironments.globalEnvironmentDraft);
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const context = { workspaceUid: workspace?.uid, workspacePath: workspace?.pathname };

  const run = async (operation) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (err) {
      setError(err.message || 'SOPS operation failed');
    } finally {
      setBusy(false);
    }
  };

  const inspect = async (file) => {
    const result = await window.ipcRenderer.invoke('renderer:sops-inspect', { file, ...context });
    setSettings({
      file: result.file || file,
      recipients: result.recipients.map((key) => ({ key, label: result.labels?.[key] || '' })),
      loaded: true
    });
  };

  const open = () => run(async () => {
    if (draft?.environmentUid === environment.uid) {
      throw new Error('Save or discard environment changes before configuring SOPS.');
    }
    const file = environment.secretsProvider?.file || '';
    setSettings({ file, recipients: [], loaded: false });
    if (file) {
      await inspect(file);
    }
  });

  const selectFile = (create) => run(async () => {
    const file = await window.ipcRenderer.invoke('renderer:sops-select-file', { create });
    if (!file) return;
    if (create) {
      setSettings({ file, recipients: [], loaded: true });
    } else {
      await inspect(file);
    }
  });

  const save = () => run(async () => {
    if (!settings?.file || !settings.loaded) {
      throw new Error('Select an existing SOPS file or create a new one.');
    }
    const recipients = settings.recipients.map((recipient) => recipient.key.trim());
    if (!recipients.length || recipients.some((key) => !key)) {
      throw new Error('At least one recipient is required; recipient keys cannot be empty.');
    }
    if (new Set(recipients).size !== recipients.length) {
      throw new Error('Recipient keys must be unique.');
    }
    const labels = Object.fromEntries(settings.recipients
      .filter((recipient) => recipient.label.trim())
      .map((recipient) => [recipient.key.trim(), recipient.label.trim()]));
    await window.ipcRenderer.invoke('renderer:sops-configure-environment', {
      ...context,
      environmentUid: environment.uid,
      file: settings.file,
      recipients,
      labels
    });
    const environments = await window.ipcRenderer.invoke('renderer:get-global-environments', context);
    dispatch(updateGlobalEnvironments(environments));
    setSettings(null);
  });

  return { settings, setSettings, busy, error, open, selectFile, save, close: () => setSettings(null) };
}
