import { createHash, randomUUID } from "node:crypto";
import { constants, chmodSync, lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type {
  ActionAuthorityConfiguration,
  ActionAuthorityPolicyClass,
} from "./authority-coordinator.js";
import { canonicalAssessmentInput } from "./artifact/artifact-assessments.js";

export const ACTION_AUTHORITY_CONFIG_FILE = "action-authority.json";
export const ACTION_AUTHORITY_CONFIG_VERSION = 2;
export const MAX_ACTION_AUTHORITY_CONFIG_BYTES = 64 * 1024;
export const MAX_ACTION_AUTHORITY_BINDINGS = 256;

const MAX_ID_BYTES = 200;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const URL_PATTERN = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:data|javascript|mailto):|\bwww\.)/iu;

export type ActionAuthorityConfigurationErrorCode =
  | "invalid_input"
  | "unsafe_filesystem"
  | "invalid_json"
  | "resource_exhausted"
  | "read_failed";

export class ActionAuthorityConfigurationError extends Error {
  constructor(
    readonly code: ActionAuthorityConfigurationErrorCode,
    detail: string,
  ) {
    super(`Invalid action authority configuration: ${detail}`);
    this.name = "ActionAuthorityConfigurationError";
  }
}

interface ActionAuthorityBindingFileEntry {
  readonly hwCapabilityId: string;
  readonly bridgeId: string;
  readonly approved: boolean;
  readonly policyClass: ActionAuthorityPolicyClass;
  readonly revision: number;
}

export interface ActionAuthorityConfigurationLoaderDependencies {
  /** Test seam for a replacement/removal between path inspection and open. */
  readonly afterFileMetadata?: () => void | Promise<void>;
}

export interface ActionAuthorityBindingWriteInput {
  readonly hwCapabilityId: string;
  readonly bridgeId: string;
  readonly approved: boolean;
  readonly policyClass: ActionAuthorityPolicyClass;
  readonly revision: number;
}

/** Returns the one fixed Phase 0 path under the supplied data directory. */
export function actionAuthorityConfigurationPath(dataDirectory: string): string {
  return join(resolveDataDirectoryPath(dataDirectory), ACTION_AUTHORITY_CONFIG_FILE);
}

/**
 * Replaces the canonical action-authority file in one private atomic rename.
 * The returned projection is the exact value accepted by AuthorityCoordinator;
 * callers update the running coordinator only after this write succeeds.
 */
