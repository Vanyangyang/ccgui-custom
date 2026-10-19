import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_PREF_KEY } from "./persistence";
import { readPermissionPref } from "./permissions";

const runtime = vi.hoisted(() => ({ web: false }));
vi.mock("@/lib/transport", () => ({ get isWeb() { return runtime.web; } }));

beforeEach(() => {
  localStorage.clear();
  runtime.web = false;
});

describe.each([
  { web: true, fallback: "auto" },
  { web: false, fallback: "auto" },
])("permission preference (web=$web)", ({ web, fallback }) => {
  beforeEach(() => { runtime.web = web; });

  it("uses the platform default without a saved choice", () => {
    expect(readPermissionPref()).toBe(fallback);
    expect(localStorage.getItem(PERMISSION_PREF_KEY)).toBeNull();
  });

  it("uses the platform default for an invalid saved choice", () => {
    localStorage.setItem(PERMISSION_PREF_KEY, "unknown");
    expect(readPermissionPref()).toBe(fallback);
  });

  it.each(["auto", "manual", "plan", "bypass"])("preserves the explicit %s choice", (permission) => {
    localStorage.setItem(PERMISSION_PREF_KEY, permission);
    expect(readPermissionPref()).toBe(permission);
  });
});
