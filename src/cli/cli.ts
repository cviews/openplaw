import { createRequire } from "node:module";
import { startCommand } from "../commands/start.js";
import { scanCommand } from "../commands/scan.js";
import { configCommand } from "../commands/config.js";
import { daemonCommand, type DaemonSubcommand } from "../commands/daemon.js";
import { tuiCommand, type TuiCommandOptions } from "../commands/tui.js";
import { initCommand, type InitCommandOptions } from "../commands/init.js";
import { webCommand, type WebCommandOptions } from "../commands/web.js";
import { logger } from "../infra/logger.js";

const require = createRequire(import.meta.url);
const VERSION: string = require("../../package.json").version;

function printUsage(): void {
  console.log(`openplaw v${VERSION} — Feishu/DingTalk bot management platform

Usage:
  openplaw <command> [options]

Commands:
  start     Start the openplaw gateway
  scan      Scan for agents and MCP servers
  config    Print resolved configuration
  tui       Launch the opencode TUI with openplaw config
  init      Initialize ~/.openplaw/ and ~/.config/openplaw/ directories
  daemon    Manage the openplaw gateway daemon service
  web       Start the openplaw web management UI
  version   Print version

Daemon Subcommands:
  daemon status     Show daemon service status
  daemon install    Install daemon as platform service
  daemon uninstall  Uninstall daemon service
  daemon start      Start the daemon service
  daemon stop       Stop the daemon service
  daemon restart    Restart the daemon service

Options:
  --agents-dir <path>   Path to agents directory
  --config <path>       Path to config file
  --health-port <port>  Health check port (default: 9090)
  --project <path>      Project directory for TUI (default: cwd)
  --model <model>       Override model for TUI
  --session <id>        Resume TUI session
  --agent <name>        Start TUI with specific agent
  --port <port>         Web UI port (default: 4098)
  --host <host>         Web UI host (default: 0.0.0.0)
  --force               Force overwrite existing config files (for init)
  --verbose             Enable verbose logging
  -h, --help            Show this help message
`);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  let i = 2;

  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i++;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      result.help = true;
      i++;
    } else if (arg === "--verbose") {
      result.verbose = true;
      i++;
    } else if (arg === "--force") {
      result.force = true;
      i++;
    } else if (arg === "--agents-dir" || arg === "--config" || arg === "--health-port" || arg === "--project" || arg === "--model" || arg === "--session" || arg === "--agent" || arg === "--port" || arg === "--host") {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      const value = argv[i + 1];
      if (value && !value.startsWith("-")) {
        result[key] = value;
        i += 2;
      } else {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
    } else if (!arg.startsWith("-")) {
      result.command = arg;
      i++;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return result;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    return;
  }

  if (args.verbose) {
    logger.setLevel("debug");
  }

  const command = args.command;

  if (!command || typeof command !== "string") {
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case "start": {
      const healthPort = typeof args.healthPort === "string" ? Number(args.healthPort) : undefined;
      await startCommand({
        agentsDir: typeof args.agentsDir === "string" ? args.agentsDir : undefined,
        healthPort: healthPort && Number.isFinite(healthPort) ? healthPort : undefined,
      });
      break;
    }
    case "scan": {
      await scanCommand({
        agentsDir: typeof args.agentsDir === "string" ? args.agentsDir : undefined,
        verbose: args.verbose === true,
      });
      break;
    }
    case "config": {
      await configCommand();
      break;
    }
    case "tui": {
      const tuiOptions: TuiCommandOptions = {
        project: typeof args.project === "string" ? args.project : undefined,
        model: typeof args.model === "string" ? args.model : undefined,
        session: typeof args.session === "string" ? args.session : undefined,
        agent: typeof args.agent === "string" ? args.agent : undefined,
      };
      await tuiCommand(tuiOptions);
      break;
    }
    case "init": {
      const initOptions: InitCommandOptions = {
        force: args.force === true,
      };
      await initCommand(initOptions);
      break;
    }
    case "version": {
      console.log(`openplaw v${VERSION}`);
      break;
    }
    case "daemon": {
      const daemonSubcommand = argv.find((arg, idx) => {
        if (idx <= 2) return false;
        const prev = argv[idx - 1];
        return prev === "daemon" && !arg.startsWith("-");
      });
      if (!daemonSubcommand) {
        console.log(`Usage: openplaw daemon <status|install|uninstall|start|stop|restart>`);
        process.exit(1);
      }
      const validSubcommands: DaemonSubcommand[] = ["status", "install", "uninstall", "start", "stop", "restart"];
      if (!validSubcommands.includes(daemonSubcommand as DaemonSubcommand)) {
        console.error(`Unknown daemon subcommand: ${daemonSubcommand}`);
        console.log(`Usage: openplaw daemon <status|install|uninstall|start|stop|restart>`);
        process.exit(1);
      }
      await daemonCommand(daemonSubcommand as DaemonSubcommand);
      break;
    }
    case "web": {
      const webOptions: WebCommandOptions = {
        port: typeof args.port === "string" ? Number(args.port) : undefined,
        host: typeof args.host === "string" ? args.host : undefined,
      };
      await webCommand(webOptions);
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}
