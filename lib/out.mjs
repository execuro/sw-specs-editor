// Output contract shared by every sw-specs-editor subcommand.
//
// stdout carries the command's result and nothing else: compact `key: value`
// lines, then the `next_step:` line, then any large payload LAST - so an agent
// that reads only the head of the output still learns what to do next.
//
// stderr carries progress that is not part of the result. Wait ticks are
// written only when stderr is a TTY: under an agent harness stderr is piped and
// the ticks would be captured as noise.

export const EXIT_OK = 0;
export const EXIT_UNREACHABLE = 1;
export const EXIT_USAGE = 2;

/** One `key: value` result line on stdout. */
export function line(key, value) {
  process.stdout.write(`${key}: ${value}\n`);
}

/** The next command the agent should run. Continuation lines are indented. */
export function nextStep(text) {
  const [first, ...rest] = String(text).split('\n');
  process.stdout.write(`next_step: ${first}\n`);
  for (const r of rest) process.stdout.write(`  ${r}\n`);
}

/** The large payload, always last. */
export function payload(value) {
  if (typeof value === 'string') process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Progress that is not part of the result. */
export function note(text) {
  process.stderr.write(`${text}\n`);
}

export function usage(text) {
  process.stderr.write(`${text}\n`);
  process.exit(EXIT_USAGE);
}

export function unreachable(text) {
  process.stderr.write(`${text}\n`);
  process.exit(EXIT_UNREACHABLE);
}

/**
 * Immediate stderr banner so a long wait is visibly not hung, plus periodic
 * ticks on a TTY only. Returns a stop function.
 */
export function waitBanner(text, everySec = 15) {
  process.stderr.write(`${text}\n`);
  if (!process.stderr.isTTY) return () => {};
  const started = Date.now();
  const timer = setInterval(() => {
    process.stderr.write(`  ... still waiting (${Math.round((Date.now() - started) / 1000)}s)\n`);
  }, everySec * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
