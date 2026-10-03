"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import styles from "./intake.module.css";

/**
 * 全局统一输入（Agent-first V2 P1，MASTER-PLAN §1.1）：
 * 一个入口投递文字材料；提交即“已收到”，随后轮询展示整理结果与必要问题。
 * 提交记录 id 存本机 localStorage，刷新/换页后仍能看到同一条记录与结果。
 */

type IntakeView = {
  intake: { id: string; status: string; lastError: string | null };
  items: Array<{ id: string; kind: string; state: string; summary: string | null; error: string | null }>;
  questions: Array<{ id: string; prompt: string; status: string; version: number }>;
};

type QuestionView = { id: string; prompt: string; version: number; createdAt: string };

const STATUS_LABEL: Record<string, string> = {
  received: "已收到",
  processing: "整理中…",
  waiting_input: "需要补充",
  partially_applied: "部分完成",
  completed: "已更新",
  failed: "处理失败",
  cancelled: "已取消",
};
const KIND_LABEL: Record<string, string> = {
  timetable: "课表",
  notice: "通知",
  practice: "实践记录",
  task: "任务/想法",
  note: "资料",
};
const ITEM_STATE_LABEL: Record<string, string> = {
  extracted: "已读取",
  resolving: "整理中",
  awaiting_input: "等待回答",
  ready: "已整理",
  applied: "已生效",
  ignored: "已忽略",
  failed: "处理失败",
  cancelled: "已取消",
};
const ACTIVE = new Set(["received", "processing"]);
const INTAKE_IDS_KEY = "v2.intakeIds";

function loadIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(INTAKE_IDS_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export default function UniversalIntake() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intakes, setIntakes] = useState<IntakeView[]>([]);
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const idemKey = useRef(newIdempotencyKey());

  const refreshQuestions = useCallback(() => {
    api<{ questions: QuestionView[] }>("/api/v2/questions")
      .then((r) => setQuestions(r.questions))
      .catch(() => {/* 拉取失败保留现状，下个周期再试 */});
  }, []);

  const refreshIntakes = useCallback((): Promise<IntakeView[]> => {
    const ids = loadIds().slice(-5);
    return Promise.all(ids.map((id) => api<IntakeView>(`/api/v2/intakes/${id}`).catch(() => null))).then((views) => {
      const ok = views.filter((v): v is IntakeView => v !== null);
      setIntakes(ok.reverse());
      return ok;
    });
  }, []);

  const refresh = useCallback(() => {
    refreshQuestions();
    void refreshIntakes();
  }, [refreshQuestions, refreshIntakes]);
  useEffect(refresh, [refresh]);

  // 活动中的投递每 2 秒轮询一次，全部落定即停（§8 首版轮询策略）
  useEffect(() => {
    if (!intakes.some((i) => ACTIVE.has(i.intake.status))) return;
    const timer = setInterval(async () => {
      const views = await refreshIntakes();
      await refreshQuestions();
      if (!views.some((i) => ACTIVE.has(i.intake.status))) clearInterval(timer);
    }, 2000);
    return () => clearInterval(timer);
  }, [intakes, refreshIntakes, refreshQuestions]);

  async function submit() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ intakeId: string }>("/api/v2/intakes", {
        method: "POST",
        body: { text: value },
        idempotencyKey: idemKey.current,
      });
      idemKey.current = newIdempotencyKey();
      setText("");
      const ids = [...loadIds(), r.intakeId].slice(-20);
      localStorage.setItem(INTAKE_IDS_KEY, JSON.stringify(ids));
      await refreshIntakes();
      await refreshQuestions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败，内容保留在输入框");
    } finally {
      setBusy(false);
    }
  }

  async function answer(q: QuestionView) {
    const value = (answers[q.id] ?? "").trim();
    if (!value) return;
    setError(null);
    try {
      await api(`/api/v2/questions/${q.id}/answers`, {
        method: "POST",
        body: { text: value, expectedVersion: q.version },
        idempotencyKey: newIdempotencyKey(),
      });
      setAnswers((a) => ({ ...a, [q.id]: "" }));
      await refreshQuestions();
      await refreshIntakes();
    } catch (e) {
      setError(e instanceof Error ? e.message : "回答提交失败");
      await refreshQuestions();
    }
  }

  return (
    <section className={styles.intake} aria-label="统一输入">
      <textarea
        className={styles.box}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="课表、通知、项目想法，或者说说你今天做了什么。"
        rows={text ? 4 : 1}
        maxLength={100_000}
      />
      {text.trim() && (
        <button type="button" className={styles.send} onClick={submit} disabled={busy}>
          {busy ? "提交中…" : "投递"}
        </button>
      )}
      {error && <p className={styles.error}>{error}</p>}

      {questions.length > 0 && (
        <div className={styles.questions}>
          {questions.map((q) => (
            <div key={q.id} className={styles.question}>
              <p className={styles.prompt}>{q.prompt}</p>
              <div className={styles.answerRow}>
                <input
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && answer(q)}
                  placeholder="回答…"
                />
                <button type="button" className={styles.send} onClick={() => answer(q)}>
                  回答
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {intakes.length > 0 && (
        <ul className={styles.results}>
          {intakes.map((v) => (
            <li key={v.intake.id}>
              <span className={styles.status} data-status={v.intake.status}>
                {STATUS_LABEL[v.intake.status] ?? v.intake.status}
              </span>
              {v.items.map((i) => (
                <span key={i.id} className={styles.item}>
                  {KIND_LABEL[i.kind] ?? i.kind} · {ITEM_STATE_LABEL[i.state] ?? i.state}
                  {i.summary ? `：${i.summary}` : ""}
                  {i.error ? `（${i.error}）` : ""}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
