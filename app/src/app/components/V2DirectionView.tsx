"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PATH_LABEL, type PathKey } from "@/content/direction/stages";
import { api, newIdempotencyKey } from "./api";
import { compose, emitChanged, useDashRefresh } from "./dashBus";
import styles from "./v2.module.css";

/**
 * V2 方向页（方向页打磨 D1）：四年地图与工作样本只读展示；阶段/去向由主人明确选择。
 * 试做只建有期限的小项目，不代表报名。GET 不创建任务。
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
type Stage = {
  key: "year1" | "year2" | "year3" | "year4";
  label: string;
  title: string;
  purpose: string;
  foundations: string[];
  choices: string[];
  outputs: string[];
  nextNeeds: string[];
  pathHints: Partial<Record<Exclude<PathKey, "undecided">, string>>;
  adopted: Array<{ id: string; title: string; purpose: string; status: string }>;
};
type Sample = {
  templateKey: string;
  title: string;
  problem: string;
  activities: string[];
  sample: { steps: string[]; output: string };
  basics: Array<{ label: string; needed: boolean }>;
  trial: { title: string; verifies: string; firstStep: string; estimateMinutes: number };
  follow: { id: string; status: string; version: number } | null;
};
type Track = {
  id: string;
  title: string;
  status: string;
  problem: string | null;
  activities: string[];
  sample: { steps: string[]; output: string } | null;
  basics: Array<{ label: string; needed: boolean }>;
  trial: { title: string; verifies: string; firstStep: string; estimateMinutes: number } | null;
  projects: Array<{ id: string; title: string; status: string; engagement: string }>;
};
type Direction = {
  mainGoal: { id: string; title: string } | null;
  goals: Array<{ id: string; title: string; status: string; primary: boolean }>;
  projects: Project[];
  candidates: Candidate[];
  practice: Array<{ id: string; occurredOn: string; actualMinutes: number | null; note: string; blocker: string; category: string }>;
  honesty: string;
  profile: { confirmedStage: Stage["key"] | null; stageLabel: string | null; entryYear: number | null; pathPreferences: PathKey[]; version: number };
  roadmap: Stage[];
  tracks: Track[];
  workSamples: Sample[];
  notes: Array<{ id: string; title: string; noteKind: string | null; url: string | null }>;
  reflections: Array<{ id: string; originalText: string; occurredOn: string }>;
};

const REQ: Record<string, string> = { met: "具备", unmet: "不具备", unknown: "未确认" };
const SOURCE: Record<string, string> = { retrieved: "已读到原文", snippet: "只有摘要", user_supplied: "你提供的资料" };
const PATHS: PathKey[] = ["research", "further_study", "employment", "undecided"];
const TRACK_STATUS: Record<string, string> = { exploring: "在了解", following: "持续关注", paused: "先不看" };

function sampleBody(s: { problem?: string | null; activities: string[]; sample: { steps: string[]; output: string } | null; basics: Array<{ label: string; needed: boolean }>; trial: { title: string; verifies: string; firstStep: string; estimateMinutes: number } | null }) {
  const needed = s.basics.filter((b) => b.needed).map((b) => b.label);
  const later = s.basics.filter((b) => !b.needed).map((b) => b.label);
  return (
    <>
      {s.problem && <p className={styles.candLead}>{s.problem}</p>}
      <dl className={styles.facts}>
        {s.activities.length > 0 && (
          <div>
            <dt>平时做</dt>
            <dd>{s.activities.join("、")}</dd>
          </div>
        )}
        {s.sample && (
          <div>
            <dt>工作样本</dt>
            <dd>
              {s.sample.steps.join(" → ")}。产出：{s.sample.output}
            </dd>
          </div>
        )}
        {s.trial && (
          <div>
            <dt>可以试</dt>
            <dd>
              {s.trial.title}（约 {s.trial.estimateMinutes} 分钟）——{s.trial.verifies}。第一步：{s.trial.firstStep}
            </dd>
          </div>
        )}
        {s.basics.length > 0 && (
          <div>
            <dt>基础</dt>
            <dd>
              {needed.join("、")}
              {later.length ? `；暂不需要：${later.join("、")}` : ""}
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

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

  const togglePath = (key: PathKey) => {
    const cur = new Set(data.profile.pathPreferences);
    if (cur.has(key)) cur.delete(key);
    else cur.add(key);
    act("update_direction_profile", { expectedVersion: data.profile.version, pathPreferences: [...cur] });
  };

  return (
    <div className={styles.pageWide} data-page="direction">
      <header className={styles.mast}>
        <p className={styles.kicker}>当前主要方向</p>
        <h1 className={styles.mastTitle}>{data.mainGoal ? data.mainGoal.title : "还没有定"}</h1>
        {!data.mainGoal && <p className={styles.lede}>不确定也没关系。想好了说一句，比如“这学期先打好数学基础”。</p>}
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
      </header>

      <section className={`${styles.card} ${styles.stages}`}>
        <h2 className={styles.title}>四年阶段</h2>
        <p className={styles.lead}>
          {data.profile.stageLabel ? `你确认现在处于${data.profile.stageLabel}` : "还没确认现在处于哪一阶段——先看一类工作的样子，再试一次。"}
          {data.profile.entryYear ? ` · 入学 ${data.profile.entryYear}` : " · 入学年未知也能用"}
        </p>
        <div className={styles.pathRow}>
          {PATHS.map((k) => (
            <button key={k} type="button" className={data.profile.pathPreferences.includes(k) ? styles.btnPrimary : styles.btn} onClick={() => togglePath(k)}>
              {PATH_LABEL[k]}
            </button>
          ))}
        </div>
        <p className={styles.muted}>去向可以并存，没选的不代表排除。点上面记下你明确说过的偏好；不会生成全年待办。</p>
        <div className={styles.stageStrip}>
          {data.roadmap.map((s) => (
            <article key={s.key} className={styles.stageCard} data-current={data.profile.confirmedStage === s.key ? "true" : "false"}>
              <h3 className={styles.subtitle}>
                {s.label} · {s.title}
              </h3>
              <p className={styles.candLead}>{s.purpose}</p>
              <dl className={styles.facts} data-stack="true">
                <div>
                  <dt>共同基础</dt>
                  <dd>{s.foundations.join("；")}</dd>
                </div>
                <div>
                  <dt>值得验证</dt>
                  <dd>{s.choices.join("；")}</dd>
                </div>
                {s.adopted.length > 0 && (
                  <div>
                    <dt>你采用的</dt>
                    <dd>{s.adopted.map((i) => `${i.title}${i.status === "completed" ? "（完成）" : ""}`).join("、")}</dd>
                  </div>
                )}
                {Object.entries(s.pathHints).map(([k, text]) =>
                  text ? (
                    <div key={k}>
                      <dt>{PATH_LABEL[k as PathKey]}</dt>
                      <dd>{text}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
              <div className={styles.detailActions}>
                <button type="button" className={styles.btn} onClick={() => act("update_direction_profile", { expectedVersion: data.profile.version, confirmedStage: s.key })}>
                  我现在在{s.label}
                </button>
                {s.choices[0] && (
                  <button type="button" className={styles.btnGhost} onClick={() => act("update_roadmap_item", { stageKey: s.key, title: s.choices[0], purpose: s.purpose })}>
                    采用这条
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        {error && <p className={styles.error}>{error}</p>}
      </section>

      {data.tracks.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.title}>你在关注的工作</h2>
          {data.tracks.map((t) => (
            <div key={t.id} className={styles.cand}>
              <div className={styles.candHead}>
                <span className={styles.candTitle}>{t.title}</span>
                <em className={styles.tagBadge}>{TRACK_STATUS[t.status] ?? t.status}</em>
              </div>
              {sampleBody(t)}
              {t.projects.length > 0 ? <p className={styles.muted}>关联项目：{t.projects.map((p) => `${p.title}（${p.engagement === "trial" ? "试做" : "投入"}）`).join("、")}</p> : <p className={styles.muted}>还没有关联项目。</p>}
              {t.status !== "paused" ? (
                <button type="button" className={styles.btnGhost} onClick={() => act("upsert_direction_track", { trackId: t.id, status: "paused" })}>
                  这个方向先不看了
                </button>
              ) : (
                <button type="button" className={styles.btn} onClick={() => act("upsert_direction_track", { trackId: t.id, status: "exploring" })}>
                  继续了解
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      <section className={styles.card}>
        <h2 className={styles.title}>工作样本</h2>
        <p className={styles.muted}>先看这类人平时做什么。关注只记下来，不建任务；关注后仍能看到同样的步骤和基础。</p>
        <div className={styles.compare}>
          {data.workSamples.map((s) => {
            const follow = s.follow;
            return (
            <div key={s.templateKey} className={styles.cand}>
              <div className={styles.candHead}>
                <span className={styles.candTitle}>{s.title}</span>
                {follow && <em className={styles.tagBadge}>{TRACK_STATUS[follow.status] ?? follow.status}</em>}
              </div>
              {sampleBody(s)}
              {follow?.status === "paused" ? (
                <button type="button" className={styles.btn} onClick={() => act("upsert_direction_track", { trackId: follow.id, status: "exploring" })}>
                  继续了解
                </button>
              ) : follow ? (
                <button type="button" className={styles.btnGhost} onClick={() => act("upsert_direction_track", { trackId: follow.id, status: "paused" })}>
                  这个方向先不看了
                </button>
              ) : (
                <button type="button" className={styles.btn} onClick={() => act("upsert_direction_track", { templateKey: s.templateKey })}>
                  先关注这类工作
                </button>
              )}
            </div>
            );
          })}
        </div>
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
        <h2 className={styles.title}>候选（最多 3 个）</h2>
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
                试一下
              </button>
              <span className={styles.muted}>默认用一小段时间试做（可改），只在这里建项目和第一步，不代表报名</span>
            </div>
          </div>
        ))}
      </section>

      {data.reflections.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.title}>你记下的感受</h2>
          {data.reflections.map((r) => (
            <p key={r.id} className={styles.muted}>
              {r.occurredOn.slice(5)} · {r.originalText}
            </p>
          ))}
        </section>
      )}

      {data.notes.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.title}>我记录的线索</h2>
          {data.notes.map((n) => (
            <p key={n.id} className={styles.muted}>
              {n.title}
              {n.url ? ` · ${n.url}` : ""}
            </p>
          ))}
        </section>
      )}

      <section className={styles.card}>
        <h2 className={styles.title}>最近的实践记录</h2>
        {data.practice.length === 0 && <p className={styles.muted}>还没有实践记录。在底部说一句「今天学了…」就会出现在这里。</p>}
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
