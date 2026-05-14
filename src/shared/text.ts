export function toText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  return String(value);
}

export { normalizeOptionalLowercaseString, normalizeLowercaseStringOrEmpty } from "./string-coerce.js";
