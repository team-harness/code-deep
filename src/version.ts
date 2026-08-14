import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as {
  version: string;
  dependencies: Record<string, string>;
};

export const CODE_DEEP_VERSION = packageJson.version;
export const CODEGRAPH_VERSION = packageJson.dependencies['@colbymchenry/codegraph'];
