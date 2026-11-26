// 前端环境变量类型声明（Rsbuild 通过 loadEnv + source.define 注入 web/.env 中的 VITE_ 变量）
interface ImportMetaEnv {
  readonly VITE_AMAP_KEY?: string;
  readonly VITE_AMAP_SECURITY_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
