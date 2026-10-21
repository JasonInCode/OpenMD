import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  Box,
  Button,
  chakra,
  Dialog,
  Flex,
  HStack,
  IconButton,
  Portal,
  Slider,
  Text,
  VStack,
} from "@chakra-ui/react";
import { useTheme } from "next-themes";
import {
  ImagePlus,
  Minus,
  Palette,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useSettings, MAX_BACKGROUND_BLUR } from "../stores/settings";
import { isFolderVerbRegistered, isMdAssociated, openImageDialog, registerFolderVerb, registerMdAssociation, unregisterFolderVerb, unregisterMdAssociation } from "../tauri/api";
import { useBackgroundSrc } from "../lib/useBackgroundSrc";
import { useOverlayBlur } from "../lib/overlayBlur";
import { FloatingScrollbar } from "./FloatingScrollbar";

type SectionId = "general" | "appearance";

const SECTIONS: { id: SectionId; label: string; icon: ComponentType<{ size?: number | string }> }[] = [
  { id: "general", label: "通用", icon: SlidersHorizontal },
  { id: "appearance", label: "外观", icon: Palette },
];

/** 「名称 + 当前状态 + 操作按钮」一行。文件关联与右键菜单两个开关共用。 */
function ToggleRow({
  label,
  on,
  busy,
  statusOn,
  statusOff,
  actionOn,
  actionOff,
  onToggle,
}: {
  label: string;
  on: boolean;
  busy: boolean;
  statusOn: string;
  statusOff: string;
  /** 已开启时点击按钮的操作 */
  actionOn: string;
  /** 未开启时点击按钮的操作 */
  actionOff: string;
  onToggle: () => void;
}) {
  return (
    <Flex
      justify="space-between"
      align="center"
      gap={6}
      py={3}
      borderBottomWidth="1px"
      borderColor="border.subtle"
    >
      <Text fontSize="sm" color="fg.muted" flexShrink={0}>
        {label}
      </Text>
      <HStack gap={3}>
        <Text fontSize="sm">{on ? statusOn : statusOff}</Text>
        <Button
          size="xs"
          variant={on ? "outline" : "subtle"}
          borderColor="border.subtle"
          disabled={busy}
          onClick={onToggle}
        >
          {on ? actionOn : actionOff}
        </Button>
      </HStack>
    </Flex>
  );
}

