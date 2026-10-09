"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  NEWS_CATEGORIES,
  NEWS_LABELS,
  type NewsPolicy,
  type NewsRun,
} from "@/contracts/ai-news";
import { api, newIdempotencyKey } from "./api";
import { compose, emitChanged, useDashRefresh } from "./dashBus";
import ErrorNote, { toErrorState } from "./ErrorNote";
import styles from "./news.module.css";
type Data = {
  latest: NewsRun | null;
  runs: Array<
    Pick<
      NewsRun,
      "id" | "status" | "days" | "createdAt" | "errorMessage" | "trigger"
    >
  >;
  policy: NewsPolicy;
  version: number;
  scheduledEnabled: boolean;
  timezone: string;
};
const STATUS: Record<NewsRun["status"], string> = {
  queued: "排队中",
  running: "正在检索与总结",
  ready: "已生成",
  empty: "近期没有可收录资讯",
  failed: "更新失败",
  cancelled: "更新已取消",
};
export default function NewsView() {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState<{ message: string; status?: number } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [category, setCategory] = useState<
      "all" | (typeof NEWS_CATEGORIES)[number]
    >("all");
  const key = useRef<{ action: string; key: string } | null>(null);
  const refresh = useCallback(() => {
    api<Data>("/api/v2/ai-news")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(toErrorState(e, "加载资讯失败")));
  }, []);
  useEffect(refresh, [refresh]);
  useDashRefresh(refresh);
  const running =
    data?.runs.some((r) => ["queued", "running"].includes(r.status)) ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [running, refresh]);
  async function action(operation: string, args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const signature = JSON.stringify({ operation, args });
    if (key.current?.action !== signature)
      key.current = { action: signature, key: newIdempotencyKey() };
    try {
      await api("/api/v2/actions", {
        method: "POST",
        body: { operation, args },
        idempotencyKey: key.current.key,
      });
      key.current = null;
      emitChanged();
      refresh();
    } catch (e) {
      setError(toErrorState(e, "操作未完成"));
    } finally {
      setBusy(false);
    }
  }
  const when = (v: string) =>
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: data?.timezone ?? "Asia/Shanghai",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(v));
  const latest = data?.latest,
    attempt = data?.runs[0],
    stories = latest?.digest?.stories ?? [],
    shown = stories.filter(
      (s) => category === "all" || s.category === category,
    );
  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <p>
          {latest
            ? `最近 ${latest.days} 天 · ${stories.length} 条 · ${when(latest.generatedAt!)} 生成`
            : "最近7天的重要变化，保留原文与依据"}
        </p>
        <button
          disabled={busy || running || !data}
          onClick={() =>
            action("request_ai_news", { days: data?.policy.days ?? 7 })
          }
        >
          {running ? "正在更新…" : "更新资讯"}
        </button>
      </div>
      {running && (
        <button disabled={busy} onClick={() => action("cancel_ai_news", {})}>
          停止本次更新
        </button>
      )}
      <ErrorNote error={error} />
      {!data && !error && <p role="status">正在加载资讯…</p>}
      {attempt &&
        ["queued", "running", "failed", "cancelled"].includes(
          attempt.status,
        ) && (
          <p className={styles.notice} role="status">
            {STATUS[attempt.status]}
            {attempt.errorMessage
              ? `：${attempt.errorMessage}`
              : "，完成后自动刷新"}
            {latest && attempt.id !== latest.id
              ? "。下方保留上次成功盘点。"
              : ""}
          </p>
        )}
      {data && (
        <div className={styles.schedule}>
          <p>
            {data.policy.enabled
              ? `每天 ${data.policy.localTime}（${data.timezone}）自动盘点最近 ${data.policy.days} 天`
              : "自动更新已暂停"}
            {data.policy.enabled && !data.scheduledEnabled
              ? "；定期AI总开关当前关闭，暂不会自动运行"
              : "；受每日调用预算限制"}
            。
          </p>
          <div>
            <button
              disabled={busy}
              onClick={() =>
                action("update_ai_news_policy", {
                  enabled: !data.policy.enabled,
                  expectedVersion: data.version,
                })
              }
            >
              {data.policy.enabled ? "暂停自动更新" : "恢复自动更新"}
            </button>
            <button
              onClick={() =>
                compose({
                  label: "AI资讯自动更新",
                  text: "帮我调整AI资讯的自动更新时间和盘点范围，先问我偏好",
                })
              }
            >
              让Agent调整
            </button>
          </div>
        </div>
      )}
      {latest?.warnings.length ? (
        <details className={styles.coverage}>
          <summary>
            本次来源与覆盖范围（{latest.warnings.length}项说明）
          </summary>
          <ul>
            {latest.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <p>
            公开订阅与搜索摘要只能覆盖部分资讯；引用核对不等于独立核实每项宣传效果。
          </p>
        </details>
      ) : null}
      {data && !latest && !running && (
        <div className={styles.empty}>
          <h2>还没有资讯盘点</h2>
          <p>
            点击“更新资讯”，Agent会读取近期来源，按四类整理事实和学习启发。不会自动给你添加任务。
          </p>
        </div>
      )}
      {latest && (
        <>
          <div className={styles.filters} aria-label="资讯分类">
            {(["all", ...NEWS_CATEGORIES] as const).map((c) => (
              <button
                key={c}
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {c === "all" ? "全部" : NEWS_LABELS[c]}{" "}
                <span>
                  {c === "all"
                    ? stories.length
                    : stories.filter((s) => s.category === c).length}
                </span>
              </button>
            ))}
          </div>
          {!shown.length && (
            <p className={styles.empty}>
              {stories.length
                ? "本次没有收录这个类别，不为凑数量编造新闻。"
                : "已取得来源，但这个时间范围内没有日期明确、可收录的新闻。"}
            </p>
          )}
          <div className={styles.stories}>
            {shown.map((s, i) => {
              const refs = s.citations.map((c) => ({
                c,
                source: latest.sources.find((x) => x.id === c.sourceId)!,
              }));
              return (
                <article key={`${s.title}:${i}`} className={styles.story}>
                  <div className={styles.meta}>
                    {NEWS_LABELS[s.category]} ·{" "}
                    {refs
                      .map((r) => r.source.publisher)
                      .filter((v, j, a) => a.indexOf(v) === j)
                      .join(" / ")}
                    {latest.integrationMode === "fixture" ? " · 演示数据" : ""}
                  </div>
                  <h2>{s.title}</h2>
                  <p className={styles.summary}>{s.summary}</p>
                  <div className={styles.interpretation}>
                    <strong>Agent解读 · 对学习和科研的意义</strong>
                    <p>{s.relevance}</p>
                    {s.uncertainty && (
                      <p className={styles.muted}>仍需留意：{s.uncertainty}</p>
                    )}
                  </div>
                  <details>
                    <summary>查看来源与依据</summary>
                    {refs.map(({ c, source }) => (
                      <div className={styles.source} key={c.sourceId}>
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {source.title} ↗
                        </a>
                        <p className={styles.muted}>
                          {source.publisher} ·{" "}
                          {source.publishedAt
                            ? `发布于 ${when(source.publishedAt)}`
                            : "发布日期未知"}{" "}
                          ·{" "}
                          {source.evidence === "snippet"
                            ? "搜索摘要"
                            : "订阅摘要"}
                        </p>
                        <blockquote>{c.quote}</blockquote>
                      </div>
                    ))}
                  </details>
                  <button
                    className={styles.ask}
                    onClick={() =>
                      compose({
                        label: s.title,
                        text: `关于AI资讯「${s.title}」（来源：${refs[0].source.url}），请先读取已保存资讯，解释我需要哪些基础、能怎样动手理解。不要直接添加任务。`,
                      })
                    }
                  >
                    问Agent：我能怎么学
                  </button>
                </article>
              );
            })}
          </div>
        </>
      )}
      {data && data.runs.length > 1 && (
        <details className={styles.history}>
          <summary>最近更新记录</summary>
          <ul>
            {data.runs.map((r) => (
              <li key={r.id}>
                {when(r.createdAt)} · {r.trigger === "manual" ? "手动" : "自动"}{" "}
                · 最近{r.days}天 · {STATUS[r.status]}
                {r.errorMessage ? `：${r.errorMessage}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
