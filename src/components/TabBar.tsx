import { useEffect, useState } from "react";
import { Box, HStack, IconButton, Text } from "@chakra-ui/react";
import { X } from "lucide-react";
import { isDirty, useTabs } from "../stores/tabs";
import { startPress, trackDrag } from "../lib/tabDrag";
import { watchTabDropHover, type Insertion } from "../lib/tabDrop";

/**
 * 别的窗口拖标签过来时的插入线。落点横坐标由 Rust 给(它是唯一知道全局光标与
 * 各窗口矩形的一方),插入位与线条位置在本窗口的标签栏上量。
 */
function TabDropIndicator() {
  const [insertion, setInsertion] = useState<Insertion | null>(null);
  useEffect(() => watchTabDropHover(setInsertion), []);
  if (!insertion) return null;
  return (
    <Box
      position="absolute"
      top={1}
      bottom={1}
      left={insertion.x}
      w="2px"
      borderRadius="full"
      bg="fg"
      pointerEvents="none"
    />
  );
}

export function TabBar() {
  const { tabs, activeId, setActive, requestCloseTab } = useTabs();

  return (
    // 空白处留作窗口拖拽区;标签带 tabindex,点击与拖拽不会被拖窗区抢走。
    <Box
      display="flex"
      alignItems="center"
      flex={1}
      minW={0}
      data-tauri-drag-region=""
    >
      <HStack
        gap={0}
        px={2}
        flex={1}
        minW={0}
        position="relative"
        role="tablist"
        aria-label="已打开的文档"
        data-tab-strip=""
        data-tauri-drag-region=""
        overflowX="auto"
        overflowY="hidden"
        css={{
          "&::-webkit-scrollbar": { height: "0px" },
        }}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <Box
              key={tab.id}
              data-tab-id={tab.id}
              // 标签是 div 而非 button:关闭按钮是另一个 button,button 套 button 是非法 HTML。
              // 用 role=tab 保留可聚焦与选中语义,键盘的 Enter/Space 自行接管。
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => setActive(tab.id)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setActive(tab.id);
              }}
              // 阻止 WebView2 中键自动滚动,否则 auxclick 不触发、中键关闭失效。
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onPointerDown={(e) => startPress(tab, e)}
              onPointerMove={trackDrag}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void requestCloseTab(tab.id);
                }
              }}
              px={3}
              py={1.5}
              borderRadius="md"
              fontSize="xs"
              display="flex"
              alignItems="center"
              gap={1.5}
              maxW="200px"
              flexShrink={0}
              cursor="pointer"
              userSelect="none"
              bg={active ? "bg.subtle" : "transparent"}
              color="fg"
              title={tab.path}
            >
              {tab.diskChanged && (
                <Box
                  as="span"
                  w={1.5}
                  h={1.5}
                  borderRadius="full"
                  bg="orange.400"
                  flexShrink={0}
                />
              )}
              {isDirty(tab) && (
                <Box
                  as="span"
                  w={1.5}
                  h={1.5}
                  borderRadius="full"
                  border="1.5px solid"
                  borderColor="fg"
                  flexShrink={0}
                  title="有未保存的修改"
                />
              )}
              <Text as="span" truncate>
                {tab.name}
              </Text>
              <IconButton
                aria-label="关闭标签"
                size="2xs"
                variant="ghost"
                flexShrink={0}
                // 点 X 只是关闭,别顺手把这一次点击也记成"准备拖拽"。
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void requestCloseTab(tab.id);
                }}
              >
                <X size={12} />
              </IconButton>
            </Box>
          );
        })}
        <TabDropIndicator />
      </HStack>
    </Box>
  );
}
