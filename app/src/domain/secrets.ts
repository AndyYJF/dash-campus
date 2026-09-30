import crypto from "node:crypto";

/** 常量时间比较（长度不同直接不等；长度本身不是秘密） */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
