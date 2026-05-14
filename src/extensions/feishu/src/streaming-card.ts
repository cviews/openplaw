import * as lark from "@larksuiteoapi/node-sdk";

const STREAMING_UPDATE_THROTTLE_MS = 160;
const STREAMING_SIGNIFICANT_DELTA_CHARS = 18;

export type FeishuStreamingConfig = {
  appId: string;
  appSecret: string;
};

type CardState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
};

type StreamingCardOptions = {
  header?: { title: string; template?: string };
  note?: string;
};

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getTenantToken(creds: FeishuStreamingConfig): Promise<string> {
  const key = creds.appId;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    },
  );

  if (!response.ok) {
    throw new Error(`Token request failed with HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }

  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });

  return data.tenant_access_token;
}

function truncateSummary(text: string, max = 50): string {
  if (!text) return "";
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

function hasNaturalStreamingBoundary(text: string): boolean {
  return /[\n。！？!?；;：:]$/.test(text);
}

function shouldPushStreamingUpdate(previousText: string, nextText: string): boolean {
  if (!previousText) return true;
  if (hasNaturalStreamingBoundary(nextText)) return true;
  return nextText.length - previousText.length >= STREAMING_SIGNIFICANT_DELTA_CHARS;
}

/** Merge streaming text fragments, handling partial overlaps (e.g. "这" + "这是" => "这是"). */
export function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) return previous;
  if (!previous || next === previous) return next;
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  if (next.includes(previous)) return next;
  if (previous.includes(next)) return previous;

  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  return `${previous}${next}`;
}

export class FeishuStreamingSession {
  private client: lark.Client;
  private creds: FeishuStreamingConfig;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private updateThrottleMs = STREAMING_UPDATE_THROTTLE_MS;

  constructor(client: lark.Client, creds: FeishuStreamingConfig, log?: (msg: string) => void) {
    this.client = client;
    this.creds = creds;
    this.log = log;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: StreamingCardOptions & {
      replyToMessageId?: string;
      replyInThread?: boolean;
    },
  ): Promise<void> {
    if (this.state) return;

    const token = await getTenantToken(this.creds);

    const elements: Record<string, unknown>[] = [
      { tag: "markdown", content: "⏳ Thinking...", element_id: "content" },
    ];
    if (options?.note) {
      elements.push({ tag: "hr" });
      elements.push({
        tag: "markdown",
        content: `<font color='grey'>${options.note}</font>`,
        element_id: "note",
      });
    }

    const cardJson: Record<string, unknown> = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        update_multi: true,
        summary: { content: "[Generating...]" },
        streaming_config: {
          print_frequency_ms: { default: 70 },
          print_step: { default: 1 },
          print_strategy: "fast",
        },
      },
      body: { elements },
    };

    if (options?.header) {
      cardJson.header = {
        title: { tag: "plain_text", content: options.header.title },
        template: options.header.template ?? "blue",
      };
    }

    const createRes = await fetch("https://open.feishu.cn/open-apis/cardkit/v1/cards", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
    });

    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`Create card request failed with HTTP ${createRes.status}: ${body}`);
    }

    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };

    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }

    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });

    let sendRes: { code?: number; msg?: string; data?: { message_id?: string } };

    if (options?.replyToMessageId) {
      sendRes = await this.client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: {
          msg_type: "interactive",
          content: cardContent,
          ...(options.replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content: cardContent,
        },
      });
    }

    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = {
      cardId,
      messageId: sendRes.data.message_id,
      sequence: 1,
      currentText: "",
    };

    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed) return;

    const mergedInput = mergeStreamingText(this.pendingText ?? this.state.currentText, text);
    if (!mergedInput || mergedInput === this.state.currentText) return;

    this.pendingText = mergedInput;
    this.clearFlushTimer();

    const shouldForceUpdate = shouldPushStreamingUpdate(this.state.currentText, mergedInput);
    const now = Date.now();
    if (!shouldForceUpdate && now - this.lastUpdateTime < this.updateThrottleMs) {
      this.schedulePendingFlush();
      return;
    }
    this.lastUpdateTime = now;

    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) return;
      const nextText = this.pendingText ?? mergedInput;
      const mergedText = mergeStreamingText(this.state.currentText, nextText);
      if (!mergedText || mergedText === this.state.currentText) return;
      this.pendingText = null;
      this.state.currentText = mergedText;
      await this.updateCardContent(mergedText);
    });
    await this.queue;
  }

  async close(finalText?: string, options?: { note?: string }): Promise<void> {
    if (!this.state || this.closed) return;
    this.closed = true;
    this.clearFlushTimer();
    await this.queue;

    const pendingMerged = mergeStreamingText(this.state.currentText, this.pendingText ?? undefined);
    const text = finalText ? mergeStreamingText(pendingMerged, finalText) : pendingMerged;

    if (text && text !== this.state.currentText) {
      await this.updateCardContent(text);
      this.state.currentText = text;
    }

    if (options?.note) {
      await this.updateNoteContent(options.note);
    }

    this.state.sequence += 1;
    const token = await getTenantToken(this.creds);
    await fetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${this.state.cardId}/settings`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        settings: JSON.stringify({
          config: {
            streaming_mode: false,
            summary: { content: truncateSummary(text) },
          },
        }),
        sequence: this.state.sequence,
        uuid: `c_${this.state.cardId}_${this.state.sequence}`,
      }),
    }).catch((e: unknown) => this.log?.(`Close failed: ${String(e)}`));

    const finalState = this.state;
    this.state = null;
    this.pendingText = null;

    this.log?.(`Closed streaming: cardId=${finalState.cardId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }

  private async updateCardContent(text: string): Promise<void> {
    if (!this.state) return;

    this.state.sequence += 1;
    const token = await getTenantToken(this.creds);

    const response = await fetch(
      `https://open.feishu.cn/open-apis/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: text,
          sequence: this.state.sequence,
          uuid: `s_${this.state.cardId}_${this.state.sequence}`,
        }),
      },
    );

    if (!response.ok) {
      this.log?.(`Update content failed with HTTP ${response.status}`);
    }
  }

  private async updateNoteContent(note: string): Promise<void> {
    if (!this.state) return;

    this.state.sequence += 1;
    const token = await getTenantToken(this.creds);

    await fetch(
      `https://open.feishu.cn/open-apis/cardkit/v1/cards/${this.state.cardId}/elements/note/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: `<font color='grey'>${note}</font>`,
          sequence: this.state.sequence,
          uuid: `n_${this.state.cardId}_${this.state.sequence}`,
        }),
      },
    ).catch((e: unknown) => this.log?.(`Note update failed: ${String(e)}`));
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private schedulePendingFlush(): void {
    if (this.flushTimer || !this.pendingText || this.closed) return;
    const delayMs = Math.max(0, this.updateThrottleMs - (Date.now() - this.lastUpdateTime));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const pending = this.pendingText;
      if (!pending || this.closed) return;
      void this.update(pending);
    }, delayMs);
  }
}
