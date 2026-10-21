import { Box, Button, IconButton, Portal } from "@chakra-ui/react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

type TitleBarSliderControlProps = {
  /** 按钮图标。 */
  icon: LucideIcon;
  /** 按钮文字(紧凑模式下只留图标)。 */
  label: string;
  /** 按钮 aria-label 与 tooltip。 */
  title: string;
  /** 紧凑模式:按钮退化为图标。 */
  compact: boolean;
  /** 面板内容(滑条等)。 */
  children: ReactNode;
};

/**
 * 顶栏的悬停式调节控件:一个按钮 + 悬停展开的面板,边距与字号共用同一套展开/收起时序。
 */
export function TitleBarSliderControl({
  icon,
  label,
  title,
  compact,
  children,
}: TitleBarSliderControlProps) {
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  // 面板从按钮下沿弹出,坐标要等 portal 渲染后才能脱离顶栏的 overflow:hidden
  // (顶栏中间操作区为避免挤压 WindowControls 加了 overflow:hidden,不 portal 会被裁)。
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const exitTimer = useRef<number | null>(null);
  // 指针是否还在按钮或面板上:面板被 Portal 挂到 body 下,不是按钮的 DOM 子节点,
  // 不能靠 wrapRef.matches(":hover") 判断,只能自己记。
  const hovering = useRef(false);

  const clearTimers = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (exitTimer.current !== null) {
      window.clearTimeout(exitTimer.current);
      exitTimer.current = null;
    }
  };

  const show = () => {
    clearTimers();
    // 重新取按钮 rect:窗口大小变化 / 顶栏换行后位置会变,不能用缓存值。
    const wrap = wrapRef.current;
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      setPos({ x: rect.left + rect.width / 2, y: rect.bottom + 8 });
    }
    setPhase("open");
  };

  // 收起分两步:先切到 closing 播退场动画,动画结束再真正卸载。
  const close = () => {
    clearTimers();
    setPhase((p) => (p === "closed" ? p : "closing"));
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null;
      setPhase("closed");
    }, 120);
  };

  const scheduleClose = () => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      close();
    }, 120);
  };

  // 拖滑块时指针会滑出面板:按住期间不收起,松手后再判断是否已真正离开。
  const handleLeave = (e: { buttons: number }) => {
    hovering.current = false;
    if (e.buttons !== 0) return;
    scheduleClose();
  };

  useEffect(() => clearTimers, []);

  useEffect(() => {
    const onPointerUp = () => {
      if (!hovering.current) close();
    };
    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  }, []);

  const handleEnter = () => {
    hovering.current = true;
    show();
  };

  const Icon = icon;

  return (
    <Box
      ref={wrapRef}
      position="relative"
      display="flex"
      alignItems="center"
      onPointerEnter={handleEnter}
      onPointerLeave={handleLeave}
    >
      {compact ? (
        <IconButton
          aria-label={label}
          title={title}
          variant="ghost"
          size="xs"
          onClick={show}
        >
          <Icon size={14} />
        </IconButton>
      ) : (
        <Button
          aria-label={label}
          title={title}
          variant="ghost"
          size="sm"
          gap={1.5}
          onClick={show}
        >
          <Icon size={15} />
          {label}
          <ChevronDown size={12} opacity={0.55} />
        </Button>
      )}

      {/* 悬停展开的调节面板:Portal 渲染到 body 之外,避开顶栏 overflow:hidden 的裁剪。
          animationFillMode="both" 让退场动画播完后停在末态(opacity 0):
          Chakra 的 animationStyle 只给 animationName、不带 fill-mode,
          动画结束到定时卸载之间元素会回弹到不透明,肉眼就是"闪一下"。 */}
      {phase !== "closed" && pos && (
        <Portal>
          <Box
            data-placement="bottom"
            animationStyle={phase === "open" ? "slide-fade-in" : "slide-fade-out"}
            animationDuration={phase === "open" ? "fast" : "faster"}
            animationFillMode="both"
            position="fixed"
            top={`${pos.y}px`}
            left={`${pos.x}px`}
            transform="translateX(-50%)"
            zIndex={1000}
            minW="220px"
            bg="bg"
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="10px"
            boxShadow="md"
            p={3}
            onPointerEnter={handleEnter}
            onPointerLeave={handleLeave}
          >
            {children}
          </Box>
        </Portal>
      )}
    </Box>
  );
}
