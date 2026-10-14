jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const sops = require('./index');

describe('SOPS subprocess isolation', () => {
  let directory;
  let file;
  let input;
  let child;
  let respond;
  const recipient = 'age1acdef';
  const encrypted = JSON.stringify({
    token: 'ENC[AES256_GCM,data:encrypted]',
    sops: { mac: 'ENC[AES256_GCM,data:mac]', age: [{ recipient }] }
  });

  beforeEach(async () => {
    directory = path.join(__dirname, `.test-${randomUUID()}`);
    await fs.mkdir(directory);
    file = path.join(directory, 'secrets.json');
    jest.spyOn(fs, 'access').mockResolvedValue();
    input = '';
    child = undefined;
    respond = true;
    spawn.mockImplementation(() => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = jest.fn(() => {
        process.nextTick(() => child.emit('close', null));
        return true;
      });
      child.stdin = new Writable({
        write(bytes, encoding, done) {
          input += bytes.toString();
          done();
        },
        final(done) {
          done();
          if (respond) {
            process.nextTick(() => {
              child.stdout.end(encrypted);
              child.emit('close', 0);
            });
          }
        }
      });
      return child;
    });
  });
  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    spawn.mockReset();
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('passes plaintext only over stdin, never through shell, argv or child environment additions', async () => {
    const secret = 'VALUE-MUST-NEVER-APPEAR-IN-ARGV';
    await sops.writeSecrets(file, { token: secret }, [recipient]);
    const [binary, args, options] = spawn.mock.calls[0];
    expect(binary).toContain(path.join('sops', 'bin'));
    expect(args.join(' ')).not.toContain(secret);
    expect(input).toBe(JSON.stringify({ token: secret }));
    expect(options.shell).toBe(false);
    expect(options.env).toBe(process.env);
    expect(await fs.readFile(file, 'utf8')).not.toContain(secret);
    expect(await fs.readdir(directory)).toEqual(['secrets.json']);
  });

  test('discards potentially sensitive stderr and subprocess failure details', async () => {
    respond = false;
    await fs.writeFile(file, encrypted);
    const pending = sops.readSecrets(file);
    while (!child) await new Promise((resolve) => setImmediate(resolve));
    child.stderr.end('SENSITIVE PRIVATE KEY AND PLAINTEXT');
    child.emit('error', new Error('SENSITIVE PRIVATE KEY AND PLAINTEXT'));
    await expect(pending).rejects.toThrow('Unable to execute bundled SOPS.');
  });

  test('kills timed-out subprocesses and returns a sanitized error', async () => {
    respond = false;
    await fs.writeFile(file, encrypted);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const pending = sops.readSecrets(file);
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    while (!child) await new Promise((resolve) => setImmediate(resolve));
    await jest.advanceTimersByTimeAsync(30001);
    await assertion;
    expect(child.kill).toHaveBeenCalled();
  });
});
