import zlib from "node:zlib";

/**
 * 原始像素 → PNG（只用 zlib，不引入图像库）。用于把扫描 PDF 的页面图像交给图片识别。
 * 太大的页面先按整数倍缩小（取块平均），保证长边不超过 maxSide。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export type RawImage = { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: 1 | 3 | 4 };

export function downscale(img: RawImage, maxSide: number): RawImage {
  const k = Math.ceil(Math.max(img.width, img.height) / maxSide);
  if (k <= 1) return img;
  const w = Math.floor(img.width / k);
  const h = Math.floor(img.height / k);
  const ch = img.channels;
  const out = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (let dy = 0; dy < k; dy++) {
          const row = ((y * k + dy) * img.width + x * k) * ch + c;
          for (let dx = 0; dx < k; dx++) sum += img.data[row + dx * ch]!;
        }
        out[(y * w + x) * ch + c] = Math.round(sum / (k * k));
      }
    }
  }
  return { data: out, width: w, height: h, channels: ch };
}

export function encodePng(img: RawImage): Buffer {
  const { width, height, channels } = img;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 每行过滤类型：None
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
