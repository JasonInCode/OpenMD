import { useMemo, useState } from "react";
import { Box, Button, HStack, IconButton, SegmentGroup, Text } from "@chakra-ui/react";
import { useTheme } from "next-themes";
import { Code2, Eye, Moon, Play, Settings, Sun } from "lucide-react";
import { withViewTransition } from "../utils/viewTransition";
import { isMarpFromSource } from "../renderer/pipeline";
import { isDirty, useTabs } from "../stores/tabs";
import { useSettings, type ViewMode } from "../stores/settings";
import { useToc } from "../stores/toc";
import { useUI } from "../stores/ui";
import { OpenWithControl } from "./OpenWithControl";
import { PresentationMode } from "./PresentationMode";

/**
 * 状态栏(footer)。三段结构:
 * - 左:文件元信息(路径、未保存、磁盘冲突、字数等)。
 * - 右(居左):用别的程序打开(OpenWithControl)。
 * - 右(居右):预览/代码切换 + marp 演示入口。
 *
 * 没有打开文档(首页)时整个状态栏不渲染——为空时显示一个 26px 高的边框条反而更难看。
 */
export function StatusBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const viewMode = useSettings((s) => s.viewMode);
  const setViewMode = useSettings((s) => s.setViewMode);
  const entries = useToc((s) => s.entries);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  // 主题切换用 View Transition 交叉淡入,避免全文档逐元素颜色过渡卡顿。
  const toggleTheme = () => {
    withViewTransition(() => setTheme(isDark ? "light" : "dark"));
  };
  const tab = tabs.find((t) => t.id === activeId);

  // marp 演示独立成全屏覆盖层,状态留在本地:仅在用户点演示按钮时短暂出现。
  const [presenting, setPresenting] = useState(false);

  if (!tab) return null;

  // 编辑中的字数统计跟随草稿,保存后归位到 content。
  const source = tab.draft ?? tab.content;
  const wordCount = tab.path ? source.trim().split(/\s+/).filter(Boolean).length : 0;
  const charCount = tab.path ? source.length : 0;

  // 只跑一次轻量 frontmatter 检测;不调 renderFull(StatusBar 渲染频率高,完整 pipeline 太重)。
  const isMarp = useMemo(() => (tab.path ? isMarpFromSource(source) : false), [tab.path, source]);

  return (
    <HStack
      as="footer"
      h="26px"
      px={3}
      gap={4}
      flexShrink={0}
      borderTopWidth="1px"
      borderColor="border.subtle"
      bg="bg.subtle"
      fontSize="2xs"
      color="fg.muted"
      userSelect="none"
    >
      {tab.diskChanged && <Text whiteSpace="nowrap" color="orange.400">文件已在磁盘上修改</Text>}
      {isDirty(tab) && <Text whiteSpace="nowrap" color="fg">未保存</Text>}
      {tab.path && (
        <>
          <Text whiteSpace="nowrap">{`${wordCount} 词`}</Text>
          <Text whiteSpace="nowrap">{`${charCount} 字符`}</Text>
          <Text whiteSpace="nowrap">{`${entries.length} 个标题`}</Text>
        </>
      )}
      {tab.error && (
        <Text ms="auto" color="fg.subtle">
          打开失败
        </Text>
      )}

      {/* 把右侧区推到末端。OpenWith 在最左、视图切换在最右,中间留出间隙。 */}
      <Box ms="auto" />
      <OpenWithControl />
      <HStack
        borderRadius="8px"
        borderWidth="1px"
        borderColor="border.subtle"
        bg="bg.panel"
        alignItems="center"
        p="2px"
        gap={1}
      >
        <SegmentGroup.Root
          size="xs"
          value={viewMode}
          onValueChange={(e) => {
            const next = e.value as ViewMode;
            withViewTransition(() => setViewMode(next));
          }}
          aria-label="切换预览或代码视图"
        >
          <SegmentGroup.Indicator />
          <SegmentGroup.Item value="preview">
            <SegmentGroup.ItemHiddenInput />
            <SegmentGroup.ItemText display="inline-flex" alignItems="center" gap={1}>
              <Eye size={12} />
              预览
            </SegmentGroup.ItemText>
          </SegmentGroup.Item>
          <SegmentGroup.Item value="code">
            <SegmentGroup.ItemHiddenInput />
            <SegmentGroup.ItemText display="inline-flex" alignItems="center" gap={1}>
              <Code2 size={12} />
              代码
            </SegmentGroup.ItemText>
          </SegmentGroup.Item>
        </SegmentGroup.Root>
      </HStack>
      {isMarp && viewMode === "preview" && tab.path && (
        <Button
          aria-label="演示"
          title="演示"
          size="2xs"
          variant="ghost"
          gap={1}
          px={2}
          onClick={() => setPresenting(true)}
        >
          <Play size={11} />
          演示
        </Button>
      )}

      {/* 设置 + 主题切换:右下角图标-only,与右侧控件间隔几个像素。 */}
      <IconButton
        aria-label="切换主题"
        title="切换亮/暗主题"
        variant="ghost"
        size="2xs"
        color="fg.muted"
        _hover={{ color: "fg", bg: "bg.subtle" }}
        onClick={toggleTheme}
      >
        {isDark ? <Sun size={12} /> : <Moon size={12} />}
      </IconButton>
      <IconButton
        aria-label="设置"
        title="设置"
        variant="ghost"
        size="2xs"
        color="fg.muted"
        _hover={{ color: "fg", bg: "bg.subtle" }}
        onClick={() => setSettingsOpen(true)}
      >
        <Settings size={12} />
      </IconButton>

      {presenting && tab.path && (
        <PresentationMode
          content={source}
          path={tab.path}
          onExit={() => setPresenting(false)}
        />
      )}
    </HStack>
  );
}