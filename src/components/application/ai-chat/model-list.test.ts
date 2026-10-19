import { describe, expect, it } from "vitest";
import { filterModels, groupModelsByProvider } from "./model-list";
import type { ModelOption } from "./cli-menu";

const model = (
  id: string,
  label: string,
  provider?: string,
): ModelOption => ({ id, label, provider });

/** Two relays serving the same model id: the report was that these read as
 *  identical rows once the list was filtered (no section headers, no source). */
const RELAYS: ModelOption[] = [
  model("agentrouter/deepseek-v4-flash", "deepseek-v4-flash", "agentrouter"),
  model("laowang/deepseek-v4-flash", "deepseek-v4-flash", "老王"),
  model("agentrouter/deepseek-v4-pro", "deepseek-v4-pro", "agentrouter"),
];

describe("groupModelsByProvider", () => {
  it("keeps section keys when the list truly mixes providers", () => {
    const groups = groupModelsByProvider(RELAYS);
    expect(groups.map((g) => g.key)).toEqual(["agentrouter", "老王"]);
  });

  it("keeps the header when a filter narrowed the list to one provider", () => {
    // Filtering to a single relay used to drop the header, leaving rows that
    // no longer said where the model came from — the reported regression.
    const groups = groupModelsByProvider([RELAYS[0], RELAYS[2]]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("agentrouter");
    expect(groups[0].rows).toHaveLength(2);
  });

  it("treats a provider-less catalog as keyless too", () => {
    const groups = groupModelsByProvider([model("gpt-5", "gpt-5")]);
    expect(groups).toEqual([{ key: "", rows: [model("gpt-5", "gpt-5")] }]);
  });
});

describe("filterModels", () => {
  it("passes the catalog through untouched for an empty query", () => {
    expect(filterModels(RELAYS, "")).toBe(RELAYS);
  });

  it("narrows to one relay when the query names its provider", () => {
    const hit = filterModels(RELAYS, "老王");
    expect(hit.map((m) => m.id)).toEqual(["laowang/deepseek-v4-flash"]);
  });

  it("matches provider alongside label and id", () => {
    // The panel lowercases the query before calling in (see EngineModelPanel).
    expect(filterModels(RELAYS, "agentrouter").map((m) => m.id)).toEqual([
      "agentrouter/deepseek-v4-flash",
      "agentrouter/deepseek-v4-pro",
    ]);
    expect(filterModels(RELAYS, "v4-pro").map((m) => m.id)).toEqual([
      "agentrouter/deepseek-v4-pro",
    ]);
  });
});
