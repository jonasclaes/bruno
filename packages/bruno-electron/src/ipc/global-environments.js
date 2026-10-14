require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ipcMain, dialog } = require('electron');
const sops = require('@usebruno/common/sops');
const { resolveSecretsFile, normalizeSecretsProvider } = require('../utils/sops');
const { uuid } = require('../utils/common');
const { withFileLock } = require('../utils/filesystem');
const { utils: { jsonToDotenv } } = require('@usebruno/common');
const { globalEnvironmentsStore } = require('../store/global-environments');
const { generateUniqueName, sanitizeName, writeFile, isValidDotEnvFilename } = require('../utils/filesystem');
const { readWorkspaceConfig, writeWorkspaceConfig } = require('../utils/workspace-config');

/**
 * Migrates activeEnvironmentUid from workspace.yml to the electron store (per-workspace).
 * This handles users upgrading from versions that stored the active global env in workspace.yml.
 *
 * Fallback chain:
 * 1. Per-workspace electron store (already migrated) - use it
 * 2. workspace.yml activeEnvironmentUid - migrate to electron store, remove from file
 * 3. Legacy electron store activeGlobalEnvironmentUid - migrate to per-workspace store
 * 4. null (new workspace)
 */
const migrateActiveGlobalEnvironmentUid = async (workspacePath) => {
  // Already in per-workspace store (null means explicitly "No Environment", undefined means not set)
  const perWorkspaceUid = globalEnvironmentsStore.getActiveGlobalEnvironmentUidForWorkspace(workspacePath);
  if (perWorkspaceUid !== undefined) {
    return perWorkspaceUid;
  }

  // Try workspace.yml
  try {
    const config = readWorkspaceConfig(workspacePath);
    if (config.activeEnvironmentUid) {
      const uid = config.activeEnvironmentUid;
      // Migrate to electron store
      globalEnvironmentsStore.setActiveGlobalEnvironmentUidForWorkspace(workspacePath, uid);
      // Rewrite workspace.yml without activeEnvironmentUid (generateYamlContent drops unknown fields)
      await writeWorkspaceConfig(workspacePath, config);
      return uid;
    }
  } catch (error) {
    // workspace.yml may not exist or be unreadable, continue to next fallback
  }

  // Fallback to legacy single active uid
  const legacyUid = globalEnvironmentsStore.getActiveGlobalEnvironmentUid();
  if (legacyUid) {
    globalEnvironmentsStore.setActiveGlobalEnvironmentUidForWorkspace(workspacePath, legacyUid);
    return legacyUid;
  }

  return null;
};

