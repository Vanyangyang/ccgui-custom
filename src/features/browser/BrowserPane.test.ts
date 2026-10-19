import { describe, expect, it } from "vitest";
import { browserTabLabel, normalizeAddress } from "./address";

describe("normalizeAddress", () => {
  it("passes through values that already carry a scheme", () => {
    expect(normalizeAddress("https://example.com/a b")).toBe("https://example.com/a b");
    expect(normalizeAddress("http://192.168.1.1:8080/x")).toBe("http://192.168.1.1:8080/x");
  });

  it("prefixes https:// for host-like input", () => {
    expect(normalizeAddress("example.com")).toBe("https://example.com");
    expect(normalizeAddress("docs.example.com/path?q=1")).toBe("https://docs.example.com/path?q=1");
  });

  it("prefixes http:// for localhost and IP addresses", () => {
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeAddress("127.0.0.1:3000/app")).toBe("http://127.0.0.1:3000/app");
  });

  it("falls back to a Bing search for anything else", () => {
    expect(normalizeAddress("claude code 教程")).toBe(
      `https://www.google.com/search?q=${encodeURIComponent("claude code 教程")}`,
    );
    expect(normalizeAddress("")).toBe("");
  });
});

describe("browserTabLabel", () => {
  const tab = (url: string, title = "") => ({ id: "b1", url, title });

  it("prefers the document title", () => {
    expect(browserTabLabel(tab("https://example.com", "Example"), "fallback")).toBe("Example");
  });

  it("falls back to the host, then the generic label", () => {
    expect(browserTabLabel(tab("https://example.com/path"), "fallback")).toBe("example.com");
    expect(browserTabLabel(tab("not a url"), "fallback")).toBe("fallback");
  });
});
