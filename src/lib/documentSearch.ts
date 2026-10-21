import { useSearch, type TextMatch } from "../stores/search";

/** 不参与查找的标签:脚本、样式,以及正文里插入的复制按钮。 */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "BUTTON"]);

/** 块级标签:不同块之间的文字不该被拼成一处命中。 */
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

const HIGHLIGHT_ALL = "md-find";
const HIGHLIGHT_CURRENT = "md-find-current";

/** TS 5.8 的 HighlightRegistry 只声明了 forEach,set/delete 是运行时真实存在的方法。 */
type WritableHighlightRegistry = HighlightRegistry & {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
};

/** 文本节点所属的块:用于判断两段文字之间是不是隔了个段落。 */
function blockOf(el: Element, root: HTMLElement): Element {
  let cur: Element | null = el;
  while (cur && cur !== root) {
    if (BLOCK_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentElement;
  }
  return root;
}

/**
 * 收集根节点下的全部命中,大小写不敏感。
 * 命中按「块内连续文本」算:同一段里的行内标签不算隔断,段落之间算隔断。
 */
export function collectMatches(root: HTMLElement, query: string): TextMatch[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  // 文本节点按文档顺序摊平成一条长文本,每段记住自己在长文本里的位置。
  const segments: { node: Text; flatStart: number; len: number; block: Element }[] = [];
  let flat = "";
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    const parent = node.parentElement;
    if (!text || !parent) continue;
    const block = blockOf(parent, root);
    // 换块就插一个隔断符,免得「粗」和下一段的「体」被拼成一处假命中。
    if (lastBlock !== null && block !== lastBlock) flat += "\n";
    segments.push({ node: node as Text, flatStart: flat.length, len: text.length, block });
    flat += text;
    lastBlock = block;
  }

  const haystack = flat.toLowerCase();
  const out: TextMatch[] = [];
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    from = at + needle.length;
    const end = from;
    const parts: TextMatch["parts"] = [];
    let block: Element | null = null;
    let crossesBlock = false;
    for (const seg of segments) {
      if (seg.flatStart + seg.len <= at || seg.flatStart >= end) continue;
      if (block === null) block = seg.block;
      else if (block !== seg.block) crossesBlock = true;
      const s = Math.max(at, seg.flatStart);
      const e = Math.min(end, seg.flatStart + seg.len);
      parts.push({ node: seg.node, start: s - seg.flatStart, end: e - seg.flatStart });
    }
    if (parts.length === 0 || crossesBlock) continue;
    out.push({ parts });
  }
  return out;
}

/** 高亮注册表。运行时不支持 CSS Custom Highlight API 时返回 null。 */
function highlightRegistry(): WritableHighlightRegistry | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return null;
  if (typeof Highlight === "undefined") return null;
  return CSS.highlights as WritableHighlightRegistry;
}

/** 命中的文本区间。节点已经不在文档里(正文重渲染过)时返回 null。 */
function toRange(m: TextMatch): Range | null {
  const first = m.parts[0];
  const last = m.parts[m.parts.length - 1];
  if (!first || !last) return null;
  // 偏移是收集时算的,正文重渲染后节点可能已经换了:对不上就不画这一处。
  if (!first.node.isConnected || !last.node.isConnected) return null;
  if (first.start > (first.node.nodeValue?.length ?? 0)) return null;
  if (last.end > (last.node.nodeValue?.length ?? 0)) return null;
  const range = document.createRange();
  range.setStart(first.node, first.start);
  range.setEnd(last.node, last.end);
  return range;
}

/**
 * 画高亮。只用 CSS Custom Highlight API:它只给文本区间上色,不动 DOM,
 * 编辑态下不会把标记写进草稿。运行时不支持这个 API 时画不了颜色,
 * 命中数与跳转仍然照常。
 */
function paintHighlights(matches: TextMatch[], current: TextMatch | null): void {
  const registry = highlightRegistry();
  if (!registry) return;
  const ranges: Range[] = [];
  for (const m of matches) {
    const range = toRange(m);
    if (range) ranges.push(range);
  }
  registry.set(HIGHLIGHT_ALL, new Highlight(...ranges));
  const currentRange = current ? toRange(current) : null;
  const hl = new Highlight(...(currentRange ? [currentRange] : []));
  // 当前命中与普通命中重叠,靠 priority 保证它画在上层。
  hl.priority = 1;
  registry.set(HIGHLIGHT_CURRENT, hl);
}

function clearHighlights(): void {
  const registry = highlightRegistry();
  if (!registry) return;
  registry.delete(HIGHLIGHT_ALL);
  registry.delete(HIGHLIGHT_CURRENT);
}

let root: HTMLElement | null = null;
let refreshTimer = 0;

/** 登记要查找的正文根节点(预览模式的 article / 代码视图的 pre);传 null 表示取消登记。 */
export function registerSearchRoot(el: HTMLElement | null): void {
  clearHighlights();
  root = el;
  // 换了文档或视图,上一份文档里的「第 n 个」在这里没有意义。
  useSearch.setState({ index: -1 });
  refreshSearch();
}

/** 重新计算命中并重画高亮。正文内容换了之后要调,否则命中数停在旧内容上。 */
export function refreshSearch(): void {
  const state = useSearch.getState();
  if (!root || !state.query) {
    clearHighlights();
    state.setMatches([], -1);
    return;
  }
  const matches = collectMatches(root, state.query);
  const index = matches.length === 0 ? -1 : Math.min(state.index, matches.length - 1);
  state.setMatches(matches, index);
  paintHighlights(matches, index >= 0 ? matches[index] : null);
}

/** 合并短时间内的多次刷新请求(编辑态每次按键都会触发)。 */
export function scheduleSearchRefresh(): void {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    refreshSearch();
  }, 200);
}

/** 设置查询词:重新匹配,不预选命中(计数里显示 0/N)。 */
export function setSearchQuery(query: string): void {
  useSearch.getState().setQuery(query);
  useSearch.getState().setMatches([], -1);
  refreshSearch();
}

/** 在命中之间跳转:delta 为 1 是下一个,-1 是上一个,到头尾会绕回。 */
export function stepSearchMatch(delta: 1 | -1): void {
  const state = useSearch.getState();
  const { matches } = state;
  if (matches.length === 0) return;
  const next =
    state.index < 0
      ? delta === 1
        ? 0
        : matches.length - 1
      : (state.index + delta + matches.length) % matches.length;
  state.setMatches(matches, next);
  paintHighlights(matches, matches[next]);
  scrollToMatch(next);
}

function scrollToMatch(index: number): void {
  const m = useSearch.getState().matches[index];
  const el = m?.parts[0]?.node.parentElement;
  el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
}

/** 显示搜索框。 */
function openSearch(): void {
  useSearch.getState().setOpen(true);
}

/** 隐藏搜索框,并清掉查询词与高亮。 */
export function closeSearch(): void {
  const state = useSearch.getState();
  state.setOpen(false);
  state.setQuery("");
  state.setMatches([], -1);
  clearHighlights();
}

/** Ctrl+F:开着就收起,没开就弹出。 */
export function toggleSearch(): void {
  if (useSearch.getState().open) closeSearch();
  else openSearch();
}
