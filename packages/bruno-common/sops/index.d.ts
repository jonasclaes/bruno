export type SecretValue = string | number | boolean | null | SecretValue[] | { [key: string]: SecretValue };
export type SecretsProvider = { type: 'sops'; file: string };
export type EnvironmentVariable = {
  name: string; value?: SecretValue; secret?: boolean; enabled?: boolean; [key: string]: unknown;
};
export type Environment = {
  variables?: EnvironmentVariable[]; secretsProvider?: SecretsProvider; [key: string]: unknown;
};
export function readSecrets(file: string): Promise<Record<string, SecretValue>>;
export function writeSecrets(file: string, values: Record<string, SecretValue>, recipients?: string[]): Promise<void>;
export function getRecipients(file: string): Promise<string[]>;
export function updateRecipients(file: string, recipients: string[]): Promise<void>;
export function readRecipientLabels(file: string): Promise<Record<string, string>>;
export function writeRecipientLabels(file: string, labels: Record<string, string>): Promise<void>;
export function resolveSecretsPath(provider: SecretsProvider, basePath?: string): string;
export function hydrateEnvironment<T extends Environment>(env: T, basePath?: string): Promise<T>;
export function saveEnvironmentSecrets(env: Environment, basePath?: string): Promise<void>;
