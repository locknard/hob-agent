import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
  type SkillProviderObservation,
} from "@deepseek-ai/dsh-skill";

export const name = "home-skill-filesystem";
export const inject = ["skills"] as const;

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024;
const DEFAULT_MAX_SKILLS = 64;
const TENANT_SKILL_RANK = 700;
const ALLOWED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "whenToUse",
  "disable-model-invocation",
  "user-invocable",
  "metadata",
]);
const INVALID_SCALAR = Symbol("invalid-scalar");
const OPAQUE_RESOURCE_BASE = {
  kind: "opaque" as const,
  description: "Tenant skill resources are unavailable in Phase 0",
};

export interface HomeSkillProviderOptions {
  /** Absolute tenant `<household>/skills` directory. */
  readonly directory: string;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxSkills?: number;
}

interface NormalizedOptions {
  readonly directory: string;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxSkills: number;
}

interface SkillLocator {
  readonly relativePath: string;
  readonly expectedName: string;
}

interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly invocation: {
    readonly modelInvocable: boolean;
    readonly userInvocable: boolean;
  };
  readonly content: string;
}

interface ReadSkillText {
  readonly text: string;
  readonly bytes: number;
}

type ReadResult =
  | { readonly kind: "ok"; readonly value: ReadSkillText }
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe" }
  | { readonly kind: "oversized" }
  | { readonly kind: "invalid" };

type RootResult =
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe" }
  | { readonly kind: "ready"; readonly path: string };

interface DiscoveredCandidate {
  readonly candidate: SkillCandidate;
  readonly name: string;
}

/** Register the bounded tenant provider in the official DSH skill registry. */
export function apply(ctx: Context, options: HomeSkillProviderOptions): void {
  const normalized = normalizeOptions(options);
  ctx.skills.registerProvider((control) => new HomeSkillProvider(ctx, control, normalized));
}

/**
 * Tenant-local implementation of the official DSH SkillProvider contract.
 * It deliberately has no model-facing registry or loader of its own.
 */
export class HomeSkillProvider implements SkillProvider {
  readonly name = name;
  private readonly options: NormalizedOptions;

  constructor(
    _ctx: Context,
    _control: SkillProviderControl,
    options: HomeSkillProviderOptions,
  ) {
    this.options = normalizeOptions(options);
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    options.signal?.throwIfAborted();
    const root = await this.root();
    if (root.kind === "missing") return [];
    if (root.kind === "unsafe") return { candidates: [], complete: false };

    let entries;
    try {
      entries = await readdir(root.path, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if (isMissingError(error)) return [];
      throw error;
    }
    const discoveredPaths = await this.skillPaths(root.path, entries, options.signal);
    const descriptors = discoveredPaths.paths;
    const discovered: DiscoveredCandidate[] = [];
    const duplicateNames = new Set<string>();
    const nameCounts = new Map<string, number>();
    let totalBytes = 0;
    let complete = discoveredPaths.complete;

    for (const relativePath of descriptors) {
      options.signal?.throwIfAborted();
      if (discovered.length >= this.options.maxSkills) {
        complete = false;
        break;
      }
      const read = await this.readScoped(root.path, relativePath, options.signal);
      if (read.kind === "missing" || read.kind === "invalid") continue;
      if (read.kind !== "ok") {
        complete = false;
        continue;
      }
      totalBytes += read.value.bytes;
      if (totalBytes > this.options.maxTotalBytes) {
        complete = false;
        break;
      }
      const parsed = parseSkill(read.value.text);
      if (parsed === undefined) continue;
      const count = (nameCounts.get(parsed.name) ?? 0) + 1;
      nameCounts.set(parsed.name, count);
      if (count > 1) duplicateNames.add(parsed.name);
      discovered.push({
        name: parsed.name,
        candidate: this.candidate(relativePath, parsed),
      });
    }

    const candidates = discovered
      .filter((entry) => !duplicateNames.has(entry.name))
      .map((entry) => entry.candidate);
    if (duplicateNames.size > 0) complete = false;
    return complete ? candidates : { candidates, complete: false };
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    options.signal?.throwIfAborted();
    if (candidate.provider !== this.name || !isSkillName(candidate.name)) return undefined;
    const locator = asLocator(candidate.locator);
    if (locator === undefined || locator.expectedName !== candidate.name) return undefined;
    const root = await this.root();
    if (root.kind !== "ready") return undefined;
    const read = await this.readScoped(root.path, locator.relativePath, options.signal);
    if (read.kind !== "ok") return undefined;
    const parsed = parseSkill(read.value.text);
    if (parsed === undefined || parsed.name !== candidate.name) return undefined;
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
      invocation: parsed.invocation,
      source: "custom",
      provider: this.name,
      resourceBase: OPAQUE_RESOURCE_BASE,
      content: parsed.content,
    };
  }

