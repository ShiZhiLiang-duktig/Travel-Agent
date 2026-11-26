/**
 * 全链路 Trace —— "可观测 + 可回放"的落地点。
 *
 * 每一步（求解、校验、压测、重规划）都落盘为 JSONL，
 * 面试时可现场演示"回放某次运行的完整决策链"。
 * 同时自动聚合每次 run 的关键指标到 metrics_index.json，
 * 方便简历上列"跑了 N 次，平均韧性分 X%"。
 *
 * Python 版 src/core/trace.py 的 TS 重写。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// src/core -> 上两级 = 项目根目录
const PROJECT_ROOT = join(__dirname, "..", "..");
export const DEFAULT_TRACE_DIR = join(PROJECT_ROOT, "traces");
const METRICS_INDEX = "metrics_index.json";

export interface TraceEventRecord {
  ts: string;
  run_id: string;
  step: string;
  agent: string;
  payload: unknown;
}

export class Tracer {
  run_id: string;
  trace_dir: string;
  path: string;
  events: TraceEventRecord[] = [];

  constructor(run_id: string, trace_dir?: string) {
    this.run_id = run_id;
    this.trace_dir = trace_dir ?? DEFAULT_TRACE_DIR;
    mkdirSync(this.trace_dir, { recursive: true });
    this.path = join(this.trace_dir, `${run_id}.jsonl`);
  }

  log(step: string, agent: string, payload: unknown): void {
    const event: TraceEventRecord = {
      ts: new Date().toISOString().slice(0, 19),
      run_id: this.run_id,
      step,
      agent,
      payload,
    };
    this.events.push(event);
    appendFileSync(this.path, JSON.stringify(event) + "\n", "utf-8");
  }

  summary() {
    return {
      run_id: this.run_id,
      total_events: this.events.length,
      agents: Array.from(new Set(this.events.map((e) => e.agent))).sort(),
      steps: this.events.map((e) => e.step),
    };
  }

  /** 落盘本次 run 的指标，并聚合到 metrics_index.json。返回本次指标文件路径。 */
  write_metrics(metrics: Record<string, unknown>): string {
    const per_run_path = join(this.trace_dir, `${this.run_id}.metrics.json`);
    const record = {
      run_id: this.run_id,
      ts: new Date().toISOString().slice(0, 19),
      metrics,
    };
    writeFileSync(per_run_path, JSON.stringify(record, null, 2), "utf-8");

    // 聚合到索引
    const index_path = join(this.trace_dir, METRICS_INDEX);
    let index: Record<string, unknown> = {};
    if (existsSync(index_path)) {
      try {
        index = JSON.parse(readFileSync(index_path, "utf-8"));
      } catch {
        index = {};
      }
    }

    const runs = (index.runs as Record<string, unknown>[]) ?? [];
    runs.push(record);
    index.runs = runs;
    index.last_updated = record.ts;

    const agg: Record<string, { count: number; mean: number; min: number; max: number }> = {};
    for (const key of ["pass_rate", "resilience_score", "changed_count"]) {
      const vals = runs
        .map((r) => (r.metrics as Record<string, unknown>)[key])
        .filter((v): v is number => typeof v === "number");
      if (vals.length > 0) {
        agg[key] = {
          count: vals.length,
          mean: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10000) / 10000,
          min: Math.round(Math.min(...vals) * 10000) / 10000,
          max: Math.round(Math.max(...vals) * 10000) / 10000,
        };
      }
    }
    index.aggregates = agg;

    writeFileSync(index_path, JSON.stringify(index, null, 2), "utf-8");
    return per_run_path;
  }
}
