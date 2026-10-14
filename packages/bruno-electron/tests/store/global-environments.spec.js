jest.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
jest.mock('@usebruno/node-machine-id', () => ({ machineIdSync: () => 'test-machine-id' }));
jest.mock('electron-store', () => class {
  constructor() {
    this.data = new Map();
  }

  get(key, fallback) {
    return structuredClone(this.data.has(key) ? this.data.get(key) : fallback);
  }

  set(key, value) {
    this.data.set(key, structuredClone(value));
  }

  clear() {
    this.data.clear();
  }
});

const { globalEnvironmentsStore } = require('../../src/store/global-environments');
const { encryptStringSafe } = require('../../src/utils/encryption');

// Previously, a bug caused environment variables to be saved without a type.
// Since that issue is now fixed, this code ensures that anyone who imported
// data before the fix will have the missing types added retroactively.
describe('global environment variable type backward compatibility', () => {
  beforeEach(() => {
    globalEnvironmentsStore.store.clear();
  });

  it('should add type field for existing global environments without type', async () => {
    // Mock global environments without type field
    const mockGlobalEnvironments = [
      {
        uid: 'yDlwWe3qgimPG20G7AbF7',
        name: 'Test Environment',
        variables: [
          {
            uid: 'b6BIHGaCrm4m97YA2dIdx',
            name: 'regular_var',
            value: 'regular_value',
            enabled: true,
            secret: false
            // Missing: type field
          },
          {
            uid: 'yQTqanPoMdRjKnHyIOZNc',
            name: 'secret_var',
            value: 'secret_value',
            enabled: true,
            secret: true
            // Missing: type field
          }
        ]
      }
    ];

    globalEnvironmentsStore.store.set('environments', mockGlobalEnvironments);

    const processedEnvironments = await globalEnvironmentsStore.getGlobalEnvironments();

    expect(processedEnvironments).toHaveLength(1);
    expect(processedEnvironments[0].variables).toHaveLength(2);

    const regularVar = processedEnvironments[0].variables.find((v) => v.name === 'regular_var');
    const secretVar = processedEnvironments[0].variables.find((v) => v.name === 'secret_var');

    expect(regularVar.name).toBe('regular_var');
    expect(regularVar.type).toBe('text');

    expect(secretVar.name).toBe('secret_var');
    expect(secretVar.type).toBe('text');
  });
});

describe('global environment variable read-time dataType parsing', () => {
  beforeEach(() => {
    globalEnvironmentsStore.store.clear();
  });

  const storedAs = (dataType, value) => ({
    uid: 'yDlwWe3qgimPG20G7AbF7',
    name: 'Test Environment',
    variables: [
      {
        uid: 'b6BIHGaCrm4m97YA2dIdx',
        name: 'v',
        value,
        dataType,
        type: 'text',
        enabled: true,
        secret: false
      }
    ]
  });

  const readVar = async () => (await globalEnvironmentsStore.getGlobalEnvironments())[0].variables[0];

  it('parses @number string values into JS numbers', async () => {
    globalEnvironmentsStore.store.set('environments', [storedAs('number', '42')]);
    expect((await readVar()).value).toBe(42);
  });

  it('parses @boolean string values into JS booleans', async () => {
    globalEnvironmentsStore.store.set('environments', [storedAs('boolean', 'false')]);
    expect((await readVar()).value).toBe(false);
  });

  it('parses @object string values via JSON.parse', async () => {
    globalEnvironmentsStore.store.set('environments', [storedAs('object', '{"a":1}')]);
    expect((await readVar()).value).toEqual({ a: 1 });
  });

  it('passes string-typed values through unchanged', async () => {
    globalEnvironmentsStore.store.set('environments', [storedAs('string', 'hello')]);
    expect((await readVar()).value).toBe('hello');
  });

  it('is idempotent — already-coerced values stay put', async () => {
    globalEnvironmentsStore.store.set('environments', [storedAs('number', 42)]);
    expect((await readVar()).value).toBe(42);
  });

  it('parses secret variables by their dataType after decryption', async () => {
    // Encrypt so the decryption round-trip yields '42', which is then coerced.
    const encrypted = encryptStringSafe('42').value;
    const env = {
      uid: 'yDlwWe3qgimPG20G7AbF7',
      name: 'Test Environment',
      variables: [
        {
          uid: 'b6BIHGaCrm4m97YA2dIdx',
          name: 'sec',
          value: encrypted,
          dataType: 'number',
          type: 'text',
          enabled: true,
          secret: true
        }
      ]
    };
    globalEnvironmentsStore.store.set('environments', [env]);
    expect((await readVar()).value).toBe(42);
  });
});
