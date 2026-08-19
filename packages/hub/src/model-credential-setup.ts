import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import { parseModelReference } from "@hob-agent/agent-layer/model-reference";

import { provisionPrimaryModelApiKey } from "./model-credential-profile.js";

const MAX_SECRET_BYTES = 16_384;

interface TtySecretInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
}

interface TextOutput {
  write(value: string): unknown;
}

/** Reads a bounded secret; interactive terminals are switched to no-echo raw mode. */
export async function readSecretInput(
  input: TtySecretInput,
  promptOutput: TextOutput = process.stderr,
): Promise<string> {
  const value = input.isTTY && input.setRawMode
    ? await readHiddenTtySecret(input, promptOutput)
    : await readPipedSecret(input);
  if (value.length === 0) throw new Error("API key must not be empty");
  return value;
}

async function readPipedSecret(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input as AsyncIterable<string | Buffer>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_SECRET_BYTES) throw new Error("API key input is too long");
    chunks.push(buffer);
  }
  return stripOneLineEnding(Buffer.concat(chunks).toString("utf8"));
}

function readHiddenTtySecret(input: TtySecretInput, output: TextOutput): Promise<string> {
  return new Promise((resolveSecret, rejectSecret) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
    };
    const finish = () => {
      cleanup();
      resolveSecret(value);
    };
    const fail = (error: Error) => {
      cleanup();
      rejectSecret(error);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return fail(new Error("Credential setup cancelled"));
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
        if (Buffer.byteLength(value) > MAX_SECRET_BYTES) return fail(new Error("API key input is too long"));
      }
    };
    output.write("Model API key: ");
    input.setRawMode?.(true);
    input.on("data", onData);
    input.resume();
  });
}

function stripOneLineEnding(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

export async function setupModelCredential(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  input: TtySecretInput = process.stdin,
): Promise<{ provider: string; profileId: string; status: "configured" }> {
  const dataDirectory = environment.HOB_DATA_DIR?.trim();
  if (!dataDirectory || !isAbsolute(dataDirectory)) {
    throw new Error("HOB_DATA_DIR must be an absolute private data directory");
  }
  const modelReference = environment.HOB_MODEL?.trim();
  if (!modelReference) throw new Error("HOB_MODEL is required");
  let model;
  try {
    model = parseModelReference(modelReference);
  } catch {
    throw new Error("HOB_MODEL must be a supported provider/model reference");
  }
  const apiKey = await readSecretInput(input);
  const profile = await provisionPrimaryModelApiKey(dataDirectory, model.provider, apiKey);
  return { provider: model.provider, profileId: profile.id, status: "configured" };
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  void setupModelCredential().then(
    (result) => { console.log(JSON.stringify(result)); },
    () => {
      console.error("hob-agent model credential setup failed");
      process.exitCode = 1;
    },
  );
}
