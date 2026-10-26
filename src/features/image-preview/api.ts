import { invoke, listen } from "@/lib/transport";
import { isWeb } from "@/lib/platform";

export type ImagePreviewScope = "file" | "directory";
export interface ImagePreviewGrant { path: string; scope: ImagePreviewScope }
const native = <T,>(command: string, args?: Record<string, unknown>) => isWeb
  ? Promise.reject(new Error("Desktop only")) : invoke<T>(command, args);
export const imagePreview = {
  scopes: (path: string) => invoke<ImagePreviewGrant[]>("image_preview_scope", { path }),
  list: () => invoke<ImagePreviewGrant[]>("list_image_preview_grants"),
  grant: (path: string, scope: ImagePreviewScope, expectedPath: string) => native<ImagePreviewGrant>("grant_image_preview", { path, scope, expectedPath }),
  revoke: (path: string, scope: ImagePreviewScope) => invoke<void>("revoke_image_preview_grant", { path, scope }),
  readBytes: (path: string) => invoke<ArrayBuffer>("read_preview_image_bytes", { path }),
  readDataUrl: (path: string) => invoke<string>("read_preview_image", { path }),
  changed: async (callback: () => void) => {
    const subscriptions = await Promise.allSettled([
      listen("image-preview-grants://changed", callback),
      listen("transport://connected", callback),
      listen("granted-roots://changed", callback),
      listen("workspace-roots://changed", callback),
    ]);
    const stops = subscriptions.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const failed = subscriptions.find(result => result.status === "rejected");
    if (failed?.status === "rejected") {
      stops.forEach(stop => stop());
      throw failed.reason;
    }
    return () => stops.forEach(stop => stop());
  },
};
