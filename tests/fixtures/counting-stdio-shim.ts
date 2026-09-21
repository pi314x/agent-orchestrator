import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/**
 * Spawn-counting stdio shim for the proxy race test: records one line per
 * child started, then stays alive forwarding stdio to the real fixture, so
 * the pool cannot tell it apart from the fixture itself.
 *
 * argv: [counterFile, command, ...args]
 */
const [counterFile, command, ...args] = process.argv.slice(2);
if (counterFile === undefined || command === undefined) {
  console.error('usage: counting-stdio-shim.ts <counterFile> <command> [args...]');
  process.exit(2);
}

appendFileSync(counterFile, `${Date.now()}\n`);

// Extensionless launcher shims (pnpm's .bin/tsx) do not exec without a
// shell on Windows — the same reason a bare node:child_process spawn of one
// fails with ENOENT while the SDK's own transport succeeds.
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('exit', code => process.exit(code ?? 0));
child.on('error', error => {
  console.error(error.message);
  process.exit(1);
});
