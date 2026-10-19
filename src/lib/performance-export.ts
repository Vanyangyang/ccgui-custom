import { ipc } from "./ipc";
import { isWeb, pickSavePath } from "./platform";
import type { PerformanceReport } from "./performance-summary";

export async function exportPerformanceReport(report: PerformanceReport, title: string): Promise<"saved" | "downloaded" | "cancelled"> {
  const filename = `ccgui-performance-${report.generatedAt.replace(/[^0-9TZ]/g, "-")}.json`;
  const content = JSON.stringify(report);
  if (!isWeb) {
    const path = await pickSavePath(title, filename);
    if (!path) return "cancelled";
    await ipc.writeFile(path, content);
    return "saved";
  }
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    return "downloaded";
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
