import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  HStack,
  IconButton,
  Menu,
  Portal,
  Slider,
  Text,
} from "@chakra-ui/react";
import { useTheme } from "next-themes";
import {
  ChevronDown,
  FileText,
  FolderOpen,
  FolderTree,
  PanelRight,
  Pencil,
  Save,
  StretchHorizontal,
  Type,
} from "lucide-react";
import {
  MAX_CONTENT_PADDING,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  useSettings,
} from "../stores/settings";
import { openFolderDialog, openFileDialog } from "../tauri/api";
import { openFolderInNewWindow } from "../lib/openFolder";
import { openStandaloneFiles } from "../lib/openStandaloneFiles";
import { isDirty, useTabs } from "../stores/tabs";
import { TabBar } from "./TabBar";
import { TitleBarSearch } from "./TitleBarSearch";
import { WindowControls } from "./WindowControls";
import { TitleBarSliderControl } from "./TitleBarSliderControl";

export function TitleBar({ onOpenError }: { onOpenError?: (msg: string) => void }) {
  const {
    fontSize,
    setFontSize,
    tocOpen,
    toggleToc,
    contentPadding,
    setContentPadding,
    editMode,
    toggleEditMode,
  } = useSettings();
  const activeTab = useTabs((s) => s.tabs.find((x) => x.id === s.activeId));
  const saveTab = useTabs((s) => s.saveTab);
  // 编辑/保存属于「当前文档」:无打开的文档时不显示(首页不渲染顶栏,这里仅作兜底)。
  const canEdit = !!activeTab?.path;
  const dirty = activeTab ? isDirty(activeTab) : false;
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";

  // 窄窗口下右侧控件会挤压标签栏;
  // 改走图标-only:logo(左)与 WindowControls(右)固定不动,右侧操作区在不够宽时退化为图标。
  // 阈值参考:右侧操作区全部展开大约 350px,加上左侧固定簇约 240px,低于 900px 切紧凑模式。
  const COMPACT_THRESHOLD = 900;
  const [compact, setCompact] = useState(
    typeof window !== "undefined" && window.innerWidth < COMPACT_THRESHOLD,
  );
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < COMPACT_THRESHOLD);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const [openMenu, setOpenMenu] = useState(false);
  const openMenuCloseTimer = useRef<number | null>(null);

  const cancelOpenMenuClose = () => {
    if (openMenuCloseTimer.current !== null) {
      window.clearTimeout(openMenuCloseTimer.current);
      openMenuCloseTimer.current = null;
    }
  };

  const showOpenMenu = () => {
    cancelOpenMenuClose();
    setOpenMenu(true);
  };

  const scheduleOpenMenuClose = () => {
    cancelOpenMenuClose();
    openMenuCloseTimer.current = window.setTimeout(() => {
      openMenuCloseTimer.current = null;
      setOpenMenu(false);
    }, 120);
  };

  useEffect(() => cancelOpenMenuClose, []);

  const handleOpen = async () => {
    try {
      const paths = await openFileDialog();
      await openStandaloneFiles(paths ?? []);
    } catch (e) {
      onOpenError?.(String(e));
    }
  };

  const handleWorkspace = async () => {
    const picked = await openFolderDialog().catch((e) => {
      onOpenError?.(String(e));
      return null;
    });
    if (!picked) return;
    await openFolderInNewWindow(picked).catch((e) => onOpenError?.(String(e)));
  };

  // 顶栏一行三段:左侧固定簇(Logo 与 打开/编辑/保存,彼此 4px)、中间标签栏、
  // 右侧功能组(目录/边距/字号)与窗口控制。标签栏吃掉中间剩余宽度,放不下就横向滚动。
  // 去原生标题栏后,整条顶栏都是拖拽区(data-tauri-drag-region);
  // 按钮与标签自带可点击语义,点击不受影响。双击拖拽区可最大化/还原。
  return (
    <Box
      as="header"
      h="46px"
      // 右侧不留内边距:窗口按钮要贴到右上角,留白会让角落点不到关闭。
      paddingLeft="3px"
      flexShrink={0}
      userSelect="none"
      display="flex"
      alignItems="center"
      gap={2}
      data-tauri-drag-region=""
    >
      {/* 左侧固定簇:Logo 与 打开/编辑/保存 三键,间隔 4px。 */}
      <HStack gap={1} alignItems="center" flexShrink={0} data-tauri-drag-region="">
        {/* wordmark PNG 上下各有约34%透明留白(字形仅占30%高度),
            用固定高度容器 + 负 margin 裁剪到字形本身,栏高保持紧凑。 */}
        <Box h="18px" overflow="hidden" display="flex" flexShrink={0} data-tauri-drag-region="">
          <img
            src={isDark ? "/wordmark-white.png" : "/wordmark-black.png"}
            alt="OpenMD"
            draggable={false}
            data-tauri-drag-region=""
            style={{
              height: "59px",
              width: "auto",
              marginTop: "-20px",
              mixBlendMode: isDark ? "screen" : "multiply",
              userSelect: "none",
            }}
          />
        </Box>

        {/* 打开:下拉菜单(打开文件 / 打开文件夹),只留图标不配文字。 */}
        <Menu.Root
          open={openMenu}
          onOpenChange={(e) => setOpenMenu(e.open)}
          positioning={{ placement: "bottom-start" }}
        >
          <Menu.Trigger asChild>
            <IconButton
              aria-label="打开"
              title="打开"
              variant="ghost"
              size={compact ? "xs" : "sm"}
              gap={1}
              onPointerEnter={showOpenMenu}
              onPointerLeave={scheduleOpenMenuClose}
            >
              <FolderOpen size={14} />
              <ChevronDown size={12} opacity={0.55} />
            </IconButton>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner zIndex={1000}>
              <Menu.Content
                minW="160px"
                bg="bg"
                borderWidth="1px"
                borderColor="border.subtle"
                borderRadius="10px"
                boxShadow="md"
                overflow="hidden"
                p={1}
                onPointerEnter={showOpenMenu}
                onPointerLeave={scheduleOpenMenuClose}
              >
                <Menu.Item
                  value="open-file"
                  display="flex"
                  alignItems="center"
                  gap={2}
                  fontSize="sm"
                  px={2}
                  py={1.5}
                  borderRadius="6px"
                  cursor="pointer"
                  onClick={() => void handleOpen()}
                >
                  <FileText size={14} />
                  打开文件
                </Menu.Item>
                <Menu.Item
                  value="open-folder"
                  display="flex"
                  alignItems="center"
                  gap={2}
                  fontSize="sm"
                  px={2}
                  py={1.5}
                  borderRadius="6px"
                  cursor="pointer"
                  onClick={() => void handleWorkspace()}
                >
                  <FolderTree size={14} />
                  打开文件夹
                </Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>

        {/* 编辑/保存作用于当前文档。 */}
        {canEdit && (
          <>
            <IconButton
              aria-label="切换编辑模式 (Ctrl+E)"
              title="编辑模式 (Ctrl+E)"
              variant="ghost"
              size={compact ? "xs" : "sm"}
              bg={editMode ? "fg" : "transparent"}
              color={editMode ? "bg" : "fg"}
              _hover={{ bg: editMode ? "fg.muted" : "bg.subtle" }}
              onClick={toggleEditMode}
            >
              <Pencil size={14} />
            </IconButton>
            <IconButton
              aria-label="保存 (Ctrl+S)"
              title="保存 (Ctrl+S)"
              variant="ghost"
              size={compact ? "xs" : "sm"}
              disabled={!dirty}
              onClick={() => activeTab && void saveTab(activeTab.id)}
            >
              <Save size={14} />
            </IconButton>
          </>
        )}
      </HStack>

      {/* 标签栏:与顶栏同行,占中间剩余宽度。 */}
      <TabBar />

      {/* 右侧功能组与窗口控制。 */}
      <HStack gap={1} alignItems="center" flexShrink={0} data-tauri-drag-region="">
        {/* 搜索框:平时不显示,Ctrl+F 唤出。 */}
        <TitleBarSearch compact={compact} />

        {compact ? (
          <IconButton
            aria-label="目录栏"
            title="目录栏 (Ctrl+B)"
            variant={tocOpen ? "subtle" : "ghost"}
            size="xs"
            onClick={toggleToc}
          >
            <PanelRight size={14} />
          </IconButton>
        ) : (
          <Button
            aria-label="目录栏"
            title="目录栏 (Ctrl+B)"
            variant={tocOpen ? "subtle" : "ghost"}
            size="sm"
            gap={1.5}
            onClick={toggleToc}
          >
            <PanelRight size={15} />
            目录
          </Button>
        )}

        {/* 边距与字号:同一套悬停式滑条控件,面板内容各自不同。 */}
        <TitleBarSliderControl
          icon={StretchHorizontal}
          label="边距"
          title="调整内容左右边距"
          compact={compact}
        >
          <HStack justify="space-between" mb={2}>
            <Text fontSize="xs" color="fg.muted">
              内容边距
            </Text>
            <Text fontSize="xs" color="fg.muted" fontVariantNumeric="tabular-nums">
              {contentPadding}px
            </Text>
          </HStack>
          <Slider.Root
            min={0}
            max={MAX_CONTENT_PADDING}
            step={4}
            size="sm"
            value={[contentPadding]}
            onValueChange={(e) => setContentPadding(e.value[0])}
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
          <HStack gap={1} mt={2}>
            {(
              [
                { v: 0, label: "窄" },
                { v: 200, label: "适中" },
                { v: 400, label: "宽" },
              ] as const
            ).map((opt) => (
              <Button
                key={opt.v}
                size="xs"
                flex={1}
                variant={contentPadding === opt.v ? "subtle" : "ghost"}
                onClick={() => setContentPadding(opt.v)}
              >
                {opt.label}
              </Button>
            ))}
          </HStack>
        </TitleBarSliderControl>

        <TitleBarSliderControl
          icon={Type}
          label="字号"
          title="调整正文字号 (Ctrl+- / Ctrl+=)"
          compact={compact}
        >
          <HStack justify="space-between" mb={2}>
            <Text fontSize="xs" color="fg.muted">
              正文字号
            </Text>
            <Text fontSize="xs" color="fg.muted" fontVariantNumeric="tabular-nums">
              {fontSize}px
            </Text>
          </HStack>
          <Slider.Root
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            step={1}
            size="sm"
            value={[fontSize]}
            onValueChange={(e) => setFontSize(e.value[0])}
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumbs />
            </Slider.Control>
          </Slider.Root>
        </TitleBarSliderControl>

        <WindowControls />
      </HStack>
    </Box>
  );
}
