/**
 * 主题系统：基底固定为「浅灰侧栏 + 纯白主区」的极简风格，
 * 只切换强调色（主按钮、选中态、地图标记、强调文字）。
 * 通过 <html data-theme="xxx"> 驱动 styles.css 中的 CSS 变量覆盖。
 */
export type ThemeKey = "graphite" | "ocean" | "forest" | "clay" | "lilac";

export interface ThemeDef {
  key: ThemeKey;
  name: string;
  swatch: string;
  desc: string;
}

export const THEMES: ThemeDef[] = [
  { key: "ocean", name: "海盐蓝", swatch: "#2563eb", desc: "清爽理性" },
  { key: "graphite", name: "纯白", swatch: "#f5f5f7", desc: "干净留白" },
  { key: "forest", name: "苔绿", swatch: "#059669", desc: "自然沉静" },
  { key: "clay", name: "赤陶", swatch: "#ea580c", desc: "温暖有力" },
  { key: "lilac", name: "丁香紫", swatch: "#7c3aed", desc: "品牌紫" },
];

const STORAGE_KEY = "tuwen.theme.v2";
const DEFAULT_THEME: ThemeKey = "ocean";

/** 读取主题：不做持久化，每次刷新都回到默认主题 */
export function getStoredTheme(): ThemeKey {
  return DEFAULT_THEME;
}

/** 当前用户选择的主题（运行期唯一真值，供属性守护使用） */
let currentKey: ThemeKey = DEFAULT_THEME;
let guardStarted = false;

/** 应用主题：写 data-theme 到 <html>，并同步 Semi UI 为浅色模式，最后持久化 */
export function applyTheme(key: ThemeKey): void {
  currentKey = key;
  document.documentElement.dataset.theme = key;
  // 全部主题均为浅色方案，Semi 组件保持 light
  if (document.body) {
    document.body.setAttribute("theme-mode", "light");
  }
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * 部分宿主环境（如 IDE 内置浏览器）会在页面加载后注入自己的 data-theme，
 * 这里监听 <html> 属性变化并把值纠正回用户选择。真实浏览器中该监听永不触发。
 */
function startThemeGuard(): void {
  if (guardStarted || typeof MutationObserver === "undefined") return;
  guardStarted = true;
  new MutationObserver(() => {
    if (document.documentElement.dataset.theme !== currentKey) {
      document.documentElement.dataset.theme = currentKey;
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

/** 启动时初始化：读取并应用，返回当前主题 */
export function initTheme(): ThemeKey {
  const key = getStoredTheme();
  applyTheme(key);
  startThemeGuard();
  return key;
}
