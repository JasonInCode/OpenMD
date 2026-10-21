import { useEffect, useRef } from "react";
import { Box, HStack, IconButton, Input, Text } from "@chakra-ui/react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useSearch } from "../stores/search";
import { closeSearch, setSearchQuery, stepSearchMatch } from "../lib/documentSearch";

/**
 * 顶栏搜索框:平时不显示,Ctrl+F 唤出,再次 Ctrl+F、点关闭按钮或按 Esc 收起。
 * 放在「目录」按钮左边,跟着顶栏一起走。
 */
export function TitleBarSearch({ compact }: { compact: boolean }) {
  const open = useSearch((s) => s.open);
  const query = useSearch((s) => s.query);
  const total = useSearch((s) => s.matches.length);
  const index = useSearch((s) => s.index);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  if (!open) return null;

  return (
    <HStack gap={1} alignItems="center" flexShrink={0}>
      <Box position="relative" display="flex" alignItems="center">
        <Box position="absolute" left="6px" color="fg.muted" pointerEvents="none" display="flex">
          <Search size={12} />
        </Box>
        <Input
          ref={inputRef}
          size="2xs"
          variant="subtle"
          value={query}
          placeholder="搜索"
          aria-label="在文档中搜索"
          w={compact ? "110px" : "170px"}
          pl="22px"
          fontSize="xs"
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              stepSearchMatch(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              closeSearch();
            }
          }}
        />
      </Box>
      <Text
        fontSize="2xs"
        color="fg.muted"
        minW="32px"
        textAlign="center"
        fontVariantNumeric="tabular-nums"
      >
        {`${index < 0 ? 0 : index + 1}/${total}`}
      </Text>
      <IconButton
        aria-label="上一个匹配"
        title="上一个匹配 (Shift+Enter)"
        variant="ghost"
        size="2xs"
        onClick={() => stepSearchMatch(-1)}
      >
        <ChevronUp size={14} />
      </IconButton>
      <IconButton
        aria-label="下一个匹配"
        title="下一个匹配 (Enter)"
        variant="ghost"
        size="2xs"
        onClick={() => stepSearchMatch(1)}
      >
        <ChevronDown size={14} />
      </IconButton>
      <IconButton
        aria-label="关闭搜索"
        title="关闭搜索 (Esc)"
        variant="ghost"
        size="2xs"
        onClick={closeSearch}
      >
        <X size={14} />
      </IconButton>
    </HStack>
  );
}
