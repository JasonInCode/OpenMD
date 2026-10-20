import { create } from "zustand";

/**
 * 跨组件触发的 UI 浮层开关(不持久化):设置弹窗、未来的对话框等。
 * 状态独立成 store 避免在 TitleBar / StatusBar / EmptyState 之间层层回传 props。
 */
interface UIState {
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
}

export const useUI = create<UIState>((set) => ({
  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),
}));