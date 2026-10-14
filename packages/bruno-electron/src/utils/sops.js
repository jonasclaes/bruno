const fs = require('fs');
const path = require('path');
const sops = require('@usebruno/common/sops');

const isSopsEnvironment = (environment) => environment?.secretsProvider?.type === 'sops';

const repositoryPath = (file) => {
  let existing = file;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('SOPS file must be inside a Git repository');
    existing = parent;
  }
  const real = fs.realpathSync(existing);
  let directory = fs.statSync(real).isDirectory() ? real : path.dirname(real);
  while (!fs.existsSync(path.join(directory, '.git'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('SOPS file must be inside a Git repository');
    directory = parent;
  }
  return file;
};

const resolveSecretsFile = (file, workspacePath) => {
  if (typeof file !== 'string' || !file.trim()) throw new Error('SOPS file is required');
  if (!workspacePath && !path.isAbsolute(file)) {
    throw new Error('App-local SOPS environments require an absolute file path');
  }
  const resolved = sops.resolveSecretsPath({ type: 'sops', file }, workspacePath);
  return repositoryPath(resolved);
};

const normalizeSecretsProvider = (provider, workspacePath) => {
  if (provider == null) return provider;
  if (provider.type !== 'sops') throw new Error('Unsupported secrets provider');
  const file = resolveSecretsFile(provider.file, workspacePath);
  return {
    type: 'sops',
    file: workspacePath ? path.relative(path.resolve(workspacePath), file).split(path.sep).join('/') : file
  };
};

const hydrateEnvironment = async (environment, workspacePath) => {
  if (!isSopsEnvironment(environment)) return environment;
  try {
    const secretsProvider = normalizeSecretsProvider(environment.secretsProvider, workspacePath);
    const hydrated = await sops.hydrateEnvironment({ ...environment, secretsProvider }, workspacePath);
    return {
      ...environment,
      secretsProvider,
      variables: (environment.variables || []).map((variable) => {
        if (variable.secret !== true) return { ...variable };
        const secret = hydrated.variables.find((value) => value.name === variable.name && value.secret === true);
        if (!secret) throw new Error('SOPS secret is missing');
        return { ...variable, value: secret.value };
      })
    };
  } catch (error) {
    throw Object.assign(new Error('Unable to load SOPS environment secrets'), { code: 'SOPS_ERROR' });
  }
};

const saveEnvironmentSecrets = async (environment, workspacePath, previousEnvironment) => {
  if (!isSopsEnvironment(environment)) return environment;
  environment.secretsProvider = normalizeSecretsProvider(environment.secretsProvider, workspacePath);
  await sops.saveEnvironmentSecrets(environment, workspacePath, previousEnvironment);
  return environment;
};

const withoutSecretValues = (environment) => ({
  ...environment,
  variables: (environment.variables || []).map((variable) =>
    variable.secret ? { ...variable, value: '' } : { ...variable }
  )
});

module.exports = {
  isSopsEnvironment,
  resolveSecretsFile,
  normalizeSecretsProvider,
  hydrateEnvironment,
  saveEnvironmentSecrets,
  withoutSecretValues
};
