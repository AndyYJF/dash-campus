"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./AppShell.module.css";

type ProjectLite = { id: string; title: string; status: string; updatedAt: string };

/** 侧栏近期项目：最多三个快捷入口，更多进入计划页（产品计划 5.2）；窄屏隐藏 */
export default function ShellExtras() {
  const [projects, setProjects] = useState<ProjectLite[] | null>(null);
  useEffect(() => {
    fetch("/api/v1/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { projects: ProjectLite[] } | null) => {
        if (!b) return;
        setProjects(
          b.projects
            .filter((p) => p.status === "active")
            .sort((a, c) => c.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 3),
        );
      })
      .catch(() => {});
  }, []);
  if (!projects || projects.length === 0) return <div className={styles.spacer} />;
  return (
    <div className={styles.recent}>
      <div className={styles.recentTitle}>近期项目</div>
      {projects.map((p) => (
        <Link key={p.id} href={`/projects/${p.id}`} className={styles.recentLink}>
          {p.title}
        </Link>
      ))}
    </div>
  );
}

type InstanceStatus = { hold: boolean; restoredAt: string | null; pastReminders: unknown[]; heldJobs: unknown[] };

/** 恢复暂停提示：hold 期间所有页面顶部可见（只读说明；解除只能用运维命令） */
export function RestoreHoldBanner() {
  const [st, setSt] = useState<InstanceStatus | null>(null);
  useEffect(() => {
    fetch("/api/v1/instance")
      .then((r) => (r.ok ? r.json() : null))
      .then(setSt)
      .catch(() => {});
  }, []);
  if (!st?.hold) return null;
  return (
    <div className={styles.holdBanner} role="status">
      <strong>实例已从备份恢复，外部动作已暂停。</strong>
      <span>
        恢复时间 {st.restoredAt ? new Date(st.restoredAt).toLocaleString() : "未知"}；邮件、搜索和模型调用暂不进行，
        过去的提醒不会补发（{st.pastReminders.length} 条已过触发点）。核对数据并确认旧实例已停止后，由部署者运行
        <code> scripts/resume-after-restore.sh </code>。
      </span>
    </div>
  );
}
