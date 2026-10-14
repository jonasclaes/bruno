import parseEnvironment from './parseEnvironment';
import stringifyEnvironment from './stringifyEnvironment';

describe('SOPS environment descriptors', () => {
  it('round-trips the provider, inheritance and typed secret without its plaintext', () => {
    const source = `name: production
extends: base
secretsProvider:
  type: sops
  file: secrets/production.enc.yaml
variables:
  - name: credentials
    secret: true
    type: object
`;
    const parsed = parseEnvironment(source);
    expect(parsed.secretsProvider).toEqual({ type: 'sops', file: 'secrets/production.enc.yaml' });
    parsed.variables[0].value = { password: 'sensitive' };
    const serialized = stringifyEnvironment(parsed);
    expect(serialized).not.toContain('sensitive');
    const roundTrip = parseEnvironment(serialized);
    expect(roundTrip.secretsProvider).toEqual(parsed.secretsProvider);
    expect(roundTrip.extends).toBe('base');
    expect(roundTrip.variables[0]).toMatchObject({ name: 'credentials', secret: true, dataType: 'object', value: '' });
  });
});
