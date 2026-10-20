import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Box,
  Button,
  Grid,
  HStack,
  IconButton,
  Input,
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
  Minus,
  PanelLeft,
  Pencil,
  Plus,
  Save,
  StretchHorizontal,
} from "lucide-react";
import { useSettings, MAX_CONTENT_PADDING } from "../stores/settings";
import { openFolderDialog, openFileDialog } from "../tauri/api";
import { openFolderAsWorkspace } from "../lib/openFolderAsWorkspace";
import { openStandaloneFiles } from "../lib/openStandaloneFiles";
import { isDirty, useTabs } from "../stores/tabs";
import { WindowControls } from "./WindowControls";

export function TitleBar({ onOpenError }: { onOpenError?: (msg: string) => void }) {
  const { t } = useTranslation();
  const {
    fontSize,
    setFontSize,
    tocOpen,
    toggleToc,
    sidebarTab,
    setSidebarTab,
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

  // 窄窗口下中间控件会挤压 WindowControls;
  // 改走图标-only:logo(左)与 WindowControls(右)固定不动,中间操作区在不够宽时退化为图标。
  // 阈值参考:中文标题+字号输入+边距按钮全部展开大约 900px;低于此值切紧凑模式。
  const COMPACT_THRESHOLD = 900;
  const [compact, setCompact] = useState(
    typeof window !== "undefined" && window.innerWidth < COMPACT_THRESHOLD,
  );
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < COMPACT_THRESHOLD);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 字号输入框的本地草稿:回车/失焦时提交,外部变更(按钮/快捷键)时同步。
  const [sizeDraft, setSizeDraft] = useState(String(fontSize));
  useEffect(() => {
    setSizeDraft(String(fontSize));
  }, [fontSize]);
  const commitSize = () => {
    const n = Number.parseInt(sizeDraft, 10);
    if (Number.isNaN(n)) {
      setSizeDraft(String(fontSize));
    } else {
      setFontSize(n);
    }
  };
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

  // 「边距」按钮的调节面板:悬停展开、离开延迟收起;开关都走 slide-fade 动画(与"打开"菜单一致)。
  const [paddingPhase, setPaddingPhase] = useState<"closed" | "open" | "closing">("closed");
  // 面板从 paddingWrapRef 下沿弹出,坐标靠 portal 渲染后才能脱离顶栏的 overflow:hidden
  // (顶栏中间操作区为避免挤压 WindowControls 加了 overflow:hidden,不 portal 会被裁)。
  const [paddingPanelPos, setPaddingPanelPos] = useState<{ x: number; y: number } | null>(null);
  const paddingCloseTimer = useRef<number | null>(null);
  const paddingExitTimer = useRef<number | null>(null);
  // 包住"按钮 + 面板"的容器:面板是它的 DOM 子节点,用 :hover 判断指针是否还在控件范围内。
  const paddingWrapRef = useRef<HTMLDivElement | null>(null);

  const clearPaddingTimers = () => {
    if (paddingCloseTimer.current !== null) {
      window.clearTimeout(paddingCloseTimer.current);
      paddingCloseTimer.current = null;
    }
    if (paddingExitTimer.current !== null) {
      window.clearTimeout(paddingExitTimer.current);
      paddingExitTimer.current = null;
    }
  };

  const showPaddingPanel = () => {
    clearPaddingTimers();
    // 重新取按钮 rect:窗口大小变化 / 顶栏换行后位置会变,不能用缓存值。
    const wrap = paddingWrapRef.current;
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      setPaddingPanelPos({ x: rect.left + rect.width / 2, y: rect.bottom + 8 });
    }
    setPaddingPhase("open");
  };

  // 收起分两步:先切到 closing 播退场动画,动画结束再真正卸载。
  const closePaddingPanel = () => {
    clearPaddingTimers();
    setPaddingPhase((p) => (p === "closed" ? p : "closing"));
    paddingExitTimer.current = window.setTimeout(() => {
      paddingExitTimer.current = null;
      setPaddingPhase("closed");
    }, 120);
  };

  const schedulePaddingClose = () => {
    clearPaddingTimers();
    paddingCloseTimer.current = window.setTimeout(() => {
      paddingCloseTimer.current = null;
      closePaddingPanel();
    }, 120);
  };

  // 拖滑块时指针会滑出面板:按住期间不收起,松手后再判断是否已真正离开。
  const handlePaddingLeave = (e: { buttons: number }) => {
    if (e.buttons !== 0) return;
    schedulePaddingClose();
  };

  useEffect(() => clearPaddingTimers, []);

  useEffect(() => {
    const onPointerUp = () => {
      const el = paddingWrapRef.current;
      if (el && !el.matches(":hover")) closePaddingPanel();
    };
    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  }, []);

  const handleOpen = async () => {
    try {
      const paths = await openFileDialog();
      await openStandaloneFiles(paths ?? []);
    } catch (e) {
      onOpenError?.(String(e));
    }
  };

  // 目录按钮与 Tab 联动:侧栏开着但显示文件页时,点击是切换而不是关闭。
  const tocShown = tocOpen && sidebarTab === "toc";
  const handleWorkspace = async () => {
    // 打开文件夹是内容操作,不应复用侧栏按钮的收起逻辑。
    setSidebarTab("files");
    if (!tocOpen) toggleToc();
    const picked = await openFolderDialog().catch((e) => {
      onOpenError?.(String(e));
      return null;
    });
    if (!picked) return;
    await openFolderAsWorkspace(picked);
  };
  const handleTocButton = () => {
    if (tocOpen && sidebarTab === "files") {
      setSidebarTab("toc");
      return;
    }
    toggleToc();
  };

  // 三列网格:左 Logo、中功能、右窗口控制,保证功能组在窗口中真正居中。
  // 去原生标题栏后,整条顶栏都是拖拽区(data-tauri-drag-region);
  // 按钮自身不带该属性,点击不受影响。双击拖拽区可最大化/还原。
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
      data-tauri-drag-region=""
    >
      <Grid templateColumns="auto minmax(0, 1fr) auto" w="100%" alignItems="center" data-tauri-drag-region="">
        <Box justifySelf="start" display="flex" alignItems="center" data-tauri-drag-region="">
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
        </Box>

        <HStack gap={1} justifySelf="center" overflow="hidden" maxW="100%" data-tauri-drag-region="">
          {/* 编辑/保存:从正文区移到顶栏「打开」左侧,作用于当前文档。 */}
          {canEdit && (
            <>
              <IconButton
                aria-label={t("viewer.toolbar.toggleEdit")}
                title={t("viewer.toolbar.editTitle")}
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
                aria-label={t("viewer.toolbar.saveShortcut")}
                title={t("viewer.toolbar.saveShortcut")}
                variant="ghost"
                size={compact ? "xs" : "sm"}
                disabled={!dirty}
                onClick={() => activeTab && void saveTab(activeTab.id)}
              >
                <Save size={14} />
              </IconButton>
            </>
          )}
          <Menu.Root
            open={openMenu}
            onOpenChange={(e) => setOpenMenu(e.open)}
            positioning={{ placement: "bottom-start" }}
          >
            <Menu.Trigger asChild>
              {compact ? (
                <IconButton
                  aria-label={t("shell.open")}
                  title={t("shell.open")}
                  variant="ghost"
                  size="xs"
                  onPointerEnter={showOpenMenu}
                  onPointerLeave={scheduleOpenMenuClose}
                >
                  <FolderOpen size={14} />
                </IconButton>
              ) : (
                <Button
                  aria-label={t("shell.open")}
                  title={t("shell.open")}
                  variant="ghost"
                  size="sm"
                  gap={1.5}
                  onPointerEnter={showOpenMenu}
                  onPointerLeave={scheduleOpenMenuClose}
                >
                  <FolderOpen size={15} />
                  {t("shell.open")}
                  <ChevronDown size={12} opacity={0.55} />
                </Button>
              )}
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
                    {t("shell.openFile")}
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
                    {t("shell.openFolder")}
                  </Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>

          <IconButton
            aria-label={t("shell.decreaseFontSize")}
            title={t("shell.decreaseFontSizeShortcut")}
            variant="ghost"
            size={compact ? "xs" : "sm"}
            onClick={() => setFontSize(fontSize - 1)}
          >
            <Minus size={14} />
          </IconButton>
          {!compact && (
            <Input
              type="number"
              min={13}
              max={28}
              value={sizeDraft}
              onChange={(e) => setSizeDraft(e.target.value)}
              onBlur={commitSize}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              aria-label={t("shell.fontSize")}
              title={t("shell.fontSizeInputTitle")}
              w="44px"
              h="26px"
              size="xs"
              px={0}
              textAlign="center"
              borderRadius="6px"
              bg="bg.subtle"
              borderColor="transparent"
              focusRing="none"
              _hover={{ borderColor: "fg.muted" }}
              _focusVisible={{ borderColor: "fg.muted" }}
              css={{
                "&::-webkit-outer-spin-button, &::-webkit-inner-spin-button": {
                  WebkitAppearance: "none",
                  margin: 0,
                },
                MozAppearance: "textfield",
              }}
            />
          )}
          <IconButton
            aria-label={t("shell.increaseFontSize")}
            title={t("shell.increaseFontSizeShortcut")}
            variant="ghost"
            size={compact ? "xs" : "sm"}
            onClick={() => setFontSize(fontSize + 1)}
          >
            <Plus size={14} />
          </IconButton>

          {compact ? (
            <IconButton
              aria-label={t("shell.tocBar")}
              title={t("shell.tocBarShortcut")}
              variant={tocShown ? "subtle" : "ghost"}
              size="xs"
              onClick={handleTocButton}
            >
              <PanelLeft size={14} />
            </IconButton>
          ) : (
            <Button
              aria-label={t("shell.tocBar")}
              title={t("shell.tocBarShortcut")}
              variant={tocShown ? "subtle" : "ghost"}
              size="sm"
              gap={1.5}
              onClick={handleTocButton}
            >
              <PanelLeft size={15} />
              {t("shell.toc")}
            </Button>
          )}

          <Box
            ref={paddingWrapRef}
            position="relative"
            display="flex"
            alignItems="center"
            onPointerEnter={showPaddingPanel}
            onPointerLeave={handlePaddingLeave}
          >
            {compact ? (
              <IconButton
                aria-label={t("shell.margin")}
                title={t("shell.marginTitle")}
                variant="ghost"
                size="xs"
                onClick={showPaddingPanel}
              >
                <StretchHorizontal size={14} />
              </IconButton>
            ) : (
              <Button
                aria-label={t("shell.margin")}
                title={t("shell.marginTitle")}
                variant="ghost"
                size="sm"
                gap={1.5}
                onClick={showPaddingPanel}
              >
                <StretchHorizontal size={15} />
                {t("shell.margin")}
                <ChevronDown size={12} opacity={0.55} />
              </Button>
            )}

            {/* 悬停展开的边距调节面板:实时改预览左右内边距。
                Portal 渲染到 body 之外:顶栏中间 HStack 为避免挤压 WindowControls 加了
                overflow:hidden,内联子元素会被裁掉;portal 后面板脱离裁剪范围。
                animationFillMode="both" 让退场动画播完后停在末态(opacity 0):
                Chakra 的 animationStyle 只给 animationName、不带 fill-mode,
                动画结束到定时卸载之间元素会回弹到不透明,肉眼就是"闪一下"。 */}
            {paddingPhase !== "closed" && paddingPanelPos && (
              <Portal>
                <Box
                  data-placement="bottom"
                  animationStyle={paddingPhase === "open" ? "slide-fade-in" : "slide-fade-out"}
                  animationDuration={paddingPhase === "open" ? "fast" : "faster"}
                  animationFillMode="both"
                  position="fixed"
                  top={`${paddingPanelPos.y}px`}
                  left={`${paddingPanelPos.x}px`}
                  transform="translateX(-50%)"
                  zIndex={1000}
                  minW="220px"
                  bg="bg"
                  borderWidth="1px"
                  borderColor="border.subtle"
                  borderRadius="10px"
                  boxShadow="md"
                  p={3}
                  onPointerEnter={showPaddingPanel}
                  onPointerLeave={handlePaddingLeave}
                >
                  <HStack justify="space-between" mb={2}>
                    <Text fontSize="xs" color="fg.muted">
                      {t("shell.contentPadding")}
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
                        { v: 0, label: t("shell.paddingNarrow") },
                        { v: 200, label: t("shell.paddingMedium") },
                        { v: 400, label: t("shell.paddingWide") },
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
                </Box>
              </Portal>
            )}
          </Box>
        </HStack>

        <Box justifySelf="end" display="flex" alignItems="center" data-tauri-drag-region="">
          <WindowControls />
        </Box>
      </Grid>
    </Box>
  );
}