export function writeActionAuthorityConfiguration(
  path: string,
  bindings: readonly ActionAuthorityBindingWriteInput[],
): Readonly<Record<string, ActionAuthorityConfiguration>> {
  if (!isAbsolute(path) || !path.endsWith(`/${ACTION_AUTHORITY_CONFIG_FILE}`)) throw invalidInput();
  if (!Array.isArray(bindings) || bindings.length > MAX_ACTION_AUTHORITY_BINDINGS) throw resourceExhausted();
  const normalized = bindings.map((binding) => {
    if (!isPlainRecord(binding)) throw invalidInput();
    const hwCapabilityId = boundedId(binding.hwCapabilityId);
    const bridgeId = boundedId(binding.bridgeId);
    if (typeof binding.approved !== "boolean" || !isPolicyClass(binding.policyClass) || !isPositiveSafeInteger(binding.revision)) throw invalidInput();
    return { hwCapabilityId, bridgeId, approved: binding.approved, policyClass: binding.policyClass, revision: binding.revision } satisfies ActionAuthorityBindingFileEntry;
  });
  if (new Set(normalized.map((binding) => binding.hwCapabilityId)).size !== normalized.length) throw invalidInput();
  normalized.sort((left, right) => compareCodePoints(left.hwCapabilityId, right.hwCapabilityId));
  const parent = dirname(path);
  assertPrivateDirectory(parent);
  assertPrivateTarget(path);
  const raw = `${JSON.stringify({ version: ACTION_AUTHORITY_CONFIG_VERSION, bindings: normalized })}\n`;
  if (Buffer.byteLength(raw, "utf8") > MAX_ACTION_AUTHORITY_CONFIG_BYTES) throw resourceExhausted();
  const temporaryPath = join(parent, `.${ACTION_AUTHORITY_CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch {
    try { unlinkSync(temporaryPath); } catch { /* retain the original source when cleanup cannot run */ }
    throw new ActionAuthorityConfigurationError("read_failed", "configuration file could not be replaced");
  }
  return parseActionAuthorityConfiguration(raw);
}

/**
 * Loads the startup-only Hub-private authority projection. A missing file is
 * the only non-error empty state; this function never writes, repairs, or
 * watches the configuration source.
 */
export async function loadActionAuthorityConfiguration(
  dataDirectory: string,
  dependencies: ActionAuthorityConfigurationLoaderDependencies = {},
): Promise<Readonly<Record<string, ActionAuthorityConfiguration>>> {
  const configuredDirectory = resolveDataDirectoryPath(dataDirectory);
  const canonicalDirectory = await verifyDataDirectory(configuredDirectory);
  const path = join(canonicalDirectory, ACTION_AUTHORITY_CONFIG_FILE);
  const fileMetadata = await lstatOrMissing(path);
  if (fileMetadata === undefined) return Object.freeze({});
  if (fileMetadata.isSymbolicLink() || !fileMetadata.isFile() || privateMode(fileMetadata.mode) !== 0o600) {
    throw invalidFilesystem();
  }
  try {
    await dependencies.afterFileMetadata?.();
  } catch {
    throw invalidFilesystem();
  }

  let canonicalFile: string;
  try {
    canonicalFile = await realpath(path);
  } catch {
    throw invalidFilesystem();
  }
  if (dirname(canonicalFile) !== canonicalDirectory || canonicalFile !== path) {
    throw invalidFilesystem();
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorMetadata = await handle.stat();
    if (!descriptorMetadata.isFile() || privateMode(descriptorMetadata.mode) !== 0o600) {
      throw invalidFilesystem();
    }
    const raw = await readBoundedUtf8(handle, descriptorMetadata.size);
    return parseActionAuthorityConfiguration(raw);
  } catch (error) {
    if (error instanceof ActionAuthorityConfigurationError) throw error;
    throw new ActionAuthorityConfigurationError("read_failed", "configuration file could not be read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyDataDirectory(path: string): Promise<string> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw invalidFilesystem();
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || privateMode(metadata.mode) !== 0o700) {
    throw invalidFilesystem();
  }

  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw invalidFilesystem();
  }
  let canonicalMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    canonicalMetadata = await lstat(canonical);
  } catch {
    throw invalidFilesystem();
  }
  if (canonicalMetadata.isSymbolicLink()
    || !canonicalMetadata.isDirectory()
    || privateMode(canonicalMetadata.mode) !== 0o700) {
    throw invalidFilesystem();
  }
  return canonical;
}

async function readBoundedUtf8(
  handle: Awaited<ReturnType<typeof open>>,
  descriptorSize: number,
): Promise<string> {
  if (!Number.isSafeInteger(descriptorSize) || descriptorSize < 0 || descriptorSize > MAX_ACTION_AUTHORITY_CONFIG_BYTES) {
    throw new ActionAuthorityConfigurationError("resource_exhausted", "configuration file exceeds the byte limit");
  }
  const buffer = Buffer.alloc(MAX_ACTION_AUTHORITY_CONFIG_BYTES + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, null);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > MAX_ACTION_AUTHORITY_CONFIG_BYTES) {
    throw new ActionAuthorityConfigurationError("resource_exhausted", "configuration file exceeds the byte limit");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } catch {
    throw new ActionAuthorityConfigurationError("invalid_json", "configuration file is not valid UTF-8");
  }
}

function parseActionAuthorityConfiguration(raw: string): Readonly<Record<string, ActionAuthorityConfiguration>> {
  assertNoDuplicateJsonKeys(raw);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ActionAuthorityConfigurationError("invalid_json", "configuration JSON is malformed");
  }
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ["bindings", "version"])
    || value.version !== ACTION_AUTHORITY_CONFIG_VERSION) {
    throw invalidInput();
  }
  if (!Array.isArray(value.bindings) || value.bindings.length > MAX_ACTION_AUTHORITY_BINDINGS) {
    throw new ActionAuthorityConfigurationError("resource_exhausted", "configuration binding count is invalid");
  }

  const entries: ActionAuthorityBindingFileEntry[] = [];
  const seen = new Set<string>();
  for (const binding of value.bindings) {
    if (!isPlainRecord(binding)
      || !hasExactKeys(binding, ["approved", "bridgeId", "hwCapabilityId", "policyClass", "revision"])) {
      throw invalidInput();
    }
    const entry = parseBinding(binding);
    if (seen.has(entry.hwCapabilityId)) throw invalidInput();
    seen.add(entry.hwCapabilityId);
    entries.push(entry);
  }

  entries.sort((left, right) => compareCodePoints(left.hwCapabilityId, right.hwCapabilityId));
  const output: Record<string, ActionAuthorityConfiguration> = {};
  for (const entry of entries) {
    const configuration = Object.freeze({
      bridgeId: entry.bridgeId,
      approved: entry.approved,
      policyClass: entry.policyClass,
      configIdentity: computeConfigurationIdentity(entry),
      configRevision: entry.revision,
    });
    Object.defineProperty(output, entry.hwCapabilityId, {
      configurable: false,
      enumerable: true,
      value: configuration,
      writable: false,
    });
  }
  return Object.freeze(output);
}

function parseBinding(value: Record<string, unknown>): ActionAuthorityBindingFileEntry {
  const hwCapabilityId = boundedId(value.hwCapabilityId);
  const bridgeId = boundedId(value.bridgeId);
  if (typeof value.approved !== "boolean"
    || !isPolicyClass(value.policyClass)
    || !isPositiveSafeInteger(value.revision)) throw invalidInput();
  return {
    hwCapabilityId,
    bridgeId,
    approved: value.approved,
    policyClass: value.policyClass,
    revision: value.revision,
  };
}

function computeConfigurationIdentity(entry: ActionAuthorityBindingFileEntry): `sha256:${string}` {
  const canonical = canonicalAssessmentInput({
    kind: "action-authority-config-v2",
    input: {
      approved: entry.approved,
      bridgeId: entry.bridgeId,
      hwCapabilityId: entry.hwCapabilityId,
      policyClass: entry.policyClass,
    },
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function isPolicyClass(value: unknown): value is ActionAuthorityPolicyClass {
  return value === "direct" || value === "confirmation" || value === "administrator";
}

function boundedId(value: unknown): string {
  if (typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES
    || !STABLE_ID_PATTERN.test(value)
    || URL_PATTERN.test(value)) {
    throw invalidInput();
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compareCodePoints);
  const sortedExpected = [...expected].sort(compareCodePoints);
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function privateMode(mode: number | bigint): number {
  return Number(mode) & 0o777;
}

function resolveDataDirectoryPath(dataDirectory: string): string {
  if (typeof dataDirectory !== "string"
    || !isAbsolute(dataDirectory)
    || dataDirectory === ":memory:"
    || /(?:^|[\\/])\.env(?:$|[\\/])/iu.test(dataDirectory)) {
    throw invalidInput();
  }
  return resolve(dataDirectory);
}

async function lstatOrMissing(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw invalidFilesystem();
  }
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function invalidInput(): ActionAuthorityConfigurationError {
  return new ActionAuthorityConfigurationError("invalid_input", "configuration content is invalid");
}

function invalidFilesystem(): ActionAuthorityConfigurationError {
  return new ActionAuthorityConfigurationError("unsafe_filesystem", "configuration filesystem boundary is invalid");
}

function resourceExhausted(): ActionAuthorityConfigurationError {
  return new ActionAuthorityConfigurationError("resource_exhausted", "configuration exceeds the resource limit");
}

function assertPrivateDirectory(path: string): void {
  let metadata;
  try { metadata = lstatSync(path); } catch { throw invalidFilesystem(); }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || privateMode(metadata.mode) !== 0o700) throw invalidFilesystem();
  try { realpathSync(path); } catch { throw invalidFilesystem(); }
}

function assertPrivateTarget(path: string): void {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || privateMode(metadata.mode) !== 0o600) throw invalidFilesystem();
  } catch (error) {
    if (error instanceof ActionAuthorityConfigurationError) throw error;
    if (!isMissingError(error)) throw invalidFilesystem();
  }
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function assertNoDuplicateJsonKeys(raw: string): void {
  let index = 0;
  const fail = (): never => { throw new ActionAuthorityConfigurationError("invalid_json", "configuration JSON is malformed"); };
  const skipWhitespace = (): void => {
    while (index < raw.length && /[\u0020\u0009\u000a\u000d]/u.test(raw[index]!)) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    if (raw[index] !== '"') fail();
    index += 1;
    while (index < raw.length) {
      const character = raw[index]!;
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(raw.slice(start, index)) as string;
        } catch {
          fail();
        }
      }
      if (character === "\\") {
        index += 2;
        if (index > raw.length) fail();
        continue;
      }
      if (character < " ") fail();
      index += 1;
    }
    return fail();
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = raw[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[index] === "}") {
        index += 1;
        return;
      }
      while (index < raw.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new ActionAuthorityConfigurationError("invalid_json", "configuration JSON contains a duplicate object key");
        keys.add(key);
        skipWhitespace();
        if (raw[index] !== ":") fail();
        index += 1;
        parseValue();
        skipWhitespace();
        if (raw[index] === "}") {
          index += 1;
          return;
        }
        if (raw[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (raw[index] === "]") {
        index += 1;
        return;
      }
      while (index < raw.length) {
        parseValue();
        skipWhitespace();
        if (raw[index] === "]") {
          index += 1;
          return;
        }
        if (raw[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (character === '"') {
      parseString();
      return;
    }
    if (raw.startsWith("true", index)) {
      index += 4;
      return;
    }
    if (raw.startsWith("false", index)) {
      index += 5;
      return;
    }
    if (raw.startsWith("null", index)) {
      index += 4;
      return;
    }
    const number = raw.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (number !== undefined) {
      index += number.length;
      return;
    }
    fail();
  };

  parseValue();
  skipWhitespace();
  if (index !== raw.length) fail();
}
