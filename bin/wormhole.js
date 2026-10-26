#!/usr/bin/env node
import { main } from '../dist/cli.js';

// Output piped into `head` and the like: stop quietly when the reader goes away.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

process.exitCode = await main(process.argv);
