/**
 * 只读分享：把一份行程快照存成公开 slug，供未登录访客查看。
 *
 * 存储策略（与 auth / db 的降级策略保持一致）：
 *   - PG 就绪 → 写 shares 表（权威存储）
 *   - PG 不可用 → 写 .data/shares.json（原子落盘，进程重启后链接仍可访问）
 * 无论 PG 是否就绪，都会同步写一份本地镜像，保证数据库挂掉后历史分享不失效。
 * 未登录访客通过 GET /api/share/:slug + 前端 /s/:slug 查看。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDbReady, dbSaveShare, dbGetShare } from "./db.js";

/** 分享内容：行程快照 + 展示所需的元信息（不含用户隐私） */
export interface SharePayload {
  title: string;
  city: string;
  days: number;
  startDate: string;
  itinerary: unknown;
}

export interface ShareRecord {
  slug: string;
  payload: SharePayload;
  owner: string;
  created_at: string;
}

const memory = new Map<string, ShareRecord>();
const SHARE_FILE = fileURLToPath(new URL("../../.data/shares.json", import.meta.url));

/** 模块加载时恢复历史分享：无 PG 也能在重启后继续访问旧链接 */
function loadLocalShares(): void {
  try {
    if (!fs.existsSync(SHARE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SHARE_FILE, "utf8"));
    if (Array.isArray(data?.shares)) {
      for (const rec of data.shares) {
        if (rec?.slug && rec?.payload) memory.set(rec.slug, rec as ShareRecord);
      }
    }
  } catch (e: any) {
    console.warn(`[shares] 本地分享文件读取失败：${e?.message || e}`);
  }
}
loadLocalShares();

/** 原子写盘（临时文件 + 重命名，避免写一半损坏） */
function persistLocalShares(): void {
  try {
    fs.mkdirSync(path.dirname(SHARE_FILE), { recursive: true });
    const payload = { version: 1, shares: [...memory.values()] };
    const tmp = SHARE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    fs.renameSync(tmp, SHARE_FILE);
  } catch (e: any) {
    console.warn(`[shares] 本地分享写入失败：${e?.message || e}`);
  }
}

/** 生成 URL 安全的短 slug（8 字符） */
function genSlug(): string {
  return crypto.randomBytes(6).toString("base64url");
}

/** 新建分享，返回带 slug 的记录 */
export async function saveShare(
  payload: SharePayload,
  owner: string,
): Promise<ShareRecord> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = genSlug();
    if (memory.has(slug)) continue;
    const rec: ShareRecord = {
      slug,
      payload,
      owner,
      created_at: new Date().toISOString(),
    };
    memory.set(slug, rec);
    if (isDbReady()) {
      try {
        await dbSaveShare(slug, payload, owner);
      } catch {
        /* 落库失败 → 本地文件兜底已足够 */
      }
    }
    persistLocalShares();
    return rec;
  }
  throw new Error("生成分享链接失败，请重试");
}

/** 读取分享（内存 → 本地文件 → PG） */
export async function getShare(slug: string): Promise<ShareRecord | null> {
  const cached = memory.get(slug);
  if (cached) return cached;
  if (!isDbReady()) return null;
  try {
    const row = await dbGetShare(slug);
    if (!row) return null;
    const rec: ShareRecord = {
      slug: row.slug,
      payload: row.payload as SharePayload,
      owner: row.owner || "",
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    };
    memory.set(slug, rec);
    persistLocalShares();
    return rec;
  } catch {
    return null;
  }
}