  private async root(): Promise<RootResult> {
    try {
      const metadata = await lstat(this.options.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { kind: "unsafe" };
      const canonical = await realpath(this.options.directory);
      const canonicalMetadata = await lstat(canonical);
      if (!canonicalMetadata.isDirectory() || canonicalMetadata.isSymbolicLink()) return { kind: "unsafe" };
      return { kind: "ready", path: canonical };
    } catch (error) {
      if (isMissingError(error)) return { kind: "missing" };
      throw error;
    }
  }

  private async skillPaths(
    root: string,
    entries: readonly import("node:fs").Dirent[],
    signal?: AbortSignal,
  ): Promise<{ readonly paths: string[]; readonly complete: boolean }> {
    const paths: string[] = [];
    let complete = true;
    for (const entry of [...entries].sort((left, right) => compare(left.name, right.name))) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) {
        complete = false;
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        paths.push(entry.name);
        continue;
      }
      if (!entry.isDirectory()) {
        complete = false;
        continue;
      }
      const child = join(root, entry.name, "SKILL.md");
      try {
        const metadata = await lstat(child);
        if (metadata.isSymbolicLink()) {
          complete = false;
        } else if (metadata.isFile()) {
          paths.push(join(entry.name, "SKILL.md"));
        }
      } catch (error) {
        if (!isMissingError(error)) throw error;
      }
    }
    return { paths: paths.sort(compare), complete };
  }

  private candidate(relativePath: string, parsed: ParsedSkill): SkillCandidate {
    const locator: SkillLocator = {
      relativePath,
      expectedName: parsed.name,
    };
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
      invocation: parsed.invocation,
      source: "custom",
      provider: this.name,
      rank: TENANT_SKILL_RANK,
      locator,
      resourceBase: OPAQUE_RESOURCE_BASE,
    };
  }

  private async readScoped(root: string, relativePath: string, signal?: AbortSignal): Promise<ReadResult> {
    const safePath = containedRelativePath(root, relativePath);
    if (safePath === undefined || !isAllowedSkillPath(safePath)) return { kind: "unsafe" };
    let current = root;
    try {
      for (const segment of safePath.split(sep)) {
        current = join(current, segment);
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) return { kind: "unsafe" };
      }
      const canonical = await realpath(current);
      if (containedRelativePath(root, canonical) === undefined) return { kind: "unsafe" };
      return await readBoundedText(canonical, this.options.maxFileBytes, signal);
    } catch (error) {
      if (isMissingError(error)) return { kind: "missing" };
      if (isSymlinkError(error)) return { kind: "unsafe" };
      throw error;
    }
  }
}