function GeneralSection() {
  // 文件关联状态:null = 未知/浏览器预览(不渲染该行)
  const [assoc, setAssoc] = useState<boolean | null>(null);
  const [assocBusy, setAssocBusy] = useState(false);
  // 文件夹右键菜单:注册表写入能力随 Windows 权限而定
  const [folderVerb, setFolderVerb] = useState<boolean | null>(null);
  const [folderVerbBusy, setFolderVerbBusy] = useState(false);
  // 关闭窗口行为(与关闭询问对话框的"不再提醒"共用一个设置)
  const { closeAction, setCloseAction } = useSettings();

  useEffect(() => {
    isMdAssociated()
      .then(setAssoc)
      .catch(() => setAssoc(null));
    isFolderVerbRegistered()
      .then(setFolderVerb)
      .catch(() => setFolderVerb(null));
  }, []);

  const toggleAssociation = async () => {
    setAssocBusy(true);
    try {
      if (assoc) {
        await unregisterMdAssociation();
      } else {
        await registerMdAssociation();
      }
      setAssoc(!assoc);
    } catch (e) {
      console.error("文件关联操作失败:", e);
    } finally {
      setAssocBusy(false);
    }
  };

  const toggleFolderVerb = async () => {
    setFolderVerbBusy(true);
    try {
      if (folderVerb) {
        await unregisterFolderVerb();
      } else {
        await registerFolderVerb();
      }
      setFolderVerb(!folderVerb);
    } catch (e) {
      console.error("右键菜单操作失败:", e);
    } finally {
      setFolderVerbBusy(false);
    }
  };

  return (
    <VStack align="stretch" gap={0}>
      <Flex
        justify="space-between"
        align="center"
        gap={6}
        py={3}
        borderBottomWidth="1px"
        borderColor="border.subtle"
      >
        <Text fontSize="sm" color="fg.muted" flexShrink={0}>
          关闭窗口
        </Text>
        <HStack gap={1}>
          {(
            [
              { v: "ask", label: "每次询问" },
              { v: "tray", label: "隐藏到托盘" },
              { v: "exit", label: "直接退出" },
            ] as const
          ).map((opt) => (
            <Button
              key={opt.v}
              size="xs"
              variant={closeAction === opt.v ? "subtle" : "ghost"}
              onClick={() => setCloseAction(opt.v)}
            >
              {opt.label}
            </Button>
          ))}
        </HStack>
      </Flex>
      {assoc !== null && (
        <ToggleRow
          label="文件关联"
          on={assoc}
          busy={assocBusy}
          statusOn="已关联 .md 等文件"
          statusOff="未关联"
          actionOn="取消关联"
          actionOff="设为默认"
          onToggle={() => void toggleAssociation()}
        />
      )}
      {folderVerb !== null && (
        <ToggleRow
          label="文件夹右键菜单"
          on={folderVerb}
          busy={folderVerbBusy}
          statusOn="已启用"
          statusOff="未启用"
          actionOn="关闭"
          actionOff="启用"
          onToggle={() => void toggleFolderVerb()}
        />
      )}
    </VStack>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const {
    fontSize,
    setFontSize,
    backgroundImage,
    backgroundBlur,
    setBackgroundImage,
    setBackgroundBlur,
  } = useSettings();

  // 选一张图片作为整窗背景;取消选择即清空。
  const pickBackground = async () => {
    const picked = await openImageDialog().catch(() => null);
    if (picked) setBackgroundImage(picked);
  };
  const backgroundName = backgroundImage ? backgroundImage.split(/[\\/]/).pop() : null;
  // 预览缩略图:走和背景层同一条资源协议放行逻辑。
  const backgroundSrc = useBackgroundSrc(backgroundImage);

  return (
    <VStack align="stretch" gap={0}>
      <Flex justify="space-between" align="center" gap={6} py={3} borderBottomWidth="1px" borderColor="border.subtle">
        <Text fontSize="sm" color="fg.muted" flexShrink={0}>
          主题
        </Text>
        <HStack gap={1}>
          {(
            [
              { v: "light", label: "亮色" },
              { v: "dark", label: "暗色" },
              { v: "system", label: "跟随系统" },
            ] as const
          ).map((opt) => (
            <Button
              key={opt.v}
              size="xs"
              variant={theme === opt.v ? "subtle" : "ghost"}
              onClick={() => setTheme(opt.v)}
            >
              {opt.label}
            </Button>
          ))}
        </HStack>
      </Flex>

      <Flex justify="space-between" align="center" gap={6} py={3} borderBottomWidth="1px" borderColor="border.subtle">
        <Text fontSize="sm" color="fg.muted" flexShrink={0}>
          正文字号 (13-28)
        </Text>
        <HStack gap={1}>
          <IconButton aria-label="减小字号" variant="ghost" size="xs" onClick={() => setFontSize(fontSize - 1)}>
            <Minus size={13} />
          </IconButton>
          <Text w="30px" textAlign="center" fontSize="sm">
            {fontSize}
          </Text>
          <IconButton aria-label="增大字号" variant="ghost" size="xs" onClick={() => setFontSize(fontSize + 1)}>
            <Plus size={13} />
          </IconButton>
        </HStack>
      </Flex>

      <Flex justify="space-between" align="center" gap={6} py={3} borderBottomWidth="1px" borderColor="border.subtle">
        <Text fontSize="sm" color="fg.muted" flexShrink={0}>
          背景图片
        </Text>
        <HStack gap={2} minW={0}>
          {backgroundSrc && (
            <chakra.button
              type="button"
              title="选择图片"
              onClick={() => void pickBackground()}
              w="44px"
              h="28px"
              flexShrink={0}
              borderRadius="6px"
              borderWidth="1px"
              borderColor="border.subtle"
              overflow="hidden"
              cursor="pointer"
            >
              <img
                src={backgroundSrc}
                alt=""
                draggable={false}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            </chakra.button>
          )}
          <Text fontSize="xs" color="fg.subtle" truncate maxW="160px" title={backgroundImage ?? undefined}>
            {backgroundName ?? "未设置"}
          </Text>
          <Button size="xs" variant="subtle" gap={1} onClick={() => void pickBackground()}>
            <ImagePlus size={12} />
            选择图片
          </Button>
          {backgroundImage && (
            <IconButton
              aria-label="移除背景"
              title="移除背景"
              variant="ghost"
              size="xs"
              onClick={() => setBackgroundImage(null)}
            >
              <X size={13} />
            </IconButton>
          )}
        </HStack>
      </Flex>

      {/* 模糊只在有背景图时才有意义,没图就不显示这一行。 */}
      {backgroundImage && (
        <Flex justify="space-between" align="center" gap={6} py={3} borderBottomWidth="1px" borderColor="border.subtle">
          <Text fontSize="sm" color="fg.muted" flexShrink={0}>
            背景模糊
          </Text>
          <HStack gap={3}>
            <Slider.Root
              min={0}
              max={MAX_BACKGROUND_BLUR}
              step={1}
              size="sm"
              w="140px"
              value={[backgroundBlur]}
              onValueChange={(e) => setBackgroundBlur(e.value[0])}
            >
              <Slider.Control>
                <Slider.Track>
                  <Slider.Range />
                </Slider.Track>
                <Slider.Thumbs />
              </Slider.Control>
            </Slider.Root>
            <Text w="30px" textAlign="right" fontSize="sm" fontVariantNumeric="tabular-nums">
              {backgroundBlur}
            </Text>
          </HStack>
        </Flex>
      )}
    </VStack>
  );
}

/**
 * 设置弹窗:左侧导航(通用/外观) + 右侧内容。
 * 背景半透明模糊;由首页左下角与顶栏"主题"左侧的设置按钮唤起。
 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("general");
  const contentRef = useRef<HTMLDivElement>(null);
  // 打开时模糊整个 App 内容(见 lib/overlayBlur.ts)。
  useOverlayBlur(open);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) onClose();
      }}
      placement="center"
      size="full"
    >
      <Portal>
        <Dialog.Backdrop bg="blackAlpha.300" />
        <Dialog.Positioner>
          <Dialog.Content
            borderRadius="12px"
            borderWidth="1px"
            borderColor="border.subtle"
            bg="bg"
            overflow="hidden"
            w="min(750px, 94vw)"
            h="min(500px, 80vh)"
            minH={0}
          >
            <Dialog.CloseTrigger asChild>
              <IconButton
                aria-label="关闭设置"
                variant="ghost"
                size="xs"
                position="absolute"
                top={3}
                right={3}
                zIndex={40}
              >
                <X size={15} />
              </IconButton>
            </Dialog.CloseTrigger>

            <Dialog.Body p={0} h="full" display="flex">
              {/* 左侧导航(pt 与内容区 p=6 对齐,首行按钮和第一行文字齐平) */}
              <VStack
                w="150px"
                flexShrink={0}
                align="stretch"
                gap={1}
                p={3}
                pt={6}
                borderRightWidth="1px"
                borderColor="border.subtle"
                bg="bg.subtle"
              >
                {SECTIONS.map((s) => {
                  const active = s.id === section;
                  return (
                    <Button
                      key={s.id}
                      w="full"
                      justifyContent="flex-start"
                      gap={2}
                      size="sm"
                      variant={active ? "subtle" : "ghost"}
                      onClick={() => setSection(s.id)}
                    >
                      <s.icon size={15} />
                      {s.label}
                    </Button>
                  );
                })}
              </VStack>

              {/* 右侧内容:悬浮滚动条 */}
              <Box flex={1} minW={0} position="relative" display="flex">
                <Box ref={contentRef} className="no-scrollbar" flex={1} minW={0} p={6} overflowY="auto">
                  {section === "general" && <GeneralSection />}
                  {section === "appearance" && <AppearanceSection />}
                </Box>
                <FloatingScrollbar targetRef={contentRef} />
              </Box>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
