"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  state: "accepted" | "working" | "needs_input" | "in_background" | "applied" | "partly_applied" | "no_change" | "answered" | "failed" | "cancelled";
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
  goal?: { id: string; revision: number; current: boolean; state: string; objective: string; constraints?: string[] } | null;
  verification?: { status: "verified" | "partial" | "needs_action" | "blocked" | "pending"; label: string; checks: Array<{ kind: string; ok: boolean | null; subject: string; detail: string }>; repairs: Array<{ reason: string; steps: string[] }> } | null;
};
type ChatTurn = { id: string; seq: number; role: "owner" | "agent"; text: string; intakeId: string | null; questionId: string | null; createdAt: string; result: Result | null; replyTo?: { prompt: string; intakeId: string | null } | null; replyResult?: Result | null };
type Conversation = { conversationId: string | null; turns: ChatTurn[]; nextBeforeSeq: number | null };
type GoalRef = { id: string; revision: number; objective: string };
type OpenGoal = { id: string; revision: number; objective: string; state: string; lastResult: string | null };

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
  in_background: "后台处理中",
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

export default function UniversalIntake({ fullPage = false }: { fullPage?: boolean }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [context, setContext] = useState<ComposeDetail | null>(null);
  const [goal, setGoal] = useState<GoalRef | null>(null);
  const [openGoals, setOpenGoals] = useState<OpenGoal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [beforeSeq, setBeforeSeq] = useState<number | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const conversationRef = useRef<string | null>(null);
  const loadEpoch = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const olderOffset = useRef<{ height: number; top: number } | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const [showCommands, setShowCommands] = useState(false);
  const [feedback, setFeedback] = useState("");
  type Draft = { text: string; files: File[]; context: ComposeDetail | null; busy?: boolean };
  const [savedDraft, setSavedDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft>({ text: "", files: [], context: null });
  const lastAttempt = useRef<{ value: string; contextJson: string; files: File[] } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [dragging, setDragging] = useState(false);
  const [wrong, setWrong] = useState<{ intakeId: string; verdict: Verdict; text: string; key: string } | null>(null);
  const [wrongSent, setWrongSent] = useState<Record<string, boolean>>({});
  const idemKey = useRef(newIdempotencyKey());
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<Result[]> => {
    const epoch = ++loadEpoch.current;
    const [page, q, goals, conversation] = await Promise.all([
      api<{ intakes: Result[]; nextCursor: string | null }>("/api/v2/intakes?limit=6").catch(() => null),
      api<{ questions: Question[] }>("/api/v2/questions").catch(() => null),
      api<{ goals: OpenGoal[] }>("/api/v2/goals?limit=5").catch(() => null),
      api<Conversation>("/api/v2/conversations/current?limit=30").catch(() => null),
    ]);
    if (epoch !== loadEpoch.current) return page?.intakes ?? [];
    if (page) setResults(page.intakes);
    setLoadError(!conversation);
    if (conversation) {
      const same = conversation.conversationId === conversationRef.current;
      conversationRef.current = conversation.conversationId;
      if (!same) { stickToBottom.current = true; olderOffset.current = null; }
      setTurns((current) => same
        ? [...current.filter((t) => !conversation.turns.some((n) => n.id === t.id)), ...conversation.turns].sort((a, b) => a.seq - b.seq)
        : conversation.turns);
      if (!same) setBeforeSeq(conversation.nextBeforeSeq);
      else setBeforeSeq((current) => current === null ? null : Math.min(current, conversation.nextBeforeSeq ?? current));
    }
    if (q) setQuestions(q.questions.map((x) => ({ ...x, options: x.options ?? [] })));
    if (goals) setOpenGoals(goals.goals.filter((g) => g.state !== "cancelled"));
    return [...(page?.intakes ?? []), ...(conversation?.turns.flatMap((t) => [t.result, t.replyResult].filter((r): r is Result => Boolean(r))) ?? [])];
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);
  useDashRefresh(load);
  const isOpen = fullPage || expanded;
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (!el || !isOpen) return;
    if (olderOffset.current) {
      el.scrollTop = olderOffset.current.top + el.scrollHeight - olderOffset.current.height;
      olderOffset.current = null;
    } else if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [turns, results, isOpen]);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || !isOpen) return;
    const observer = new ResizeObserver(() => { if (stickToBottom.current) el.scrollTop = el.scrollHeight; });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isOpen]);

  // 还有处理中的投递就每 2 秒看一次，落定即停并通知各页刷新
  const hasActive = results.some((r) => ACTIVE.has(r.state)) || turns.some((t) => [t.result, t.replyResult].some((r) => r && ACTIVE.has(r.state)));
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

  // 后台任务（复盘、探索、邮件）可能要几分钟：放慢到 15 秒看一次，终态核验回来就停
  const hasBackground = !hasActive && (results.some((r) => r.state === "in_background") || turns.some((t) => [t.result, t.replyResult].some((r) => r?.state === "in_background")));
  useEffect(() => {
    if (!hasBackground) return;
    const timer = setInterval(async () => {
      const next = await load();
      if (!next.some((r) => r.state === "in_background")) {
        clearInterval(timer);
        emitChanged();
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [hasBackground, load]);

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
      setExpanded(true);
      stickToBottom.current = true;
      boxRef.current?.focus();
    };
    const shortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setExpanded(true); boxRef.current?.focus(); }
      if (e.key === "Escape") { setShowCommands(false); setExpanded(false); boxRef.current?.blur(); }
    };
    window.addEventListener(DASH_COMPOSE, onCompose);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener(DASH_COMPOSE, onCompose);
      window.removeEventListener("keydown", shortcut);
    };
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
    // 上一条的“已收到”不留到这一次：这次没成功时不能还显示着成功
    setFeedback("");
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
      setFeedback(body?.answered ? [...(body.results ?? []).map((r) => r.error?.message ?? r.summary), body.note].filter(Boolean).join("\n") : "");
      setExpanded(true);
      stickToBottom.current = true;
      setShowCommands(false);
      setText("");
      setFiles([]);
      setContext(null);
      setGoal(null);
      await load();
      // Answers can apply operations synchronously without an active intake to poll.
      if (body?.answered) emitChanged();
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
    const id = conversationRef.current;
    if (!id || beforeSeq === null || historyBusy) return;
    setHistoryBusy(true);
    try {
      const page = await api<Conversation>(`/api/v2/conversations/${id}?limit=30&beforeSeq=${beforeSeq}`);
      if (conversationRef.current !== id) return;
      const el = transcriptRef.current;
      if (el) olderOffset.current = { height: el.scrollHeight, top: el.scrollTop };
      stickToBottom.current = false;
      setTurns((current) => [...page.turns.filter((t) => !current.some((c) => c.id === t.id)), ...current].sort((a, b) => a.seq - b.seq));
      setBeforeSeq(page.nextBeforeSeq);
    } catch { setError("更早的消息暂时没加载出来，可以重试。"); }
    finally { setHistoryBusy(false); }
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
  const canSend = (text.trim().length > 0 || files.length > 0) && !busy;
  const latest = results[0];
  const badge = hasActive ? "处理中…" : questions.length ? `${questions.length} 个待回答` : latest && latest.state === "failed" ? "上一条没有办成" : null;

  const renderQuestion = (q: Question) => (
    <div key={q.id} className={styles.question}>
      <p className={styles.prompt}>{q.prompt}</p>
      {q.reason && <p className={styles.reason}>{q.reason}</p>}
      <div className={styles.options}>
        {q.options.map((o, i) => <button key={i} type="button" className={styles.option} onClick={() => answerInBar(q, o)}>{o}</button>)}
      </div>
      <button type="button" className={styles.linkBtn} onClick={() => answerInBar(q)}>用自己的话回答</button>
    </div>
  );
  const renderReply = (r: Result) => (
            <div className={styles.result} data-state={r.state}>
              <div className={styles.resultHead}>
                <span className={styles.status} data-state={r.state}>
                  {STATE_LABEL[r.state]}
                </span>
              </div>
              {r.state === "working" && <p className={styles.when}>正在理解你的话，必要时先查相关安排与记录</p>}
              {!ACTIVE.has(r.state) && <p className={styles.summary}>{r.summary}</p>}
              {r.questions.filter((q) => questions.some((current) => current.id === q.id)).map(renderQuestion)}
              {r.followUps.map((f) => (
                <p key={f.summary} className={styles.followUp} data-state={f.state}>
                  {f.summary}
                </p>
              ))}
              {!ACTIVE.has(r.state) && r.goal?.current && (r.goal.constraints?.length ?? 0) > 0 && (
                <p className={styles.when}>一直守着：{r.goal.constraints!.join("；")}</p>
              )}
              {!ACTIVE.has(r.state) && r.verification && r.state !== "answered" && (
                <p className={styles.followUp} data-state={["partial", "blocked"].includes(r.verification.status) ? "failed" : r.verification.status}>
                  {r.verification.label}
                  {r.verification.repairs.length > 0 && `（已在原范围内自动修正 ${r.verification.repairs.length} 次）`}
                </p>
              )}
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
              {(understandingLine(r.understanding) || Boolean(r.verification?.checks.length)) && <details className={styles.explanation}>
                <summary>处理依据与核对</summary>
                {understandingLine(r.understanding) && <p className={styles.when}>{understandingLine(r.understanding)}</p>}
                {r.verification?.checks.map((c, i) => <p key={i} className={styles.when}>{c.subject}：{c.detail}</p>)}
              </details>}
              {open[r.intakeId] && (
                <ul className={styles.changes}>
                  {r.changes.map((c, i) => (
                    <li key={`${c.label}-${i}`}>
                      {c.detail}：{c.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
  );
  const visibleQuestionIds = new Set(turns.flatMap((t) => [...(t.result?.questions ?? []), ...(t.replyResult?.questions ?? [])].map((q) => q.id)));
  const otherQuestions = questions.filter((q) => !visibleQuestionIds.has(q.id));
  const pending = [...results].reverse().filter((r) => ACTIVE.has(r.state) && !turns.some((t) => t.role === "agent" && t.intakeId === r.intakeId));

  return (
    <section
      ref={rootRef}
      className={`${styles.intake}${dragging ? ` ${styles.dragging}` : ""}`}
      data-open={isOpen ? "true" : "false"}
      data-mode={fullPage ? "page" : "dock"}
      aria-label="Agent 对话"
      id="intake"
      onFocusCapture={() => setExpanded(true)}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        setExpanded(true);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {isOpen && <div className={styles.dockHead}>
        <div className={styles.chatTitle}><strong>Agent 对话</strong><span>{hasActive ? "正在处理…" : "学习、计划和探索，都可以直接聊"}</span></div>
        {!fullPage && <Link href="/chat" className={styles.headButton}>打开对话页</Link>}
        {fullPage ? <Link href="/today" className={styles.headButton}>返回工作台</Link> : <button type="button" className={styles.headClose} onClick={() => { setExpanded(false); setShowCommands(false); boxRef.current?.blur(); }} aria-label="收起 Agent 对话">收起</button>}
      </div>}
      {isOpen && <div ref={transcriptRef} className={styles.transcript} role="log" aria-label="对话消息" aria-live="polite" onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}>
        {loadError && <div className={styles.loadError} role="status">暂时无法读取对话，已显示的消息和草稿还在。<button type="button" className={styles.linkBtn} onClick={() => void load()}>重试</button></div>}
        {beforeSeq !== null && <button type="button" className={styles.historyLoad} disabled={historyBusy} onClick={() => void more()}>{historyBusy ? "正在加载…" : "查看更早的消息"}</button>}
        {!turns.length && !pending.length && !loadError && <div className={styles.empty}>
          <h2>今天想聊什么？</h2><p>把想法、课表或卡住的事发过来，我们一起理清下一步。</p>
          <div className={styles.starters}>
            <button type="button" onClick={() => { setText("今天的课程和学习安排是什么？"); boxRef.current?.focus(); }}>看看今天的安排</button>
            <button type="button" onClick={() => { setText("帮我规划这周的学习，先问清楚我的情况"); boxRef.current?.focus(); }}>一起规划这周</button>
            <button type="button" onClick={() => fileRef.current?.click()}>导入课表或资料</button>
          </div>
        </div>}
        {turns.map((t) => {
          const firstReply = t.role === "agent" && t.intakeId ? turns.find((n) => n.seq > t.seq && n.replyTo?.intakeId === t.intakeId) : null;
          const laterReply = t.replyTo?.intakeId ? turns.find((n) => n.seq > t.seq && n.replyTo?.intakeId === t.replyTo!.intakeId) : null;
          return <div key={t.id}>
            <div className={t.role === "owner" ? styles.userMessage : styles.agentMessage} data-role={t.role}>
              <div className={styles.messageMeta}>{t.role === "owner" ? "你" : "Agent"}<time dateTime={t.createdAt}>{timeLabel(t.createdAt)}</time></div>
              {firstReply ? <p className={styles.messageText}>{firstReply.replyTo!.prompt}</p> : t.role === "agent" && t.result ? renderReply(t.result) : <p className={styles.messageText}>{t.text || "已上传文件"}</p>}
            </div>
            {t.replyResult && <div className={styles.agentMessage} data-role="agent"><div className={styles.messageMeta}>Agent</div>{laterReply ? <p className={styles.messageText}>{laterReply.replyTo!.prompt}</p> : renderReply(t.replyResult)}</div>}
          </div>;
        })}
        {pending.map((r) => <div key={`pending-${r.intakeId}`} className={styles.agentMessage} data-role="agent">
          {!turns.some((t) => t.role === "owner" && t.intakeId === r.intakeId) && <p className={styles.messageText}>{r.text || "已上传文件"}</p>}
          <div className={styles.messageMeta}>Agent</div><p className={styles.thinking} role="status">正在理解和处理，需要补充信息时会问你…</p>
        </div>)}
        {otherQuestions.length > 0 && <div className={styles.agentMessage}><div className={styles.messageMeta}>还有待回答的事</div>{otherQuestions.map(renderQuestion)}</div>}
        {openGoals.length > 0 && <details className={styles.previousGoals}><summary>继续以前的目标</summary>
          {openGoals.map((g) => <button key={g.id} type="button" className={styles.linkBtn} onClick={() => { setGoal({ id: g.id, revision: g.revision, objective: g.objective }); boxRef.current?.focus(); }}>继续：{g.objective}</button>)}
        </details>}
      </div>}
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
            if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey || (!e.shiftKey && window.matchMedia("(pointer: fine)").matches))) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={selectedCommand?.hint ?? (context?.question ? "回答这个问题…" : "发消息，或粘贴图片、拖入文件…")}
          rows={text.includes("\n") || text.length > 80 ? 3 : 1}
          maxLength={100_000}
          aria-label="把材料或想法放进来"
        />
        {!isOpen && badge && (
          <button type="button" className={styles.badge} data-kind={hasActive ? "working" : questions.length ? "question" : "failed"} onClick={() => { setExpanded(true); stickToBottom.current = true; }}>
            {badge}
          </button>
        )}
        <div className={styles.actions}>
          <input ref={fileRef} type="file" multiple accept={ACCEPT} className={styles.fileInput} onChange={(e) => e.target.files && addFiles(e.target.files)} aria-label="添加文件" />
          <button type="button" className={styles.attach} disabled={busy} onClick={() => fileRef.current?.click()}>
            添加文件
          </button>
          <button type="button" className={styles.send} onClick={submit} disabled={!canSend}>
            {busy ? "提交中…" : "发送"}
          </button>
        </div>
      </div>
      {isOpen && <div className={styles.composerHint}><button type="button" className={styles.linkBtn} onClick={() => setShowCommands((v) => !v)} aria-expanded={paletteOpen}>/ 快捷指令</button><span>Enter 发送 · Shift + Enter 换行</span></div>}
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

      {isOpen && feedback && <p className={styles.feedback} role="status">{feedback}</p>}
    </section>
  );
}
