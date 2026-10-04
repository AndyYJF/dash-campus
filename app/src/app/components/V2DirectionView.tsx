"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import { compose, emitChanged, useDashRefresh } from "./dashBus";
import styles from "./v2.module.css";

/**
 * V2 方向页（REPAIR-PLAN §5.3）：最多 1 个主方向 + 2 个候选；进行中的项目给下一步、证据和基于记录的建议。
 * 没有证据就承认；选“试做”只是在这里建一个有期限的小项目，不代表报名或对外承诺。
 */

type Project = {
  id: string;
  title: string;
  question: string;
  engagement: string;
  trialUntil: string | null;
  trialEnded: boolean;
  openQuestions: string[];
  openTasks: Array<{ id: string; title: string; estimateMinutes: number | null }>;
  nextSessions: Array<{ id: string; title: string; startUtc: string; endUtc: string; reason: string }>;
  evidence: Array<{ id: string; occurredOn: string; actualMinutes: number | null; note: string; blocker: string }>;
  requirements: string[];
  achievements: string[];
  suggestion: string;
};
type Candidate = {
  id: string;
  title: string;
  question: string;
  deliverable: string;
  fitReason: string;
  evidenceStatus: string;
  canonicalUrl: string | null;
  firstStep: { title: string; estimateMinutes: number | null } | null;
  requirements: Array<{ label: string; status: string }>;
  unknowns: string[];
};
type Direction = {
  mainGoal: { id: string; title: string } | null;
  goals: Array<{ id: string; title: string; status: string; primary: boolean }>;
  projects: Project[];
  candidates: Candidate[];
  practice: Array<{ id: string; occurredOn: string; actualMinutes: number | null; note: string; blocker: string; category: string }>;
  honesty: string;
};

const REQ: Record<string, string> = { met: "具备", unmet: "不具备", unknown: "未确认" };
const SOURCE: Record<string, string> = { retrieved: "已读到原文", snippet: "只有摘要", user_supplied: "你提供的资料" };

