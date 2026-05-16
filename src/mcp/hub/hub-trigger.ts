import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { logger } from "../../infra/logger.js";
import type { AgentNameResolver } from "../../bootstrap/agent-name-resolver.js";
import type { ModelRef } from "../../utils/model.js";

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;

export function registerHubTriggerTools(
  server: McpServer,
  deps: {
    client: OpencodeClient;
    getDefaultAgent: () => string;
    agentNameResolver: AgentNameResolver;
    getLatestModel?: () => Promise<ModelRef | null>;
  },
): void {
  const { client, getDefaultAgent, agentNameResolver } = deps;

  server.tool(
    "trigger_agent",
    `Trigger an AI agent to process a message. This is the primary way gateway invokes agent processing.\nDefault agent: ${getDefaultAgent()}`,
    {
      agent: z.string().optional().describe(`Agent name to use (default: ${getDefaultAgent()})`),
      message: z.string().min(1).describe("The message text to send to the agent"),
      directory: z.string().optional().describe("Project directory path for workspace context"),
      session_id: z.string().optional().describe("Existing session ID to continue conversation (omit for new session)"),
      parent_session_id: z.string().optional().describe("Parent session ID for sub-agent delegation"),
    },
    async ({ agent, message, directory, session_id, parent_session_id }) => {
      const rawAgentName = agent ?? getDefaultAgent();
      const resolvedAgentName = agentNameResolver.resolve(rawAgentName);
      logger.info(`trigger_agent: raw=${rawAgentName}, resolved=${resolvedAgentName}, directory=${directory ?? "none"}, message_length=${message.length}`);

      try {
        let sessionId: string;
        let sessionRecreated = false;

        if (session_id) {
          // Verify the session still exists in the opencode server
          try {
            const messagesArgs: Record<string, unknown> = { sessionID: session_id };
            if (directory) messagesArgs.directory = directory;
            const checkResult = await client.session.messages(messagesArgs as any);
            if (!checkResult.data) {
              logger.info(`trigger_agent: session_id=${session_id} not found (status=${checkResult.response?.status}), creating new session`);
              const createArgs: Record<string, unknown> = {};
              if (directory) createArgs.directory = directory;
              const createResult = await client.session.create(createArgs as any);
              if (!createResult.data) {
                throw new Error(`Session recreate failed (status: ${createResult.response.status})`);
              }
              sessionId = createResult.data.id;
              sessionRecreated = true;
            } else {
              sessionId = session_id;
            }
          } catch (checkErr) {
            logger.info(`trigger_agent: session check error for ${session_id}: ${checkErr instanceof Error ? checkErr.message : String(checkErr)}, creating new session`);
            const createArgs: Record<string, unknown> = {};
            if (directory) createArgs.directory = directory;
            const createResult = await client.session.create(createArgs as any);
            if (!createResult.data) {
              throw new Error(`Session recreate failed (status: ${createResult.response.status})`);
            }
            sessionId = createResult.data.id;
            sessionRecreated = true;
          }
        } else {
          const createArgs: Record<string, unknown> = {};
          if (directory) createArgs.directory = directory;
          if (parent_session_id) createArgs.parentID = parent_session_id;
          const createResult = await client.session.create(createArgs as any);
          if (!createResult.data) {
            throw new Error(
              `Session create failed (status: ${createResult.response.status})`,
            );
          }
          sessionId = createResult.data.id;
        }

        if (sessionRecreated) {
          logger.info(`trigger_agent: recreated session ${sessionId} (old stale session was ${session_id})`);
        }

        const promptArgs: Record<string, unknown> = {
          sessionID: sessionId,
          agent: resolvedAgentName,
          parts: [{ type: "text" as const, text: message }],
        };
        if (directory) promptArgs.directory = directory;

        try {
          const latestModel = await deps.getLatestModel?.();
          if (latestModel) {
            promptArgs.model = latestModel;
            logger.info(`trigger_agent: using latest model from config: ${latestModel.providerID}/${latestModel.modelID}`);
          }
        } catch (err) {
          logger.warn(`trigger_agent: failed to read latest model config: ${err instanceof Error ? err.message : String(err)}`);
        }

        const promptResult = await client.session.promptAsync(promptArgs as any);

        if (promptResult.error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Failed to prompt agent "${resolvedAgentName}" (raw: "${rawAgentName}"): ${JSON.stringify(promptResult.error)}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Agent ${resolvedAgentName} triggered successfully. Session: ${sessionId}`,
            },
          ],
          structuredContent: {
            session_id: sessionId,
            agent: resolvedAgentName,
            directory: directory ?? null,
            status: "triggered",
          },
        };
      } catch (err) {
        logger.error("trigger_agent failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_agent_result",
    "Get the result of an agent session. Polls until the agent finishes or timeout.",
    {
      session_id: z.string().min(1).describe("Session ID to check"),
      directory: z.string().optional().describe("Project directory path for workspace context"),
      timeout_ms: z
        .number()
        .int()
        .min(1_000)
        .max(600_000)
        .optional()
        .describe("Max wait time in ms (default: 300000)"),
    },
    async ({ session_id, directory, timeout_ms }) => {
      const deadline = Date.now() + (timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS);
      let completed = false;

      while (Date.now() < deadline) {
        try {
          const statusResult = await client.session.status();
          if (statusResult.data) {
            const statuses = statusResult.data;
            const sessionStatus = statuses[session_id];
            if (sessionStatus?.type === "idle") {
              completed = true;
              break;
            }
          }
        } catch { }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      let resultText = "";
      try {
        const messagesArgs: Record<string, unknown> = { sessionID: session_id };
        if (directory) messagesArgs.directory = directory;
        const messagesResult = await client.session.messages(messagesArgs as any);
        if (messagesResult.data) {
          const assistantMsgs = messagesResult.data.filter(
            (msg: any) => msg.info?.role === "assistant",
          );
          const lastMsg = assistantMsgs.at(-1);
          if (lastMsg) {
            const parts: string[] = [];
            for (const part of lastMsg.parts ?? []) {
              if (part.type === "text") {
                parts.push(part.text);
              }
            }
            resultText = parts.join("\n");
          }
        }
      } catch { }

      if (!completed) {
        const partial = resultText ? `\n\nPartial result:\n${resultText}` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Warning: Timed out waiting for agent to complete.${partial}`,
            },
          ],
          structuredContent: { session_id, completed: false, result: resultText },
        };
      }

      if (!resultText) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Agent completed but returned no output.",
            },
          ],
          structuredContent: { session_id, completed: true, result: "" },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: resultText,
          },
        ],
        structuredContent: { session_id, completed: true, result: resultText },
      };
    },
  );
}