import type { ReactNode } from "react";
import { Flex } from "@chakra-ui/react";

/**
 * 侧栏顶部的一行标题:图标 + 名称,说明这一栏装的是什么。
 * 两个侧栏(左:文件夹树,右:目录大纲)共用同一套外观。
 */
export function SidebarHeader({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <Flex
      gap={1.5}
      alignItems="center"
      px={2}
      pt={2}
      pb={1}
      flexShrink={0}
      fontSize="xs"
      fontWeight="medium"
      color="fg"
      userSelect="none"
    >
      {icon}
      {label}
    </Flex>
  );
}
