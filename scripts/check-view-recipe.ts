import { readFileSync } from "node:fs";

import {
  checkProductViewRecipeSource,
  formatProductViewRecipeSourceCheck,
} from "@hob-agent/inbox-web/view-recipe-source-check";

const sourcePath = process.argv[2] ?? "examples/views/calm-household.json";

let source: string;
try {
  source = readFileSync(sourcePath, "utf8");
} catch {
  console.error("Layout recipe file is unavailable.");
  process.exitCode = 1;
  source = "";
}

if (process.exitCode !== 1) {
  const result = checkProductViewRecipeSource(source);
  const write = result.passed ? console.log : console.error;
  for (const line of formatProductViewRecipeSourceCheck(result)) write(line);
  if (!result.passed) process.exitCode = 1;
}
