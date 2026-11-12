/**
 * 端到端冒烟：真实 ffmpeg 抽帧 → 判定 → 定位 → 落盘 → 重定位。
 *
 * 用法：npm run smoke:localization
 * 依赖：mock 模型服务（scripts/mock-model-server.mjs）与项目内置 ffmpeg。
 * 数据目录隔离在 .tmp/smoke-data，不会污染 data/。
 */
import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..', '..')
const outfile = path.join(root, '.tmp', 'localization-e2e.cjs')
const dataDir = path.join(root, '.tmp', 'smoke-data')

fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.dirname(outfile), { recursive: true })

await build({
  entryPoints: [path.join(root, 'scripts', 'smoke', 'e2e-entry.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  alias: { '@shared': path.join(root, 'src/shared') },
  outfile,
  logLevel: 'warning',
  absWorkingDir: root
})

const electronBinary = require('electron')
const started = Date.now()
const env = {
  ...process.env,
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  VIDEOREVIEW_DATA_DIR: dataDir
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_NO_ATTACH_CONSOLE

const child = spawn(electronBinary, [outfile], { cwd: root, stdio: 'inherit', env })
child.on('exit', (code) => {
  console.log(`\nElectron 端到端退出码：${code}（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`)
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(code ?? 1)
})