function normalizeOptions(options: HomeSkillProviderOptions): NormalizedOptions {
  if (options === undefined || typeof options.directory !== "string" || !isAbsolute(options.directory)) {
    throw new TypeError("Home skill directory must be absolute");
  }
  return {
    directory: resolve(options.directory),
    maxFileBytes: positiveLimit(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
    maxTotalBytes: positiveLimit(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes"),
    maxSkills: positiveLimit(options.maxSkills ?? DEFAULT_MAX_SKILLS, "maxSkills"),
  };
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Home skill ${name} must be a positive integer`);
  return value;
}

async function readBoundedText(path: string, maxBytes: number, signal?: AbortSignal): Promise<ReadResult> {
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { kind: "unsafe" };
    if (metadata.size > maxBytes) return { kind: "oversized" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) return { kind: "oversized" };
    try {
      return {
        kind: "ok",
        value: {
          text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)),
          bytes: offset,
        },
      };
    } catch {
      return { kind: "invalid" };
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingError(error)) return { kind: "missing" };
    if (isSymlinkError(error)) return { kind: "unsafe" };
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseSkill(raw: string): ParsedSkill | undefined {
  const firstLineEnd = raw.indexOf("\n");
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return undefined;
  const start = firstLineEnd + 1;
  let lineStart = start;
  let closingStart = -1;
  let closingBodyStart = -1;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
      closingStart = lineStart;
      closingBodyStart = nextNewline < 0 ? raw.length : nextNewline + 1;
      break;
    }
    if (nextNewline < 0) break;
    lineStart = nextNewline + 1;
  }
  if (closingStart < 0) return undefined;
  const fields = parseFrontmatterFields(raw.slice(start, closingStart));
  if (fields === undefined) return undefined;
  if (["disableModelInvocation", "modelInvocable", "userInvocable"].some((key) => Object.hasOwn(fields, key))) {
    return undefined;
  }
  const skillName = stringField(fields.name);
  const description = stringField(fields.description);
  if (skillName === undefined || description === undefined || !isSkillName(skillName)) return undefined;
  const disableModelInvocation = booleanField(fields["disable-model-invocation"]);
  const userInvocable = booleanField(fields["user-invocable"]);
  if (disableModelInvocation === "invalid" || userInvocable === "invalid") return undefined;
  const whenToUse = stringField(fields.whenToUse);
  return {
    name: skillName,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    ...(isRecord(fields.metadata) ? { metadata: fields.metadata } : {}),
    invocation: {
      modelInvocable: disableModelInvocation !== true,
      userInvocable: userInvocable !== false,
    },
    content: raw.slice(closingBodyStart).trim(),
  };
}

function parseFrontmatterFields(raw: string): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {};
  let nestedKey: string | undefined;
  let nestedMetadata: Record<string, unknown> | undefined;
  const nestedKeys = new Set<string>();
  for (const line of raw.split("\n")) {
    const normalized = line.replace(/\r$/, "");
    if (normalized !== normalized.trimStart()) {
      if (
        nestedKey !== "metadata"
        || !normalized.startsWith("  ")
        || normalized[2] === " "
        || normalized[2] === "\t"
      ) return undefined;
      if (normalized.trim().length === 0 || normalized.trimStart().startsWith("#")) continue;
      const nested = normalized.trim();
      const separator = nested.indexOf(":");
      if (separator <= 0) return undefined;
      const key = nested.slice(0, separator).trim();
      if (!isFieldName(key) || nestedKeys.has(key)) return undefined;
      const value = parseScalar(nested.slice(separator + 1).trim());
      if (value === INVALID_SCALAR) return undefined;
      nestedMetadata ??= {};
      nestedKeys.add(key);
      nestedMetadata[key] = value;
      continue;
    }
    if (normalized.trim().length === 0 || normalized.startsWith("#")) continue;
    const separator = normalized.indexOf(":");
    if (separator <= 0 || normalized.slice(0, separator).trim() !== normalized.slice(0, separator)) return undefined;
    const key = normalized.slice(0, separator).trim();
    if (!isFieldName(key) || !ALLOWED_FRONTMATTER_KEYS.has(key) || Object.hasOwn(fields, key)) return undefined;
    const value = parseScalar(normalized.slice(separator + 1).trim());
    if (value === INVALID_SCALAR) return undefined;
    if (key === "metadata" && value !== "" && !isRecord(value)) return undefined;
    fields[key] = value;
    nestedKey = key === "metadata" && value === "" ? key : undefined;
  }
  if (nestedMetadata !== undefined) fields.metadata = nestedMetadata;
  return fields;
}

function parseScalar(value: string): unknown {
  const normalized = stripInlineComment(value);
  if (normalized === "") return "";
  if (normalized === "null" || normalized === "~") return null;
  if (normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "false" || normalized === "no" || normalized === "off") return false;
  if (normalized.startsWith("\"") && normalized.endsWith("\"")) {
    try {
      return JSON.parse(normalized);
    } catch {
      return INVALID_SCALAR;
    }
  }
  if (normalized.startsWith("'") && normalized.endsWith("'")) return normalized.slice(1, -1).replace(/''/g, "'");
  if (normalized.startsWith("{") || normalized.startsWith("[")) {
    if (normalized.startsWith("{") && hasDuplicateJsonKeys(normalized)) return INVALID_SCALAR;
    try {
      return JSON.parse(normalized);
    } catch {
      return INVALID_SCALAR;
    }
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  if (normalized === "|" || normalized === ">") return INVALID_SCALAR;
  return normalized;
}

function hasDuplicateJsonKeys(value: string): boolean {
  const keys = new Set<string>();
  const keyPattern = /"((?:\\.|[^"\\])*)"\s*:/g;
  for (const match of value.matchAll(keyPattern)) {
    let key: string;
    try {
      key = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return true;
    }
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

function stripInlineComment(value: string): string {
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === "\"" && quote !== "single") quote = quote === "double" ? undefined : "double";
    else if (character === "'" && quote !== "double") quote = quote === "single" ? undefined : "single";
    else if (character === "#" && quote === undefined && value[index - 1] === " ") return value.slice(0, index).trimEnd();
  }
  return value;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(value);
}

function booleanField(value: unknown): boolean | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "1" || value === 1) return true;
  if (value === "0" || value === 0) return false;
  return "invalid";
}

function asLocator(value: unknown): SkillLocator | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("relativePath" in value) || !("expectedName" in value)) return undefined;
  const locator = value as { relativePath?: unknown; expectedName?: unknown };
  if (typeof locator.relativePath !== "string" || typeof locator.expectedName !== "string") return undefined;
  return { relativePath: locator.relativePath, expectedName: locator.expectedName };
}

function containedRelativePath(root: string, path: string): string | undefined {
  const child = relative(root, resolve(root, path));
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined;
  return child;
}

function isAllowedSkillPath(path: string): boolean {
  const segments = path.split(sep);
  return (segments.length === 1 && segments[0]?.endsWith(".md") === true)
    || (segments.length === 2 && segments[1] === "SKILL.md");
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function isSymlinkError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ELOOP";
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
