#!/usr/bin/env node
/**
 * scripts/package-win.mjs
 *
 * 把 electron-builder 的 `release/win-unpacked/` 整理成「解压即见 exe」的绿色发布包：
 *
 *   release/videoReview-win-x86.zip
 *   └─ videoReview-win-x86/
 *      ├─ 视频智能审核.exe        # 原生启动器（几十 KB，启动快，双击即用）
 *      ├─ 使用说明.txt            # 和 exe 并排，打开解压目录即可看到
 *      └─ app/                    # Electron 运行时（真实 exe 改名为 videoReview.exe）
 *         ├─ videoReview.exe
 *         ├─ *.dll / *.pak / locales/ / resources/ ...
 *
 * 为什么需要启动器：Electron 的 dll / pak / icudtl.dat / locales / resources 必须与
 * 真实 exe 位于同一目录，无法直接收进子目录。用一个极小的原生启动器启动 app/ 下的
 * 真实 exe，就能做到「根目录只留一个 exe + 规范子目录」，同时保持直接启动、无需解压。
 * 启动器同时把数据目录（VIDEOREVIEW_DATA_DIR）指向包根目录的 data/，首次运行自动创建。
 *
 * 用法：由 `npm run build:win` 在 electron-builder --dir 成功后自动调用。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(ROOT, 'release')
const unpackedDir = path.join(releaseDir, 'win-unpacked')

const stagingName = 'videoReview-win-x86'
const stagingDir = path.join(releaseDir, stagingName)
const appDir = path.join(stagingDir, 'app')
const zipPath = path.join(releaseDir, `${stagingName}.zip`)
const innerExeName = 'videoReview.exe'
const launcherName = '视频智能审核.exe'
const iconPath = path.join(ROOT, 'build', 'icon.ico')
const usageDocPath = path.join(ROOT, 'resources', '使用说明-windows.txt')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = String(pkg.version || '0.0.0')
const productName = String(pkg.build?.productName || pkg.description || pkg.name)
const companyName = String(pkg.author || '')
const productExeName = `${productName}.exe`

function log(message) {
  console.log(`[package] ${message}`)
}

function fail(message) {
  console.error(`[package] 失败：${message}`)
  process.exit(1)
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes
  let unitIndex = -1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/** 递归查找文件（限制深度，避免遍历过深） */
function findFile(rootDir, fileName, maxDepth = 6) {
  if (!fs.existsSync(rootDir)) return null
  const queue = [{ dir: rootDir, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return absolute
      if (entry.isDirectory() && depth < maxDepth) queue.push({ dir: absolute, depth: depth + 1 })
    }
  }
  return null
}

