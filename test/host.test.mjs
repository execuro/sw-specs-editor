// lib/host.mjs: the process chain the CLI sends, and how the server reads a host out of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ancestry, chainHeaders, parseChain, commonHost, alive, CHAIN_HEADER } from '../lib/host.mjs';

test('ancestry starts with this process and walks up through its parent', { skip: process.platform === 'win32' && 'no ps' }, () => {
  const chain = ancestry();
  assert.equal(chain[0], process.pid);
  assert.equal(chain[1], process.ppid);
  assert.equal(new Set(chain).size, chain.length, 'no pid twice');
  assert.equal(chainHeaders()[CHAIN_HEADER], chain.join(','));
});

test('parseChain accepts only a list of real pids', () => {
  assert.deepEqual(parseChain('10,20,30'), [10, 20, 30]);
  for (const bad of [undefined, '', 'a,b', '10,,20', '10,1', '-5']) assert.deepEqual(parseChain(bad), [], String(bad));
});

test('commonHost: the nearest ancestor every recent poll shares', () => {
  // Two `poll` calls from Claude Code: own pid and shell differ, the host does not.
  assert.equal(commonHost([[101, 201, 500, 400], [102, 202, 500, 400]]), 500);
  // Through npx: more short-lived layers, same answer.
  assert.equal(commonHost([[101, 201, 500, 400], [103, 303, 302, 301, 500, 400]]), 500);
  // Two invocations from one shell command share that shell; an earlier poll from
  // another shell rules it out.
  assert.equal(commonHost([[101, 201, 500], [102, 777, 500], [103, 777, 500]]), 500);
  // The legs of one `poll` share every pid, their own shell included: no host from those.
  assert.equal(commonHost([[101, 201, 500], [101, 201, 500]]), null);
  assert.equal(commonHost([]), null);
  assert.equal(commonHost([[101, 201], [102, 202]]), null);
});

test('alive follows a real process from start to kill', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise(r => child.once('spawn', r));
  assert.equal(alive(child.pid), true);
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
  assert.equal(alive(child.pid), false);
});
