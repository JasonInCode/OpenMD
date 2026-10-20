/** 是否运行在 Tauri WebView 内(false 表示普通浏览器预览)。 */
export const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;