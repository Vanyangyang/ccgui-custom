/**
 * `/mcp` 面板的开关状态。放在独立 store 里，让输入框（slash picker / 提交
 * 拦截）能直接打开面板，而面板挂在会话树上，不经过 composer props 链。
 */
import { create } from "zustand";

interface McpPanelState {
  open: boolean;
  openPanel(): void;
  closePanel(): void;
}

export const useMcpPanel = create<McpPanelState>((set) => ({
  open: false,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
}));
