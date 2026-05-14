export function readStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export function normalizeNullableString(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  return value.trim();
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim();
}

export function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

export function lowercasePreservingWhitespace(value: string): string {
  return value.trim().toLowerCase();
}

export function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