function when(utc: string): string {
  const d = new Date(utc);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

export default function V2DirectionView() {
  const [data, setData] = useState<Direction | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api<Direction>("/api/v2/direction")
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);
  useEffect(refresh, [refresh]);
  useDashRefresh(refresh);

  const act = useCallback((operation: string, args: Record<string, unknown>) => {
    api("/api/v2/actions", { method: "POST", body: { operation, args }, idempotencyKey: newIdempotencyKey() })
      .then(() => emitChanged())
      .catch((e) => setError(e instanceof Error ? e.message : "操作没有成功"));
  }, []);

  if (error && !data) return <p className={styles.error}>{error}</p>;
  if (!data) return <p className={styles.muted}>加载中…</p>;

  return (
    <div className={styles.page}>
      <section className={styles.card}>
        <h2 className={styles.title}>当前主要方向</h2>
        {data.mainGoal ? <p className={styles.lead}>{data.mainGoal.title}</p> : <p className={styles.muted}>还没有定主要方向——不确定也没关系。想好了说一句，比如“这学期先打好数学基础”。</p>}
        {data.goals.filter((g) => !g.primary).length > 0 && (
          <p className={styles.muted}>
            其他目标：
            {data.goals
              .filter((g) => !g.primary)
              .map((g) => `${g.title}${g.status === "paused" ? "（暂停）" : ""}`)
              .join("、")}
          </p>
        )}
        <p className={styles.muted}>{data.honesty}</p>
        {error && <p className={styles.error}>{error}</p>}
      </section>

      {data.projects.map((p) => (
        <section key={p.id} className={styles.card}>
          <h2 className={styles.title}>
            {p.title}
            <em className={styles.tagBadge} data-tone={p.engagement === "trial" ? "warn" : "ok"}>
              {p.engagement === "trial" ? `试做${p.trialUntil ? ` · 到 ${p.trialUntil}` : ""}` : "正式投入"}
            </em>
          </h2>
          {p.question && <p className={styles.muted}>想弄清楚：{p.question}</p>}
          <p className={styles.why}>{p.suggestion}</p>
          {p.trialEnded && <p className={styles.question}>试做期到了。继续、换一个，还是转为正式投入？直接说一句就行。</p>}
          {p.nextSessions.length > 0 && (
            <>
              <h3 className={styles.subtitle}>已排的下一步</h3>
              {p.nextSessions.map((s) => (
                <div key={s.id} className={styles.session}>
                  <span className={styles.time}>{when(s.startUtc)}</span>
                  <span className={styles.sessionTitle}>{s.title}</span>
                </div>
              ))}
            </>
          )}
          {p.nextSessions.length === 0 && p.openTasks.length > 0 && <p className={styles.muted}>还没排上时间的步骤：{p.openTasks.map((t) => t.title).join("、")}</p>}
          <h3 className={styles.subtitle}>实践证据（最近 14 天）</h3>
          {p.evidence.length === 0 && <p className={styles.muted}>还没有记录。做完一次，说一句“做了多久、卡在哪”就会出现在这里。</p>}
          {p.evidence.map((e) => (
            <div key={e.id} className={styles.session}>
              <span className={styles.time}>{e.occurredOn.slice(5)}</span>
              <span className={styles.sessionTitle}>
                {e.note || "实践"}
                {e.blocker ? `（卡点：${e.blocker}）` : ""}
              </span>
              <span className={styles.muted}>{e.actualMinutes === null ? "分钟未知" : `${e.actualMinutes}′`}</span>
            </div>
          ))}
          {p.requirements.length > 0 && <p className={styles.muted}>别人的要求（不算你的成果）：{p.requirements.join("、")}</p>}
          {p.achievements.length > 0 && <p className={styles.muted}>你完成的成果：{p.achievements.join("、")}</p>}
          {p.openQuestions.length > 0 && <p className={styles.muted}>待验证：{p.openQuestions.join("；")}</p>}
          <div className={styles.detailActions}>
            {p.engagement === "trial" && (
              <button type="button" className={styles.btn} onClick={() => act("update_project_state", { projectId: p.id, engagement: "committed" })}>
                转为正式投入
              </button>
            )}
            <button type="button" className={styles.btn} onClick={() => act("update_project_state", { projectId: p.id, status: "paused" })}>
              先暂停
            </button>
            <button type="button" className={styles.btnGhost} onClick={() => compose({ label: p.title, command: "record", text: "", selectedEntityRef: { kind: "project", id: p.id } })}>
              说说进展…
            </button>
          </div>
        </section>
      ))}

      <section className={styles.card}>
        <h2 className={styles.title}>候选{data.projects.length ? "（最多 2 个）" : "（最多 3 个）"}</h2>
        {data.candidates.length === 0 && (
          <p className={styles.muted}>
            暂无候选。可以说“帮我找一个能试出是否喜欢科研的小项目”，或者把看到的项目资料直接放进输入框。
          </p>
        )}
        {data.candidates.map((c) => (
          <div key={c.id} className={styles.cand}>
            <div className={styles.candHead}>
              <span className={styles.candTitle}>{c.title}</span>
              {c.canonicalUrl ? (
                <a href={c.canonicalUrl} target="_blank" rel="noreferrer" className={styles.link}>
                  来源↗
                </a>
              ) : (
                <em className={styles.tagBadge}>无链接</em>
              )}
            </div>
            {c.fitReason && <p className={styles.why}>为什么可能适合：{c.fitReason}</p>}
            {c.firstStep && (
              <p className={styles.muted}>
                第一步：{c.firstStep.title}
                {c.firstStep.estimateMinutes ? `（约 ${c.firstStep.estimateMinutes} 分钟）` : ""}
              </p>
            )}
            {c.requirements.length > 0 && <p className={styles.muted}>前置条件：{c.requirements.map((r) => `${r.label}（${REQ[r.status] ?? r.status}）`).join("；")}</p>}
            {c.unknowns.length > 0 && <p className={styles.muted}>待验证：{c.unknowns.join("；")}</p>}
            <p className={styles.muted}>
              {c.deliverable && `做完能得到：${c.deliverable} · `}资料：{SOURCE[c.evidenceStatus] ?? c.evidenceStatus}
            </p>
            <div className={styles.detailActions}>
              <button type="button" className={styles.btnPrimary} onClick={() => act("select_candidate", { candidateId: c.id, mode: "trial", trialWeeks: 2 })}>
                试做两周
              </button>
              <span className={styles.muted}>只在这里建一个小项目和第一步，不代表报名或对外承诺</span>
            </div>
          </div>
        ))}
      </section>

      <section className={styles.card}>
        <h2 className={styles.title}>最近的实践记录</h2>
        {data.practice.length === 0 && <p className={styles.muted}>还没有实践记录。在顶部输入框说一句「今天学了…」就会出现在这里。</p>}
        {data.practice.map((p) => (
          <div key={p.id} className={styles.session}>
            <span className={styles.time}>{p.occurredOn.slice(5)}</span>
            <span className={styles.sessionTitle}>
              {p.note || "实践"}
              {p.category === "other" ? "（不算学习投入）" : ""}
              {p.blocker ? `（卡点：${p.blocker}）` : ""}
            </span>
            <span className={styles.muted}>{p.actualMinutes === null ? "分钟未知" : `${p.actualMinutes}′`}</span>
          </div>
        ))}
      </section>

      <p className={styles.muted}>
        旧版入口：
        <Link className={styles.link} href="/inbox">
          收件箱（含被折叠的通知）
        </Link>{" "}
        ·{" "}
        <Link className={styles.link} href="/reviews">
          回顾
        </Link>{" "}
        ·{" "}
        <Link className={styles.link} href="/explore">
          探索记录
        </Link>
      </p>
    </div>
  );
}
