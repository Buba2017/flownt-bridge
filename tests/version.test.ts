import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { BRIDGE_VERSION } from '../src/version.js';

test('bridge version comes from package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
  assert.equal(BRIDGE_VERSION, pkg.version);
});
