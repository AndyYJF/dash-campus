"use client";
import { useRef, useState } from 'react';
import type { previewTimetable } from '@/repositories/timetable';
import { api, newIdempotencyKey } from './api';
import styles from './dash.module.css';

type Preview = ReturnType<typeof previewTimetable>;
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export default function TimetableImport({ timezone, onChanged }: { timezone: string; onChanged: () => void }) {
  const [text, setText] = useState(''), [firstMonday, setFirstMonday] = useState(''), [tz, setTz] = useState(timezone);
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState('');
  const request = useRef<{ body: string; key: string } | null>(null);
  function changed() { setPreview(null); setError(''); setResult(''); request.current = null; }
  async function loadFile(file?: File) {
    if (!file) return;
    changed();
    if (file.size > 256_000) { setError('文本文件过大，请控制在 256 KB 内'); return; }
    setBusy(true);
    try { setText(await file.text()); } catch { setError('无法读取文件，请直接粘贴课表文本'); } finally { setBusy(false); }
  }
  async function check() {
    setBusy(true); setError(''); setResult(''); setPreview(null); request.current = null;
    try { setPreview(await api<Preview>('/api/v1/timetable/preview', { method: 'POST', body: { text, firstMonday, timezone: tz } })); }
    catch (e) { setError(e instanceof Error ? e.message : '预览失败'); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true); setError('');
    const body = { text, firstMonday, timezone: tz, expectedRevision: preview.planningRevision };
    const serialized = JSON.stringify(body), key = request.current?.body === serialized ? request.current.key : newIdempotencyKey();
    request.current = { body: serialized, key };
    try {
      const r = await api<{ created: number; skipped: number }>('/api/v1/timetable/import', { method: 'POST', body, idempotencyKey: key });
      setResult(`已导入 ${r.created} 条活动规则，跳过 ${r.skipped} 条完全相同的规则。`); setPreview(null); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : '导入失败'); } finally { setBusy(false); }
  }
  return <details className={styles.subForm}><summary>批量导入课表（SDCT1）</summary>
    <p className={styles.muted}>粘贴课表文本或选择 UTF-8 文本文件。第一教学周须填写周一日期，不能用第一天上课日期代替。预览不会保存课程。</p>
    <label className={styles.label}>课表文本<textarea className={styles.field} rows={9} maxLength={64000} disabled={busy} value={text} placeholder={'SDCT1\nT=18\nP=1,08:15-09:00;2,09:10-09:55\nC=课程名称|教师|地点|1|1-2|3-18|A|-'} onChange={e => { setText(e.target.value); changed(); }} /></label>
    <label className={styles.label}>或选择文本文件<input className={styles.field} type="file" accept=".txt,text/plain" disabled={busy} onChange={e => void loadFile(e.target.files?.[0])} /></label>
    <div className={styles.formGrid}><label className={styles.label}>第一教学周的周一<input className={styles.field} type="date" disabled={busy} value={firstMonday} onChange={e => { setFirstMonday(e.target.value); changed(); }} /></label>
      <label className={styles.label}>课程时区<input className={styles.field} disabled={busy} value={tz} onChange={e => { setTz(e.target.value); changed(); }} /></label></div>
    <p className={styles.muted}>周次支持范围与逗号列表；A=全部、O=单周、E=双周。连续节次包含课间休息，离散节次分别保存。导入只新增活动，修改后的课表需先检查已有规则。</p>
    <button className={styles.btn} disabled={busy || !text.trim() || !firstMonday} onClick={() => void check()}>解析并预览</button>
    {preview && <section aria-label="课表导入预览"><h3>确认课表</h3><p>{preview.courses.length} 条课程安排 · {preview.occurrenceCount} 个上课时段 · 新增 {preview.newRules} 条规则 · 跳过重复 {preview.duplicateRules} 条</p>
      <p className={styles.muted}>第 1 周周一：{preview.firstMonday} · 共 {preview.totalWeeks} 周 · {preview.timezone}</p>
      {preview.courses.map(c => <div key={c.line} className={styles.logItem}><strong>{c.name}</strong><p>{c.teacher} · {c.location}</p><p>{weekdays[c.weekday - 1]} · 第 {c.periods.join('、')} 节 · 第 {c.weeks.join('、')} 周</p><p className={styles.muted}>{c.rules.map((r, i) => <span key={i} style={{ display: 'block' }}>{r.validFrom} 至 {r.validUntil} · {r.localStart}–{r.localEnd}</span>)}</p></div>)}
      <p className={styles.muted}>课程占用可用学习时间；既有任务不会自动改期，导入后请核对本周排程冲突。节假日或临时调课可使用“单日变更”。</p>
      <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void confirm()}>确认导入课表</button></section>}
    {error && <p className={styles.error} role="alert">{error}</p>}{result && <p role="status">{result}</p>}
  </details>;
}
