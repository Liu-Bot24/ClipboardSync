import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertPackagingNode } from '../scripts/check-package-node.mjs';

for (const version of ['22.12.0', '22.22.0', '24.0.0', '24.15.0']) {
  test(`client packaging accepts Node ${version}`, () => assert.doesNotThrow(() => assertPackagingNode(version)));
}
for (const version of ['20.0.0', '22.0.0', '22.11.9', '23.0.0', '25.0.0', '26.7.0']) {
  test(`client packaging rejects unsupported Node ${version}`, () => assert.throws(() => assertPackagingNode(version), /Use Node.js/));
}
test('both client packages fail before Packager on incompatible Node without restricting the Hub runtime', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.engines.node, '>=22');
  for (const platform of ['mac', 'win']) {
    assert.match(pkg.scripts[`package:${platform}`], /^node scripts\/check-package-node\.mjs && electron-packager /);
  }
});
