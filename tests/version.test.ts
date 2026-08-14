import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CODEGRAPH_VERSION, CODE_DEEP_VERSION } from '../src/index.js';

describe('version policy', () => {
  it('tracks code-deep and CodeGraph versions independently', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
      dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies['@colbymchenry/codegraph']).toBe('1.5.0');
    expect(packageJson.name).toBe('@team-harness/code-deep');
    expect(CODE_DEEP_VERSION).toBe(packageJson.version);
    expect(CODEGRAPH_VERSION).toBe(packageJson.dependencies['@colbymchenry/codegraph']);

    const compatibilityPackage = JSON.parse(
      await readFile(new URL('../compat/code-intel/package.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(compatibilityPackage.version).toBe(packageJson.version);
    expect(compatibilityPackage.bin).toEqual({ 'code-deep': 'cli.js' });
    expect(compatibilityPackage.dependencies['@team-harness/code-deep']).toBe(packageJson.version);
  });
});
