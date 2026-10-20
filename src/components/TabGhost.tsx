import { Box, Flex, Text } from "@chakra-ui/react";
import { isDirty, useTabs } from "../stores/tabs";

/**
 * 芯片窗口的界面:拖拽途中跟手的那一枚标签。
 *
 * 整扇窗口就是一枚标签那么大(见 tab_drag.rs),落下之前它不该显示完整界面 ——
 * 一扇 900×640 的窗口跟着光标会把目标窗口的标签栏整个盖住,而插入线恰恰画在
 * 那里。落定后 Rust 发 `tab-drag-settled`,App 把它换成完整界面。
 */
export function TabGhost() {
  const tab = useTabs((s) => s.tabs[0]);
  if (!tab) return <Box flex={1} bg="bg" />;
  return (
    <Flex
      alignItems="center"
      gap={1.5}
      px={3}
      h="100vh"
      overflow="hidden"
      bg="bg.subtle"
      color="fg"
      fontSize="xs"
      userSelect="none"
      boxShadow="lg"
    >
      {isDirty(tab) && (
        <Box
          w={1.5}
          h={1.5}
          borderRadius="full"
          border="1.5px solid"
          borderColor="fg"
          flexShrink={0}
        />
      )}
      <Text truncate>{tab.name}</Text>
    </Flex>
  );
}
