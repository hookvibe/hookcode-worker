# @hookvibe/hookcode-worker

Standalone HookCode worker runtime.

This package runs the HookCode worker process outside the main `hookcode` repository. It is published to npmjs for direct installation and packaged as a GHCR image for Docker deployments.

## Install

```bash
npm install -g @hookvibe/hookcode-worker@0.1.0
```

Or run it without a global install:

```bash
npx @hookvibe/hookcode-worker@0.1.0
```

## Usage

Required environment variables:

- `HOOKCODE_BACKEND_URL`
- `HOOKCODE_WORKER_ID`
- `HOOKCODE_WORKER_TOKEN`

Common optional variables:

- `HOOKCODE_WORKER_NAME`
- `HOOKCODE_WORKER_KIND`
- `HOOKCODE_WORKER_MAX_CONCURRENCY`
- `HOOKCODE_WORK_DIR`
- `HOOKCODE_WORKER_PREVIEW`

Example:

```bash
HOOKCODE_BACKEND_URL="https://your-hookcode.example.com/api" \
HOOKCODE_WORKER_ID="worker_xxx" \
HOOKCODE_WORKER_TOKEN="token_xxx" \
HOOKCODE_WORKER_NAME="Build Host A" \
HOOKCODE_WORKER_KIND="remote" \
HOOKCODE_WORKER_MAX_CONCURRENCY="1" \
hookcode-worker
```

## Development

```bash
pnpm install
pnpm test
pnpm build
pnpm dev
```

## Docker

The published image is pushed to:

```text
ghcr.io/hookvibe/hookcode-worker:<version>
```

Run the packaged image directly:

```bash
docker run --rm \
  -e HOOKCODE_BACKEND_URL="https://your-hookcode.example.com/api" \
  -e HOOKCODE_WORKER_ID="worker_xxx" \
  -e HOOKCODE_WORKER_TOKEN="token_xxx" \
  -e HOOKCODE_WORKER_NAME="Dedicated Remote Worker" \
  -e HOOKCODE_WORKER_KIND="remote" \
  -e HOOKCODE_WORKER_MAX_CONCURRENCY="1" \
  ghcr.io/hookvibe/hookcode-worker:0.1.0
```

