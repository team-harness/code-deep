import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

export const CODE_INTEL_VERSION = packageJson.version;
