// Would `npm publish` ship the right files?
//
// The allow-list is read from package.json rather than restated here: a second
// copy is a second thing to forget. This asserts three things the manifest
// alone cannot - that nothing escapes the allow-list, that the pieces the
// package is useless without are present, and that the tests stay out.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const allowed = [...manifest.files, 'package.json'];

const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: PKG, encoding: 'utf8' }));
const files = packed[0].files.map(f => f.path);

const fail = [];
const outside = files.filter(f => !allowed.some(a => (a.endsWith('/') ? f.startsWith(a) : f === a)));
if (outside.length) fail.push(`outside the allow-list: ${outside.join(', ')}`);

for (const required of ['bin/cli.mjs', 'lib/server.mjs', 'lib/guide.mjs', 'page/index.html', 'skills/sw-specs-editor/SKILL.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  if (!files.includes(required)) fail.push(`missing from the tarball: ${required}`);
}
const leaked = files.filter(f => f.startsWith('test/'));
if (leaked.length) fail.push(`tests must never ship: ${leaked.join(', ')}`);

if (fail.length) {
  console.error(`npm pack would be wrong:\n  ${fail.join('\n  ')}`);
  process.exit(1);
}
console.log(`npm pack: ${files.length} files, all inside the allow-list.`);
