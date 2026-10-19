import { describe, expect, it } from "vitest";
import {
  extractProviderBlock,
  removeProviderBlock,
  replaceProviderBlock,
} from "./piFamilyModelsBlocks";

const yamlConfig = `providers:
  first:
    baseUrl: https://first.example
    models:
      - id: first-model

  target:
    baseUrl: https://target.example
    headers:
      X-Test: "{}"
    models:
      - id: target-model
        name: "target // model"
  last:
    baseUrl: https://last.example
# top-level comment
`;

const jsoncConfig = `{
  // provider catalog
  "providers": {
    "first": {
      "baseUrl": "https://first.example",
      "models": [{ "id": "first-{model}" }]
    },
    /* target comment */
    "target": {
      "baseUrl": "https://target.example",
      "headers": { "X-Test": "// not a comment" },
      "models": [{ "id": "target-model", "shape": "{}" }]
    },
    "last": { "baseUrl": "https://last.example" }
  }
}
`;

describe("extractProviderBlock", () => {
  it("extracts one YAML provider without swallowing siblings or comments", () => {
    const block = extractProviderBlock(yamlConfig, "yaml", "target");

    expect(block).not.toBeNull();
    expect(block?.text).toBe(`  target:
    baseUrl: https://target.example
    headers:
      X-Test: "{}"
    models:
      - id: target-model
        name: "target // model"`);
    expect(yamlConfig.slice(0, block!.start)).toContain("first-model");
    expect(yamlConfig.slice(block!.end)).toContain("  last:");
    expect(yamlConfig.slice(block!.end)).toContain("# top-level comment");
  });

  it("extracts the final YAML provider through EOF", () => {
    const config = "providers:\r\n    first:\r\n      baseUrl: https://first.example\r\n    last:\r\n      baseUrl: https://last.example";
    const block = extractProviderBlock(config, "yaml", "last");

    expect(block?.text).toBe("    last:\r\n      baseUrl: https://last.example");
  });

  it("returns null for a provider that is not present", () => {
    expect(extractProviderBlock(yamlConfig, "yaml", "missing")).toBeNull();
    expect(extractProviderBlock(jsoncConfig, "json", "missing")).toBeNull();
  });

  it("extracts a JSONC provider while respecting comments and nested strings", () => {
    const block = extractProviderBlock(jsoncConfig, "json", "target");

    expect(block).not.toBeNull();
    expect(block?.text).toContain('"target": {');
    expect(block?.text).toContain('"// not a comment"');
    expect(block?.text).toContain('"shape": "{}"');
    expect(jsoncConfig.slice(0, block!.start)).toContain('"first"');
    expect(jsoncConfig.slice(block!.end)).toContain('"last"');
  });
});

describe("replaceProviderBlock", () => {
  it("round-trips an unchanged YAML block byte-for-byte", () => {
    const block = extractProviderBlock(yamlConfig, "yaml", "target");
    expect(block).not.toBeNull();

    expect(replaceProviderBlock(yamlConfig, block!, block!.text)).toBe(yamlConfig);
  });

  it("changes only the selected JSONC provider block", () => {
    const block = extractProviderBlock(jsoncConfig, "json", "target");
    expect(block).not.toBeNull();
    const edited = block!.text.replace(
      "https://target.example",
      "https://edited.example",
    );
    const next = replaceProviderBlock(jsoncConfig, block!, edited);

    expect(next).toContain("https://edited.example");
    expect(next).not.toContain("https://target.example");
    expect(next).toContain("https://first.example");
    expect(next).toContain("https://last.example");
    expect(next).toContain("/* target comment */");
  });
});
describe("removeProviderBlock", () => {
  it("removes one YAML provider while preserving the other providers", () => {
    const block = extractProviderBlock(yamlConfig, "yaml", "target");
    expect(block).not.toBeNull();

    const next = removeProviderBlock(yamlConfig, block!, "yaml");
    expect(next).not.toContain("target.example");
    expect(next).toContain("first.example");
    expect(next).toContain("last.example");
    expect(next).toContain("# top-level comment");
  });

  it("removes the first, middle, and last JSONC properties without breaking commas", () => {
    const urls = {
      first: "https://first.example",
      target: "https://target.example",
      last: "https://last.example",
    } as const;
    for (const providerId of Object.keys(urls) as Array<keyof typeof urls>) {
      const block = extractProviderBlock(jsoncConfig, "json", providerId);
      expect(block).not.toBeNull();

      const next = removeProviderBlock(jsoncConfig, block!, "json");
      const jsonWithoutComments = next
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(() => JSON.parse(jsonWithoutComments)).not.toThrow();
      expect(next).not.toContain(`\"${providerId}\"`);
      expect(next).toContain('"providers": {');
      for (const [id, url] of Object.entries(urls)) {
        if (id === providerId) {
          expect(next).not.toContain(url);
        } else {
          expect(next).toContain(url);
        }
      }
    }
  });
});
