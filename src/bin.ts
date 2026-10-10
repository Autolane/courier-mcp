#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2), { env: process.env, out: (line) => console.log(line), err: (line) => console.error(line) }).then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
