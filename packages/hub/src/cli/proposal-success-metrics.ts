import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import {
  readProposalSuccessMetricsFromPath,
  type ProposalSuccessMetricsResult,
} from "../home/proposal-success-metrics.js";

export const PROPOSAL_SUCCESS_METRICS_EXIT_CODES = Object.freeze({
  metrics: 0,
  insufficientEvidence: 2,
  invalidArguments: 1,
} as const);

export type ProposalSuccessMetricsEnvironment = Readonly<Record<string, string | undefined>>;

/** Parses one explicit observation boundary; the reader never chooses a hidden historical cutoff. */
export function parseProposalSuccessMetricsArgs(
  args: readonly string[],
): { readonly asOf: string } {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.length === 0 || normalized[0] !== "--as-of") throw new TypeError("--as-of is required");
  if (normalized.length < 2) throw new TypeError("--as-of is required");
  if (normalized.length > 2) throw new TypeError("unknown argument");
  const asOf = normalized[1];
  if (typeof asOf !== "string" || !Number.isFinite(Date.parse(asOf))) throw new TypeError("invalid as-of");
  return { asOf };
}

/** Reads only HOB_DATA_DIR/proposals.sqlite through the read-only metrics seam. */
export function readProposalSuccessMetrics(
  environment: ProposalSuccessMetricsEnvironment,
  asOf: string,
): ProposalSuccessMetricsResult {
  const dataDirectory = environment.HOB_DATA_DIR;
  const proposalPath = typeof dataDirectory === "string" ? join(dataDirectory, "proposals.sqlite") : "";
  return readProposalSuccessMetricsFromPath(proposalPath, asOf);
}

function isMainModule(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath);
}

if (isMainModule()) {
  try {
    const { asOf } = parseProposalSuccessMetricsArgs(process.argv.slice(2));
    const result = readProposalSuccessMetrics(process.env, asOf);
    console.log(JSON.stringify(result));
    if (result.outcome === "insufficient_evidence") process.exitCode = PROPOSAL_SUCCESS_METRICS_EXIT_CODES.insufficientEvidence;
  } catch {
    console.error("hob-agent proposal success metrics requires one valid --as-of timestamp");
    process.exitCode = PROPOSAL_SUCCESS_METRICS_EXIT_CODES.invalidArguments;
  }
}
