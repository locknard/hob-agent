import { z } from "zod";

import {
  adapterRegistrationSchema,
  bridgeControlSchema,
  bridgeInfoSchema,
  bridgeStreamErrorSchema,
  canonicalExtensionKey,
  controlResultSchema,
  credentialMaterialSchema,
  envelopeSchema,
  normalizeBridgeStreamError,
  type AdapterRegistration,
  type BridgeAdapter,
  type BridgeCredentialProvider,
  type BridgeStreamErrorReason,
  type ControlResult,
} from "./bridge-contract.js";

/**
 * Harness-only public seam check. Adapter implementations may be classes with
 * private runtime fields, so project the four contract members before applying
 * a strict shape; this does not alter the frozen bridgeAdapterSchema.
 */
const publicBridgeAdapterSchema = z.object({
  info: bridgeInfoSchema,
  events: z.custom<BridgeAdapter["events"]>((value) => typeof value === "function"),
  control: bridgeControlSchema,
  extension: z.custom<BridgeAdapter["extension"]>((value) => typeof value === "function"),
}).strict();

/** Exact strings are preferred; regular expressions support adapters whose
 * snapshot IDs intentionally include a process-local monotonic component. */
export type ReplayIdentityExpectation = string | RegExp;

export interface ReplayExpectation {
  readonly epochId: ReplayIdentityExpectation;
  readonly snapshotId: ReplayIdentityExpectation;
  readonly remoteInstanceId: ReplayIdentityExpectation;
  readonly deviceEnvelopeCount: number;
  readonly stateEnvelopeCount: number;
}

export interface ExtensionHandleExpectation {
  readonly key: string;
  readonly available: boolean;
}

export interface StreamErrorExpectation {
  readonly reason: BridgeStreamErrorReason;
  readonly probe: (adapter: BridgeAdapter) => Promise<unknown>;
}

export interface ResyncExpectation {
  readonly result?: ControlResult;
}

export interface BridgeAdapterConformanceInput<C> {
  readonly registration: AdapterRegistration<C>;
  readonly adapterType: string;
  readonly bridgeId: string;
  readonly config: unknown;
  readonly credentials: BridgeCredentialProvider;
  readonly replay: ReplayExpectation;
  readonly coreMajor?: number;
  readonly extensionHandles?: readonly ExtensionHandleExpectation[];
  readonly streamError?: StreamErrorExpectation;
  readonly resync?: ResyncExpectation;
  readonly maxReplayEnvelopes?: number;
}

export type BridgeAdapterConformanceCheckName =
  | "registration-schema"
  | "registration-identity"
  | "config-schema"
  | "factory-sync"
  | "factory-purity"
  | "adapter-schema"
  | "credential-scope"
  | "stream-replay"
  | "extension-handles"
  | "stream-error"
  | "resync"
  | "dispose";

export interface BridgeAdapterConformanceCheck {
  readonly name: BridgeAdapterConformanceCheckName;
  readonly passed: boolean;
}

export interface BridgeAdapterConformanceReport {
  readonly passed: boolean;
  readonly checks: readonly BridgeAdapterConformanceCheck[];
}

/**
 * Contract-only conformance seam. It intentionally does not ingest, journal,
 * reduce, or manage adapter lifecycle beyond the probes named by the input.
 */
