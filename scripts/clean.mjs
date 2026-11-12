#!/usr/bin/env node
/**
 * scripts/clean.mjs
 *
 * 一键清理「可再生的构建 / 测试产物」，避免误删源码或用户数据。
 *
 * 默认清理（仅限仓库根目录内）：
 *   out/       electron-vite 构建产物
 *   release/   electron-builder 打包产物
 *   .tmp/      验证 / 冒烟脚本的临时目录（bundle、mock 数据、测试视频）
 *
 * 可选参数：
 *   --data     额外清理 data/ 下的可再生缓存：
 *              data/electron/（Electron userData 与 session 缓存）与 data/logs/；
 *              保留 settings.json、model-profiles.json、tasks/ 等业务数据。
 *   --dry-run  只打印将要清理的内容，不做任何删除。
 *   --help     打印本说明。
 *
 * 安全约束：
 *   - 只清理仓库根目录下名称固定的目标，解析后的绝对路径必须位于仓库根内；
 *   - 目标是符号链接 / 目录联接（junction）时不跟随、不删除，只提示跳过；
 *   - 不删除 data/ 下的业务文件；--data 也只清理明确的缓存子目录；
 *   - 目标不存在时安静跳过，不视为错误。
 *
 * 用法：
 *   npm run clean
 *   npm run clean -- --dry-run
 *   npm run clean -- --data --dry-run
 *
 * 无第三方依赖，Node >= 20。退出码：0 正常，1 参数错误或清理失败。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（脚本位于 <root>/scripts/） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 默认清理目标（相对仓库根） */
const DEFAULT_TARGETS = ['out', 'release', '.tmp']

/** --data 时清理的可再生缓存（相对仓库根） */
const DATA_CACHE_TARGETS = [path.join('data', 'electron'), path.join('data', 'logs')]

/** --data 时明确保留的业务数据，仅用于提示 */
const DATA_PRESERVED = ['data/settings.json', 'data/model-profiles.json', 'data/tasks/']

const USAGE = `用法：node scripts/clean.mjs [--dry-run] [--data]

默认清理仓库根下的构建/测试产物：${DEFAULT_TARGETS.join('、')}
  --dry-run  只打印将要清理的内容，不删除任何文件
  --data     额外清理 data/ 下的缓存（${DATA_CACHE_TARGETS.map((item) => item.split(path.sep).join('/')).join('、')}），
             保留 ${DATA_PRESERVED.join('、')}
  --help     打印本说明`

/**
 * 把相对路径解析为绝对路径，并断言它确实位于仓库根内。
 * 该断言是安全边界：任何越界（含 .. 逃逸、盘符不同）都直接报错。
 */
function resolveInsideRoot(relativePath) {
  const absolute = path.resolve(ROOT, relativePath)
  const relative = path.relative(ROOT, absolute)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝清理仓库根之外的路径：${relativePath} -> ${absolute}`)
  }
  return absolute
}

/** 统一显示为使用 / 分隔的相对路径，便于跨平台阅读 */
function displayPath(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/')
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unitIndex = -1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(unitIndex < 1 ? 1 : 2)} ${units[unitIndex]}`
}

/**
 * 扫描目录树的大小与条目数。不跟随符号链接（符号链接只统计为 1 个条目）。
 * 扫描失败时返回 sizeKnown=false，但仍允许继续删除（删除失败会单独报错）。
 */
function scanTree(absolutePath) {
  const result = { entries: 0, bytes: 0, sizeKnown: true }
  const walk = (current) => {
    const stats = fs.lstatSync(current)
    if (stats.isSymbolicLink()) {
      result.entries += 1
      return
    }
    if (!stats.isDirectory()) {
      result.entries += 1
      result.bytes += stats.size
      return
    }
    for (const name of fs.readdirSync(current)) {
      walk(path.join(current, name))
    }
  }
  try {
    walk(absolutePath)
  } catch (error) {
    result.sizeKnown = false
    console.warn(`    （无法完整统计大小：${error instanceof Error ? error.message : String(error)}）`)
  }
  return result
}

