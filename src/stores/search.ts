import { create } from "zustand";

/** 命中落在某个文本节点里的一段。 */
export interface TextPart {
  node: Text;
  start: number;
  end: number;
}

/**
 * 一处命中。命中可能跨多个文本节点:行内格式、代码高亮都会把一句话拆成几段,
 * 拆开之后就搜不到「def main」这种连贯的词了。
 */
export interface TextMatch {
  parts: TextPart[];
}

/**
 * 顶栏搜索框的状态:显隐、查询词、当前文档里的命中与当前命中序号。
 * 命中的计算在 lib/documentSearch.ts(要碰 DOM),这里只存结果给 UI 读。
 */
interface SearchState {
  open: boolean;
  query: string;
  /** 当前文档里的全部命中,按出现顺序。 */
  matches: TextMatch[];
  /** 当前命中的 0 基序号;-1 表示还没有命中可选(界面按 1 起显示,没选中时显示 0)。 */
  index: number;
  setOpen: (v: boolean) => void;
  setQuery: (q: string) => void;
  setMatches: (matches: TextMatch[], index: number) => void;
}

export const useSearch = create<SearchState>((set) => ({
  open: false,
  query: "",
  matches: [],
  index: -1,
  setOpen: (open) => set({ open }),
  setQuery: (query) => set({ query }),
  setMatches: (matches, index) => set({ matches, index }),
}));
