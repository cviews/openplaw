import { createOpencodeServer, type Config } from "@opencode-ai/sdk";
import { ensureOpencodeInPath } from "../utils/path.js";

async function main(): Promise<void> {
  ensureOpencodeInPath();

  const configContent = process.env.OPENCODE_CONFIG_CONTENT;
  const port = parseInt(process.env.OPENCODE_SERVER_PORT ?? "4096", 10);
  const hostname = process.env.OPENCODE_SERVER_HOSTNAME ?? "localhost";

  let config: Config | undefined;
  if (configContent) {
    try {
      config = JSON.parse(configContent);
    } catch {
      process.stderr.write("Failed to parse OPENCODE_CONFIG_CONTENT\n");
    }
  }

  const { url, close } = await createOpencodeServer({
    hostname,
    port,
    config,
  });

  process.stderr.write(`opencode server started at ${url}\n`);

  const shutdown = () => {
    process.stderr.write("opencode server shutting down...\n");
    close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(
    `opencode server failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