const registerGlobalEnvironmentsIpc = (mainWindow, workspaceEnvironmentsManager) => {
  const inspectSecrets = async (file) => {
    if (!fs.existsSync(file)) return { file, recipients: [], labels: {}, secretNames: [] };
    const recipients = await sops.getRecipients(file);
    const labels = await sops.readRecipientLabels(file);
    const values = await sops.readSecrets(file);
    return { file, recipients, labels, secretNames: Object.keys(values) };
  };

  ipcMain.handle('renderer:sops-inspect', async (event, { file, workspacePath }) => {
    return inspectSecrets(resolveSecretsFile(file, workspacePath));
  });

  ipcMain.handle('renderer:sops-save', async (event, { file, workspacePath, recipients, labels, secrets }) => {
    const resolved = resolveSecretsFile(file, workspacePath);
    if (secrets !== undefined && (!secrets || typeof secrets !== 'object' || Array.isArray(secrets))) {
      throw new Error('SOPS secrets must be an object');
    }
    return withFileLock(resolved, async () => {
      const existing = fs.existsSync(resolved);
      if (secrets !== undefined) {
        await sops.writeSecrets(resolved, secrets, recipients);
      } else if (!existing) {
        throw new Error('SOPS secrets file does not exist');
      }
      if (existing && recipients !== undefined) await sops.updateRecipients(resolved, recipients);
      if (labels !== undefined) await sops.writeRecipientLabels(resolved, labels);
      return inspectSecrets(resolved);
    });
  });

  ipcMain.handle('renderer:sops-configure-environment', async (event, {
    environmentUid, workspacePath, file, recipients, labels
  }) => {
    const resolved = resolveSecretsFile(file, workspacePath);
    if (workspacePath && !workspaceEnvironmentsManager) throw new Error('Workspace environments manager is unavailable');
    return withFileLock(resolved, async () => {
      const environments = workspacePath
        ? (await workspaceEnvironmentsManager.getGlobalEnvironmentsByPath(workspacePath)).globalEnvironments
        : await globalEnvironmentsStore.getGlobalEnvironments();
      const environment = environments.find((env) => env.uid === environmentUid);
      if (!environment) throw new Error('Environment not found');
      const existing = fs.existsSync(resolved);
      const values = existing
        ? await sops.readSecrets(resolved)
        : Object.fromEntries((environment.variables || []).filter((variable) => variable.secret === true)
            .map((variable) => [variable.name, variable.value]));
      const variables = (environment.variables || []).map((variable) => {
        if (Object.hasOwn(values, variable.name) && variable.secret !== true) {
          throw new Error('A SOPS secret name conflicts with a non-secret environment variable');
        }
        if (variable.secret !== true) return { ...variable };
        if (!Object.hasOwn(values, variable.name)) {
          throw new Error('A declared environment secret is missing from the SOPS file');
        }
        return { ...variable, value: values[variable.name] };
      });
      for (const [name, value] of Object.entries(values)) {
        if (variables.some((variable) => variable.name === name)) continue;
        variables.push({
          uid: uuid(), name, value, type: 'text', enabled: true, secret: true,
          dataType: value !== null && typeof value === 'object' ? 'object' : typeof value === 'number'
            ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string'
        });
      }
      const secretsProvider = normalizeSecretsProvider({ type: 'sops', file: resolved }, workspacePath);
      if (!existing) await sops.writeSecrets(resolved, values, recipients);
      if (existing && recipients !== undefined) await sops.updateRecipients(resolved, recipients);
      if (labels !== undefined) await sops.writeRecipientLabels(resolved, labels);
      const params = { environmentUid, variables, secretsProvider, skipSecretsWrite: true };
      if (workspacePath) {
        await workspaceEnvironmentsManager.saveGlobalEnvironmentByPath(workspacePath, params);
      } else {
        await globalEnvironmentsStore.saveGlobalEnvironment(params);
      }
      return { secretsProvider, variables };
    });
  });

  ipcMain.handle('renderer:sops-select-file', async (event, { create } = {}) => {
    const options = {
      title: create ? 'Create encrypted secrets file' : 'Select encrypted secrets file',
      filters: [{ name: 'SOPS secrets', extensions: ['yaml', 'yml', 'json'] }]
    };
    const result = create
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showOpenDialog(mainWindow, { ...options, properties: ['openFile'] });
    if (result.canceled) return null;
    const file = create ? result.filePath : result.filePaths?.[0];
    return file ? resolveSecretsFile(file) : null;
  });

  ipcMain.handle('renderer:create-global-environment', async (event, { uid, name, variables, color, extends: inheritedGlobalEnvironmentName, secretsProvider, workspaceUid, workspacePath }) => {
    try {
      // If workspace path provided, use workspace environments manager
      if (workspacePath && workspaceEnvironmentsManager) {
        const { globalEnvironments } = await workspaceEnvironmentsManager.getGlobalEnvironmentsByPath(workspacePath);
        const existingNames = globalEnvironments?.map((env) => env.name) || [];

        const sanitizedName = sanitizeName(name);
        const uniqueName = generateUniqueName(sanitizedName, (name) => existingNames.includes(name));

        return await workspaceEnvironmentsManager.addGlobalEnvironmentByPath(workspacePath, { uid, name: uniqueName, variables, color, extends: inheritedGlobalEnvironmentName, secretsProvider });
      }

      const existingGlobalEnvironments = await globalEnvironmentsStore.getGlobalEnvironments();
      const existingNames = existingGlobalEnvironments?.map((env) => env.name) || [];

      const sanitizedName = sanitizeName(name);
      const uniqueName = generateUniqueName(sanitizedName, (name) => existingNames.includes(name));

      const created = await globalEnvironmentsStore.addGlobalEnvironment({ uid, name: uniqueName, variables, color, extends: inheritedGlobalEnvironmentName, secretsProvider });

      return { name: uniqueName, color, variables: created.variables, ...(created.secretsProvider ? { secretsProvider: created.secretsProvider } : {}) };
    } catch (error) {
      console.error('Error in renderer:create-global-environment:', error);
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:save-global-environment', async (event, { environmentUid, variables, color, extends: inheritedGlobalEnvironmentName, secretsProvider, workspaceUid, workspacePath }) => {
    try {
      if (workspacePath && workspaceEnvironmentsManager) {
        return await workspaceEnvironmentsManager.saveGlobalEnvironmentByPath(workspacePath, { environmentUid, variables, color, extends: inheritedGlobalEnvironmentName, secretsProvider });
      }

      await globalEnvironmentsStore.saveGlobalEnvironment({ environmentUid, variables, color, extends: inheritedGlobalEnvironmentName, secretsProvider });
    } catch (error) {
      console.error('Error in renderer:save-global-environment:', error);
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:save-global-environment-extends', async (event, { environmentUid, extends: inheritedGlobalEnvironmentName, workspaceUid, workspacePath }) => {
    try {
      if (workspacePath && workspaceEnvironmentsManager) {
        return await workspaceEnvironmentsManager.saveGlobalEnvironmentExtendsByPath(workspacePath, { environmentUid, extends: inheritedGlobalEnvironmentName });
      }

      await globalEnvironmentsStore.saveGlobalEnvironmentExtends({ environmentUid, extends: inheritedGlobalEnvironmentName });
    } catch (error) {
      console.error('Error in renderer:save-global-environment-extends:', error);
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:rename-global-environment', async (event, { environmentUid, name, workspaceUid, workspacePath }) => {
    try {
      if (workspacePath && workspaceEnvironmentsManager) {
        return await workspaceEnvironmentsManager.renameGlobalEnvironmentByPath(workspacePath, { environmentUid, name });
      }

      await globalEnvironmentsStore.renameGlobalEnvironment({ environmentUid, name });
    } catch (error) {
      console.error('Error in renderer:rename-global-environment:', error);
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:delete-global-environment', async (event, { environmentUid, workspaceUid, workspacePath }) => {
    try {
      if (workspacePath && workspaceEnvironmentsManager) {
        await workspaceEnvironmentsManager.deleteGlobalEnvironmentByPath(workspacePath, { environmentUid });
        // Clear active environment for this workspace if the deleted one was active
        const activeUid = globalEnvironmentsStore.getActiveGlobalEnvironmentUidForWorkspace(workspacePath);
        if (activeUid === environmentUid) {
          globalEnvironmentsStore.setActiveGlobalEnvironmentUidForWorkspace(workspacePath, null);
        }
      } else {
        await globalEnvironmentsStore.deleteGlobalEnvironment({ environmentUid });
      }
    } catch (error) {
      console.error('Error in renderer:delete-global-environment:', error);
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:select-global-environment', async (event, { environmentUid, workspacePath }) => {
    try {
      if (workspacePath) {
        globalEnvironmentsStore.setActiveGlobalEnvironmentUidForWorkspace(workspacePath, environmentUid || null);
      } else {
        globalEnvironmentsStore.setActiveGlobalEnvironmentUid(environmentUid || null);
      }
    } catch (error) {
      console.error('Error in renderer:select-global-environment:', error);
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:get-global-environments', async (event, { workspaceUid, workspacePath }) => {
    try {
      let globalEnvironments = [];

      if (workspacePath && workspaceEnvironmentsManager) {
        const result = await workspaceEnvironmentsManager.getGlobalEnvironmentsByPath(workspacePath);
        globalEnvironments = result?.globalEnvironments || [];
      } else {
        globalEnvironments = (await globalEnvironmentsStore.getGlobalEnvironments()) || [];
      }

      const activeGlobalEnvironmentUid = workspacePath
        ? await migrateActiveGlobalEnvironmentUid(workspacePath)
        : globalEnvironmentsStore.getActiveGlobalEnvironmentUid();

      return {
        globalEnvironments,
        activeGlobalEnvironmentUid
      };
    } catch (error) {
      console.error('Error in renderer:get-global-environments:', error);
      return Promise.reject(error);
    }
  });

  // Save workspace .env file variables
  ipcMain.handle('renderer:save-workspace-dotenv-variables', async (event, { workspacePath, variables, filename = '.env' }) => {
    try {
      if (!workspacePath) {
        throw new Error('Workspace path is required');
      }

      if (!isValidDotEnvFilename(filename)) {
        throw new Error('Invalid .env filename');
      }

      const dotEnvPath = path.join(workspacePath, filename);
      const content = jsonToDotenv(variables);
      await writeFile(dotEnvPath, content);

      return { success: true };
    } catch (error) {
      console.error('Error saving workspace .env file:', error);
      return Promise.reject(error);
    }
  });

  // Save workspace .env file raw content
  ipcMain.handle('renderer:save-workspace-dotenv-raw', async (event, { workspacePath, content, filename = '.env' }) => {
    try {
      if (!workspacePath) {
        throw new Error('Workspace path is required');
      }

      if (!isValidDotEnvFilename(filename)) {
        throw new Error('Invalid .env filename');
      }

      const dotEnvPath = path.join(workspacePath, filename);
      await writeFile(dotEnvPath, content);

      return { success: true };
    } catch (error) {
      console.error('Error saving workspace .env file:', error);
      return Promise.reject(error);
    }
  });

  // Create workspace .env file
  ipcMain.handle('renderer:create-workspace-dotenv-file', async (event, { workspacePath, filename = '.env' }) => {
    try {
      if (!workspacePath) {
        throw new Error('Workspace path is required');
      }

      if (!isValidDotEnvFilename(filename)) {
        throw new Error('Invalid .env filename');
      }

      const dotEnvPath = path.join(workspacePath, filename);

      if (fs.existsSync(dotEnvPath)) {
        throw new Error(`${filename} file already exists`);
      }

      await writeFile(dotEnvPath, '');

      return { success: true };
    } catch (error) {
      console.error('Error creating workspace .env file:', error);
      return Promise.reject(error);
    }
  });

  // Delete workspace .env file
  ipcMain.handle('renderer:delete-workspace-dotenv-file', async (event, { workspacePath, filename = '.env' }) => {
    try {
      if (!workspacePath) {
        throw new Error('Workspace path is required');
      }

      if (!isValidDotEnvFilename(filename)) {
        throw new Error('Invalid .env filename');
      }

      const dotEnvPath = path.join(workspacePath, filename);

      if (!fs.existsSync(dotEnvPath)) {
        throw new Error(`${filename} file does not exist`);
      }

      fs.unlinkSync(dotEnvPath);

      return { success: true };
    } catch (error) {
      console.error('Error deleting workspace .env file:', error);
      return Promise.reject(error);
    }
  });

  ipcMain.handle('renderer:update-global-environment-color', async (event, { environmentUid, color, workspacePath }) => {
    try {
      if (workspacePath && workspaceEnvironmentsManager) {
        return await workspaceEnvironmentsManager.updateGlobalEnvironmentColorByPath(workspacePath, { environmentUid, color });
      }

      await globalEnvironmentsStore.updateGlobalEnvironmentColor({ environmentUid, color });
    } catch (error) {
      console.error('Error in renderer:update-global-environment-color:', error);
      return Promise.reject(error);
    }
  });
};

module.exports = registerGlobalEnvironmentsIpc;
