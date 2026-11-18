import { nativeImage, type NativeImage } from 'electron'
import { Workbook, type Cell, type Worksheet } from 'exceljs'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { clampNumber, formatTimeMs } from '@shared/format'
import { verdictExportText } from '@shared/task'
import type { FrameRecord, RegionRecord } from '@shared/types'
import { resolveFrameImagePath } from '../paths'

const IMAGE_WIDTH = 300
const IMAGE_HEIGHT = 168
const CONFIDENCE_COLUMN = 7
const PREVIEW_COLUMN = 8
const LOCATION_COLUMN = 9
const UNAVAILABLE_IMAGE = '帧图片不可用'
const TEXT_PADDING = 2
const TEXT_LINE_HEIGHT = 17
const ROW_PADDING = 4
const PREFERRED_COLUMN_WIDTH = 60
const MAX_COLUMN_WIDTH = 255
const MAX_ROW_HEIGHT = 409

export async function writeItemResults(filePath: string, taskId: string, frames: FrameRecord[]): Promise<void> {
  const workbook = new Workbook()
  const sheet = workbook.addWorksheet('物品识别结果', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: '序号' },
    { header: '时间' },
    { header: '判定' },
    { header: '异常类型' },
    { header: '异常说明' },
    { header: '证据' },
    { header: '置信度', style: { numFmt: '0.000' } },
    { header: '预览', width: 0 },
    { header: '异常定位', width: 0 }
  ]
  const header = sheet.getRow(1)
  header.height = 22
  header.font = { bold: true }
  header.alignment = { vertical: 'middle' }

  // 在异步读图前固定结果，避免仍在处理的任务在导出期间混入新判定。
  const snapshot = frames.map((frame) => ({ ...frame }))
  for (const frame of snapshot) {
    const row = sheet.addRow([
      frame.index + 1,
      formatTimeMs(frame.timestampMs),
      verdictExportText(frame.verdict),
      frame.categories.join('、') || null,
      frame.description || null,
      frame.evidence || null,
      frame.confidence
    ])
    row.alignment = { vertical: 'middle', wrapText: true }
    row.getCell(CONFIDENCE_COLUMN).alignment = { ...row.alignment, horizontal: 'left' }
    const bytes = await readFrameImage(taskId, frame.fileName)
    const original = bytes && nativeImage.createFromBuffer(bytes)
    if (!bytes || !original || original.isEmpty()) {
      row.getCell(PREVIEW_COLUMN).value = UNAVAILABLE_IMAGE
      if (frame.regions.length > 0) row.getCell(LOCATION_COLUMN).value = UNAVAILABLE_IMAGE
      continue
    }

    const { width, height } = original.getSize()
    const scale = Math.min(1, IMAGE_WIDTH / width, IMAGE_HEIGHT / height)
    const size = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
    // Excel 行高以磅为单位，图片的显示尺寸以 96 DPI 的像素为单位。
    row.height = (size.height + 8) * 0.75
    const extension = /\.jpe?g$/i.test(frame.fileName) ? 'jpeg' : 'png'
    addFrameImage(sheet, row.number, PREVIEW_COLUMN, bytes, extension, size)
    const annotated = drawRegions(original, frame.regions)
    if (annotated) addFrameImage(sheet, row.number, LOCATION_COLUMN, annotated, 'jpeg', size)
  }
  fitCells(sheet)

  const temporary = path.join(path.dirname(filePath), '.videoreview-' + randomUUID() + '.tmp')
  try {
    await writeWorkbook(workbook, temporary)
    await replaceExportFile(temporary, filePath)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function writeWorkbook(workbook: Workbook, filePath: string): Promise<void> {
  const output = createWriteStream(filePath, { flags: 'wx' })
  // Windows 重命名前需要等待底层文件句柄关闭，包括写入失败时。
  const closed = new Promise<void>((resolve) => { output.once('close', resolve) })
  try {
    await Promise.all([
      finished(output, { cleanup: true }),
      workbook.xlsx.write(output, { zip: { compression: 'STORE' } })
    ])
  } finally {
    output.destroy()
    await closed
  }
}

async function replaceExportFile(temporary: string, destination: string): Promise<void> {
  for (const retryDelay of [100, 250, 500, 0]) {
    try {
      await fs.rename(temporary, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
      if (retryDelay === 0) {
        throw new Error('无法保存 Excel。请关闭已打开的同名文件后重试，或改用其他文件名或有写入权限的目录。', { cause: error })
      }
      await delay(retryDelay)
    }
  }
}

function addFrameImage(
  sheet: Worksheet, row: number, column: number, bytes: Buffer,
  extension: 'jpeg' | 'png', size: { width: number; height: number }
): void {
  const imageColumn = sheet.getColumn(column)
  // 默认字体的 Excel 列宽单位约为 7 像素，预留两侧空隙。
  imageColumn.width = Math.max(imageColumn.width ?? 0, Math.ceil((size.width + 10) / 7))
  // ExcelJS 在 Node.js 中接收 Buffer，但其声明把 buffer 参数定义为 ArrayBuffer。
  const imageId = sheet.workbook.addImage({ buffer: bytes as unknown as ArrayBuffer, extension })
  sheet.addImage(imageId, { tl: { col: column - 1 + 0.08, row: row - 1 + 0.02 }, ext: size })
}

function fitCells(sheet: Worksheet): void {
  const widths = sheet.columns.map((column, index) => index + 1 >= PREVIEW_COLUMN ? column.width ?? 0 : 0)
  sheet.eachRow((row) => {
    row.eachCell((cell, column) => {
      const lines = cellLines(cell)
      const naturalWidth = lines.reduce((longest, line) => Math.max(longest, textWidth(line)), 0) + TEXT_PADDING
      const limit = Math.ceil(Math.min(naturalWidth, MAX_COLUMN_WIDTH))
      let width = Math.max(widths[column - 1], Math.min(limit, PREFERRED_COLUMN_WIDTH))
      // 如果常规列宽会让这一行超高，优先加宽列，保留更多文本可见。
      while (width < limit && getTextHeight(lines, width) > MAX_ROW_HEIGHT) {
        width = Math.min(limit, Math.ceil(width * 1.5))
      }
      widths[column - 1] = width
    })
  })
  sheet.columns.forEach((column, index) => { column.width = widths[index] })

  sheet.eachRow((row) => {
    let height = row.height ?? 0
    row.eachCell((cell, column) => {
      height = Math.max(height, getTextHeight(cellLines(cell), widths[column - 1]))
    })
    row.height = Math.min(height, MAX_ROW_HEIGHT)
  })
}

function cellLines(cell: Cell): string[] {
  const text = typeof cell.value === 'number' && cell.numFmt === '0.000'
    ? cell.value.toFixed(3)
    : cell.text
  return text.split(/\r\n|\r|\n/)
}

function textWidth(text: string): number {
  let width = 0
  for (const char of text) {
    if (char === '\t') width += 4
    else if (char.charCodeAt(0) > 127) width += 2.25
    else width += /[MW@%&]/.test(char) ? 1.5 : 1
  }
  return width
}

function getTextHeight(lines: string[], columnWidth: number): number {
  const availableWidth = Math.max(1, columnWidth - TEXT_PADDING)
  let lineCount = lines.length
  for (const line of lines) {
    let usedWidth = 0
    // 英文单词整体换行，中文字符逐字估算，保留输入中的手动换行。
    for (const part of line.trimEnd().match(/[!-~]+|./gu) ?? []) {
      const partWidth = textWidth(part)
      if (usedWidth > 0 && usedWidth + partWidth > availableWidth) {
        lineCount += 1
        usedWidth = 0
        if (part === ' ' || part === '\t') continue
      }
      const extraLines = Math.ceil(partWidth / availableWidth) - 1
      lineCount += extraLines
      usedWidth += partWidth - extraLines * availableWidth
    }
  }
  return lineCount * TEXT_LINE_HEIGHT + ROW_PADDING
}

async function readFrameImage(taskId: string, fileName: string): Promise<Buffer | null> {
  const sourcePath = resolveFrameImagePath(taskId, fileName)
  if (!sourcePath) return null
  try {
    return await fs.readFile(sourcePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function drawRegions(original: NativeImage, regions: RegionRecord[]): Buffer | null {
  if (regions.length === 0) return null
  const originalSize = original.getSize()
  const ratio = Math.min(1, 960 / Math.max(originalSize.width, originalSize.height))
  const image = ratio < 1 ? original.resize({
    width: Math.max(1, Math.round(originalSize.width * ratio)),
    height: Math.max(1, Math.round(originalSize.height * ratio)),
    quality: 'good'
  }) : original
  const { width, height } = image.getSize()
  const pixels = image.toBitmap()
  const thickness = Math.max(2, Math.round(Math.max(width, height) / 160))
  // Windows/Linux x64 上的 NativeImage 位图顺序为 BGRA。
  const outline = Buffer.from([24, 24, 24, 255])
  const red = Buffer.from([45, 45, 245, 255])
  let drawn = false
  for (const { box } of regions) {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) continue
    const [x1, y1, x2, y2] = box.map((value) => clampNumber(value, 0, 1))
    if (x2 <= x1 || y2 <= y1) continue
    const left = Math.floor(x1 * width)
    const top = Math.floor(y1 * height)
    const right = Math.ceil(x2 * width)
    const bottom = Math.ceil(y2 * height)
    const stroke = Math.min(thickness, Math.max(1, Math.floor(Math.min(right - left, bottom - top) / 3)))

    for (let y = top; y < bottom; y += 1) {
      const start = (y * width + left) * 4
      const end = (y * width + right) * 4
      if (y - top < stroke || bottom - y <= stroke) {
        const isOuterEdge = y === top || y === bottom - 1
        pixels.fill(stroke > 1 && isOuterEdge ? outline : red, start, end)
      } else {
        pixels.fill(red, start, start + stroke * 4)
        pixels.fill(red, end - stroke * 4, end)
        if (stroke > 1) {
          outline.copy(pixels, start)
          outline.copy(pixels, end - 4)
        }
      }
    }
    drawn = true
  }
  return drawn ? nativeImage.createFromBitmap(pixels, { width, height }).toJPEG(90) : null
}
