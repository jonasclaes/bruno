import React from 'react';
import Modal from 'components/Modal';
import Portal from 'components/Portal';
import useSopsSettings from './useSopsSettings';

const SopsSettings = ({ environment }) => {
  const { settings, setSettings, busy, error, open, selectFile, save, close } = useSopsSettings(environment);

  const updateRecipient = (index, field, value) => {
    setSettings({
      ...settings,
      recipients: settings.recipients.map((recipient, position) => position === index ? { ...recipient, [field]: value } : recipient)
    });
  };

  return (
    <div className="mb-3">
      <button type="button" className="btn btn-sm btn-secondary" data-testid="sops-settings" onClick={open} disabled={busy}>
        {environment.secretsProvider?.type === 'sops' ? 'Manage SOPS secrets' : 'Use SOPS for secrets'}
      </button>
      {environment.secretsProvider?.type === 'sops' && (
        <div className="mt-2 text-xs break-all">SOPS file: {environment.secretsProvider.file}</div>
      )}
      {!settings && error && <div role="alert">{error}</div>}
      {settings && (
        <Portal>
          <Modal
            size="lg"
            title="SOPS secret provider"
            confirmText={busy ? 'Working…' : 'Save SOPS settings'}
            handleConfirm={() => !busy && save()}
            handleCancel={() => !busy && close()}
            dataTestId="sops-settings-modal"
          >
            <div className="bruno-form flex flex-col gap-3">
              <p>Encrypted secrets live in your repository. Private keys are discovered by SOPS and never stored by Bruno.</p>
              <div className="flex gap-2">
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => selectFile(false)} disabled={busy} data-testid="sops-select-file">Select existing file</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => selectFile(true)} disabled={busy} data-testid="sops-create-file">Create encrypted file</button>
              </div>
              <div className="break-all" data-testid="sops-file">{settings.file || 'No file selected'}</div>
              <p>Recipients are read from the encrypted file. Owner names are optional display labels shared alongside it.</p>
              {settings.recipients.map((recipient, index) => (
                <div className="flex gap-2 items-center" key={index}>
                  <input
                    aria-label={`Recipient key ${index + 1}`}
                    className="textbox flex-1"
                    placeholder="age1… or ssh-ed25519 …"
                    value={recipient.key}
                    onChange={(event) => updateRecipient(index, 'key', event.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="sops-recipient-key"
                  />
                  <input
                    aria-label={`Recipient owner ${index + 1}`}
                    className="textbox"
                    placeholder="Owner (optional)"
                    value={recipient.label}
                    onChange={(event) => updateRecipient(index, 'label', event.target.value)}
                    disabled={busy}
                    data-testid="sops-recipient-owner"
                  />
                  <button
                    type="button"
                    aria-label={`Remove recipient ${index + 1}`}
                    onClick={() => setSettings({ ...settings, recipients: settings.recipients.filter((_, position) => position !== index) })}
                    disabled={busy}
                    data-testid="sops-remove-recipient"
                  >Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn-sm btn-secondary self-start"
                onClick={() => setSettings({ ...settings, recipients: [...settings.recipients, { key: '', label: '' }] })}
                disabled={busy || !settings.loaded}
                data-testid="sops-add-recipient"
              >Add recipient
              </button>
              <p>Save recipient changes to re-encrypt the file automatically. Add and remove secrets using the environment’s Secrets table.</p>
              <p>Removing a recipient does not revoke access to Git history or previously decrypted credentials; rotate those credentials separately.</p>
              {error && <div role="alert">{error}</div>}
            </div>
          </Modal>
        </Portal>
      )}
    </div>
  );
};

export default SopsSettings;
