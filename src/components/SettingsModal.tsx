import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  Box,
  Button,
  chakra,
  Dialog,
  Flex,
  HStack,
  IconButton,
  Menu,
  Portal,
  Slider,
  Text,
  VStack,
} from "@chakra-ui/react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ImagePlus,
  Minus,
  Palette,
  Plus,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useSettings, MAX_BACKGROUND_BLUR, type Language } from "../stores/settings";
import { isFolderVerbRegistered, isMdAssociated, openImageDialog, registerFolderVerb, registerMdAssociation, unregisterFolderVerb, unregisterMdAssociation } from "../tauri/api";
import { useBackgroundSrc } from "../lib/useBackgroundSrc";
import { useOverlayBlur } from "../lib/overlayBlur";
import { FloatingScrollbar } from "./FloatingScrollbar";

type SectionId = "general" | "appearance";

const SECTIONS: { id: SectionId; labelKey: string; icon: ComponentType<{ size?: number | string }> }[] = [
  { id: "general", labelKey: "settings.section.general", icon: SlidersHorizontal },
  { id: "appearance", labelKey: "settings.section.appearance", icon: Palette },
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
  const { t } = useTranslation();
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
      <LanguageRow />
      <Flex
        justify="space-between"
        align="center"
        gap={6}
        py={3}
        borderBottomWidth="1px"
        borderColor="border.subtle"
      >
        <Text fontSize="sm" color="fg.muted" flexShrink={0}>
          {t("settings.general.closeWindow")}
        </Text>
        <HStack gap={1}>
          {(
            [
              { v: "ask", label: t("settings.general.closeAction.ask") },
              { v: "tray", label: t("settings.general.closeAction.tray") },
              { v: "exit", label: t("settings.general.closeAction.exit") },
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
          label={t("settings.general.fileAssociation")}
          on={assoc}
          busy={assocBusy}
          statusOn={t("settings.general.associated")}
          statusOff={t("settings.general.notAssociated")}
          actionOn={t("settings.general.disassociate")}
          actionOff={t("settings.general.setDefault")}
          onToggle={() => void toggleAssociation()}
        />
      )}
      {folderVerb !== null && (
        <ToggleRow
          label={t("settings.general.folderContextMenu")}
          on={folderVerb}
          busy={folderVerbBusy}
          statusOn={t("settings.general.enabled")}
          statusOff={t("settings.general.notEnabled")}
          actionOn={t("settings.general.disable")}
          actionOff={t("settings.general.enable")}
          onToggle={() => void toggleFolderVerb()}
        />
      )}
    </VStack>
  );
}

function AppearanceSection() {
  const { t } = useTranslation();
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
          {t("settings.appearance.theme")}
        </Text>
        <HStack gap={1}>
          {(
            [
              { v: "light", label: t("settings.appearance.themeLight") },
              { v: "dark", label: t("settings.appearance.themeDark") },
              { v: "system", label: t("settings.appearance.themeSystem") },
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
          {t("settings.appearance.fontSize")}
        </Text>
        <HStack gap={1}>
          <IconButton aria-label={t("settings.appearance.fontSizeDecrease")} variant="ghost" size="xs" onClick={() => setFontSize(fontSize - 1)}>
            <Minus size={13} />
          </IconButton>
          <Text w="30px" textAlign="center" fontSize="sm">
            {fontSize}
          </Text>
          <IconButton aria-label={t("settings.appearance.fontSizeIncrease")} variant="ghost" size="xs" onClick={() => setFontSize(fontSize + 1)}>
            <Plus size={13} />
          </IconButton>
        </HStack>
      </Flex>

      <Flex justify="space-between" align="center" gap={6} py={3} borderBottomWidth="1px" borderColor="border.subtle">
        <Text fontSize="sm" color="fg.muted" flexShrink={0}>
          {t("settings.appearance.background")}
        </Text>
        <HStack gap={2} minW={0}>
          {backgroundSrc && (
            <chakra.button
              type="button"
              title={t("settings.appearance.backgroundChoose")}
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
            {backgroundName ?? t("settings.appearance.backgroundNone")}
          </Text>
          <Button size="xs" variant="subtle" gap={1} onClick={() => void pickBackground()}>
            <ImagePlus size={12} />
            {t("settings.appearance.backgroundChoose")}
          </Button>
          {backgroundImage && (
            <IconButton
              aria-label={t("settings.appearance.backgroundRemove")}
              title={t("settings.appearance.backgroundRemove")}
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
            {t("settings.appearance.backgroundBlur")}
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

/** 界面语言选择行(通用设置第一行)。 */
function LanguageRow() {
  const { t } = useTranslation();
  const language = useSettings((s) => s.language);
  const setLanguage = useSettings((s) => s.setLanguage);
  const options = [
    { v: "auto", label: t("settings.language.auto") },
    // 语言名用各自的原文显示,不随界面语言翻译。
    { v: "zh", label: "简体中文" },
    { v: "zh-TW", label: "繁體中文" },
    { v: "ja", label: "日本語" },
    { v: "en", label: "English" },
  ] as const;
  const current = options.find((o) => o.v === language) ?? options[0];
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
        {t("settings.language.label")}
      </Text>
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button size="xs" variant="outline" borderColor="border.subtle" fontWeight="normal" gap={1}>
            {current.label}
            <ChevronDown size={12} opacity={0.55} />
          </Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner zIndex={1000}>
            <Menu.Content
              minW="110px"
              bg="bg"
              borderWidth="1px"
              borderColor="border.subtle"
              borderRadius="10px"
              boxShadow="md"
              overflow="hidden"
              p={1}
            >
              <Menu.RadioItemGroup
                value={language}
                onValueChange={(e) => setLanguage(e.value as Language)}
              >
                {options.map((o) => (
                  <Menu.RadioItem
                    key={o.v}
                    value={o.v}
                    display="flex"
                    justifyContent="space-between"
                    fontSize="sm"
                    px={2}
                    py={1.5}
                    borderRadius="6px"
                  >
                    {o.label}
                    {language === o.v && <Check size={14} aria-hidden />}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioItemGroup>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </Flex>
  );
}

/**
 * 设置弹窗:左侧导航(通用/外观) + 右侧内容。
 * 背景半透明模糊;由首页左下角与顶栏"主题"左侧的设置按钮唤起。
 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
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
                aria-label={t("settings.close")}
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
                      {t(s.labelKey)}
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
