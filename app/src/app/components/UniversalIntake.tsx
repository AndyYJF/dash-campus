"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError, newIdempotencyKey } from "./api";
import { DASH_COMPOSE, emitChanged, useDashRefresh, type ComposeDetail } from "./dashBus";
import styles from "./intake.module.css";
import { AGENT_COMMANDS, parseAgentText, formatAgentText, agentInputIssue, type AgentCommandName } from "@/domain/agent-input";

/**
 * 全局统一输入（REPAIR-PLAN §5.1，MASTER-PLAN §1.1）：
 * 一个入口放文字、截图、文件、链接或直接下指令；提交即“已收到”，处理在后台继续。
 * 每条输入的结果（实际变化、下一步/阻碍、待答问题、撤销）都从服务端读取——刷新或换设备后还在。
 */

type Question = { id: string; prompt: string; reason: string; options: string[]; purpose: string; version: number };
type Result = {
  intakeId: string;
  createdAt: string;
  text: string;
  state: "accepted" | "working" | "needs_input" | "applied" | "partly_applied" | "no_change" | "answered" | "failed" | "cancelled";
  summary: string;
  links?: Array<{ label: string; href: string }>;
  items: Array<{ id: string; kind: string; state: string; summary: string; error: string | null }>;
  changes: Array<{ label: string; detail: string }>;
  questions: Question[];
  nextActions: string[];
  followUps: Array<{ state: string; summary: string }>;
  undo: { available: boolean; batchIds: string[]; note: string };
  understanding?: { routedBy: "model" | "fast" | "rules" | null; fallbackReason: string | null; sources: string[] };
  error: { message: string; recoverable: boolean } | null;
  goal?: { id: string; revision: number; current: boolean; state: string; objective: string } | null;
};
type GoalRef = { id: string; revision: number; objective: string };

function understandingLine(u: Result["understanding"]): string | null {
  if (!u?.routedBy) return null;
  if (u.routedBy === "rules") return `按规则理解${u.fallbackReason ? `（模型理解没有用上：${u.fallbackReason}）` : ""}`;
  if (u.routedBy === "model") return u.sources.length ? `理解依据：查了 ${u.sources.join("、")}` : "按你的原话理解，没有另外查询";
  return null;
}

const STATE_LABEL: Record<Result["state"], string> = {
  accepted: "已收到",
  working: "整理中…",
  needs_input: "需要你回答",
  applied: "已更新",
  partly_applied: "部分完成",
  no_change: "已保存",
  answered: "已回答",
  failed: "没有办成",
  cancelled: "已取消",
};
const ACTIVE = new Set(["accepted", "working"]);
const VERDICTS = [
  { id: "wrong_intent", label: "意思理解错了" },
  { id: "wrong_object", label: "对象/时间找错了" },
  { id: "should_ask", label: "应该先问我" },
  { id: "should_not_ask", label: "不该问，直接办" },
  { id: "other", label: "其他" },
] as const;
type Verdict = (typeof VERDICTS)[number]["id"];
const ACCEPT = "image/png,image/jpeg,image/webp,application/pdf,text/plain,text/csv,text/calendar,.ics,.csv,.txt,.md";
const MAX_FILES = 10;

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function csrf(): string {
  try {
    return localStorage.getItem("csrfToken") ?? "";
  } catch {
    return "";
  }
}

