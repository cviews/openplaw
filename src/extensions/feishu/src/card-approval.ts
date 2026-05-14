import * as lark from "@larksuiteoapi/node-sdk";

const APPROVAL_CONFIRM_ACTION = "feishu.approval.confirm";
const APPROVAL_CANCEL_ACTION = "feishu.approval.cancel";
const CARD_INTERACTION_VERSION = "ocf1";

type ApprovalCardParams = {
  to: string;
  planSummary: string;
  planDetails: string;
  operatorId: string;
  chatId?: string;
  expiresAt: number;
  sessionId: string;
};

type InteractionContext = {
  u?: string;
  h?: string;
  s?: string;
  e: number;
  t?: "p2p" | "group";
};

type InteractionEnvelope = {
  oc: typeof CARD_INTERACTION_VERSION;
  k: "button" | "quick" | "meta";
  a: string;
  q?: string;
  c?: InteractionContext;
};

function buildInteractionContext(params: {
  operatorId: string;
  chatId?: string;
  expiresAt: number;
  sessionId: string;
}): InteractionContext {
  return {
    u: params.operatorId,
    ...(params.chatId ? { h: params.chatId } : {}),
    s: params.sessionId,
    e: params.expiresAt,
  };
}

function buildEnvelope(
  kind: InteractionEnvelope["k"],
  action: string,
  context: InteractionContext,
  command?: string,
): InteractionEnvelope {
  return {
    oc: CARD_INTERACTION_VERSION,
    k: kind,
    a: action,
    ...(command ? { q: command } : {}),
    c: context,
  };
}

function buildApprovalCard(params: ApprovalCardParams): Record<string, unknown> {
  const context = buildInteractionContext({
    operatorId: params.operatorId,
    chatId: params.chatId,
    expiresAt: params.expiresAt,
    sessionId: params.sessionId,
  });

  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    header: {
      title: { tag: "plain_text", content: "📋 执行计划确认" },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**摘要**: ${params.planSummary}`,
        },
        {
          tag: "column_set",
          flex_mode: "bisect",
          background_style: "default",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "markdown",
                  content: `<font color='grey'>详情 (点击展开)</font>`,
                },
              ],
            },
          ],
        },
        {
          tag: "markdown",
          content: params.planDetails,
        },
        { tag: "hr" },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "✅ 确认执行" },
              type: "primary",
              value: buildEnvelope("quick", APPROVAL_CONFIRM_ACTION, context, params.planSummary),
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "❌ 取消" },
              type: "danger",
              value: buildEnvelope("button", APPROVAL_CANCEL_ACTION, context),
            },
          ],
        },
      ],
    },
  };
}

type ApprovalCallbackResult =
  | { action: "confirm"; sessionId: string; operatorId: string }
  | { action: "cancel"; sessionId: string; operatorId: string }
  | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function decodeCardAction(event: unknown): ApprovalCallbackResult {
  if (!isRecord(event)) return null;

  const operator = isRecord(event)
    ? (event.operator as Record<string, unknown> | undefined)
    : undefined;
  const action = isRecord(event)
    ? (event.action as Record<string, unknown> | undefined)
    : undefined;
  const context = isRecord(event)
    ? (event.context as Record<string, unknown> | undefined)
    : undefined;

  const operatorId = typeof operator?.open_id === "string" ? operator.open_id : "";
  const chatId = typeof context?.chat_id === "string" ? context.chat_id : undefined;
  void chatId;

  const actionValue = action?.value;
  if (!isRecord(actionValue) || actionValue.oc !== CARD_INTERACTION_VERSION) return null;

  const actionName = typeof actionValue.a === "string" ? actionValue.a : "";
  const envelopeContext = isRecord(actionValue.c) ? actionValue.c : undefined;
  const sessionId = typeof envelopeContext?.s === "string" ? envelopeContext.s : "";
  const expiry = typeof envelopeContext?.e === "number" ? envelopeContext.e : 0;

  if (expiry > 0 && Date.now() > expiry) return null;

  const expectedUser = typeof envelopeContext?.u === "string" ? envelopeContext.u.trim() : "";
  if (expectedUser && expectedUser !== operatorId.trim()) return null;

  if (actionName === APPROVAL_CONFIRM_ACTION) {
    return { action: "confirm", sessionId, operatorId };
  }
  if (actionName === APPROVAL_CANCEL_ACTION) {
    return { action: "cancel", sessionId, operatorId };
  }

  return null;
}

export function sendApprovalCard(client: lark.Client, params: ApprovalCardParams): Promise<void> {
  const card = buildApprovalCard(params);
  return client.im.message
    .create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: params.to,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    })
    .then(() => {});
}

export function updateApprovalCard(
  client: lark.Client,
  params: { cardId: string; card: Record<string, unknown> },
): Promise<void> {
  return client.im.message
    .patch({
      path: { message_id: params.cardId },
      data: { content: JSON.stringify(params.card) },
    })
    .then(() => {});
}

export {
  decodeCardAction,
  type ApprovalCallbackResult,
  type ApprovalCardParams,
};
