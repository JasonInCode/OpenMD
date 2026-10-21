import { useRef } from "react";
import { Box, Flex, Text, VStack } from "@chakra-ui/react";
import { ListTree } from "lucide-react";
import { setActiveHeading, useToc } from "../stores/toc";
import { FloatingScrollbar } from "./FloatingScrollbar";
import { SidebarHeader } from "./SidebarHeader";

/**
 * 右侧目录栏:当前文档的标题大纲。
 *
 * 显不显示由顶栏的「目录」按钮控制(开关状态是 settings.tocOpen)。
 */
export function TocSidebar({ open }: { open: boolean }) {
  const { entries, activeId } = useToc();
  const listRef = useRef<HTMLDivElement>(null);

  const minLevel = entries.length > 0 ? Math.min(...entries.map((e) => e.level)) : 1;

  const list = (
    <VStack gap={0} align="stretch">
      {entries.map((entry) => {
        const active = entry.id === activeId;
        return (
          <Box
            key={`${entry.level}-${entry.id}`}
            as="button"
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
