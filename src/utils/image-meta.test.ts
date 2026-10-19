import { describe, expect, it } from "vitest";

import { dataUrlBytes, formatFileSize, imageMetaText } from "./image-meta";

describe("formatFileSize", () => {
  it("formats bytes, KB and MB like the reference UI", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    // The reference screenshot's value.
    expect(formatFileSize(187.5 * 1024)).toBe("187.5 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("returns an empty string for invalid input so callers can omit it", () => {
    expect(formatFileSize(Number.NaN)).toBe("");
    expect(formatFileSize(-1)).toBe("");
  });
});

describe("dataUrlBytes", () => {
  const png = (bytes: number[]) =>
    `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

  it("recovers the exact byte length across base64 padding cases", () => {
    expect(dataUrlBytes(png([1]))).toBe(1); // "==" padding
    expect(dataUrlBytes(png([1, 2]))).toBe(2); // "=" padding
    expect(dataUrlBytes(png([1, 2, 3]))).toBe(3); // no padding
    expect(dataUrlBytes(png(Array.from({ length: 1000 }, (_, i) => i % 256)))).toBe(1000);
  });

  it("returns null for non-data URLs", () => {
    expect(dataUrlBytes("https://example.com/a.png")).toBeNull();
    expect(dataUrlBytes("data:")).toBeNull();
  });
});

describe("imageMetaText", () => {
  it("joins dimensions and size with the reference separator", () => {
    expect(imageMetaText({ width: 792, height: 964, size: 187.5 * 1024 })).toBe(
      "792 × 964 · 187.5 KB",
    );
  });

  it("degrades to whichever field is known, empty when neither is", () => {
    expect(imageMetaText({ width: 792, height: 964 })).toBe("792 × 964");
    expect(imageMetaText({ size: 1024 })).toBe("1.0 KB");
    expect(imageMetaText({})).toBe("");
  });
});
