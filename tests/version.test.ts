import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CODE_INTEL_VERSION } from '../src/version.js';

describe('version policy', () => {
  it('matches the exact CodeGraph dependency version', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
      dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies['@colbymchenry/codegraph']).toBe('1.5.0');
    expect(packageJson.version).toBe(packageJson.dependencies['@colbymchenry/codegraph']);
    expect(CODE_INTEL_VERSION).toBe(packageJson.version);
  });
});
