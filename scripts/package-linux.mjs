#!/usr/bin/env node
/**
 * 把 electron-builder 的 linux-unpacked 整理成可复制到麒麟 Linux 的便携包：
 *
 *   release/videoReview-linux-x64.tar.gz
 *   └─ videoReview-linux-x64/
 *      ├─ 视频智能审核       # 启动脚本
 *      ├─ 使用说明.txt
 *      └─ app/               # Electron 运行组件，请勿拆分
 *
 * 启动脚本会把运行数据放到发布包根目录的 data/，这样整个目录复制到内网机器
 * 后仍然可以保留设置、任务和日志。若调用方已设置 VIDEOREVIEW_DATA_DIR，则保留
 * 调用方指定的目录。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(ROOT, 'release')
const unpackedDir = path.join(releaseDir, 'linux-unpacked')
const stagingName = 'videoReview-linux-x64'
const stagingDir = path.join(releaseDir, stagingName)
const appDir = path.join(stagingDir, 'app')
const archivePath = path.join(releaseDir, `${stagingName}.tar.gz`)
const launcherName = '视频智能审核'
const innerExecutableName = 'videoReview'
const usageDocPath = path.join(ROOT, 'resources', '使用说明-linux.txt')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const builtExecutableName = String(pkg.build?.executableName || pkg.name)

function fail(message) {
  console.error(`[package-linux] 失败：${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`[package-linux] ${message}`)
}

function removeIfExists(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

function createLauncher(targetPath) {
  // 使用 POSIX shell，避免目标机器必须预装 Node、Python 或其他运行时。
  const launcher = `#!/usr/bin/env sh
set -eu
ROOT=\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)
if [ -z "\${VIDEOREVIEW_DATA_DIR:-}" ]; then
  export VIDEOREVIEW_DATA_DIR="\$ROOT/data"
fi
exec "\$ROOT/app/${innerExecutableName}" "\$@"
`
  fs.writeFileSync(targetPath, launcher, { encoding: 'utf8', mode: 0o755 })
  fs.chmodSync(targetPath, 0o755)
}

function createArchive() {
  const result = spawnSync('tar', ['-czf', archivePath, stagingName], {
    cwd: releaseDir,
    stdio: 'inherit'
  })
  if (result.error) fail(`未找到 tar：${result.error.message}`)
  if (result.status !== 0 || !fs.existsSync(archivePath)) {
    fail(`tar 打包失败（exit=${result.status ?? 'unknown'}）`)
  }
}

function main() {
  if (!fs.existsSync(unpackedDir)) {
    fail('未找到 release/linux-unpacked，请先执行 electron-builder --linux x64 --dir')
  }
  if (!fs.existsSync(usageDocPath)) fail('缺少 resources/使用说明-linux.txt')

  fs.mkdirSync(releaseDir, { recursive: true })
  removeIfExists(stagingDir)
  removeIfExists(archivePath)
  fs.mkdirSync(stagingDir, { recursive: true })

  log(`整理发布目录：release/${stagingName}/`)
  fs.renameSync(unpackedDir, appDir)

  const builtExecutable = path.join(appDir, builtExecutableName)
  if (!fs.existsSync(builtExecutable)) {
    fail(`未找到 Linux 应用程序：app/${builtExecutableName}`)
  }
  fs.renameSync(builtExecutable, path.join(appDir, innerExecutableName))
  fs.chmodSync(path.join(appDir, innerExecutableName), 0o755)

  createLauncher(path.join(stagingDir, launcherName))
  fs.copyFileSync(usageDocPath, path.join(stagingDir, '使用说明.txt'))
  fs.mkdirSync(path.join(stagingDir, 'data'), { recursive: true })

  log(`创建压缩包：release/${path.basename(archivePath)}`)
  createArchive()

  // 使用说明同步放一份在 release/，分发/预览时无需先解压 tar.gz
  const releaseDocPath = path.join(releaseDir, '使用说明-Linux.txt')
  fs.copyFileSync(usageDocPath, releaseDocPath)

  const size = fs.statSync(archivePath).size
  log(`完成（${(size / 1024 / 1024).toFixed(1)} MiB）`)
  log(`使用说明：release/${path.basename(releaseDocPath)}（与包内 使用说明.txt 相同）`)
}

main()
