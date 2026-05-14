#!/usr/bin/env node
import { runCli } from "./cli.js";

// Keep process alive until server commands (web/start) create their own
// persistent handles (HTTP servers). Without this, Node.js ESM exits
// during module evaluation before async commands can start servers.
const keepAlive = setInterval(() => {}, 60_000);

runCli()
  .then(() => clearInterval(keepAlive))
  .catch((err) => {
    clearInterval(keepAlive);
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
