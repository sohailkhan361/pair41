// A stand-in for Codex in the wrapper test: it logs every line typed into it to FAKE_LOG, then "works" on it for two
// seconds (printing a dot every 200 ms, like a spinner) and shows its prompt again.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.FAKE_LOG ?? '/dev/null';
let queue = Promise.resolve();
process.stdout.write('codex> ');
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(log, `${line}\n`);
  queue = queue.then(async () => {
    for (let i = 0; i < 10; i++) {
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, 200));
    }
    process.stdout.write('\ncodex> ');
  });
});
