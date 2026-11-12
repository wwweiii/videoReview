/**
 * 生成能力探针用的标定图（纯 Node，无第三方依赖）。
 *
 * 输出 PNG（RGBA8）：白底 + 若干纯色矩形，位置来自 shared/localization/probe 的 PROBE_RECTS。
 * 两张图：全尺寸（1120×672）与半尺寸（560×336），用于区分"绝对像素 vs 归一化"。
 */

import zlib from 'node:zlib'
import { PROBE_RECTS } from '@shared/localization/probe'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, row * (stride + 1) + 1, row * stride, row * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 6 })

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** 生成探针标定图 PNG */
export function renderProbePng(width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4)
  // 白底
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    rgba[offset] = 255
    rgba[offset + 1] = 255
    rgba[offset + 2] = 255
    rgba[offset + 3] = 255
  }
  for (const item of PROBE_RECTS) {
    const [nx1, ny1, nx2, ny2] = item.rect
    const x1 = Math.round(nx1 * width)
    const y1 = Math.round(ny1 * height)
    const x2 = Math.round(nx2 * width)
    const y2 = Math.round(ny2 * height)
    for (let y = Math.max(0, y1); y < Math.min(height, y2); y += 1) {
      for (let x = Math.max(0, x1); x < Math.min(width, x2); x += 1) {
        const offset = (y * width + x) * 4
        rgba[offset] = item.color[0]
        rgba[offset + 1] = item.color[1]
        rgba[offset + 2] = item.color[2]
        rgba[offset + 3] = 255
      }
    }
  }
  return encodePng(width, height, rgba)
}

export function probeDataUrl(width: number, height: number): string {
  return `data:image/png;base64,${renderProbePng(width, height).toString('base64')}`
}
