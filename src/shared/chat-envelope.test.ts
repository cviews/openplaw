import { describe, it, expect } from "vitest";
import { stripEnvelope, stripMessageIdHints } from "./chat-envelope";

describe("stripEnvelope", () => {
  it("removes single [omo:...] marker", () => {
    const input = "Hello [omo:secret] world";
    expect(stripEnvelope(input)).toBe("Hello  world");
  });

  it("removes multiple [omo:...] markers", () => {
    const input = "[omo:start]Hello [omo:mid]world[omo:end]";
    expect(stripEnvelope(input)).toBe("Hello world");
  });

  it("returns original text when no markers present", () => {
    const input = "Hello world";
    expect(stripEnvelope(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(stripEnvelope("")).toBe("");
  });
});

describe("stripMessageIdHints", () => {
  it("removes <!-- msg:id --> comment", () => {
    const input = "Hello <!-- msg:12345 --> world";
    expect(stripMessageIdHints(input)).toBe("Hello  world");
  });

  it("removes multiple msg id comments", () => {
    const input = "<!-- msg:one -->Hello<!-- msg:two -->world";
    expect(stripMessageIdHints(input)).toBe("Helloworld");
  });

  it("returns original text when no comments present", () => {
    const input = "Hello world";
    expect(stripMessageIdHints(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(stripMessageIdHints("")).toBe("");
  });
});
