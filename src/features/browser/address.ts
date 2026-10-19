import type { BrowserTab } from "./store";

/** Address-bar entry: an explicit scheme passes through; something that
 * looks like a host gets https://; anything else becomes a Bing search
 * (Google is unreachable for many users here). */
export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (!value) return "";
  // localhost/IPs first: "localhost:5173" would otherwise parse as a scheme.
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/.test(value)) return `http://${value}`;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

/** Display label for a browser tab: document title, else host, else the
 * generic new-tab label. */
export function browserTabLabel(tab: BrowserTab, fallback: string): string {
  if (tab.title) return tab.title;
  try {
    return new URL(tab.url).hostname || fallback;
  } catch {
    return fallback;
  }
}
