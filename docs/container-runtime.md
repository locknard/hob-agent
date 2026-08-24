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

The image sets `HOB_VAULT_KEY_FILE=/run/secrets/hob-vault-key`. Create the
operator-managed key before starting the image; the command writes 64 hex
characters plus a newline (exactly 32 decoded bytes) and never prints the key:

```sh
export HOB_VAULT_KEY_SOURCE="/var/lib/hob-agent/hob-vault-key"
sudo install -d -m 0700 /var/lib/hob-agent
sudo sh -c 'umask 077; openssl rand -hex 32 > /var/lib/hob-agent/hob-vault-key'
sudo chmod 600 "$HOB_VAULT_KEY_SOURCE"
sudo chown 1000:1000 "$HOB_VAULT_KEY_SOURCE"
```

The image's non-root `node` user is UID 1000. Keep the bind source owner-only
(`0600`) and owned by UID 1000 so that this user can read it. The key is a
separate read-only secret mount, never product data under `/data`; keep the
source outside the repository checkout and do not put it in an image layer or a
command-line environment value. The `.dockerignore` also excludes the exact
`hob-vault-key` filename as a defensive build-context guard.

Run it with one named volume and the same configuration variables used by the
bare process. The product HTTP host intentionally listens on `127.0.0.1`, so
host networking is required for the host to reach the container's product
surface. The image already sets `HOB_DATA_DIR=/data` and
`HOB_VAULT_KEY_FILE=/run/secrets/hob-vault-key`:

```sh
docker volume create hob-agent-data
docker run --rm --name hob-agent \
  --network host \
  --mount type=volume,src=hob-agent-data,dst=/data \
  --mount type=bind,src="$HOB_VAULT_KEY_SOURCE",dst=/run/secrets/hob-vault-key,readonly \
  -e HOB_BRIDGES="$HOB_BRIDGES" \
  -e HOB_MODEL="$HOB_MODEL" \
  hob-agent:phase0
```

The key mount is required. If `/run/secrets/hob-vault-key` is absent or
permission-unsafe, startup fails closed before credential setup and never
selects the macOS Keychain fallback. Keep `HOB_VAULT_KEY_FILE` at the image's
fixed path; the key itself never belongs in `-e` or `--env` arguments.

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
