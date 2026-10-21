import { Box, Flex } from "@chakra-ui/react";
import { FolderOpen } from "lucide-react";
import { useWorkspace } from "../stores/workspace";
import { SidebarHeader } from "./SidebarHeader";
import { WorkspaceTree } from "./WorkspaceTree";

/**
 * 左侧工作区栏:只放文件夹目录树。
 *
 * 显不显示由「有没有打开文件夹」决定 —— 打开的是单篇文档时这一栏整个不出现,
 * 不用留空位。
 */
export function WorkspaceSidebar() {
  const root = useWorkspace((s) => s.root);

  // 常驻挂载,通过宽度过渡实现展开/收起动画。
  return (
    <Box
      w={root ? "250px" : "0px"}
      flexShrink={0}
      position="relative"
      overflow="hidden"
      transition="width 0.25s ease"
      _motionReduce={{ transition: "none" }}
    >
      <Flex w="250px" h="100%" direction="column">
        <SidebarHeader icon={<FolderOpen size={13} />} label="文件夹" />
        <Box flex={1} minH={0}>
          <WorkspaceTree />
        </Box>
      </Flex>
    </Box>
  );
}
