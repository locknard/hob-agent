import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 3 * MAX_FILE_BYTES;

export interface HouseholdPromptContext {
  readonly soul: string;
  readonly home: string;
  readonly memory: string;
}

/** Loads the bounded startup snapshot consumed by DSH's prompt registry. */
export async function loadHouseholdPromptContext(
  directory: string,
): Promise<HouseholdPromptContext> {
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw new Error("Household prompt directory must be absolute");
  }

  const [soul, home, memory] = await Promise.all([
    readContribution(directory, "SOUL.md"),
    readContribution(directory, "HOME.md"),
    readContribution(directory, "MEMORY.md"),
  ]);
  const total = Buffer.byteLength(soul) + Buffer.byteLength(home) + Buffer.byteLength(memory);
  if (total > MAX_TOTAL_BYTES) throw invalidFile();
  return Object.freeze({ soul, home, memory });
}

async function readContribution(directory: string, name: string): Promise<string> {
  try {
    const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) throw invalidFile();
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_FILE_BYTES) throw invalidFile();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0") || text.includes("{{") || text.includes("}}")) throw invalidFile();
      return text.trim();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof HouseholdPromptFileError) throw error;
    throw invalidFile();
  }
}

class HouseholdPromptFileError extends Error {
  constructor() {
    super("Household prompt file is missing, unsafe, invalid, or too large");
    this.name = "HouseholdPromptFileError";
  }
}

function invalidFile(): HouseholdPromptFileError {
  return new HouseholdPromptFileError();
}
