import { safeEqualSecret } from "../../../security/secret-equal.js";
import * as crypto from "node:crypto";

export function verifyFeishuWebhook(params: {
  verificationToken: string;
  encryptKey: string;
  body: string;
  timestamp: string;
  nonce: string;
  signature: string;
}): boolean {
  const { timestamp, nonce, encryptKey, body, signature } = params;

  if (!timestamp || !nonce || !signature) return false;

  // Reject expired timestamps (more than 1 hour old)
  const ts = Number(timestamp);
  if (Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 3600) return false;

  // Feishu v2 verification: base64(sha256(timestamp + nonce + encryptKey + body))
  const content = `${timestamp}\n${nonce}\n${encryptKey}\n${body}`;
  const hash = crypto.createHash("sha256");
  hash.update(content);
  const expected = hash.digest("base64");

  return safeEqualSecret(signature, expected);
}