export async function runBridgeAdapterConformance<C>(
  input: BridgeAdapterConformanceInput<C>,
): Promise<BridgeAdapterConformanceReport> {
  const checks: BridgeAdapterConformanceCheck[] = [];
  const addCheck = (name: BridgeAdapterConformanceCheckName, passed: boolean): number => {
    checks.push({ name, passed });
    return checks.length - 1;
  };
  const setCheck = (index: number, passed: boolean): void => {
    const previous = checks[index];
    if (previous !== undefined) checks[index] = { ...previous, passed };
  };
  const disposeResults: boolean[] = [];
  const finish = (): BridgeAdapterConformanceReport => {
    addCheck("dispose", disposeResults.every((passed) => passed));
    return report(checks);
  };

  const registrationResult = safeParseResult(adapterRegistrationSchema, input.registration);
  addCheck("registration-schema", registrationResult.success);
  if (!registrationResult.success) return finish();

  const registrationIdentityIndex = addCheck(
    "registration-identity",
    nonEmptyString(input.bridgeId) && input.adapterType === input.registration.adapterType,
  );
  const expectedCoreMajor = input.coreMajor ?? 6;

  const configResult = safeParseResult(input.registration.configSchema, input.config);
  addCheck("config-schema", configResult.success);
  if (!configResult.success) return finish();

  let credentialReadCount = 0;
  let credentialBoundaryViolation = false;
  const credentialReadAliases = new Set<string>();
  const credentialRequirements = new Map(
    input.registration.credentialRequirements.map((requirement) => [requirement.alias, requirement.kind]),
  );
  const scopedCredentials: BridgeCredentialProvider = {
    resolve: async (alias) => {
      credentialReadCount += 1;
      credentialReadAliases.add(alias);
      const requiredKind = credentialRequirements.get(alias);
      if (requiredKind === undefined) {
        credentialBoundaryViolation = true;
        return undefined;
      }
      const material = await input.credentials.resolve(alias);
      if (material !== undefined) {
        const parsed = credentialMaterialSchema.safeParse(material);
        if (!parsed.success || parsed.data.kind !== requiredKind) {
          credentialBoundaryViolation = true;
          return undefined;
        }
      }
      return material;
    },
    describe: async (alias) => {
      credentialReadCount += 1;
      credentialReadAliases.add(alias);
      if (!credentialRequirements.has(alias)) {
        credentialBoundaryViolation = true;
        return { configured: false };
      }
      const description = await input.credentials.describe(alias);
      if (typeof description?.configured !== "boolean") {
        credentialBoundaryViolation = true;
        return { configured: false };
      }
      return description;
    },
  };
  const construct = (): ConstructionResult => {
    const readsBefore = credentialReadCount;
    try {
      const created = input.registration.factory({
        bridgeId: input.bridgeId,
        config: configResult.value as C,
        credentials: scopedCredentials,
      });
      if (isPromiseLike(created)) {
        return { synchronous: false, pure: credentialReadCount === readsBefore };
      }
      if (created === null || typeof created !== "object") {
        return { synchronous: true, pure: credentialReadCount === readsBefore };
      }
      return {
        synchronous: true,
        pure: credentialReadCount === readsBefore,
        adapter: created as BridgeAdapter,
      };
    } catch {
      return { synchronous: true, pure: credentialReadCount === readsBefore };
    }
  };

  const primary = construct();
  addCheck("factory-sync", primary.synchronous && primary.adapter !== undefined);
  const factoryPurityIndex = addCheck("factory-purity", primary.pure);
  const adapterSchemaIndex = addCheck(
    "adapter-schema",
    primary.adapter !== undefined && safeParseSuccess(publicBridgeAdapterSchema, publicAdapterShape(primary.adapter)),
  );
  if (primary.adapter === undefined) return finish();

  const info = primary.adapter.info;
  setCheck(
    registrationIdentityIndex,
    checks[registrationIdentityIndex]?.passed === true
      && info.bridgeId === input.bridgeId
      && !Object.prototype.hasOwnProperty.call(info, "adapterType")
      && majorOf(info.coreVersion) === expectedCoreMajor,
  );
  if (!checks[adapterSchemaIndex]?.passed) {
    disposeResults.push(await disposeAdapter(primary.adapter));
    return finish();
  }

  const credentialPassed = await checkCredentialScope(input);
  const credentialScopeIndex = addCheck("credential-scope", credentialPassed);

  const replayPassed = await checkReplay(primary.adapter, input.replay, input.maxReplayEnvelopes);
  addCheck("stream-replay", replayPassed);

  const extensionsPassed = checkExtensionHandles(primary.adapter, input.extensionHandles);
  addCheck("extension-handles", extensionsPassed);
  disposeResults.push(await disposeAdapter(primary.adapter));

  if (input.streamError !== undefined) {
    const errorAdapter = construct();
    setCheck(factoryPurityIndex, checks[factoryPurityIndex]?.passed === true && errorAdapter.pure);
    const streamErrorPassed = errorAdapter.adapter === undefined
      ? false
      : await checkStreamError(errorAdapter.adapter, input.streamError);
    addCheck("stream-error", streamErrorPassed);
    if (errorAdapter.adapter !== undefined) disposeResults.push(await disposeAdapter(errorAdapter.adapter));
  }

  const controlAdapter = construct();
  setCheck(factoryPurityIndex, checks[factoryPurityIndex]?.passed === true && controlAdapter.pure);
  let resyncPassed = false;
  if (controlAdapter.adapter !== undefined) {
    try {
      const result = await controlAdapter.adapter.control.requestResync(new AbortController().signal);
      const parsed = controlResultSchema.safeParse(result);
      resyncPassed = parsed.success
        && (input.resync?.result === undefined || sameControlResult(parsed.data, input.resync.result));
    } catch {
      resyncPassed = false;
    }
    disposeResults.push(await disposeAdapter(controlAdapter.adapter));
  }
  addCheck("resync", resyncPassed);
  if (controlAdapter.adapter === undefined) disposeResults.push(false);
  const allCredentialReadsDeclared = [...credentialReadAliases]
    .every((alias) => credentialRequirements.has(alias));
  setCheck(credentialScopeIndex, credentialPassed && !credentialBoundaryViolation && allCredentialReadsDeclared);
  return finish();
}

