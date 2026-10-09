"use client";

import { useState } from "react";
import styles from "./DemoBar.module.css";
import { api, ApiError } from "./api";
import { compose, emitChanged, useDashRefresh } from "./dashBus";
import { useDemoStatus, type DemoStatus } from "./demoStatus";

/** 体验指引：每条是一句可以直接交给 Agent 的话，点了只填进输入框，发不发由访客决定 */
const TRY_PROMPTS: Array<{ title: string; text: string }> = [
  { title: "安排一件事", text: "明天找个空档，安排一个半小时复习线性代数第三章" },
  { title: "问问今天", text: "我今天还有哪些课和学习安排？晚上还放得下一小时吗？" },
  { title: "临时有变", text: "今晚有社团活动去不了自习，把今晚的学习安排挪到这周其他时间" },
  { title: "记一笔投入", text: "刚才花了 40 分钟把数据结构的二叉树作业写完了" },
  { title: "丢一条通知", text: "【教务处通知】全体本科生请于本周五 17:00 前在教务系统完成选课确认，逾期不予补办。" },
  { title: "找个方向试试", text: "我对机器学习方向有点兴趣，帮我找几个两周内能做完的入门小项目" },
];

const PAGES: Array<{ href: string; label: string; note: string }> = [
  { href: "/today", label: "今天", note: "课表、学习块和当天能放下多少" },
  { href: "/week", label: "本周", note: "一周的时间轴，点空档可以直接安排" },
  { href: "/direction", label: "方向", note: "阶段、关注方向、试做中的项目" },
  { href: "/news", label: "AI资讯", note: "每天盘点，引用都可点回原文" },
  { href: "/chat", label: "对话", note: "和 Agent 的完整多轮对话" },
  { href: "/settings", label: "设置", note: "作息、提醒、调用预算" },
];

function guideSeen(): boolean {
  try {
    return localStorage.getItem("demoGuideSeen") !== null;
  } catch {
    // 读不到本地存储就保持收起
    return true;
  }
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * 演示实例的提示条（只在 DEMO_MODE=1 的实例上出现）：说明这是合成数据、何时恢复、当天 AI 余量，
 * 并给第一次来的人一份“可以试什么”。正式实例上不渲染任何东西。
 */
export default function DemoBar() {
  const { status, refresh } = useDemoStatus();
  // null = 访客还没点过：第一次来默认展开指引，看过之后记在本机，不再自动展开
  const [toggled, setToggled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Agent 处理完一件事后余量会变：跟着刷新
  useDashRefresh(refresh);

  if (!status?.demo) return null;
  const s: Extract<DemoStatus, { demo: true }> = status;
  const left = Math.max(0, s.ai.limit - s.ai.used);

  // 到这里已经在浏览器里（状态是挂载后才读到的），可以直接看本机记号
  const open = toggled ?? !guideSeen();

  function toggle() {
    setToggled(!open);
    try {
      localStorage.setItem("demoGuideSeen", "1");
    } catch {
      // 记不下来只是下次还会自动展开
    }
  }

  async function reset() {
    if (!window.confirm("把所有数据恢复成初始示例？所有访客共用这一份数据，当前的修改会被清掉。")) return;
    setBusy(true);
    setNote(null);
    try {
      await api("/api/v1/demo/reset", { method: "POST" });
      setNote("已恢复成初始示例");
      emitChanged();
      await refresh();
      // 当前页面上可能还留着已经不存在的对象：整页重读最稳妥
      window.location.reload();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : "恢复失败，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.bar} aria-label="演示模式说明">
      <div className={styles.row}>
        <span className={styles.tag}>演示模式</span>
        <p className={styles.lead}>
          这里是合成的示例数据，所有访客共用，放心改。每天 {String(s.resetHour).padStart(2, "0")}:00 自动恢复成初始状态。
        </p>
        <div className={styles.actions}>
          <span className={styles.meter} title="全站当天还能发起的模型请求数，所有访客共用">
            {s.ai.configured ? (
              <>
                今日 AI 余量 <b>{left}</b>/{s.ai.limit}
              </>
            ) : (
              "未接入模型"
            )}
          </span>
          <button type="button" className={styles.link} onClick={toggle} aria-expanded={open}>
            {open ? "收起指引" : "体验指引"}
          </button>
          <button type="button" className={styles.link} onClick={reset} disabled={busy}>
            {busy ? "恢复中…" : "恢复示例数据"}
          </button>
        </div>
      </div>
      {note && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
      {s.ai.configured && left === 0 && (
        <p className={styles.note} role="status">
          今天的 AI 调用额度已经用完，对话和探索要等明天 {hhmm(s.nextResetAt)} 之后；课表、任务、手动安排等不受影响。
        </p>
      )}
      {open && (
        <div className={styles.guide}>
          <div>
            <h2 className={styles.guideTitle}>对 Agent 说一句</h2>
            <p className={styles.guideHint}>点一条会填进底部的输入框，可以改了再发。Agent 只调用登记过的业务操作，改动都能撤销。</p>
            <ul className={styles.prompts}>
              {TRY_PROMPTS.map((p) => (
                <li key={p.title}>
                  <button type="button" className={styles.prompt} onClick={() => compose({ label: "", text: p.text })}>
                    <span className={styles.promptTitle}>{p.title}</span>
                    <span className={styles.promptText}>{p.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className={styles.guideTitle}>逛一逛</h2>
            <ul className={styles.pages}>
              {PAGES.map((p) => (
                <li key={p.href}>
                  <a href={p.href}>{p.label}</a>
                  <span>{p.note}</span>
                </li>
              ))}
            </ul>
            <p className={styles.guideHint}>
              演示环境不发邮件、不接旧工具；其余功能与正式部署是同一套代码。
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
