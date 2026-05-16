import * as lark from "@larksuiteoapi/node-sdk";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";

const STREAMING_UPDATE_THROTTLE_MS = 150;
const STREAMING_SIGNIFICANT_DELTA_CHARS = 2;

const feishuHttpAgent = new UndiciAgent({
  connections: 6,
  pipelining: 1,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

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
let tokenRefreshMutex: Promise<string> | null = null;

async function refreshTokenInternal(creds: FeishuStreamingConfig): Promise<string> {
  const key = creds.appId;

  const response = await undiciFetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
      dispatcher: feishuHttpAgent,
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

async function getTenantToken(creds: FeishuStreamingConfig): Promise<string> {
  const key = creds.appId;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  if (tokenRefreshMutex) {
    return tokenRefreshMutex;
  }

  const refreshStart = Date.now();
  tokenRefreshMutex = refreshTokenInternal(creds);
  try {
    const token = await tokenRefreshMutex;
    const elapsed = Date.now() - refreshStart;
    if (elapsed > 50) {
      console.log(`[feishu-streaming-timing] token refresh: ${elapsed}ms`);
    }
    return token;
  } finally {
    tokenRefreshMutex = null;
  }
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
  private closed = false;
  private cardTimedOutFlag = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private updateThrottleMs = STREAMING_UPDATE_THROTTLE_MS;
  /** In-flight concurrent API requests — tracked so close() can drain them before finalising. */
  private inFlight = new Set<Promise<void>>();

  constructor(client: lark.Client, creds: FeishuStreamingConfig, log?: (msg: string) => void) {
    this.client = client;
    this.creds = creds;
    this.log = log;
  }

  async warmTokenCache(): Promise<void> {
    await getTenantToken(this.creds);
    this.log?.("Token cache pre-warmed");
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
      { tag: "markdown", content: "", element_id: "loading" },
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
          print_frequency_ms: { default: 15 },
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

    const createRes = await undiciFetch("https://open.feishu.cn/open-apis/cardkit/v1/cards", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
      dispatcher: feishuHttpAgent,
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

  /** Sync state mutation + pre-allocated sequence → fire-and-forget fetch. Handler.ts does NOT await, so API latency never blocks SSE consumption. */
  async update(text: string): Promise<void> {
    if (!this.state || this.closed) return;

    const mergedInput = mergeStreamingText(this.pendingText ?? this.state.currentText, text);
    if (!mergedInput || mergedInput === this.state.currentText) return;

    this.pendingText = mergedInput;
    this.clearFlushTimer();

    const shouldForceUpdate = shouldPushStreamingUpdate(this.state.currentText, mergedInput);
    const now = Date.now();
    const throttleAge = now - this.lastUpdateTime;
    if (!shouldForceUpdate && throttleAge < this.updateThrottleMs) {
      this.log?.(`update throttled: +${mergedInput.length - this.state.currentText.length}chars delta, throttleAge=${throttleAge}ms, pending flush in ${Math.max(0, this.updateThrottleMs - throttleAge)}ms`);
      this.schedulePendingFlush();
      return;
    }
    this.lastUpdateTime = now;

    // Sequence pre-allocation: guarantees monotonic sequence even with concurrent in-flight fetches
    const mergedText = mergeStreamingText(this.state.currentText, this.pendingText ?? mergedInput);
    if (!mergedText || mergedText === this.state.currentText) return;
    const prevLen = this.state.currentText.length;
    this.pendingText = null;
    this.state.currentText = mergedText;
    this.state.sequence += 1;

    const seq = this.state.sequence;
    const cardId = this.state.cardId;

    this.log?.(`update force-push: seq=${seq}, +${mergedText.length - prevLen}chars, total=${mergedText.length}chars, inFlight=${this.inFlight.size}`);

    const p = this.fetchContentUpdate(mergedText, cardId, seq);
    this.trackInFlight(p);
  }

  /** Replace card content entirely — used when transitioning from thinking phase to streaming text. */
  async replaceContent(text: string): Promise<void> {
    if (!this.state || this.closed) return;
    if (!text) return;

    this.clearFlushTimer();
    this.lastUpdateTime = Date.now();
    this.pendingText = null;
    this.state.currentText = text;
    this.state.sequence += 1;

    const seq = this.state.sequence;
    const cardId = this.state.cardId;
    this.log?.(`replaceContent: seq=${seq}, total=${text.length}chars, inFlight=${this.inFlight.size}`);

    const p = this.fetchContentUpdate(text, cardId, seq);
    this.trackInFlight(p);
  }

  async close(finalText?: string, options?: { note?: string }): Promise<void> {
    if (!this.state || this.closed) return;
    this.closed = true;
    this.clearFlushTimer();

    const closeStart = Date.now();
    const inFlightCount = this.inFlight.size;

    // Drain in-flight: ensures streaming updates reach Feishu before freezing the card
    await Promise.all([...this.inFlight]);
    const drainMs = Date.now() - closeStart;
    this.log?.(`close drain: ${inFlightCount} in-flight, ${drainMs}ms`);

    const pendingMerged = mergeStreamingText(this.state.currentText, this.pendingText ?? undefined);
    const text = finalText ? mergeStreamingText(pendingMerged, finalText) : pendingMerged;

    // Final content update — sequential, awaited for reliability.
    if (text && text !== this.state.currentText) {
      this.state.sequence += 1;
      await this.fetchContentUpdate(text, this.state.cardId, this.state.sequence);
      this.state.currentText = text;
    }

    // Final note update — sequential, awaited for reliability.
    if (options?.note) {
      this.state.sequence += 1;
      const noteSeq = this.state.sequence;
      const noteToken = await getTenantToken(this.creds);
      await undiciFetch(
        `https://open.feishu.cn/open-apis/cardkit/v1/cards/${this.state.cardId}/elements/note/content`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${noteToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: `<font color='grey'>${options.note}</font>`,
            sequence: noteSeq,
            uuid: `n_${this.state.cardId}_${noteSeq}`,
          }),
          dispatcher: feishuHttpAgent,
        },
      ).catch((e: unknown) => this.log?.(`Final note update failed: ${String(e)}`));
    }

    this.state.sequence += 1;
    const loadSeq = this.state.sequence;
    const loadToken = await getTenantToken(this.creds);
    await undiciFetch(
      `https://open.feishu.cn/open-apis/cardkit/v1/cards/${this.state.cardId}/elements/loading/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${loadToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: "",
          sequence: loadSeq,
          uuid: `l_${this.state.cardId}_${loadSeq}`,
        }),
        dispatcher: feishuHttpAgent,
      },
    ).catch((e: unknown) => this.log?.(`Final loading clear failed: ${String(e)}`));

    // Disable streaming_mode — the card is now frozen.
    this.state.sequence += 1;
    const token = await getTenantToken(this.creds);
    await undiciFetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${this.state.cardId}/settings`, {
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
      dispatcher: feishuHttpAgent,
    }).catch((e: unknown) => this.log?.(`Close failed: ${String(e)}`));

    const totalCloseMs = Date.now() - closeStart;
    const finalState = this.state;
    this.state = null;
    this.pendingText = null;

    this.log?.(`close total: ${totalCloseMs}ms, cardId=${finalState.cardId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }

  isCardTimedOut(): boolean {
    return this.cardTimedOutFlag;
  }

  public async keepAlive(): Promise<boolean> {
    if (!this.state || this.closed) return false;

    this.state.sequence += 1;
    const seq = this.state.sequence;
    const cardId = this.state.cardId;

    const token = await getTenantToken(this.creds);
    const response = await undiciFetch(
      `https://open.feishu.cn/open-apis/cardkit/v1/cards/${cardId}/settings`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          settings: JSON.stringify({
            config: {
              streaming_mode: true,
              streaming_config: {
                print_frequency_ms: { default: 15 },
                print_step: { default: 1 },
                print_strategy: "fast",
              },
            },
          }),
          sequence: seq,
          uuid: `k_${cardId}_${seq}`,
        }),
        dispatcher: feishuHttpAgent,
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      this.log?.(`keepAlive failed with HTTP ${response.status}: ${detail}`);
      return false;
    }

    this.log?.(`keepAlive: streaming_mode reset (seq ${seq})`);
    return true;
  }

  public async updateNoteContent(note: string): Promise<void> {
    if (!this.state || this.closed) return;

    // Pre-allocate sequence synchronously
    this.state.sequence += 1;
    const seq = this.state.sequence;
    const cardId = this.state.cardId;

    const p = getTenantToken(this.creds).then(async (token) => {
      await undiciFetch(
        `https://open.feishu.cn/open-apis/cardkit/v1/cards/${cardId}/elements/note/content`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: `<font color='grey'>${note}</font>`,
            sequence: seq,
            uuid: `n_${cardId}_${seq}`,
          }),
          dispatcher: feishuHttpAgent,
        },
      ).catch((e: unknown) => this.log?.(`Note update failed: ${String(e)}`));
    });
    this.trackInFlight(p);
  }

  public async updateLoadingContent(content: string): Promise<void> {
    if (!this.state || this.closed) return;

    this.state.sequence += 1;
    const seq = this.state.sequence;
    const cardId = this.state.cardId;

    const p = getTenantToken(this.creds).then(async (token) => {
      await undiciFetch(
        `https://open.feishu.cn/open-apis/cardkit/v1/cards/${cardId}/elements/loading/content`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content,
            sequence: seq,
            uuid: `l_${cardId}_${seq}`,
          }),
          dispatcher: feishuHttpAgent,
        },
      ).catch((e: unknown) => this.log?.(`Loading update failed: ${String(e)}`));
    });
    this.trackInFlight(p);
  }

  /**
   * Fire-and-forget header update during streaming.
   * Pre-allocates sequence synchronously, then fires fetch concurrently.
   */
  public async updateHeader(title: string, template: string = "blue"): Promise<void> {
    if (!this.state || this.closed) return;

    // Pre-allocate sequence synchronously
    this.state.sequence += 1;
    const seq = this.state.sequence;
    const cardId = this.state.cardId;

    const p = getTenantToken(this.creds).then(async (token) => {
      await undiciFetch(
        `https://open.feishu.cn/open-apis/cardkit/v1/cards/${cardId}/settings`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            settings: JSON.stringify({
              header: {
                title: { tag: "plain_text", content: title },
                template,
              },
            }),
            sequence: seq,
            uuid: `h_${cardId}_${seq}`,
          }),
          dispatcher: feishuHttpAgent,
        },
      ).catch((e: unknown) => this.log?.(`Header update failed: ${String(e)}`));
    });
    this.trackInFlight(p);
  }

  // ── Private helpers ──────────────────────────────────────────────

  /** Fire-and-forget card content update with a pre-allocated sequence number. */
  private async fetchContentUpdate(text: string, cardId: string, sequence: number): Promise<void> {
    const fetchStart = Date.now();
    const token = await getTenantToken(this.creds);
    const response = await undiciFetch(
      `https://open.feishu.cn/open-apis/cardkit/v1/cards/${cardId}/elements/content/content`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: text,
          sequence,
          uuid: `s_${cardId}_${sequence}`,
        }),
        dispatcher: feishuHttpAgent,
      },
    );

    const elapsed = Date.now() - fetchStart;
    this.log?.(`fetchContentUpdate seq=${sequence} done: ${elapsed}ms, status=${response.status}, textLen=${text.length}`);

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch { /* ignore */ }
      this.log?.(`Update content failed with HTTP ${response.status} (seq ${sequence}): ${detail}`);

      // Frequency limit (99991400): auto-throttle and retry once
      if (detail.includes("99991400") || detail.includes("frequency limit")) {
        this.updateThrottleMs = Math.min(this.updateThrottleMs * 2, 2000);
        this.log?.(`Frequency limit hit — auto-throttled to ${this.updateThrottleMs}ms, retrying seq ${sequence}`);
        await new Promise((r) => setTimeout(r, this.updateThrottleMs));
        const retryRes = await undiciFetch(
          `https://open.feishu.cn/open-apis/cardkit/v1/cards/${cardId}/elements/content/content`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${await getTenantToken(this.creds)}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content: text,
              sequence,
              uuid: `s_${cardId}_${sequence}_r`,
            }),
            dispatcher: feishuHttpAgent,
          },
        );
        if (!retryRes.ok) {
          const retryDetail = await retryRes.text().catch(() => "");
          this.log?.(`Retry seq ${sequence} also failed: HTTP ${retryRes.status}: ${retryDetail}`);
        } else {
          this.log?.(`Retry seq ${sequence} succeeded`);
        }
      }

      if (response.status === 400 && (detail.includes("200850") || detail.includes("300309"))) {
        this.cardTimedOutFlag = true;
        this.log?.(`Card streaming timed out (200850/300309) — card is no longer updatable`);
      }
    }
  }

  /** Track a fire-and-forget request so close() can drain it before finalising. */
  private trackInFlight(promise: Promise<void>): void {
    this.inFlight.add(promise);
    promise
      .then(() => this.inFlight.delete(promise))
      .catch(() => this.inFlight.delete(promise));
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