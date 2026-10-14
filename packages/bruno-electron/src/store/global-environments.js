const _ = require('lodash');
const Store = require('electron-store');
const { parseValueByDataType, valueToString } = require('@usebruno/common/utils');
const { encryptStringSafe, decryptStringSafe } = require('../utils/encryption');
const { environmentSchema } = require('@usebruno/schema');
const { posixifyPath, withFileLock } = require('../utils/filesystem');
const { isSopsEnvironment, hydrateEnvironment, saveEnvironmentSecrets, withoutSecretValues, normalizeSecretsProvider } = require('../utils/sops');

class GlobalEnvironmentsStore {
  constructor() {
    this.store = new Store({
      name: 'global-environments',
      clearInvalidConfig: true
    });
  }

  /**
   * Validates and filters environments array, removing invalid entries
   * @param {Array} environments - Array of environment objects to validate
   * @returns {Array} - Array of valid environments
   */
  filterValidEnvironments(environments) {
    if (!Array.isArray(environments)) {
      return [];
    }

    return environments.filter((env) => {
      try {
        environmentSchema.validateSync(env);
        return true;
      } catch (error) {
        console.error('Invalid global environment');
        return false;
      }
    });
  }

  encryptGlobalEnvironmentVariables({ globalEnvironments }) {
    return globalEnvironments?.map((env) => {
      if (isSopsEnvironment(env)) return withoutSecretValues(env);
      const variables = env.variables?.map((v) => ({
        ...v,
        value: v?.secret ? encryptStringSafe(valueToString(v.value)).value : v?.value
      })) || [];

      return {
        ...env,
        variables
      };
    });
  }

  decryptGlobalEnvironmentVariables({ globalEnvironments }) {
    return globalEnvironments?.map((env) => {
      if (isSopsEnvironment(env)) return withoutSecretValues(env);
      const variables = env.variables?.map((v) => ({
        ...v,
        value: v?.secret ? parseValueByDataType(decryptStringSafe(v.value).value, v.dataType) : v?.value
      })) || [];

      return {
        ...env,
        variables
      };
    });
  }

  getStoredGlobalEnvironments() {
    let globalEnvironments = this.store.get('environments', []);

    // Previously, a bug caused environment variables to be saved without a type.
    // Since that issue is now fixed, this code ensures that anyone who imported
    // data before the fix will have the missing types added retroactively.
    globalEnvironments?.forEach((env) => {
      env?.variables?.forEach((v) => {
        if (!v.type) {
          v.type = 'text';
        }
        if (v.dataType && v.dataType !== 'string' && !v.secret) {
          v.value = parseValueByDataType(v.value, v.dataType);
        }
      });
    });

    globalEnvironments = this.filterValidEnvironments(globalEnvironments);

    globalEnvironments = this.decryptGlobalEnvironmentVariables({ globalEnvironments });

    return globalEnvironments;
  }

  async getGlobalEnvironments() {
    return Promise.all(this.getStoredGlobalEnvironments().map((env) => hydrateEnvironment(env)));
  }

  getActiveGlobalEnvironmentUid() {
    return this.store.get('activeGlobalEnvironmentUid', null);
  }

  setActiveGlobalEnvironmentUid(uid) {
    return this.store.set('activeGlobalEnvironmentUid', uid);
  }

  getActiveGlobalEnvironmentUidForWorkspace(workspacePath) {
    if (!workspacePath) return undefined;
    const key = posixifyPath(workspacePath);
    const mapping = this.store.get('activeGlobalEnvironmentUidByWorkspace', {});
    if (key in mapping) {
      return mapping[key];
    }
    return undefined;
  }

  setActiveGlobalEnvironmentUidForWorkspace(workspacePath, uid) {
    if (!workspacePath) return;
    const key = posixifyPath(workspacePath);
    const mapping = this.store.get('activeGlobalEnvironmentUidByWorkspace', {});
    mapping[key] = uid || null;
    this.store.set('activeGlobalEnvironmentUidByWorkspace', mapping);
  }

  removeActiveGlobalEnvironmentUidForWorkspace(workspacePath) {
    if (!workspacePath) return;
    const key = posixifyPath(workspacePath);
    const mapping = this.store.get('activeGlobalEnvironmentUidByWorkspace', {});
    delete mapping[key];
    this.store.set('activeGlobalEnvironmentUidByWorkspace', mapping);
  }

  async setGlobalEnvironments(globalEnvironments, saveSecretsFor) {
    globalEnvironments = this.filterValidEnvironments(globalEnvironments);

    for (const environment of globalEnvironments) {
      if (saveSecretsFor === undefined || saveSecretsFor.includes(environment.uid)) {
        await saveEnvironmentSecrets(environment);
      }
    }
    globalEnvironments = this.encryptGlobalEnvironmentVariables({ globalEnvironments });
    return this.store.set('environments', globalEnvironments);
  }

  async addGlobalEnvironment({ uid, name, variables = [], color, extends: inheritedGlobalEnvironmentName, secretsProvider }) {
    let globalEnvironments = await this.getGlobalEnvironments();
    const existingEnvironment = globalEnvironments.find((env) => env?.name == name);
    if (existingEnvironment) {
      throw new Error('Environment with the same name already exists');
    }
    globalEnvironments.push({
      uid,
      name,
      variables,
      color,
      extends: inheritedGlobalEnvironmentName,
      ...(secretsProvider ? { secretsProvider: normalizeSecretsProvider(secretsProvider) } : {})
    });
    await this.setGlobalEnvironments(globalEnvironments, [uid]);
  }

