const path = require('path');
const {
  isSopsEnvironment,
  resolveSecretsFile,
  normalizeSecretsProvider,
  hydrateEnvironment,
  withoutSecretValues
} = require('./sops');

const prepareEnvironmentForExport = async (environment, workspacePath, { preserveReferences = false } = {}) => {
  let secretsProvider;
  if (environment.secretsProvider && !isSopsEnvironment(environment)) {
    throw new Error('Unsupported secrets provider');
  }
  if (isSopsEnvironment(environment)) {
    const { file } = environment.secretsProvider;
    if (typeof file !== 'string' || !file.trim()) throw new Error('SOPS file is required');
    if (!preserveReferences || workspacePath || path.isAbsolute(file)) {
      await hydrateEnvironment(environment, workspacePath);
    }
    secretsProvider = preserveReferences
      ? { ...environment.secretsProvider }
      : { type: 'sops', file: resolveSecretsFile(file, workspacePath) };
  }
  return {
    name: environment.name,
    variables: withoutSecretValues(environment).variables,
    color: environment.color ?? undefined,
    extends: environment.extends ?? undefined,
    ...(secretsProvider ? { secretsProvider } : {})
  };
};

const relativeEnvironmentReference = (environment, descriptorRoot) => ({
  ...environment,
  ...(environment.secretsProvider
    ? { secretsProvider: normalizeSecretsProvider(environment.secretsProvider, descriptorRoot) }
    : {})
});

module.exports = { prepareEnvironmentForExport, relativeEnvironmentReference };
