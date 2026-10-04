"use client";

import { useState } from "react";
import { api, newIdempotencyKey } from "./api";
import { compose, emitChanged } from "./dashBus";
import { hm, minuteOfDay, type Picked } from "./DayTimeline";
import styles from "./v2.module.css";

/**
 * 时间线上点开一块之后的详情与操作（REPAIR-PLAN §3.2）：
 * 课程 → 这次停课 / 调到别的时间；学习安排 → 为什么排这里、开始/完成/稍后/锁定/挪动；空档 → 在这里安排。
 * 所有按钮都走与对话相同的注册操作；需要说清楚的（调到哪天）交给统一输入，带着对象上下文。
 */

const WEEKDAY = "日一二三四五六";

function dateLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 周${WEEKDAY[d.getUTCDay()]}`;
}

export default function ItemDetail(props: { picked: Picked; date: string; timezone: string; onClose: () => void; teachingNote?: string; budgetLeft?: number }) {
  const { picked, date, timezone: tz } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [minutes, setMinutes] = useState("");

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      emitChanged();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作没有成功");
    } finally {
      setBusy(false);
    }
  }

  if (picked.type === "slot") {
    const s = picked.slot;
    return (
      <section className={styles.detail} aria-label="空档">
        <div className={styles.detailHead}>
          <strong>
            空档 · {dateLabel(s.date)} {s.start}–{s.end}（{s.minutes} 分钟）
          </strong>
          <button type="button" className={styles.btnGhost} onClick={props.onClose}>
            关闭
          </button>
        </div>
        <p className={styles.muted}>
          这段时间没有课程、固定活动和已排的学习。
          {props.budgetLeft === 0 ? "不过这天的学习预算已经排满了：要在这里再加，得先挪走别的安排，或者告诉我这天的上限调高。" : props.budgetLeft !== undefined ? `这天还能新排 ${props.budgetLeft} 分钟学习。` : ""}
        </p>
        <div className={styles.detailActions}>
          <button type="button" className={styles.btnPrimary} onClick={() => compose({ label: `${dateLabel(s.date)} ${s.start}–${s.end} 的空档`, text: "这里安排", slot: { date: s.date, start: s.start, end: s.end } })}>
            在这里安排…
          </button>
        </div>
      </section>
    );
  }

  if (picked.type === "event") {
    const e = picked.event;
    const range = `${hm(minuteOfDay(e.startUtc, date, tz))}–${hm(minuteOfDay(e.endUtc, date, tz))}`;
    const name = e.title.split(" · ")[0]!;
    const source = e.sourceDate && e.sourceDate !== date ? e.sourceDate : null;
    return (
      <section className={styles.detail} aria-label="活动详情">
        <div className={styles.detailHead}>
          <strong>
            {e.kind === "course" ? "课程" : e.kind === "fixed" ? "固定活动" : "待核对"} · {e.kind === "course" ? name : e.title}
          </strong>
          <button type="button" className={styles.btnGhost} onClick={props.onClose}>
            关闭
          </button>
        </div>
        <p className={styles.muted}>
          {dateLabel(date)} {range}
          {e.location ? ` · ${e.location}` : ""}
          {e.teacher ? ` · ${e.teacher}` : ""}
        </p>
        {source && <p className={styles.muted}>这是{e.origin === "makeup" ? "补" : "调自"} {dateLabel(source)} 的课。</p>}
        {e.kind === "pending" && <p className={styles.muted}>{props.teachingNote || "这天国家调整为上班日，学校是否补课、补哪天的课还没有依据。"}先按可能上课预留，没有当成确定的课。知道了就直接告诉我，比如“这天补 10 月 8 日的课”。</p>}
        {e.kind === "fixed" && <p className={styles.muted}>这是没有课程资料的固定占用（照常扣空档）。如果它其实是课，把课表重新放进输入框一次就能带上课程信息。</p>}
        {error && <p className={styles.error}>{error}</p>}
        {e.kind === "course" && e.courseId && (
          <div className={styles.detailActions}>
            <button
              type="button"
              className={styles.btn}
              disabled={busy}
              onClick={() => run(() => api("/api/v2/actions", { method: "POST", body: { operation: "apply_teaching_day_override", args: { scope: "course", courseId: e.courseId, mode: "cancel", sourceTeachingDate: e.sourceDate ?? date, note: "这次停课" } }, idempotencyKey: newIdempotencyKey() }))}
            >
              这次停课
            </button>
            <button type="button" className={styles.btn} onClick={() => compose({ label: `${dateLabel(date)} ${name}`, text: `把${dateLabel(e.sourceDate ?? date).split(" ")[0]}的${name}课改到` })}>
              调到…
            </button>
          </div>
        )}
        {e.kind === "pending" && (
          <div className={styles.detailActions}>
            <button type="button" className={styles.btn} onClick={() => compose({ label: `${dateLabel(date)} 的上课安排`, text: `${dateLabel(date).split(" ")[0]}补` })}>
              告诉我补哪天的课…
            </button>
          </div>
        )}
      </section>
    );
  }

  const s = picked.session;
  const range = `${hm(minuteOfDay(s.startUtc, date, tz))}–${hm(minuteOfDay(s.endUtc, date, tz))}`;
  const act = (action: string, body: Record<string, unknown> = {}) => run(() => api(`/api/v2/sessions/${s.id}/${action}`, { method: "POST", body: { expectedVersion: s.version, ...body }, idempotencyKey: newIdempotencyKey() }));
  const active = ["planned", "tentative", "in_progress"].includes(s.status);
  return (
    <section className={styles.detail} aria-label="学习安排详情">
      <div className={styles.detailHead}>
        <strong>
          {s.kind === "starter" ? "起步" : "学习"} · {s.title}
        </strong>
        <button type="button" className={styles.btnGhost} onClick={props.onClose}>
          关闭
        </button>
      </div>
      <p className={styles.muted}>
        {dateLabel(date)} {range} · {s.minutes} 分钟{s.locked ? " · 已锁定" : ""}
        {s.origin === "user" ? " · 你指定的位置" : ""}
      </p>
      {s.reason && <p className={styles.why}>为什么排这里：{s.reason}</p>}
      {error && <p className={styles.error}>{error}</p>}
      {active && (
        <>
          <div className={styles.detailActions}>
            {s.status !== "in_progress" && (
              <button
                type="button"
                className={styles.btnPrimary}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    // 开始即计时并与这一段关联；已有别的计时在跑就只标记开始
                    try {
                      await api("/api/v2/focus", { method: "POST", body: { sessionId: s.id }, idempotencyKey: newIdempotencyKey() });
                    } catch {
                      await api(`/api/v2/sessions/${s.id}/start`, { method: "POST", body: { expectedVersion: s.version }, idempotencyKey: newIdempotencyKey() });
                    }
                  })
                }
              >
                开始
              </button>
            )}
            <button type="button" className={s.status === "in_progress" ? styles.btnPrimary : styles.btn} disabled={busy} onClick={() => act("complete", minutes.trim() ? { actualMinutes: Number(minutes) } : {})}>
              这一段完成
            </button>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => act("skip")}>
              稍后再排
            </button>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => act(s.locked ? "unlock" : "lock")}>
              {s.locked ? "解除锁定" : "锁定"}
            </button>
            <button type="button" className={styles.btn} onClick={() => compose({ label: `${dateLabel(date)} ${range} ${s.title}`, text: "把这段挪到", selectedEntityRef: { kind: "plan_session", id: s.id } })}>
              挪到…
            </button>
          </div>
          <label className={styles.inlineField}>
            实际用了
            <input inputMode="numeric" pattern="[0-9]*" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="可不填" aria-label="实际分钟（可不填）" />
            分钟
          </label>
        </>
      )}
    </section>
  );
}
