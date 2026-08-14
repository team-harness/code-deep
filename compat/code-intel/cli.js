#!/usr/bin/env node

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packagePath = require.resolve('@team-harness/code-deep/package.json');
await import(pathToFileURL(join(dirname(packagePath), 'dist', 'cli.js')).href);