  async saveGlobalEnvironment({ environmentUid: globalEnvironmentUid, variables, color, extends: inheritedGlobalEnvironmentName, secretsProvider, skipSecretsWrite = false }) {
    let globalEnvironments = await this.getGlobalEnvironments();
    const environment = globalEnvironments.find((env) => env?.uid == globalEnvironmentUid);
    globalEnvironments = globalEnvironments.filter((env) => env?.uid !== globalEnvironmentUid);
    if (environment) {
      if (variables !== undefined) environment.variables = variables;
      if (secretsProvider !== undefined) {
        if (secretsProvider) {
          environment.secretsProvider = normalizeSecretsProvider(secretsProvider);
        } else {
          if (isSopsEnvironment(environment)) throw new Error('SOPS provider cannot be disabled through environment save');
          delete environment.secretsProvider;
        }
      }
      if (color !== undefined) {
        environment.color = color;
      }
      if (inheritedGlobalEnvironmentName !== undefined) {
        environment.extends = inheritedGlobalEnvironmentName;
      }
    }
    if (!environment) throw new Error('Global environment not found');
    globalEnvironments.push(environment);
    await this.setGlobalEnvironments(globalEnvironments, skipSecretsWrite ? [] : [globalEnvironmentUid]);
  }

  async renameGlobalEnvironment({ environmentUid: globalEnvironmentUid, name }) {
    let globalEnvironments = await this.getGlobalEnvironments();
    const environment = globalEnvironments.find((env) => env?.uid == globalEnvironmentUid);
    globalEnvironments = globalEnvironments.filter((env) => env?.uid !== globalEnvironmentUid);
    if (environment) {
      const oldName = environment.name;
      environment.name = name;
      globalEnvironments.forEach((env) => {
        if (env?.extends === oldName) {
          env.extends = name;
        }
      });
    }
    globalEnvironments.push(environment);
    await this.setGlobalEnvironments(globalEnvironments, []);
  }

  async copyGlobalEnvironment({ uid, name, variables, secretsProvider, color, extends: inheritedGlobalEnvironmentName }) {
    let globalEnvironments = await this.getGlobalEnvironments();
    globalEnvironments.push({
      uid,
      name,
      variables,
      color,
      extends: inheritedGlobalEnvironmentName,
      ...(secretsProvider ? { secretsProvider: normalizeSecretsProvider(secretsProvider) } : {})
    });
    await this.setGlobalEnvironments(globalEnvironments, [uid]);
  }

  selectGlobalEnvironment({ environmentUid: globalEnvironmentUid }) {
    let globalEnvironments = this.getStoredGlobalEnvironments();
    const environment = globalEnvironments.find((env) => env?.uid == globalEnvironmentUid);
    if (environment) {
      this.setActiveGlobalEnvironmentUid(globalEnvironmentUid);
    } else {
      this.setActiveGlobalEnvironmentUid(null);
    }
  }

  async deleteGlobalEnvironment({ environmentUid }) {
    let globalEnvironments = await this.getGlobalEnvironments();
    let activeGlobalEnvironmentUid = this.getActiveGlobalEnvironmentUid();
    globalEnvironments = globalEnvironments.filter((env) => env?.uid !== environmentUid);
    if (environmentUid == activeGlobalEnvironmentUid) {
      this.setActiveGlobalEnvironmentUid(null);
    }
    await this.setGlobalEnvironments(globalEnvironments, []);
  }

  async saveGlobalEnvironmentExtends({ environmentUid, extends: inheritedGlobalEnvironmentName }) {
    let globalEnvironments = await this.getGlobalEnvironments();
    const environment = globalEnvironments.find((env) => env?.uid == environmentUid);
    if (environment) {
      if (inheritedGlobalEnvironmentName) {
        environment.extends = inheritedGlobalEnvironmentName;
      } else {
        delete environment.extends;
      }
    }
    await this.setGlobalEnvironments(globalEnvironments, []);
  }

  async updateGlobalEnvironmentColor({ environmentUid, color }) {
    let globalEnvironments = await this.getGlobalEnvironments();
    const environment = globalEnvironments.find((env) => env?.uid == environmentUid);
    if (environment) {
      environment.color = color;
    }
    await this.setGlobalEnvironments(globalEnvironments, []);
  }
}

for (const method of [
  'addGlobalEnvironment', 'saveGlobalEnvironment', 'renameGlobalEnvironment',
  'copyGlobalEnvironment', 'deleteGlobalEnvironment', 'saveGlobalEnvironmentExtends',
  'updateGlobalEnvironmentColor'
]) {
  const mutate = GlobalEnvironmentsStore.prototype[method];
  GlobalEnvironmentsStore.prototype[method] = function (...args) {
    return withFileLock('global-environments-store', () => mutate.apply(this, args));
  };
}

const globalEnvironmentsStore = new GlobalEnvironmentsStore();

module.exports = {
  globalEnvironmentsStore,
  GlobalEnvironmentsStore
};
