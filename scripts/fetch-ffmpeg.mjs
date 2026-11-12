#!/usr/bin/env node
/**
 * 下载内置 ffmpeg 静态二进制。
 *
 * 仓库不提交 ffmpeg（单文件约 80 MB），首次拉取代码后运行：
 *   npm run fetch:ffmpeg              # 当前平台
 *   npm run fetch:ffmpeg -- --all     # Windows + Linux
 *   npm run fetch:ffmpeg -- --force   # 已存在时强制重新下载
 *
 * 下载源为 ffmpeg-static 的 release 资产，可用 FFMPEG_STATIC_BASE 指向镜像。
 */
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = 'b6.1.1'
const BASE_URL =
  process.env.FFMPEG_STATIC_BASE?.replace(/\/+$/, '') ||
  `https://github.com/eugeneware/ffmpeg-static/releases/download/${VERSION}`

const TARGETS = {
  win32: {
    asset: 'ffmpeg-win32-x64',
    dest: 'resources/bin/win32/x64/ffmpeg.exe',
    magic: 'MZ'
  },
  linux: {
    asset: 'ffmpeg-linux-x64',
    dest: 'resources/bin/linux/x64/ffmpeg',
    magic: '\x7fELF'
  }
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function printHelp() {
  console.log(`用法：npm run fetch:ffmpeg [-- 选项]

选项：
  --all               下载 Windows 与 Linux 两个平台
  --platform <名称>   只下载指定平台（win32 / linux），可重复
  --force, -f         忽略已存在的文件，强制重新下载
  --help, -h          显示本帮助

环境变量：
  FFMPEG_STATIC_BASE  覆盖下载源前缀（用于内网镜像/代理）`)
}

function parseArgs(argv) {
  const options = { all: false, force: false, platforms: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--all') {
      options.all = true
    } else if (arg === '--force' || arg === '-f') {
      options.force = true
    } else if (arg === '--platform' || arg === '-p') {
      const value = argv[(i += 1)]
      if (!value) throw new Error('--platform 需要一个值（win32 / linux）')
      options.platforms.push(value)
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`未知参数：${arg}（用 --help 查看用法）`)
    }
  }
  return options
}

async function hasMagic(file, expected) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(expected.length)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead === buffer.length && buffer.toString('latin1') === expected
  } finally {
    await handle.close()
  }
}

function request(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const client = parsed.protocol === 'https:' ? https : http
    const req = client.get(
      parsed,
      { headers: { 'user-agent': 'videoReview-fetch-ffmpeg' } },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400) {
          const location = response.headers.location
          response.resume()
          if (!location) {
            reject(new Error(`重定向缺少 Location（HTTP ${status}）`))
          } else if (redirects <= 0) {
            reject(new Error('重定向次数过多'))
          } else {
            resolve(request(new URL(location, parsed).toString(), redirects - 1))
          }
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new Error(`下载失败：HTTP ${status}`))
          return
        }
        resolve(response)
      }
    )
    req.on('error', reject)
    req.setTimeout(30_000, () => req.destroy(new Error('连接超时（30 秒无数据）')))
  })
}

async function download(name, target, force) {
  const dest = path.join(ROOT, target.dest)
  const temp = `${dest}.download`

  if (!force) {
    try {
      const info = await stat(dest)
      if (info.size > 0) {
        console.log(`跳过 ${target.dest}（已存在，${formatSize(info.size)}；--force 可重新下载）`)
        return
      }
    } catch {
      // 文件不存在，继续下载
    }
  }

  const url = `${BASE_URL}/${target.asset}`
  console.log(`[${name}] 下载 ${url}`)

  const response = await request(url)
  const total = Number(response.headers['content-length']) || 0
  let received = 0
  let nextMark = 10

  await mkdir(path.dirname(dest), { recursive: true })
  let handle
  try {
    handle = await open(temp, 'w')
    for await (const chunk of response) {
      await handle.write(chunk)
      received += chunk.length
      if (total <= 0) continue
      const percent = Math.floor((received / total) * 100)
      if (percent >= nextMark) {
        nextMark = percent - (percent % 10) + 10
        process.stdout.write(`\r  ${formatSize(received)} / ${formatSize(total)} (${percent}%)\x1b[K`)
      }
    }
    await handle.close()
    handle = undefined
    process.stdout.write('\n')

    if (total > 0 && received !== total) {
      throw new Error(`[${name}] 下载不完整：${received} / ${total} 字节`)
    }
    if (!(await hasMagic(temp, target.magic))) {
      throw new Error(`[${name}] 文件校验失败：不是预期的 ${name} 可执行文件`)
    }
    if (target.dest.endsWith('/ffmpeg')) {
      await chmod(temp, 0o755)
    }

    await rm(dest, { force: true })
    await rename(temp, dest)

    const info = await stat(dest)
    console.log(`[${name}] 完成 ${target.dest}（${formatSize(info.size)}）`)
  } catch (error) {
    process.stdout.write('\n')
    if (handle) await handle.close().catch(() => {})
    await rm(temp, { force: true })
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const names = options.all
    ? Object.keys(TARGETS)
    : options.platforms.length > 0
      ? options.platforms
      : [process.platform]

  for (const name of names) {
    if (!TARGETS[name]) {
      throw new Error(`不支持的平台：${name}（可选：${Object.keys(TARGETS).join(' / ')}）`)
    }
  }

  for (const name of names) {
    await download(name, TARGETS[name], options.force)
  }
}

main().catch((error) => {
  console.error(`\n错误：${error.message}`)
  process.exitCode = 1
})
