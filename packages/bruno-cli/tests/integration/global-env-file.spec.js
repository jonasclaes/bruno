const fs = require('fs');
const path = require('path');
const { runCli } = require('./helpers/run-cli');
const { startLocalServer } = require('./helpers/environments');

describe('CLI portable global environment descriptors', () => {
  let directory;
  let server;
  let requests;
  let descriptor;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(__dirname, '.global-env-file-'));
    requests = 0;
    server = await startLocalServer((_req, res) => {
      requests++;
      res.end('{}');
    });
    fs.writeFileSync(path.join(directory, 'bruno.json'), '{"version":"1","name":"portable","type":"collection"}');
    fs.writeFileSync(path.join(directory, 'request.bru'), `meta {
  name: portable
  type: http
  seq: 1
}
get {
  url: ${server.baseUrl}/{{token}}
  body: none
  auth: none
}
`);
    descriptor = path.join(directory, 'global.yaml');
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('uses an explicit YAML descriptor without requiring an application workspace', async () => {
    fs.writeFileSync(descriptor, 'name: portable\nvariables:\n  - name: token\n    value: plain\n');
    const result = await runCli(['run', 'request.bru', '--global-env-file', descriptor, '--sandbox', 'developer', '--noproxy'], directory);
    expect(result.code).toBe(0);
    expect(requests).toBe(1);
  });

  it('fails closed before sending requests when encrypted secrets cannot be loaded', async () => {
    fs.writeFileSync(descriptor, 'name: portable\nsecretsProvider:\n  type: sops\n  file: missing.enc.yaml\nvariables:\n  - name: token\n    secret: true\n');
    const result = await runCli(['run', 'request.bru', '--global-env-file', descriptor, '--sandbox', 'developer', '--noproxy'], directory);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Failed to load global environment');
    expect(requests).toBe(0);
    expect(result.stderr).not.toContain('missing.enc.yaml');
  });

  it('rejects conflicting global environment selectors', async () => {
    const result = await runCli(['run', 'request.bru', '--global-env-file', descriptor, '--global-env', 'production'], directory);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Use either --global-env or --global-env-file');
    expect(requests).toBe(0);
  });
});
