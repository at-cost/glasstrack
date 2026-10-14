import { describe, expect, it } from "vitest";
import { keyBetween, keysAfter } from "./sortKey";
import { extractMentions, parseIssueKey } from "./text";

describe("keyBetween", () => {
  it("handles open ends", () => {
    const k = keyBetween(null, null);
    expect(keyBetween(null, k) < k).toBe(true);
    expect(keyBetween(k, null) > k).toBe(true);
  });
  it("always returns a key strictly between its bounds", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const keys: string[] = [keyBetween(null, null)];
    for (let i = 0; i < 3000; i++) {
      const pos = Math.floor(rand() * (keys.length + 1));
      const a = keys[pos - 1] ?? null;
      const b = keys[pos] ?? null;
      const k = keyBetween(a, b);
      if (a !== null) expect(k > a).toBe(true);
      if (b !== null) expect(k < b).toBe(true);
      expect(k.endsWith("0")).toBe(false);
      keys.splice(pos, 0, k);
    }
    expect([...keys].sort()).toEqual(keys);
  });
  it("survives repeated inserts at the front and between adjacent keys", () => {
    let first = keyBetween(null, null);
    for (let i = 0; i < 500; i++) {
      const k = keyBetween(null, first);
      expect(k < first).toBe(true);
      first = k;
    }
    let a = "a";
    const b = "b";
    for (let i = 0; i < 500; i++) {
      const k = keyBetween(a, b);
      expect(k > a && k < b).toBe(true);
      a = k;
    }
  });
  it("rejects bad input", () => {
    expect(() => keyBetween("b", "a")).toThrow();
    expect(() => keyBetween("a0", null)).toThrow();
  });
  it("keysAfter is increasing", () => {
    const ks = keysAfter(null, 50);
    expect([...ks].sort()).toEqual(ks);
    expect(new Set(ks).size).toBe(50);
  });
});

describe("text helpers", () => {
  it("extracts mentions but not emails or code", () => {
    expect(extractMentions("hi @alice and @Bob.smith, mail x@y.com `@code` ```\n@block\n```")).toEqual([
      "alice",
      "bob.smith",
    ]);
  });
  it("parses issue keys", () => {
    expect(parseIssueKey("eng-12")).toEqual({ key: "ENG", number: 12 });
    expect(parseIssueKey("12")).toBeNull();
  });
});