/**
 * 清理一个目标路径。
 * @returns {{status: 'removed'|'planned'|'skipped', reason?: string, bytes?: number, entries?: number}}
 */
function cleanTarget(relativePath, { dryRun }) {
  const absolutePath = resolveInsideRoot(relativePath)

  let stats
  try {
    stats = fs.lstatSync(absolutePath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { status: 'skipped', reason: '不存在' }
    }
    throw error
  }

  if (stats.isSymbolicLink()) {
    return { status: 'skipped', reason: '符号链接 / 目录联接，不跟随清理' }
  }

  const scanned = stats.isDirectory() ? scanTree(absolutePath) : { entries: 1, bytes: stats.size, sizeKnown: true }
  const sizeText = scanned.sizeKnown ? `${humanBytes(scanned.bytes)}，${scanned.entries} 个条目` : '大小未知'

  if (dryRun) {
    return { status: 'planned', bytes: scanned.bytes, entries: scanned.entries, reason: sizeText }
  }

  fs.rmSync(absolutePath, { recursive: true, force: true })
  if (fs.existsSync(absolutePath)) {
    throw new Error(`删除后仍然存在：${displayPath(absolutePath)}`)
  }
  return { status: 'removed', bytes: scanned.bytes, entries: scanned.entries, reason: sizeText }
}

function main() {
  const argv = process.argv.slice(2)
  let dryRun = false
  let includeData = false

  for (const argument of argv) {
    if (argument === '--dry-run') dryRun = true
    else if (argument === '--data') includeData = true
    else if (argument === '--help' || argument === '-h') {
      console.log(USAGE)
      return
    } else {
      console.error(`未知参数：${argument}\n`)
      console.error(USAGE)
      process.exitCode = 1
      return
    }
  }

  const targets = [...DEFAULT_TARGETS, ...(includeData ? DATA_CACHE_TARGETS : [])]
  const modeText = dryRun ? 'dry-run（只预览，不删除）' : '执行清理'
  console.log(`[clean] 仓库根：${ROOT}`)
  console.log(`[clean] 模式：${modeText}`)
  if (includeData) {
    console.log(`[clean] 保留数据：${DATA_PRESERVED.join('、')}`)
  }
  console.log('')

  const summary = { removed: 0, planned: 0, skipped: 0, bytes: 0, bytesKnown: true }
  let failed = false

  for (const relativePath of targets) {
    const label = relativePath.split(path.sep).join('/')
    try {
      const result = cleanTarget(relativePath, { dryRun })
      if (result.status === 'planned') {
        summary.planned += 1
        console.log(`[dry-run] 将删除 ${label}/  (${result.reason})`)
      } else if (result.status === 'removed') {
        summary.removed += 1
        console.log(`[clean]   已删除 ${label}/  (${result.reason})`)
      } else {
        summary.skipped += 1
        console.log(`[clean]   跳过   ${label}/  （${result.reason}）`)
        continue
      }
      if (typeof result.bytes === 'number' && Number.isFinite(result.bytes)) {
        summary.bytes += result.bytes
      } else {
        summary.bytesKnown = false
      }
    } catch (error) {
      failed = true
      console.error(`[clean]   失败   ${label}/：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.log('')
  if (summary.bytesKnown) {
    const sizeText = humanBytes(summary.bytes)
    console.log(
      dryRun
        ? `[clean] 预览完成：可释放约 ${sizeText}（${summary.planned} 项将删除，${summary.skipped} 项跳过）`
        : `[clean] 完成：已释放约 ${sizeText}（${summary.removed} 项已删除，${summary.skipped} 项跳过）`
    )
  } else {
    console.log(
      dryRun
        ? `[clean] 预览完成：${summary.planned} 项将删除，${summary.skipped} 项跳过（部分目标大小未知）`
        : `[clean] 完成：${summary.removed} 项已删除，${summary.skipped} 项跳过（部分目标大小未知）`
    )
  }

  if (!includeData) {
    console.log('[clean] 提示：data/ 未处理；如需清理 Electron/日志缓存，使用 --data（业务数据会保留）。')
  }

  if (failed) process.exitCode = 1
}

try {
  main()
} catch (error) {
  console.error(`[clean] 清理失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
