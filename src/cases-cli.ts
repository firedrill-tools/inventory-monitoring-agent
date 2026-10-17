#!/usr/bin/env node
import { main } from "./cases.js";
try {
  main();
} catch (error) {
  console.log(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 2;
}
