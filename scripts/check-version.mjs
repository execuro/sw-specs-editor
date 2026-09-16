// Does everything that names a version agree with package.json?
//
// The skill this package ships pins the CLI it drives - in its `allowed-tools`
// line, its metadata and its prose. A version bump that misses one of those
// publishes a skill that tells agents to fetch the *previous* release, which
// looks like it works right up until someone needs the new behaviour.
//
// Nothing generates these strings, so nothing but this check stops them.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { name, version } = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));

// Files that ship, plus the README a consumer reads on npm.
const ROOTS = ['skills', 'README.md'];

function files(rel) {
  const abs = path.join(PKG, rel);
  if (!statSync(abs).isDirectory()) return [abs];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    out.push(...files(path.join(rel, entry.name)));
  }
  return out;
}

const pinned = new RegExp(`${name.replace('/', '\\/')}@([0-9][^\\s"'\`)*]*)`, 'g');
const wrong = [];
let found = 0;

for (const root of ROOTS) {
  for (const file of files(root)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(pinned)) {
      found++;
      if (m[1] !== version) {
        wrong.push(`${path.relative(PKG, file)}: pins @${m[1]}, package.json is ${version}`);
      }
    }
  }
}

if (!found) {
  console.error(`no pinned reference to ${name}@<version> found - the skill must pin the CLI it drives`);
  process.exit(1);
}
if (wrong.length) {
  console.error(`pinned versions disagree with package.json:\n  ${wrong.join('\n  ')}`);
  process.exit(1);
}
console.log(`${found} pinned reference(s), all at ${version}.`);
