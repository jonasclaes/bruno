# Bruno CLI

With Bruno CLI, you can now run your API collections with ease using simple command line commands.

This makes it easier to test your APIs in different environments, automate your testing process, and integrate your API tests with your continuous integration and deployment workflows.

For detailed documentation, visit [Bruno CLI Documentation](https://docs.usebruno.com/bru-cli/overview).

## Installation

To install the Bruno CLI, use the node package manager of your choice, such as NPM:

```bash
npm install -g @usebruno/cli
```

## Getting started

Navigate to the directory where your API collection resides, and then run:

```bash
bru run
```

This command will run all the requests in your collection. You can also run a single request by specifying its filename:

```bash
bru run request.bru
```

Or run all requests in a collection's subfolder:

```bash
bru run folder
```

If you need to use an environment, you can specify it with the `--env` option:

```bash
bru run folder --env Local
```

If you need to collect the results of your API tests, you can specify the `--output` option:

```bash
bru run folder --output results.json
```

If you need to run a set of requests that connect to peers with both publicly and privately signed certificates respectively, you can add private CA certificates via the `--cacert` option. By default, these certificates will be used in addition to the default truststore:

```bash
bru run folder --cacert myCustomCA.pem
```

If you need to limit the trusted CA to a specified set when validating the request peer, provide them via `--cacert` and in addition use `--ignore-truststore` to disable the default truststore:

```bash
bru run request.bru --cacert myCustomCA.pem --ignore-truststore
```

## SOPS-backed environment secrets

SOPS is an opt-in secret provider for workspace and global environments. In the desktop environment editor, open **Secrets → Use SOPS for secrets**, then select or create an encrypted file inside a Git repository. Add age recipients or supported SSH public keys and optionally name their owners. Save the settings, then manage secret variables using the existing Secrets table.

Each top-level entry in the encrypted file corresponds to a secret variable. Attaching an existing file imports its secret names; ordinary requests resolve only the environment's declared secrets.

Commit the encrypted JSON or YAML file, its `<filename>.recipients.json` label sidecar, and the workspace environment descriptor. Recipient labels are public display metadata, not access-control rules. SOPS metadata in the encrypted file is the source of truth for recipients; Bruno re-encrypts the file when recipients change.

Run a workspace environment with `bru run --global-env production --workspace-path /path/to/workspace`. For an application-local global environment, select **CLI YAML descriptors** when exporting its environment into the repository, then use `--global-env-file /path/to/environment.yml`. The descriptor's `secretsProvider` contains `type: sops` and `file`, and its secret variables retain `secret: true` without plaintext values. Workspace file references are relative to the workspace root; standalone descriptor references are relative to the descriptor directory.

SOPS is bundled with desktop and CLI distributions. Private keys remain outside the repository. Configure identities through SOPS's standard discovery mechanisms, such as `SOPS_AGE_KEY_FILE` or `SOPS_AGE_SSH_PRIVATE_KEY_FILE`, including in CI. Bruno does not store private keys. Missing keys, failed decryption, and missing declared secrets fail rather than falling back to locally stored values.

For source checkouts, prepare the binary from the repository root with `node scripts/bundle-sops.js --target linux-x64`, substituting `darwin`, `linux`, or `win32` and `x64` or `arm64` for your platform. Packaging prepares binaries automatically and verifies their pinned SHA256 checksums; running requests never downloads executables.

Removing a recipient cannot revoke access to previously decrypted secrets or older Git revisions. Rotate the underlying credentials when revoking a team member's access. Automatic migration of existing local secrets is not provided.

## Importing Collections

You can import collections from other formats, such as OpenAPI, using the import command:

```bash
bru import openapi --source api.yml --output ~/Desktop/my-collection --collection-name "My API"
```

You can also use the shorter form with aliases:

```bash
bru import openapi -s api.yml -o ~/Desktop/my-collection -n "My API"
```

This creates a Bruno collection directory that can be opened in Bruno.

You can also import directly from a URL:

```bash
bru import openapi --source https://example.com/api-spec.json --output ~/Desktop --collection-name "Remote API"
```

You can also export the collection as a JSON file:

```bash
bru import openapi --source api.yml --output-file ~/Desktop/my-collection.json --collection-name "My API"
```

Import Options:

| Option                    | Details                                            |
| ------------------------- | -------------------------------------------------- |
| --source, -s              | Path to the source file or URL (required)          |
| --output, -o              | Path to the output directory                       |
| --output-file, -f         | Path to the output JSON file                       |
| --collection-name, -n     | Name for the imported collection                   |
| --insecure                | Skip SSL certificate validation when fetching from URLs |

## Command Line Options

| Option                       | Details                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| -h, --help                   | Show help                                                                     |
| --version                    | Show version number                                                           |
| -r                           | Indicates a recursive run (default: false)                                    |
| --cacert [string]            | CA certificate to verify peer against                                         |
| --env [string]               | Specify environment to run with                                               |
| --env-var [string]           | Overwrite a single environment variable, multiple usages possible             |
| -o, --output [string]        | Path to write file results to                                                 |
| -f, --format [string]        | Format of the file results; available formats are "json" (default) or "junit" |
| --reporter-json [string]     | Path to generate a JSON report                                                |
| --reporter-junit [string]    | Path to generate a JUnit report                                               |
| --reporter-html [string]     | Path to generate an HTML report                                               |
| --insecure                   | Allow insecure server connections                                             |
| --tests-only                 | Only run requests that have tests                                             |
| --bail                       | Stop execution after a failure of a request, test, or assertion               |
| --csv-file-path              | CSV file to run the collection with                                           |
| --reporter--skip-all-headers | Skip all headers in the report                                                |
| --reporter-skip-headers      | Skip specific headers in the report                                           |
| --client-cert-config         | Client certificate configuration by passing a JSON file                       |
| --delay [number]             | Add delay to each request                                                     |

## Scripting

Bruno cli returns the following exit status codes:

- `0` -- execution successful
- `1` -- an assertion, test, or request in the executed collection failed
- `2` -- the specified output directory does not exist
- `3` -- the request chain seems to loop endlessly
- `4` -- bru was called outside of a collection root directory
- `5` -- the specified input file does not exist
- `6` -- the specified environment does not exist
- `7` -- the environment override was not a string or object
- `8` -- an environment override is malformed
- `9` -- an invalid output format was requested
- `255` -- another error occurred

## Demo

![demo](assets/images/cli-demo.png)

## Support

If you encounter any issues or have any feedback or suggestions, please raise them on our [GitHub repository](https://github.com/usebruno/bruno)

Thank you for using Bruno CLI!

## Changelog

<!-- An absolute link is used here because npm treats links differently -->

See [https://github.com/usebruno/bruno/releases](https://github.com/usebruno/bruno/releases)

## License

[MIT](license.md)
