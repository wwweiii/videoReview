import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

const isWindows = process.platform === 'win32'
if (isWindows) spawnSync('chcp.com', ['65001'], { stdio: 'ignore' })

const electronVite = path.resolve(process.cwd(), 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [electronVite, 'dev'], {
  stdio: 'inherit',
  env: process.env
})

let interrupted = false

function forwardSignal(signal) {
  interrupted = true
  if (!child.killed) child.kill(signal)
}

process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

child.on('error', (error) => {
  console.error(`开发服务器启动失败：${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  process.exit(interrupted || signal ? 0 : code ?? 1)
})
