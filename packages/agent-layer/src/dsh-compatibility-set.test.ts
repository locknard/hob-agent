import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DSH_COMPATIBILITY_SET,
  DSH_COMPATIBILITY_SET_VERSION,
  assertDshCompatibilitySet,
} from './dsh-compatibility-set.js';

describe('DSH compatibility set', () => {
  it('gates the agent-layer dependency declarations to the exact set', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    assertDshCompatibilitySet(packageJson.dependencies ?? {});
  });

  it('accepts the complete exact package set', () => {
    assert.equal(
      DSH_COMPATIBILITY_SET['@deepseek-ai/dsh-llm-pi-ai'],
      DSH_COMPATIBILITY_SET_VERSION,
    );
    assert.equal(
      DSH_COMPATIBILITY_SET['@deepseek-ai/dsh-session-persistence-sqlite'],
      DSH_COMPATIBILITY_SET_VERSION,
    );
    assert.equal(
      DSH_COMPATIBILITY_SET['@deepseek-ai/dsh-skill'],
      DSH_COMPATIBILITY_SET_VERSION,
    );
    assert.equal(
      DSH_COMPATIBILITY_SET['@deepseek-ai/dsh-tool-skill'],
      DSH_COMPATIBILITY_SET_VERSION,
    );
    assert.doesNotThrow(() =>
      assertDshCompatibilitySet(DSH_COMPATIBILITY_SET),
    );
  });

  it('rejects a mixed DSH release family', () => {
    const mixed = {
      ...DSH_COMPATIBILITY_SET,
      '@deepseek-ai/dsh-agent': '0.1.0-rc.6',
    };

    assert.throws(
      () => assertDshCompatibilitySet(mixed),
      /@deepseek-ai\/dsh-agent: expected 0\.1\.0-rc\.7, received 0\.1\.0-rc\.6/,
    );
  });

  it('rejects ranges and missing required peers', () => {
    const incomplete = {
      ...DSH_COMPATIBILITY_SET,
      '@deepseek-ai/dsh-llm': '^0.1.0-rc.7',
    };
    delete incomplete['@deepseek-ai/dsh-timeout'];

    assert.throws(
      () => assertDshCompatibilitySet(incomplete),
      /@deepseek-ai\/dsh-llm: expected 0\.1\.0-rc\.7, received \^0\.1\.0-rc\.7; @deepseek-ai\/dsh-timeout: expected 0\.1\.0-rc\.7, received missing/,
    );
  });
});
