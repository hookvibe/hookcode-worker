# @hookvibe/hookcode-worker

Standalone HookCode worker runtime.

This package runs the HookCode worker process outside the main `hookcode` repository. It is published to npmjs for direct installation and packaged as a GHCR image for Docker deployments.

## Install

```bash
npm install -g @hookvibe/hookcode-worker
```

Or run a specific version without a global install:

```bash
npx @hookvibe/hookcode-worker@<required-version>
```

Check the installed version:

```bash
hookcode-worker version
```

Upgrade from the CLI:

```bash
hookcode-worker upgrade --to <required-version>
```

This wraps the equivalent global install command:

```bash
npm install -g @hookvibe/hookcode-worker@<required-version>
```

When HookCode reports a required worker version, use that exact version in either command above.

## Usage

The worker now binds through a single one-time `bind code`.

First-time manual install:

```bash
npm install -g @hookvibe/hookcode-worker

HOOKCODE_WORK_DIR="$HOME/.hookcode/workers/worker-a" \
HOOKCODE_WORKER_BIND_CODE="hcw1...." \
hookcode-worker configure

HOOKCODE_WORK_DIR="$HOME/.hookcode/workers/worker-a" \
HOOKCODE_WORKER_KIND="remote" \
HOOKCODE_WORKER_NAME="Build Host A" \
HOOKCODE_WORKER_MAX_CONCURRENCY="1" \
hookcode-worker run
```

The `configure` command exchanges the bind code for long-lived worker credentials and stores them under `HOOKCODE_WORK_DIR`. Later restarts only need `hookcode-worker run` from the same work dir.

Required first-time environment variables:

- `HOOKCODE_WORKER_BIND_CODE`

Common optional variables:

- `HOOKCODE_WORKER_NAME`
- `HOOKCODE_WORKER_KIND`
- `HOOKCODE_WORKER_MAX_CONCURRENCY`
- `HOOKCODE_WORK_DIR`
- `HOOKCODE_WORKER_PREVIEW`
- `HOOKCODE_WORKER_FORCE_RECONFIGURE`

`HOOKCODE_WORKER_FORCE_RECONFIGURE=1` forces the worker to consume the provided bind code again instead of reusing any stored credentials. This is mainly for backend-managed local workers.

## Development

```bash
pnpm install
pnpm test
pnpm build
pnpm dev
```

Local development also supports a dedicated env file. The worker will auto-load `.env.worker.local` first, then `.env.worker`, from the current working directory. Existing shell environment variables still win over file values.

```bash
cp .env.worker.example .env.worker
pnpm dev
```

To use a custom file path instead of the default discovery:

```bash
HOOKCODE_ENV_FILE=/absolute/path/to/local-worker.env pnpm dev
```

## Docker

The published image is pushed to:

```text
ghcr.io/hookvibe/hookcode-worker:<version>
```

Run the packaged image directly:

```bash
docker run --rm \
  -e HOOKCODE_WORKER_BIND_CODE="hcw1...." \
  -e HOOKCODE_WORKER_NAME="Dedicated Remote Worker" \
  -e HOOKCODE_WORKER_KIND="remote" \
  -e HOOKCODE_WORKER_MAX_CONCURRENCY="1" \
  -e HOOKCODE_WORK_DIR="/var/lib/hookcode" \
  -v hookcode-worker-data:/var/lib/hookcode \
  ghcr.io/hookvibe/hookcode-worker:<required-version>
```
