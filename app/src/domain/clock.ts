/**
 * 规划时钟：排程、相对日期、预算的“现在”统一从这里取，行为测试可以固定时刻。
 * 数据行的 created_at/updated_at 等审计时间戳不走这里。
 */
let fixed: Date | null = null;

export function nowDate(): Date {
  return fixed ? new Date(fixed.getTime()) : new Date();
}

/** 仅测试用；传 null 恢复真实时钟 */
export function setNowForTests(at: Date | null): void {
  fixed = at;
}
