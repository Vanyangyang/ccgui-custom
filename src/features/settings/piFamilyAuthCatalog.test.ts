import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { zh } from "@/i18n/zh";
import { PI_FAMILY_OAUTH_PROVIDERS } from "./piFamilyAuthCatalog";

describe("PI_FAMILY_OAUTH_PROVIDERS", () => {
  it("includes google-antigravity in omp OAuth providers", () => {
    const antigravity = PI_FAMILY_OAUTH_PROVIDERS.omp.find(
      (p) => p.id === "google-antigravity",
    );
    expect(antigravity).toBeDefined();
    expect(antigravity?.loginArg).toBe("google-antigravity");
    expect(antigravity?.statusIds).toContain("google-antigravity");
    expect(antigravity?.descKey).toBe("antigravity");
  });

  it("retains google-gemini-cli alongside google-antigravity for backward compatibility", () => {
    const geminiCli = PI_FAMILY_OAUTH_PROVIDERS.omp.find(
      (p) => p.id === "google-gemini-cli",
    );
    expect(geminiCli).toBeDefined();
    expect(geminiCli?.loginArg).toBe("google-gemini-cli");
  });

  it("ensures every OAuth provider has corresponding translation keys in zh and en", () => {
    const allProviders = [
      ...PI_FAMILY_OAUTH_PROVIDERS.pi,
      ...PI_FAMILY_OAUTH_PROVIDERS.omp,
    ];

    for (const provider of allProviders) {
      const suffix =
        provider.descKey.charAt(0).toUpperCase() + provider.descKey.slice(1);
      const descKey = `piAuthOauthDesc${suffix}` as keyof typeof zh.settings;

      expect(zh.settings[descKey]).toBeDefined();
      expect(typeof zh.settings[descKey]).toBe("string");
      expect((zh.settings[descKey] as string).length).toBeGreaterThan(0);

      expect(en.settings[descKey]).toBeDefined();
      expect(typeof en.settings[descKey]).toBe("string");
      expect((en.settings[descKey] as string).length).toBeGreaterThan(0);
    }
  });
});
