import {
  createNeutralDryRunAttestation,
  parseArtifactCompileAttestation,
  type ArtifactCompileAttestation,
  type NeutralDryRunAttestation,
} from "./artifact-compiler-contract.js";

/** A dry-run has one input: the immutable result of the neutral compiler. */
export type NeutralDryRunProducer = (compile: ArtifactCompileAttestation) => NeutralDryRunAttestation;

export function produceNeutralDryRun(compile: ArtifactCompileAttestation): NeutralDryRunAttestation {
  const parsed = parseArtifactCompileAttestation(compile);
  const status: NeutralDryRunAttestation["status"] = parsed.status === "unavailable"
    ? "unavailable"
    : parsed.status === "rejected"
      ? "failed"
      : parsed.diff.status !== "unavailable" && parsed.conflicts.status === "none"
        ? "passed"
        : "failed";
  const summary = status === "passed"
    ? "Neutral dry-run passed; no writes were performed."
    : status === "unavailable"
      ? "Neutral dry-run was unavailable because compile dependencies were unavailable."
      : "Neutral dry-run failed; no writes were performed.";

  return createNeutralDryRunAttestation({
    compile: parsed,
    status,
    diff: parsed.diff,
    conflicts: parsed.conflicts,
    summary,
  });
}

export const neutralDryRunProducer: NeutralDryRunProducer = produceNeutralDryRun;
