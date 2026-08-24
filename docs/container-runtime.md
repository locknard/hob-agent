# Single-image Hub runtime

Phase 0 ships one container image for the existing TypeScript Hub process. The
image has one entrypoint (`packages/hub/src/main.ts`), one durable volume
(`/data`), and no worker, sidecar, database, or orchestration process. Its
runtime configuration is the same environment-driven configuration used by
`pnpm start`.

Build from a checkout with no household files or secrets in the context:

```sh
docker build -t hob-agent:phase0 .
```

Run it with one named volume and the same configuration variables used by the
bare process. The product HTTP host intentionally listens on `127.0.0.1`, so
host networking is required for the host to reach the container's product
surface. The image already sets `HOB_DATA_DIR=/data`:

```sh
docker volume create hob-agent-data
docker run --rm --name hob-agent \
  --network host \
  --mount type=volume,src=hob-agent-data,dst=/data \
  -e HOB_BRIDGES="$HOB_BRIDGES" \
  -e HOB_MODEL="$HOB_MODEL" \
  hob-agent:phase0
```

On Linux, `--network host` shares the host network namespace. Docker Desktop
requires its host-networking support to be enabled; if the installed release
does not support it, there is no supported `-p` fallback for this loopback-bound
listener. Enable host networking or run the bare process instead. Configure
`HOB_BRIDGES` and `HOB_MODEL` with endpoints reachable from that network
namespace: without host networking, `127.0.0.1` inside the container means the
container itself, not the host.

The process runs as the non-root `node` user. Node remains PID 1, so the
existing Hub signal lifecycle receives `SIGTERM`/`SIGINT` and performs its
bounded graceful shutdown. Do not add a compose file or a sibling service for
Phase 0; Home Assistant and model endpoints remain configured external
bridges/providers.

`pnpm container:smoke` performs a read-only Dockerfile and `.dockerignore`
contract check and does not require a Docker daemon. When a daemon is
available, run the build command above before starting a configured household
instance.
