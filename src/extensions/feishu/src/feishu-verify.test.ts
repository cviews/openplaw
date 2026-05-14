import { describe, it, expect, vi } from "vitest";
import * as crypto from "node:crypto";
import { verifyFeishuWebhook } from "./feishu-verify.js";

function computeFeishuV2Signature(
  encryptKey: string,
  nonce: string,
  body: string,
  timestamp: string,
): string {
  const content = `${timestamp}\n${nonce}\n${encryptKey}\n${body}`;
  return crypto.createHash("sha256").update(content).digest("base64");
}

const baseParams = {
  verificationToken: "test-verification-token",
  encryptKey: "test-encrypt-key",
  body: '{"event":{"message":{"content":"hello"}}}',
  nonce: "test-nonce-123",
  timestamp: String(Math.floor(Date.now() / 1000)),
  signature: "",
};

describe("verifyFeishuWebhook", () => {
  it("returns true for a correct signature", () => {
    const signature = computeFeishuV2Signature(
      baseParams.encryptKey,
      baseParams.nonce,
      baseParams.body,
      baseParams.timestamp,
    );
    expect(
      verifyFeishuWebhook({ ...baseParams, signature }),
    ).toBe(true);
  });

  it("returns false for a wrong signature with same byte length", () => {
    const wrongSig = crypto.createHash("sha256").update("wrong-content").digest("base64");
    expect(
      verifyFeishuWebhook({ ...baseParams, signature: wrongSig }),
    ).toBe(false);
  });

  it("returns false for an expired timestamp (> 3600s old)", () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 4000);
    const signature = computeFeishuV2Signature(
      baseParams.encryptKey,
      baseParams.nonce,
      baseParams.body,
      oldTimestamp,
    );
    expect(
      verifyFeishuWebhook({ ...baseParams, timestamp: oldTimestamp, signature }),
    ).toBe(false);
  });

  it("returns false for a future timestamp far in the future", () => {
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 4000);
    const signature = computeFeishuV2Signature(
      baseParams.encryptKey,
      baseParams.nonce,
      baseParams.body,
      futureTimestamp,
    );
    expect(
      verifyFeishuWebhook({ ...baseParams, timestamp: futureTimestamp, signature }),
    ).toBe(false);
  });

  it("returns false when timestamp header is missing", () => {
    const signature = computeFeishuV2Signature(
      baseParams.encryptKey,
      baseParams.nonce,
      baseParams.body,
      baseParams.timestamp,
    );
    expect(
      verifyFeishuWebhook({ ...baseParams, timestamp: "", signature }),
    ).toBe(false);
  });

  it("returns false when nonce header is missing", () => {
    const signature = computeFeishuV2Signature(
      baseParams.encryptKey,
      baseParams.nonce,
      baseParams.body,
      baseParams.timestamp,
    );
    expect(
      verifyFeishuWebhook({ ...baseParams, nonce: "", signature }),
    ).toBe(false);
  });

  it("returns false when signature header is missing", () => {
    expect(
      verifyFeishuWebhook({ ...baseParams, signature: "" }),
    ).toBe(false);
  });

  it("returns false for NaN timestamp", () => {
    expect(
      verifyFeishuWebhook({ ...baseParams, timestamp: "notanumber", signature: "somesig" }),
    ).toBe(false);
  });

  it("uses safeEqualSecret (not regular string comparison)", async () => {
    const signature = computeFeishuV2Signature(
      baseParams.encryptKey,
      baseParams.nonce,
      baseParams.body,
      baseParams.timestamp,
    );

    verifyFeishuWebhook({ ...baseParams, signature });

    const verifyModule = await import("./feishu-verify.js");
    expect(verifyModule.verifyFeishuWebhook).toBe(verifyFeishuWebhook);

    const secretEqualModule = await import("../../../security/secret-equal.js");
    const safeEqualSpy = vi.spyOn(secretEqualModule, "safeEqualSecret");

    verifyFeishuWebhook({ ...baseParams, signature });

    expect(safeEqualSpy).toHaveBeenCalled();
    safeEqualSpy.mockRestore();
  });
});