/** 优先用 electron-builder 缓存里的 7za 打 zip；其次系统 tar；最后 PowerShell */
function createZip() {
  // 先删旧 zip，避免 7za 的更新模式残留已不存在的条目
  fs.rmSync(zipPath, { force: true })
  const sevenZip =
    findFile(
      path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache'),
      '7za.exe'
    ) || findFile(path.join(ROOT, 'node_modules'), '7za.exe', 4)

  if (sevenZip) {
    log(`使用 7za 压缩：${path.relative(ROOT, sevenZip)}`)
    const result = spawnSync(
      sevenZip,
      ['a', '-tzip', '-mx=7', '-y', zipPath, stagingName],
      { cwd: releaseDir, stdio: 'inherit' }
    )
    if (result.status === 0 && fs.existsSync(zipPath)) return
    fail(`7za 打包失败（exit=${result.status}）`)
  }

  const tarPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  if (fs.existsSync(tarPath)) {
    log('未找到 7za，改用系统 tar 打 zip')
    const result = spawnSync(tarPath, ['-a', '-c', '-f', zipPath, stagingName], {
      cwd: releaseDir,
      stdio: 'inherit'
    })
    if (result.status === 0 && fs.existsSync(zipPath)) return
    log('系统 tar 打包失败，回退 PowerShell Compress-Archive')
  }

  log('使用 PowerShell Compress-Archive 压缩（较慢）')
  const escapedSource = stagingDir.replace(/'/g, "''")
  const escapedTarget = zipPath.replace(/'/g, "''")
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Compress-Archive -Path '${escapedSource}' -DestinationPath '${escapedTarget}' -CompressionLevel Optimal -Force`
    ],
    { stdio: 'inherit' }
  )
  if (!fs.existsSync(zipPath)) fail('Compress-Archive 未生成 zip')
}

/** 清理 release 中上一轮构建留下的产物与中间目录 */
function removeStaleArtifacts() {
  if (!fs.existsSync(releaseDir)) fs.mkdirSync(releaseDir, { recursive: true })
  const escapedProduct = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const staleFilePatterns = [
    /^builder-debug\.yml$/i,
    /^builder-effective-config\.yaml$/i,
    new RegExp(`^${escapedProduct}-.+\\.(exe|zip|7z)$`, 'i')
  ]
  for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
    const absolute = path.join(releaseDir, entry.name)
    const isStaging = entry.isDirectory() && entry.name === stagingName
    const isStaleFile = entry.isFile() && staleFilePatterns.some((pattern) => pattern.test(entry.name))
    // 注意：不能清理 win-unpacked，它是本次 electron-builder 刚产出的输入目录
    if (isStaging || isStaleFile) {
      fs.rmSync(absolute, { recursive: true, force: true })
      log(`清理旧产物：${entry.name}`)
    }
  }
}

/** 生成并编译原生启动器（C#，.NET Framework 自带 csc，无额外依赖） */
function buildLauncher(targetPath) {
  const cscCandidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  const csc = cscCandidates.find((candidate) => fs.existsSync(candidate))
  if (!csc) fail('未找到 .NET Framework 编译器 csc.exe，无法生成启动器')

  const fileVersion = /^\d+\.\d+\.\d+\.\d+$/.test(version) ? version : `${version}.0`
  const source = `using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

[assembly: AssemblyTitle("${productName}")]
[assembly: AssemblyProduct("${productName}")]
[assembly: AssemblyCompany("${companyName}")]
[assembly: AssemblyFileVersion("${fileVersion}")]
[assembly: AssemblyInformationalVersion("${version}")]

namespace VideoReviewLauncher
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string appDir = Path.Combine(root, "app");
            string exePath = Path.Combine(appDir, "${innerExeName}");
            if (!File.Exists(exePath))
            {
                return;
            }

            ProcessStartInfo info = new ProcessStartInfo(exePath);
            info.UseShellExecute = false;
            info.WorkingDirectory = appDir;
            // 数据目录跟随发布包根目录，避免写进临时目录或 app/ 子目录
            info.EnvironmentVariables["VIDEOREVIEW_DATA_DIR"] = Path.Combine(root, "data");

            if (args.Length > 0)
            {
                StringBuilder builder = new StringBuilder();
                for (int index = 0; index < args.Length; index++)
                {
                    if (index > 0)
                    {
                        builder.Append(' ');
                    }
                    builder.Append('"').Append(args[index].Replace("\\"", "\\\\\\"")).Append('"');
                }
                info.Arguments = builder.ToString();
            }

            try
            {
                Process.Start(info);
            }
            catch
            {
                // 启动失败时静默退出；正常打包产物不会走到这里
            }
        }
    }
}
`

  const tempSourceDir = path.join(stagingDir, '.launcher')
  fs.mkdirSync(tempSourceDir, { recursive: true })
  const sourcePath = path.join(tempSourceDir, 'Launcher.cs')
  // csc 默认按系统代码页读取无 BOM 文件，带 BOM 才能正确编译中文程序集信息
  fs.writeFileSync(sourcePath, `\ufeff${source}`, 'utf8')

  const args = [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    `/out:${targetPath}`,
    ...(fs.existsSync(iconPath) ? [`/win32icon:${iconPath}`] : []),
    sourcePath
  ]
  log(`编译启动器：${path.basename(targetPath)}`)
  const result = spawnSync(csc, args, { cwd: ROOT, stdio: 'inherit' })
  fs.rmSync(tempSourceDir, { recursive: true, force: true })
  if (result.status !== 0 || !fs.existsSync(targetPath)) {
    fail(`启动器编译失败（exit=${result.status}）`)
  }
}

function main() {
  if (!fs.existsSync(unpackedDir)) {
    fail('未找到 release/win-unpacked，请先执行 electron-builder --win --x64 --dir')
  }
  if (!fs.existsSync(usageDocPath)) fail('缺少 resources/使用说明-windows.txt')

  removeStaleArtifacts()

  // 1. 把 win-unpacked 整体挪进 staging/app
  log(`创建发布目录：release/${stagingName}/`)
  fs.mkdirSync(appDir, { recursive: true })
  for (const entry of fs.readdirSync(unpackedDir, { withFileTypes: true })) {
    const from = path.join(unpackedDir, entry.name)
    const to = path.join(appDir, entry.name)
    fs.renameSync(from, to)
  }

  // 2. 真实 exe 改成 ASCII 名，供启动器引用（版本信息/图标不变）
  const builtExe = path.join(appDir, productExeName)
  if (!fs.existsSync(builtExe)) fail(`app/ 中未找到 ${productExeName}`)
  fs.renameSync(builtExe, path.join(appDir, innerExeName))

  // 3. 使用说明和 exe 并排放，解压后根目录即可看到
  if (fs.existsSync(usageDocPath)) {
    fs.copyFileSync(usageDocPath, path.join(stagingDir, '使用说明.txt'))
  }

  // 4. 根目录启动器
  buildLauncher(path.join(stagingDir, launcherName))

  // 5. 打 zip 并清理中间目录
  log('压缩发布包…')
  createZip()
  fs.rmSync(stagingDir, { recursive: true, force: true })
  fs.rmSync(unpackedDir, { recursive: true, force: true })
  for (const name of ['builder-debug.yml', 'builder-effective-config.yaml']) {
    fs.rmSync(path.join(releaseDir, name), { force: true })
  }

  if (!fs.existsSync(zipPath)) fail('未生成发布 zip')
  const zipSize = fs.statSync(zipPath).size

  // 使用说明同步放一份在 release/，分发/预览时无需先解压 zip
  const releaseDocPath = path.join(releaseDir, '使用说明-Windows.txt')
  if (fs.existsSync(usageDocPath)) {
    fs.copyFileSync(usageDocPath, releaseDocPath)
  }

  log('')
  log(`发布包：release/${path.basename(zipPath)}（${humanBytes(zipSize)}）`)
  log('  解压后结构：')
  log(`  ${stagingName}/`)
  log(`  ├─ ${launcherName}    # 启动器，双击运行`)
  log('  ├─ 使用说明.txt       # 使用说明')
  log('  └─ app/               # Electron 运行时（请勿拆分/移动）')
  if (fs.existsSync(releaseDocPath)) {
    log(`使用说明：release/${path.basename(releaseDocPath)}（与包内 使用说明.txt 相同）`)
  }
  const releaseLeft = fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .map((entry) => entry.name)
  log(`  release/ 当前内容：${releaseLeft.join('、') || '（空）'}`)
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
