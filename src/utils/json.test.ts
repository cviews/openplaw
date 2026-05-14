import { describe, it, expect } from "vitest";
import { stripJsonc } from "./json.js";

describe("stripJsonc", () => {
  it("leaves normal JSON unchanged", () => {
    const input = '{"key": "value", "num": 42}';
    expect(stripJsonc(input)).toBe(input);
  });

  it("strips a line comment", () => {
    const input = '{\n  "key": "value" // this is a comment\n}';
    const expected = '{\n  "key": "value" \n}';
    expect(stripJsonc(input)).toBe(expected);
  });

  it("strips multiple line comments", () => {
    const input = '// top comment\n{\n  // field comment\n  "a": 1\n}';
    const expected = '\n{\n  \n  "a": 1\n}';
    expect(stripJsonc(input)).toBe(expected);
  });

  it("preserves // inside double-quoted strings", () => {
    const input = '{"url": "https://example.com"}';
    expect(stripJsonc(input)).toBe(input);
  });

  it("preserves // inside single-quoted strings", () => {
    const input = "{'url': 'https://example.com'}";
    expect(stripJsonc(input)).toBe(input);
  });

  it("strips comment on a line without quoted strings", () => {
    const input = '{"a": 1} // trailing comment';
    const expected = '{"a": 1} ';
    expect(stripJsonc(input)).toBe(expected);
  });

  it("handles a full-line comment returning empty string", () => {
    const input = "// just a comment";
    expect(stripJsonc(input)).toBe("");
  });

  it("preserves // inside a string when followed by other text", () => {
    const input = '{"a": "x//y"}';
    expect(stripJsonc(input)).toBe(input);
  });

  it("handles mixed comments and non-comments across lines", () => {
    const input = [
      "{",
      '  "name": "test", // inline comment',
      '  "url": "https://foo.bar",',
      "  // full line comment",
      '  "val": 42',
      "}",
    ].join("\n");
    const expected = [
      "{",
      '  "name": "test", ',
      '  "url": "https://foo.bar",',
      "  ",
      '  "val": 42',
      "}",
    ].join("\n");
    expect(stripJsonc(input)).toBe(expected);
  });

  it("handles empty string", () => {
    expect(stripJsonc("")).toBe("");
  });

  it("leaves lines without // unchanged", () => {
    const input = '{"a": 1, "b": 2}';
    expect(stripJsonc(input)).toBe(input);
  });
});
