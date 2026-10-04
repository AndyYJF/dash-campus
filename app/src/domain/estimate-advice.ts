/**
 * 估时建议（REPAIR-PLAN §4.5，MASTER-PLAN §6.3）：
 * 至少 3 个可比、已确认实际用时的样本才给建议；用中位数比例，限制在 0.5–2 倍；
 * 只是建议——不改主人明确给的估时，也不从点击或停留时长推断能力。
 */

export type EstimateSample = { estimateMinutes: number; actualMinutes: number };
export type EstimateAdvice = { ratio: number; samples: number; suggestedMinutes: number };

export const MIN_SAMPLES = 3;

export function estimateAdvice(estimateMinutes: number, samples: EstimateSample[]): EstimateAdvice | null {
  const ratios = samples.filter((s) => s.estimateMinutes > 0 && s.actualMinutes > 0).map((s) => s.actualMinutes / s.estimateMinutes).sort((a, b) => a - b);
  if (ratios.length < MIN_SAMPLES) return null;
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  const ratio = Math.min(2, Math.max(0.5, median));
  // 偏差很小就不打扰
  if (Math.abs(ratio - 1) < 0.15) return null;
  return { ratio: Math.round(ratio * 100) / 100, samples: ratios.length, suggestedMinutes: Math.round((estimateMinutes * ratio) / 5) * 5 };
}
