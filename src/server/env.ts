/**
 * 加载 .env（Node 20.12+ 内置，零依赖）。
 * 必须在读取环境变量的模块（db.ts 的 DATABASE_URL）之前被导入执行。
 */
try {
  const load = (process as any).loadEnvFile;
  if (typeof load === "function") load();
} catch {
  /* .env 不存在或不可读时忽略 */
}
