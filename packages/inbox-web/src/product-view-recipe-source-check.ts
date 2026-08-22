import { runProductViewRecipeConformance } from "./product-view-recipe-conformance.js";

const MAX_RECIPE_SOURCE_BYTES = 64 * 1_024;

export type ProductViewRecipeSourceCheck =
  | Readonly<{
      passed: true;
      recipeId: string;
      recipeDigest: `sha256:${string}`;
      passedChecks: number;
      totalChecks: number;
    }>
  | Readonly<{
      passed: false;
      reason: "source_too_large" | "syntax_invalid" | "recipe_invalid";
    }>;

/** Checks inert recipe text without returning submitted content or parser errors. */
export function checkProductViewRecipeSource(source: string): ProductViewRecipeSourceCheck {
  if (Buffer.byteLength(source, "utf8") > MAX_RECIPE_SOURCE_BYTES) {
    return Object.freeze({ passed: false, reason: "source_too_large" });
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    return Object.freeze({ passed: false, reason: "syntax_invalid" });
  }

  const report = runProductViewRecipeConformance(input);
  if (!report.passed || report.recipeId === undefined || report.recipeDigest === undefined) {
    return Object.freeze({ passed: false, reason: "recipe_invalid" });
  }
  return Object.freeze({
    passed: true,
    recipeId: report.recipeId,
    recipeDigest: report.recipeDigest,
    passedChecks: report.checks.filter(({ status }) => status === "passed").length,
    totalChecks: report.checks.length,
  });
}

/** Formats a stable local-developer result without reflecting recipe content. */
export function formatProductViewRecipeSourceCheck(result: ProductViewRecipeSourceCheck): readonly string[] {
  if (result.passed) {
    return Object.freeze([
      `Layout recipe ready: ${result.recipeId}`,
      `Digest: ${result.recipeDigest}`,
      `Conformance: ${result.passedChecks}/${result.totalChecks} passed`,
    ]);
  }
  switch (result.reason) {
    case "source_too_large": return Object.freeze(["Layout recipe must fit within 64 KiB."]);
    case "syntax_invalid": return Object.freeze(["Layout recipe needs valid JSON."]);
    case "recipe_invalid": return Object.freeze(["Layout recipe needs a supported data-only structure."]);
  }
}