interface ConstructionResult {
  readonly synchronous: boolean;
  readonly pure: boolean;
  readonly adapter?: BridgeAdapter;
}

function publicAdapterShape(adapter: BridgeAdapter): unknown {
  return {
    info: adapter.info,
    events: adapter.events,
    control: adapter.control,
    extension: adapter.extension,
  };
}

function report(checks: readonly BridgeAdapterConformanceCheck[]): BridgeAdapterConformanceReport {
  return { passed: checks.every((check) => check.passed), checks: [...checks] };
}

interface SafeParseResult {
  readonly success: boolean;
  readonly value?: unknown;
}

function safeParseResult(schema: { safeParse(value: unknown): { success: boolean; data?: unknown } }, value: unknown): SafeParseResult {
  try {
    const result = schema.safeParse(value);
    return result.success ? { success: true, value: result.data } : { success: false };
  } catch {
    return { success: false };
  }
}

function safeParseSuccess(schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean {
  return safeParseResult(schema, value).success;
}

async function checkCredentialScope<C>(
  input: BridgeAdapterConformanceInput<C>,
): Promise<boolean> {
  const aliases = new Set<string>();
  for (const requirement of input.registration.credentialRequirements) {
    if (aliases.has(requirement.alias)) return false;
    aliases.add(requirement.alias);
    try {
      const description = await input.credentials.describe(requirement.alias);
      if (typeof description?.configured !== "boolean") return false;
      const material = await input.credentials.resolve(requirement.alias);
      if (material !== undefined) {
        const parsed = credentialMaterialSchema.safeParse(material);
        if (!parsed.success || parsed.data.kind !== requirement.kind) return false;
      }
    } catch {
      return false;
    }
  }

  let unknownAlias = "__conformance_unknown__";
  while (aliases.has(unknownAlias)) unknownAlias = `${unknownAlias}_x`;
  try {
    const description = await input.credentials.describe(unknownAlias);
    const material = await input.credentials.resolve(unknownAlias);
    return description?.configured === false && material === undefined;
  } catch {
    return false;
  }
}

async function checkReplay(
  adapter: BridgeAdapter,
  expected: ReplayExpectation,
  configuredMaximum: number | undefined,
): Promise<boolean> {
  const maximum = configuredMaximum ?? 1_024;
  if (!Number.isSafeInteger(maximum) || maximum < 1) return false;
  let nextSeq = 1;
  let deviceEnvelopeCount = 0;
  let stateEnvelopeCount = 0;
  let started = false;
  let completed = false;
  let seen = 0;
  try {
    const stream = adapter.events(new AbortController().signal);
    if (stream === null || typeof stream !== "object" || typeof stream[Symbol.asyncIterator] !== "function") {
      return false;
    }
    for await (const candidate of stream) {
      seen += 1;
      if (seen > maximum) return false;
      const parsed = envelopeSchema.safeParse(candidate);
      if (!parsed.success) return false;
      const envelope = parsed.data;
      if (!matchesReplayIdentity(expected.epochId, envelope.epochId) || envelope.seq !== nextSeq) return false;
      nextSeq += 1;
      if (!started) {
        if (envelope.event.kind !== "sync-start"
          || !matchesReplayIdentity(expected.snapshotId, envelope.event.snapshotId)
          || !matchesReplayIdentity(expected.remoteInstanceId, envelope.event.remoteInstanceId)) return false;
        started = true;
      } else if (envelope.event.kind === "sync-start") {
        return false;
      }
      if (envelope.event.kind === "device-upserted") deviceEnvelopeCount += 1;
      if (envelope.event.kind === "state") stateEnvelopeCount += 1;
      if (envelope.event.kind === "sync-complete") {
        completed = matchesReplayIdentity(expected.snapshotId, envelope.event.manifest.snapshotId)
          && envelope.event.manifest.deviceEnvelopeCount === deviceEnvelopeCount
          && envelope.event.manifest.stateEnvelopeCount === stateEnvelopeCount
          && deviceEnvelopeCount === expected.deviceEnvelopeCount
          && stateEnvelopeCount === expected.stateEnvelopeCount;
        break;
      }
    }
  } catch {
    return false;
  }
  return started && completed;
}

function matchesReplayIdentity(expected: ReplayIdentityExpectation, actual: string): boolean {
  if (typeof expected === "string") return actual === expected;
  expected.lastIndex = 0;
  return expected.test(actual);
}

function checkExtensionHandles(
  adapter: BridgeAdapter,
  expectations: readonly ExtensionHandleExpectation[] | undefined,
): boolean {
  const expected = new Map((expectations ?? []).map((item) => [item.key, item.available]));
  const declaredKeys = new Set<string>();
  try {
    for (const declaration of adapter.info.extensions) {
      const key = canonicalExtensionKey(declaration);
      declaredKeys.add(key);
      const expectedAvailability = expected.get(key);
      if (expectedAvailability === undefined) return false;
      const available = adapter.extension(key as never) !== undefined;
      if (available !== expectedAvailability) return false;
    }
    for (const key of expected.keys()) {
      if (!declaredKeys.has(key)) return false;
    }
    let unknownKey = "conformance-unknown@999";
    while (declaredKeys.has(unknownKey)) unknownKey = `${unknownKey}_x`;
    return adapter.extension(unknownKey as never) === undefined;
  } catch {
    return false;
  }
}

async function checkStreamError(
  adapter: BridgeAdapter,
  expectation: StreamErrorExpectation,
): Promise<boolean> {
  try {
    await expectation.probe(adapter);
    return false;
  } catch (error) {
    const normalized = normalizeBridgeStreamError(error);
    return normalized.reason === expectation.reason
      && bridgeStreamErrorSchema.safeParse({ reason: normalized.reason, message: normalized.message }).success;
  }
}

function sameControlResult(left: ControlResult, right: ControlResult): boolean {
  return left.status === right.status
    && left.reason === right.reason
    && left.adapterCode === right.adapterCode
    && left.detail === right.detail;
}

async function disposeAdapter(adapter: BridgeAdapter): Promise<boolean> {
  try {
    await adapter.control.dispose();
    return true;
  } catch {
    return false;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object"
    && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

function majorOf(version: string): number | undefined {
  const match = /^(\d+)\./.exec(version);
  return match === null ? undefined : Number(match[1]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
