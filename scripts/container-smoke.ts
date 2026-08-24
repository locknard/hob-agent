import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_BASE_IMAGE = "node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90";
const EXPECTED_ENTRYPOINT = ["node", "--import", "tsx/esm", "packages/hub/src/main.ts"];

function requireContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function nonEmptyLines(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function hasIgnoreRule(lines: readonly string[], rule: string): boolean {
  return lines.some((line) => line === rule);
}

async function main(): Promise<void> {
  const dockerfile = await readFile(join(REPOSITORY_ROOT, "Dockerfile"), "utf8");
  const dockerignore = await readFile(join(REPOSITORY_ROOT, ".dockerignore"), "utf8");
  const operatorDocs = await readFile(join(REPOSITORY_ROOT, "docs/container-runtime.md"), "utf8");
  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
    readonly scripts?: Record<string, unknown>;
  };
  const dockerLines = nonEmptyLines(dockerfile);
  const ignoreLines = nonEmptyLines(dockerignore);
  const fromLines = dockerLines.filter((line) => /^FROM\s+/u.test(line));
  requireContract(fromLines.length === 1, "Dockerfile must define exactly one image stage");
  requireContract(fromLines[0] === `FROM ${EXPECTED_BASE_IMAGE}`, "Dockerfile must pin the approved Node base image by digest");
  requireContract(dockerfile.includes("WORKDIR /app"), "Dockerfile must use one application workdir");
  requireContract(/\bHOB_DATA_DIR=\/data\b/u.test(dockerfile), "Dockerfile must bind the durable data root to /data");
  requireContract(dockerfile.includes("VOLUME [\"/data\"]"), "Dockerfile must declare exactly the /data volume");
  requireContract(dockerfile.includes("USER node"), "Dockerfile must run the Hub as the non-root node user");
  requireContract(dockerfile.includes("STOPSIGNAL SIGTERM"), "Dockerfile must preserve the Hub's SIGTERM shutdown path");
  requireContract(dockerfile.includes("EXPOSE 8787"), "Dockerfile must document the default local product port");
  requireContract(dockerfile.includes("COPY contracts ./contracts"), "Dockerfile must copy the neutral contracts workspace");
  requireContract(dockerfile.includes("COPY packages ./packages"), "Dockerfile must copy the existing packages workspace");
  requireContract(dockerfile.includes("COPY scripts/install-git-hooks.sh scripts/install-git-hooks.sh"), "Dockerfile must include only the install hook needed by the root package lifecycle");
  requireContract(!/^COPY\s+\.\s+/mu.test(dockerfile), "Dockerfile must not copy the entire build context");
  requireContract(packageJson.scripts?.start === "tsx packages/hub/src/main.ts", "container and bare-process starts must share the existing main entrypoint");
  requireContract(operatorDocs.includes("--network host"), "operator run instructions must use host networking for the loopback-bound product listener");
  requireContract(!operatorDocs.includes("-p 8787:8787"), "operator run instructions must not advertise NAT port publishing for the loopback-bound listener");

  const entrypointLine = dockerLines.find((line) => /^ENTRYPOINT\s+/u.test(line));
  requireContract(entrypointLine !== undefined, "Dockerfile must declare a direct executable entrypoint");
  let entrypoint: unknown;
  try {
    entrypoint = JSON.parse(entrypointLine!.slice("ENTRYPOINT".length).trim()) as unknown;
  } catch {
    throw new Error("Dockerfile ENTRYPOINT must be a JSON array");
  }
  requireContract(JSON.stringify(entrypoint) === JSON.stringify(EXPECTED_ENTRYPOINT), "container entrypoint must run the existing Hub main directly");
  requireContract(!/^CMD\s+/mu.test(dockerfile), "Dockerfile must not replace the direct entrypoint with a shell command");
  requireContract(!/(?:docker[- ]compose|supervisord|s6-overlay|systemd|pm2|redis|postgres|mysql)/iu.test(dockerfile), "Dockerfile must not add an orchestrator or sibling service");
  requireContract(!/(?:HOB_MODEL|HOB_BRIDGES)\s*=/u.test(dockerfile), "container configuration must remain runtime-provided");

  for (const rule of [
    ".git",
    "node_modules",
    ".env*",
    "home/**",
    "home-template/",
    "*.db",
    "*.db-shm",
    "*.db-wal",
    "*.sqlite",
    "*.sqlite-shm",
    "*.sqlite-wal",
    "docs/",
    "tests/",
    "scripts/*",
  ]) {
    requireContract(hasIgnoreRule(ignoreLines, rule), `.dockerignore must exclude ${rule}`);
  }

  console.log("container contract passed (static; Docker daemon not required)");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? `container contract failed: ${error.message}` : "container contract failed");
  process.exitCode = 1;
});
