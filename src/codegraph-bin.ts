import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export function resolveCodeGraphBin(): string {
  const packageJsonPath = require.resolve('@colbymchenry/codegraph/package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.codegraph;
  if (!bin) throw new Error('The installed CodeGraph package does not expose a codegraph bin');
  return join(dirname(packageJsonPath), bin);
}
