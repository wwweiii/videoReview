/** 第一阶段回归：真实业务模块 + 隔离文件目录 + 可控 Electron/网络/抽帧边界。 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const tmp = path.join(root, '.tmp')
fs.mkdirSync(tmp, { recursive: true })
const dataDir = fs.mkdtempSync(path.join(tmp, 'reliability-'))
process.env.VIDEOREVIEW_DATA_DIR = dataDir
const bundle = path.join(dataDir, 'checks.cjs')
try {
  await build({
    entryPoints: [path.join(root, 'scripts/reliability/checks.mjs')],
    outfile: bundle, bundle: true, format: 'cjs', platform: 'node', target: 'node22',
    alias: { '@shared': path.join(root, 'src/shared') },
    plugins: [{ name: 'controlled-boundaries', setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
      build.onResolve({ filter: /\/media\/ffmpeg$/ }, () => ({ path: 'ffmpeg', namespace: 'test' }))
      build.onLoad({ filter: /.*/, namespace: 'test' }, ({ path: name }) => ({ loader: 'js', contents: name === 'electron' ? `
        export const app = {isPackaged:false, getAppPath:()=>process.env.VIDEOREVIEW_DATA_DIR, getPath:()=>process.env.VIDEOREVIEW_DATA_DIR};
        export const BrowserWindow = {getAllWindows:()=>globalThis.testWindows??[]};
        export const safeStorage = {isEncryptionAvailable:()=>false};
        export const dialog = {};
        const image={isEmpty:()=>false,getSize:()=>({width:640,height:360}),resize:()=>image,toPNG:()=>Buffer.from('test'),toJPEG:()=>Buffer.from('test')};
        export const nativeImage={createFromPath:()=>image,createFromBuffer:()=>image};
      ` : `
        import fs from 'node:fs'; import path from 'node:path';
        export async function probeVideo(filePath) {return {fileName:path.basename(filePath),filePath,durationMs:2000,width:640,height:360,fileSizeBytes:1}};
        export async function getVideoThumbnailBuffer() { return null }
        export async function extractFrames(options) {
          if(globalThis.extractionHook) await globalThis.extractionHook(options);
          if(options.signal.aborted) throw new Error('任务已取消');
          const dir=path.join(process.env.VIDEOREVIEW_DATA_DIR,'tasks',options.taskId,'frames');
          fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'000000.png'),Buffer.from('test'));
          return [{index:0,timestampMs:0,fileName:'000000.png'}];
        }
      ` }))
    } }]
  })
  const { runChecks } = createRequire(import.meta.url)(bundle)
  await runChecks()
} finally {
  const resolved = fs.realpathSync(dataDir)
  if (path.dirname(resolved) !== fs.realpathSync(tmp) || !path.basename(resolved).startsWith('reliability-')) {
    throw new Error('拒绝清理工作区以外的测试目录')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}
