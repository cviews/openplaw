import { describe, it, expect } from "vitest";
import {
  extractFirstTextBlock,
  normalizeAssistantPhase,
  parseAssistantTextSignature,
  encodeAssistantTextSignature,
  extractAssistantVisibleText,
} from "./chat-message-content";

describe("extractFirstTextBlock", () => {
  it("returns string directly when input is string", () => {
    expect(extractFirstTextBlock("Hello world")).toBe("Hello world");
  });

  it("returns .text field when present", () => {
    expect(extractFirstTextBlock({ text: "from text field" })).toBe("from text field");
  });

  it("returns .content field when .text not present", () => {
    expect(extractFirstTextBlock({ content: "from content field" })).toBe("from content field");
  });

  it("returns .message field when other text fields not present", () => {
    expect(extractFirstTextBlock({ message: "from message field" })).toBe("from message field");
  });

  it("finds first string element in array", () => {
    expect(extractFirstTextBlock([null, "first string", "second string"])).toBe("first string");
  });

  it("searches nested arrays for first string", () => {
    expect(extractFirstTextBlock([null, [undefined, "nested string"]])).toBe("nested string");
  });

  it("returns undefined for non-string object without text fields", () => {
    expect(extractFirstTextBlock({ foo: "bar" })).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(extractFirstTextBlock(null)).toBeUndefined();
  });

  it("returns undefined for number", () => {
    expect(extractFirstTextBlock(123)).toBeUndefined();
  });
});

describe("normalizeAssistantPhase", () => {
  it("returns commentary for valid input", () => {
    expect(normalizeAssistantPhase("commentary")).toBe("commentary");
    expect(normalizeAssistantPhase("COMMENTARY")).toBe("commentary");
  });

  it("returns final_answer for valid input", () => {
    expect(normalizeAssistantPhase("final_answer")).toBe("final_answer");
    expect(normalizeAssistantPhase("Final_Answer")).toBe("final_answer");
  });

  it("returns undefined for invalid phase", () => {
    expect(normalizeAssistantPhase("invalid")).toBeUndefined();
    expect(normalizeAssistantPhase(123)).toBeUndefined();
    expect(normalizeAssistantPhase(null)).toBeUndefined();
  });
});

describe("signature round-trip", () => {
  it("round-trips with id only", () => {
    const id = "msg-123";
    const encoded = encodeAssistantTextSignature({ id });
    const parsed = parseAssistantTextSignature(encoded);
    expect(parsed).toEqual({ id });
  });

  it("round-trips with id and phase commentary", () => {
    const params = { id: "msg-123", phase: "commentary" } as const;
    const encoded = encodeAssistantTextSignature(params);
    const parsed = parseAssistantTextSignature(encoded);
    expect(parsed).toEqual(params);
  });

  it("round-trips with id and phase final_answer", () => {
    const params = { id: "msg-456", phase: "final_answer" } as const;
    const encoded = encodeAssistantTextSignature(params);
    const parsed = parseAssistantTextSignature(encoded);
    expect(parsed).toEqual(params);
  });
});

describe("parseAssistantTextSignature", () => {
  it("returns null when not starting with sig:", () => {
    expect(parseAssistantTextSignature("not-sig:123")).toBeNull();
  });

  it("returns null when not enough parts", () => {
    expect(parseAssistantTextSignature("sig:")).toBeNull();
  });

  it("ignores invalid phases", () => {
    const result = parseAssistantTextSignature("sig:abc:invalid");
    expect(result).toEqual({ id: "abc" });
  });
});

describe("extractAssistantVisibleText", () => {
  it("extracts and strips all internal markers", () => {
    const input = "[omo:internal]Hello <!-- msg:123 -->world";
    const result = extractAssistantVisibleText(input);
    expect(result).toBe("Hello world");
  });

  it("returns undefined when no text can be extracted", () => {
    expect(extractAssistantVisibleText({})).toBeUndefined();
  });
});