export default function UniversalIntake() {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [context, setContext] = useState<ComposeDetail | null>(null);
  const [goal, setGoal] = useState<GoalRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [feedback, setFeedback] = useState("");
  type Draft = { text: string; files: File[]; context: ComposeDetail | null; busy?: boolean };
  const [savedDraft, setSavedDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft>({ text: "", files: [], context: null });
  const lastAttempt = useRef<{ value: string; contextJson: string; files: File[] } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [wrong, setWrong] = useState<{ intakeId: string; verdict: Verdict; text: string; key: string } | null>(null);
  const [wrongSent, setWrongSent] = useState<Record<string, boolean>>({});
  const idemKey = useRef(newIdempotencyKey());
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<Result[]> => {
    const [page, q] = await Promise.all([
      api<{ intakes: Result[]; nextCursor: string | null }>("/api/v2/intakes?limit=6").catch(() => null),
      api<{ questions: Question[] }>("/api/v2/questions").catch(() => null),
    ]);
    if (page) {
      setResults(page.intakes);
      setNextCursor(page.nextCursor);
    }
    if (q) setQuestions(q.questions.map((x) => ({ ...x, options: x.options ?? [] })));
    return page?.intakes ?? [];
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);
  useDashRefresh(load);

  // 还有处理中的投递就每 2 秒看一次，落定即停并通知各页刷新
  const hasActive = results.some((r) => ACTIVE.has(r.state));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(async () => {
      const next = await load();
      if (!next.some((r) => ACTIVE.has(r.state))) {
        clearInterval(timer);
        emitChanged();
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  useEffect(() => { draftRef.current = { text, files, context, busy }; }, [text, files, context, busy]);

  // 时间轴/行动卡把上下文交过来：带着对象或时段开口，不用重新描述
  useEffect(() => {
    const onCompose = (e: Event) => {
      const detail = (e as CustomEvent<ComposeDetail>).detail;
      const previous = draftRef.current;
      if (previous.busy) { setFeedback("正在提交当前内容，请稍后再选另一个操作。"); return; }
      // Launcher only focuses; card actions replace the draft reversibly and never reuse old attachments.
      if (detail.command || detail.text !== undefined || detail.question) {
        if (previous.text.trim() || previous.files.length) setSavedDraft(previous);
        setContext(detail);
        setText(detail.command ? formatAgentText(detail.command, detail.text ?? "") : (detail.text ?? ""));
        setFiles([]);
        setError(null);
        setFeedback("");
        setShowCommands(false);
      }
      if (detail.question) setExpanded(true);
      boxRef.current?.focus();
    };
    const shortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); boxRef.current?.focus(); }
      if (e.key === "Escape") { setShowCommands(false); setExpanded(false); }
    };
    window.addEventListener(DASH_COMPOSE, onCompose);
    window.addEventListener("keydown", shortcut);
    return () => { window.removeEventListener(DASH_COMPOSE, onCompose); window.removeEventListener("keydown", shortcut); };
  }, []);

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).filter((f) => f.size > 0);
    if (!incoming.length) return;
    setFiles((cur) => {
      const merged = [...cur, ...incoming].slice(0, MAX_FILES);
      if (cur.length + incoming.length > MAX_FILES) setError(`一次最多 ${MAX_FILES} 个文件，多出的没有加入`);
      return merged;
    });
  }

  async function submit() {
    const value = text.trim();
    if ((!value && !files.length) || busy) return;
    const parsed = parseAgentText(value);
    const issue = agentInputIssue(parsed, { hasFiles: files.length > 0, hasUrls: /https?:\/\//.test(value), hasTask: context?.selectedEntityRef?.kind === "task", hasQuestion: Boolean(context?.question), hasSlot: Boolean(context?.slot) });
    if (issue) { setError(issue); return; }
    const contextJson = JSON.stringify([context, goal]);
    const previous = lastAttempt.current;
    if (previous && (previous.value !== value || previous.contextJson !== contextJson || previous.files.length !== files.length || previous.files.some((f, i) => f !== files[i]))) idemKey.current = newIdempotencyKey();
    lastAttempt.current = { value, contextJson, files: [...files] };
    setBusy(true);
    setError(null);
    try {
      const urls = (value.match(/https?:\/\/[^\s，。；]+/g) ?? []).slice(0, 2);
      let res: Response;
      if (files.length) {
        const form = new FormData();
        form.append("text", value);
        for (const u of urls) form.append("urls", u);
        for (const f of files) form.append("files", f, f.name || "粘贴的图片.png");
        if (context?.selectedEntityRef) form.append("selectedEntityRef", JSON.stringify(context.selectedEntityRef));
        if (context?.slot) form.append("slot", JSON.stringify(context.slot));
        if (context?.question) { form.append("questionId", context.question.id); form.append("questionVersion", String(context.question.version)); }
        if (goal && !context?.question) { form.append("goalId", goal.id); form.append("expectedGoalRevision", String(goal.revision)); }
        res = await fetch("/api/v2/intakes", { method: "POST", headers: { "x-csrf-token": csrf(), "idempotency-key": idemKey.current }, body: form });
      } else {
        res = await fetch("/api/v2/intakes", {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrf(), "idempotency-key": idemKey.current },
          body: JSON.stringify({ text: value, urls, ...(context?.selectedEntityRef ? { selectedEntityRef: context.selectedEntityRef } : {}), ...(context?.slot ? { slot: context.slot } : {}), ...(context?.question ? { questionId: context.question.id, questionVersion: context.question.version } : goal ? { goalId: goal.id, expectedGoalRevision: goal.revision } : {}) }),
        });
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string }; answered?: boolean; results?: Array<{ summary: string; error?: { message: string } | null }>; note?: string } | null;
      if (res.status === 401) throw new ApiError(401, "UNAUTHORIZED", "登录已过期。输入的内容还在，请在新标签页登录后再提交");
      if (!res.ok) throw new ApiError(res.status, "FAILED", body?.error?.message ?? `提交失败（${res.status}），内容保留在输入框`);
      idemKey.current = newIdempotencyKey();
      lastAttempt.current = null;
      setFeedback(body?.answered ? [...(body.results ?? []).map((r) => r.error?.message ?? r.summary), body.note].filter(Boolean).join("\n") || "回答已收到" : "已收到，正在处理；结果会显示在这里。");
      setExpanded(true);
      setShowCommands(false);
      setText("");
      setFiles([]);
      setContext(null);
      setGoal(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络异常，内容保留在输入框，可重试");
    } finally {
      setBusy(false);
    }
  }

  async function undo(r: Result) {
    setError(null);
    try {
      for (const batchId of [...r.undo.batchIds].reverse()) {
        await api(`/api/v2/actions/${batchId}/undo`, { method: "POST", body: { expectedVersion: 1 }, idempotencyKey: newIdempotencyKey() });
      }
      await load();
      emitChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "撤销失败");
      await load();
    }
  }

  async function sendWrong() {
    if (!wrong) return;
    setError(null);
    try {
      await api("/api/v2/feedback", { method: "POST", body: { intakeId: wrong.intakeId, verdict: wrong.verdict, ...(wrong.text.trim() ? { expectedText: wrong.text.trim() } : {}) }, idempotencyKey: wrong.key });
      setWrongSent((s) => ({ ...s, [wrong.intakeId]: true }));
      setWrong(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "反馈没有发出去，可重试");
    }
  }

  async function more() {
    if (!nextCursor) return;
    const page = await api<{ intakes: Result[]; nextCursor: string | null }>(`/api/v2/intakes?limit=10&cursor=${encodeURIComponent(nextCursor)}`).catch(() => null);
    if (!page) return;
    setResults((cur) => [...cur, ...page.intakes.filter((x) => !cur.some((c) => c.intakeId === x.intakeId))]);
    setNextCursor(page.nextCursor);
  }

  function answerInBar(q: Question, value = "") {
    window.dispatchEvent(new CustomEvent<ComposeDetail>(DASH_COMPOSE, { detail: { label: q.prompt, command: "answer", text: value, question: { id: q.id, version: q.version, prompt: q.prompt } } }));
  }

  function chooseCommand(command: AgentCommandName) {
    const current = draftRef.current;
    if (current.busy) return;
    const parsed = parseAgentText(current.text);
    setText(formatAgentText(command, parsed.error ? "" : parsed.body));
    if (current.context?.question && command !== "answer") setContext(null);
    setError(null);
    setShowCommands(false);
    boxRef.current?.focus();
  }

  const parsedText = parseAgentText(text);
  const selectedCommand = AGENT_COMMANDS.find((c) => c.name === parsedText.command);
  const commandQuery = /^\/[^\s]*$/.test(text) ? text : null;
  const visibleCommands = AGENT_COMMANDS.filter((c) => !commandQuery || c.token.includes(commandQuery));
  const paletteOpen = showCommands || commandQuery !== null;
  const shown = showHistory ? results : results.slice(0, 1);
  const canSend = (text.trim().length > 0 || files.length > 0) && !busy;

  return (
    <section
      className={`${styles.intake}${dragging ? ` ${styles.dragging}` : ""}`}
      aria-label="统一 Agent 输入"
      id="intake"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      <div className={styles.dockHead}>
        <strong>Agent</strong>
        <span className={styles.dockStatus}>{hasActive ? "处理中…" : "直接说，或用 / 指令"}</span>
        <button type="button" className={styles.headButton} onClick={() => setShowCommands((v) => !v)} aria-expanded={paletteOpen}>/ 指令</button>
        <button type="button" className={styles.headButton} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} aria-label={expanded ? "收起 Agent 对话" : "展开 Agent 对话"}>{questions.length ? `${questions.length} 个待回答` : "对话 / 历史"}</button>
      </div>
      {paletteOpen && <div className={styles.commands} aria-label="Agent 指令列表">
        {visibleCommands.map((c) => <button type="button" key={c.name} onClick={() => chooseCommand(c.name)} title={c.hint}><strong>{c.token}</strong><span>{c.label}</span></button>)}
        {!visibleCommands.length && <p className={styles.hint}>未知指令。可去掉前缀直接说。</p>}
      </div>}
      {savedDraft && <div className={styles.recover}>
        <span>之前的草稿已保留</span>
        <button type="button" className={styles.linkBtn} disabled={busy} onClick={() => { const current = draftRef.current; setText(savedDraft.text); setFiles(savedDraft.files); setContext(savedDraft.context); setSavedDraft(current.text.trim() || current.files.length ? current : null); setError(null); }}>恢复草稿</button>
      </div>}
      {goal && !context?.question && (
        <div className={styles.context}>
          <span title={goal.objective}>继续：{goal.objective}</span>
          <button type="button" className={styles.chipClose} onClick={() => setGoal(null)} aria-label="不再继续这个目标">
            ×
          </button>
        </div>
      )}
      {context?.label && (
        <div className={styles.context}>
          <span title={context.label}>{context.question ? "回答：" : "关于："}{context.label}</span>
          <button type="button" className={styles.chipClose} onClick={() => setContext(null)} aria-label="取消这个上下文">
            ×
          </button>
        </div>
      )}
      <div className={styles.composer}>
        <textarea
          ref={boxRef}
          className={styles.box}
          disabled={busy}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          placeholder={selectedCommand?.hint ?? "直接说，或用 / 指令"}
          rows={text.includes("\n") || text.length > 80 ? 3 : 1}
          maxLength={100_000}
          aria-label="把材料或想法放进来"
        />
        <div className={styles.actions}>
          <input ref={fileRef} type="file" multiple accept={ACCEPT} className={styles.fileInput} onChange={(e) => e.target.files && addFiles(e.target.files)} aria-label="添加文件" />
          <button type="button" className={styles.attach} disabled={busy} onClick={() => fileRef.current?.click()}>
            添加图片/文件
          </button>
          <button type="button" className={styles.send} onClick={submit} disabled={!canSend}>
            {busy ? "提交中…" : "发送"}
          </button>
        </div>
      </div>
      {files.length > 0 && (
        <ul className={styles.files}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className={styles.fileChip}>
              <span>{f.name || "粘贴的图片"}</span>
              <button type="button" className={styles.chipClose} onClick={() => setFiles((cur) => cur.filter((_, n) => n !== i))} aria-label={`移除 ${f.name}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {feedback && <p className={styles.feedback} role="status">{feedback}</p>}
      {expanded && <div className={styles.transcript} aria-label="Agent 对话与结果">
      {questions.length > 0 && (
        <div className={styles.questions}>
          {questions.map((q) => (
            <div key={q.id} className={styles.question}>
              <p className={styles.prompt}>{q.prompt}</p>
              {q.reason && <p className={styles.reason}>为什么问：{q.reason}</p>}
              {q.options.length > 0 && (
                <div className={styles.options}>
                  {q.options.map((o) => (
                    <button key={o} type="button" className={styles.option} onClick={() => answerInBar(q, o)}>
                      {o}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" className={styles.linkBtn} onClick={() => answerInBar(q)}>在统一栏回答…</button>
            </div>
          ))}
        </div>
      )}

      {shown.length > 0 && (
        <ul className={styles.results}>
          {shown.map((r) => (
            <li key={r.intakeId} className={styles.result} data-state={r.state}>
              <div className={styles.resultHead}>
                <span className={styles.status} data-state={r.state}>
                  {STATE_LABEL[r.state]}
                </span>
                <span className={styles.said}>{r.text || "（文件）"}</span>
                <span className={styles.when}>{timeLabel(r.createdAt)}</span>
              </div>
              {r.state === "working" && <p className={styles.when}>正在理解你的话，必要时先查相关安排与记录</p>}
              {!ACTIVE.has(r.state) && <p className={styles.summary}>{r.summary}</p>}
              {!ACTIVE.has(r.state) && understandingLine(r.understanding) && <p className={styles.when}>{understandingLine(r.understanding)}</p>}
              {r.followUps.map((f) => (
                <p key={f.summary} className={styles.followUp} data-state={f.state}>
                  {f.summary}
                </p>
              ))}
              {r.nextActions.length > 0 && (
                <ul className={styles.next}>
                  {r.nextActions.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <div className={styles.resultActions}>
                {r.links?.map((l) => <Link key={`${l.href}-${l.label}`} href={l.href} className={styles.linkBtn}>{l.label}</Link>)}
                {r.changes.length > 0 && (
                  <button type="button" className={styles.linkBtn} onClick={() => setOpen((o) => ({ ...o, [r.intakeId]: !o[r.intakeId] }))} aria-expanded={Boolean(open[r.intakeId])}>
                    {open[r.intakeId] ? "收起变化" : `看变化（${r.changes.length}）`}
                  </button>
                )}
                {r.undo.available && (
                  <button type="button" className={styles.linkBtn} onClick={() => undo(r)}>
                    撤销
                  </button>
                )}
                {r.undo.note && <span className={styles.when}>{r.undo.note}</span>}
                {!ACTIVE.has(r.state) && r.goal?.current && r.goal.state !== "cancelled" && (
                  <button type="button" className={styles.linkBtn} onClick={() => { setGoal({ id: r.goal!.id, revision: r.goal!.revision, objective: r.goal!.objective }); boxRef.current?.focus(); }}>
                    继续这个目标
                  </button>
                )}
                {!ACTIVE.has(r.state) && (wrongSent[r.intakeId]
                  ? <span className={styles.when}>已记下，谢谢纠正</span>
                  : wrong?.intakeId !== r.intakeId && <button type="button" className={styles.linkBtn} onClick={() => setWrong({ intakeId: r.intakeId, verdict: "wrong_intent", text: "", key: newIdempotencyKey() })}>理解错了</button>)}
              </div>
              {wrong?.intakeId === r.intakeId && (
                <div className={styles.question} aria-label="反馈理解错误">
                  <div className={styles.options}>
                    {VERDICTS.map((v) => (
                      <button key={v.id} type="button" className={styles.option} aria-pressed={wrong.verdict === v.id} onClick={() => setWrong({ ...wrong, verdict: v.id })}>
                        {v.label}
                      </button>
                    ))}
                  </div>
                  <textarea className={styles.box} rows={2} maxLength={1000} value={wrong.text} onChange={(e) => setWrong({ ...wrong, text: e.target.value })} placeholder="本来想让它怎么做（可不填）" aria-label="本来想让它怎么做" />
                  <div className={styles.resultActions}>
                    <button type="button" className={styles.linkBtn} onClick={sendWrong}>提交反馈</button>
                    <button type="button" className={styles.linkBtn} onClick={() => setWrong(null)}>取消</button>
                  </div>
                  <p className={styles.when}>只记录这次理解供改进，不会改动任何安排</p>
                </div>
              )}
              {open[r.intakeId] && (
                <ul className={styles.changes}>
                  {r.changes.map((c, i) => (
                    <li key={`${c.label}-${i}`}>
                      {c.detail}：{c.label}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {results.length > 1 && (
        <div className={styles.historyBar}>
          <button type="button" className={styles.linkBtn} onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
            {showHistory ? "收起历史" : `历史（${results.length}${nextCursor ? "+" : ""}）`}
          </button>
          {showHistory && nextCursor && (
            <button type="button" className={styles.linkBtn} onClick={more}>
              更早的
            </button>
          )}
        </div>
      )}
      </div>}
    </section>
  );
}
