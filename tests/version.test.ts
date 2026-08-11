import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CODEGRAPH_VERSION, CODE_INTEL_VERSION } from '../src/index.js';

describe('version policy', () => {
  it('tracks code-intel and CodeGraph versions independently', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
      dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies['@colbymchenry/codegraph']).toBe('1.5.0');
    expect(CODE_INTEL_VERSION).toBe(packageJson.version);
    expect(CODEGRAPH_VERSION).toBe(packageJson.dependencies['@colbymchenry/codegraph']);
    expect(packageJson.version).toBe('1.5.5');
  });
});
