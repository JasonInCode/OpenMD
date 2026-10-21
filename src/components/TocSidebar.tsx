import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Box, Flex, Text, VStack } from "@chakra-ui/react";
import { ListTree } from "lucide-react";
import { setActiveHeading, useToc } from "../stores/toc";
import { findTocItem, followTocItem } from "../lib/tocFollow";
import { FloatingScrollbar } from "./FloatingScrollbar";
import { SidebarHeader } from "./SidebarHeader";

/** 用户手动滚动目录后,自动跟随让位的时间(ms):这段时间内不跟用户抢滚动位置。 */
const USER_SCROLL_GRACE_MS = 2000;

/** 距离用户上次手动滚动目录过去多久,还剩多少让位时间(ms);已过让位期则为负。 */
function graceLeft(lastUserScrollAt: number): number {
  return USER_SCROLL_GRACE_MS - (performance.now() - lastUserScrollAt);
}

/**
 * 右侧目录栏:当前文档的标题大纲。
 *
 * 显不显示由顶栏的「目录」按钮控制(开关状态是 settings.tocOpen)。
 */
export function TocSidebar({ open }: { open: boolean }) {
  const { entries, activeId } = useToc();
  const listRef = useRef<HTMLDivElement>(null);
  // 用户最近一次手动滚动目录的时刻(performance.now() 毫秒)。
  const lastUserScrollRef = useRef(0);
  // 本组件自己写入的 scrollTop:用来把自身触发的 scroll 事件与用户滚动区分开。
  const selfScrollTopRef = useRef<number | null>(null);
  const followTimerRef = useRef(0);

  const minLevel = entries.length > 0 ? Math.min(...entries.map((e) => e.level)) : 1;

  // 目录跟随:选中条目滚出目录可视区时,把它最小幅度地滚回边缘。
  // 用户刚手动滚过目录时先让位,等让位期过去再跟随,不跟用户抢位置。
  // 返回 false 表示还在让位期,需要稍后重试。
  const syncFollow = useCallback((): boolean => {
    const el = listRef.current;
    if (!el) return true;
    const id = useToc.getState().activeId;
    if (!id) return true;
    if (graceLeft(lastUserScrollRef.current) > 0) return false;
    const next = followTocItem(el, findTocItem(el, id));
    if (next !== null) selfScrollTopRef.current = next;
    return true;
  }, []);

  const scheduleFollow = useCallback(() => {
    window.clearTimeout(followTimerRef.current);
    followTimerRef.current = 0;
    const tick = () => {
      followTimerRef.current = 0;
      if (syncFollow()) return;
      followTimerRef.current = window.setTimeout(tick, graceLeft(lastUserScrollRef.current));
    };
    const wait = graceLeft(lastUserScrollRef.current);
    if (wait > 0) followTimerRef.current = window.setTimeout(tick, wait);
    else tick();
  }, [syncFollow]);

  useLayoutEffect(() => {
    scheduleFollow();
  }, [activeId, entries, scheduleFollow]);

  useEffect(() => () => window.clearTimeout(followTimerRef.current), []);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    if (selfScrollTopRef.current !== null && Math.abs(el.scrollTop - selfScrollTopRef.current) < 1) {
      selfScrollTopRef.current = null;
      return;
    }
    selfScrollTopRef.current = null;
    lastUserScrollRef.current = performance.now();
  };

  const list = (
    <VStack gap={0} align="stretch">
      {entries.map((entry) => {
        const active = entry.id === activeId;
        return (
          <Box
            key={`${entry.level}-${entry.id}`}
            as="button"
            data-toc-id={entry.id}
            textAlign="start"
            fontSize={entry.level === minLevel ? "sm" : "xs"}
            fontWeight={entry.level <= minLevel + 1 ? "medium" : "normal"}
            lineHeight="1.4"
            py={1}
            pl={`${(entry.level - minLevel) * 12 + 8}px`}
            pr={2}
            borderRadius="sm"
            cursor="pointer"
            color={active ? "colorPalette.solid" : "fg"}
            bg={active ? "colorPalette.subtle" : "transparent"}
            textOverflow="ellipsis"
            overflow="hidden"
            whiteSpace="nowrap"
            _hover={{ bg: "bg.subtle" }}
            onClick={() => {
              setActiveHeading(entry.id);
              document.getElementById(entry.id)?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            }}
            title={entry.text}
          >
            {entry.text}
          </Box>
        );
      })}
    </VStack>
  );

  return (
    // 常驻挂载,通过宽度过渡实现展开/收起动画。
    <Box
      w={open ? "250px" : "0px"}
      flexShrink={0}
      position="relative"
      overflow="hidden"
      transition="width 0.25s ease"
      _motionReduce={{ transition: "none" }}
    >
      {/* 悬浮滚动条是滚动元素的兄弟节点:宿主 position:relative,滚动元素自身
          挂 no-scrollbar,由 FloatingScrollbar 叠加绘制。宿主只包滚动区,
          免得滚动条压到标题上。 */}
      <Flex w="250px" h="100%" direction="column">
        <SidebarHeader icon={<ListTree size={13} />} label="目录" />
        <Box flex={1} minH={0} position="relative">
          <Box
            ref={listRef}
            className="no-scrollbar"
            w="250px"
            h="100%"
            overflowY="auto"
            onScroll={onListScroll}
            px={2}
            py={2}
            as="nav"
            aria-label="目录"
          >
            {entries.length === 0 ? (
              <Text fontSize="sm" color="fg.subtle" px={2}>
                无标题
              </Text>
            ) : (
              list
            )}
          </Box>
          <FloatingScrollbar targetRef={listRef} />
        </Box>
      </Flex>
    </Box>
  );
}
