#!/usr/bin/env node
// Prints the name of the release asset for the current index format (used by publish-index.sh).
import { bundleName } from './lib/index-format.mjs';
console.log(bundleName());
