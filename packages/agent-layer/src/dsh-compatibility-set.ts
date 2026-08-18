/**
 * The DSH release family used by the production runtime.
 *
 * DSH publishes the core as several packages with peer dependencies. Keeping
 * the family in one exact map prevents pnpm/npm range resolution from silently
 * combining incompatible preview releases.
 */
export const DSH_COMPATIBILITY_SET_VERSION = '0.1.0-rc.7' as const;

export const DSH_COMPATIBILITY_SET = {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-agent': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-agent-loop': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-attachment': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-brand': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-code-runtime': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-commands': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-compaction': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-compaction-basic': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-credentials': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-invariants': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-launch-environment': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-llm': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-llm-pi-ai': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-repeat-tool-reminder': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-scope': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-session': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-session-projection': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-session-persistence': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-session-persistence-sqlite': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-settings': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-skill': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-system-prompt': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-timeout': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-token-meter': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-tools': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-tool-skill': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-typert-protocol': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/dsh-user-approval': DSH_COMPATIBILITY_SET_VERSION,
  '@deepseek-ai/schemastery': '3.18.1',
} as const;

export type DshCompatibilitySet = typeof DSH_COMPATIBILITY_SET;
export type DshDependencyMap = Readonly<Record<string, string | undefined>>;

/**
 * Assert that a package's resolved dependency declarations are one exact DSH
 * compatibility set. Ranges, missing peers, and untracked DSH packages fail
 * closed so a preview release cannot be mixed accidentally.
 */
export function assertDshCompatibilitySet(
  dependencies: DshDependencyMap,
  expected: DshDependencyMap = DSH_COMPATIBILITY_SET,
): asserts dependencies is DshCompatibilitySet {
  const mismatches: string[] = [];

  for (const packageName of Object.keys(expected).sort()) {
    const expectedVersion = expected[packageName];
    const receivedVersion = dependencies[packageName];
    if (receivedVersion !== expectedVersion) {
      mismatches.push(
        `${packageName}: expected ${expectedVersion}, received ${receivedVersion ?? 'missing'}`,
      );
    }
  }

  for (const packageName of Object.keys(dependencies).sort()) {
    if (
      packageName.startsWith('@deepseek-ai/dsh-') &&
      !(packageName in expected)
    ) {
      mismatches.push(`${packageName}: unexpected package`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`DSH compatibility set mismatch: ${mismatches.join('; ')}`);
  }
}
