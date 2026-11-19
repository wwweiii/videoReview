/** 在隔离目录中验证初始值、修改 defaults.ts 后的效果和已有设置的优先级。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const tmp = path.join(root, '.tmp')
fs.mkdirSync(tmp, { recursive: true })
const testDir = fs.mkdtempSync(path.join(tmp, 'defaults-'))
const originalDataDir = process.env.VIDEOREVIEW_DATA_DIR
const defaultsPath = path.join(root, 'src/shared/defaults.ts')
const originalDefaults = fs.readFileSync(defaultsPath, 'utf8')
const require = createRequire(import.meta.url)
const plain = (value) => JSON.parse(JSON.stringify(value))
let scenarioIndex = 0

// 仅替换测试 bundle 中的常量初始值，不改源码或用户数据。
function overrideDefaults(overrides) {
  const source = ts.createSourceFile(defaultsPath, originalDefaults, ts.ScriptTarget.Latest, true)
  const edits = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(source)
      if (!(name in overrides) || !declaration.initializer) continue
      edits.push({ start: declaration.initializer.getStart(source), end: declaration.initializer.end, text: JSON.stringify(overrides[name]) })
    }
  }
  assert.equal(edits.length, Object.keys(overrides).length, '所有测试默认值都必须找到对应常量')
  return edits.sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), originalDefaults)
}

async function scenario({ overrides = {}, saved, preset = null } = {}) {
  const dataDir = path.join(testDir, String(++scenarioIndex))
  fs.mkdirSync(dataDir)
  process.env.VIDEOREVIEW_DATA_DIR = dataDir
  if (saved !== undefined) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(saved), 'utf8')
  const bundle = path.join(dataDir, 'checks.cjs')
  await build({
    stdin: {
      contents: `export * from './src/main/config/settings'; export * from './src/main/config/model-config'; export * as defaults from './src/shared/defaults';`,
      resolveDir: root, loader: 'ts'
    },
    outfile: bundle, bundle: true, format: 'cjs', platform: 'node', target: 'node22',
    alias: { '@shared': path.join(root, 'src/shared') },
    plugins: [{ name: 'defaults-fixture', setup(build) {
      build.onLoad({ filter: /[\\/]shared[\\/]defaults\.ts$/ }, () => ({ contents: overrideDefaults(overrides), loader: 'ts' }))
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      build.onResolve({ filter: /^\.\/preset$/ }, () => ({ path: 'preset', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ loader: 'js', contents: name === 'electron' ? `
        export const app = {isPackaged:false, getAppPath:()=>process.env.VIDEOREVIEW_DATA_DIR, getPath:()=>process.env.VIDEOREVIEW_DATA_DIR};
        export const safeStorage = {isEncryptionAvailable:()=>false};
      ` : `const preset = ${JSON.stringify(preset)}; export const getPresetConfig = () => preset; export const isPresetAvailable = () => preset !== null;` }))
    } }]
  })
  return require(bundle)
}

try {
  const initial = await scenario({ overrides: {
    DEFAULT_CUSTOM_MODEL: { baseUrl: '', model: '', apiKey: '', timeoutSec: 120, extraHeaders: '' }
  } })
  const initialSettings = initial.loadSettings()
  assert.equal(initialSettings.modelMode, 'custom')
  assert.equal(initialSettings.requestConcurrency, initial.defaults.DEFAULT_CONCURRENCY)
  assert.equal(initialSettings.intervalSec, initial.defaults.DEFAULT_INTERVAL_SEC)
  assert.equal(initialSettings.analysisMode, initial.defaults.DEFAULT_ANALYSIS_MODE)
  assert.equal(initialSettings.judgmentImage.scalePercent, initial.defaults.DEFAULT_ITEM_IMAGE_SCALE_PERCENT)
  assert.equal(initialSettings.behaviorImageScalePercent, initial.defaults.DEFAULT_BEHAVIOR_IMAGE_SCALE_PERCENT)
  assert.equal(initialSettings.behaviorFps, initial.defaults.DEFAULT_BEHAVIOR_FPS)
  assert.deepEqual(initialSettings.behaviorItems, initial.defaults.DEFAULT_BEHAVIOR_ITEMS)
  assert.deepEqual(initialSettings.prohibitedItems, [])
  assert.deepEqual(initialSettings.customProhibitedItems, [])

  const overrides = {
    DEFAULT_MODEL_MODE: 'custom', DEFAULT_CONCURRENCY: 5, DEFAULT_DEVELOPER_MODE: true,
    DEFAULT_CUSTOM_MODEL: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'debug', apiKey: 'fixture-key', timeoutSec: 90, extraHeaders: '{"X-Test":"yes"}' },
    DEFAULT_MODEL_RUNTIME: { extraBody: '{"top_k":7}', coordinateSpaceOverride: 'absolute_px', boxOrderOverride: 'yxyx', parseDialectOverride: 'json_multi' },
    DEFAULT_INTERVAL_SEC: 3, DEFAULT_ANALYSIS_MODE: 'group', DEFAULT_GROUP_SIZE: 6,
    DEFAULT_CONFIDENCE_THRESHOLD: 0, DEFAULT_LOCALIZE: false, DEFAULT_ITEM_IMAGE_SCALE_PERCENT: 75,
    DEFAULT_BEHAVIOR_ITEMS: [{ id: 'behavior:sign', label: '手写签字' }],
    DEFAULT_BEHAVIOR_WINDOW_SEC: 3, DEFAULT_BEHAVIOR_STRIDE_SEC: 1.5, DEFAULT_BEHAVIOR_FPS: 8,
    DEFAULT_BEHAVIOR_IMAGE_SCALE_PERCENT: 50
  }
  const changed = await scenario({ overrides })
  const changedSettings = changed.loadSettings()
  const resolved = changed.getResolvedModelConfig()
  assert.equal(resolved.model, 'debug')
  assert.equal(resolved.apiKey, 'fixture-key')
  assert.equal(resolved.timeoutSec, 90)
  assert.equal(resolved.concurrency, 5)
  assert.equal(resolved.extraHeaders, '{"X-Test":"yes"}')
  assert.equal(resolved.extraBody, '{"top_k":7}')
  assert.equal(resolved.coordinateSpaceOverride, 'absolute_px')
  assert.equal(changed.getPublicSettings().customModel.hasApiKey, true)
  assert.equal(JSON.stringify(changed.getPublicSettings()).includes('fixture-key'), false)
  assert.equal(changedSettings.judgmentImage.scalePercent, 75)
  assert.equal(changedSettings.behaviorImageScalePercent, 50)
  assert.equal(changedSettings.confidenceThreshold, 0)
  assert.equal(changedSettings.localize, false)
  assert.equal(changedSettings.intervalSec, 3)
  assert.equal(changedSettings.analysisMode, 'group')
  assert.equal(changedSettings.groupSize, 6)
  assert.deepEqual(changedSettings.prohibitedItems, [])
  assert.deepEqual(changed.getBehaviorConfig(), { windowSec: 3, strideSec: 1.5, fps: 8, imageScalePercent: 50, behaviors: ['手写签字'] })
  changedSettings.behaviorItems[0].label = '修改草稿'
  assert.equal(changed.defaults.DEFAULT_BEHAVIOR_ITEMS[0].label, '手写签字')

  const legacy = await scenario({ overrides, saved: {} })
  assert.deepEqual(plain(legacy.loadSettings()), plain({ ...changed.loadSettings(),
    behaviorItems: overrides.DEFAULT_BEHAVIOR_ITEMS
  }))

  const saved = { ...initialSettings,
    customModel: { ...initialSettings.customModel, baseUrl: 'http://127.0.0.1:4321/v1', model: 'saved' },
    confidenceThreshold: 0, behaviorItems: [], customProhibitedItems: []
  }
  const existing = await scenario({ overrides, saved })
  assert.deepEqual(plain(existing.loadSettings()), plain(saved), '已有空列表、false、0 和 auto 都必须保留')
  assert.equal(existing.getResolvedModelConfig().extraBody, '', '关闭开发者模式时不启用高级默认值')

  const { traceEnabled: _traceEnabled, ...legacyTraceSettings } = { ...saved, developerMode: true }
  const legacyTrace = await scenario({ overrides, saved: legacyTraceSettings })
  assert.equal(legacyTrace.getPublicSettings().developerMode, true)
  assert.equal(legacyTrace.getPublicSettings().traceEnabled, false, '旧设置未主动启用轨迹')

  const customProhibitedItems = [{ id: 'custom:power', label: '充电宝' }]
  const oldSelection = await scenario({
    saved: { ...saved, prohibitedItems: ['pen', 'phone', 'pencil', 'custom:power'], customProhibitedItems }
  })
  assert.deepEqual(oldSelection.getPublicSettings().prohibitedItems, ['custom:power'], '旧配置移除预设物品并保留启用的自定义物品')
  assert.deepEqual(oldSelection.getAnalysisConfig().customProhibitedItems, customProhibitedItems)
  oldSelection.saveSettings({
    ...oldSelection.getPublicSettings(), section: 'items', customModel: { baseUrl: '', model: '' },
    prohibitedItems: [], customProhibitedItems: []
  })
  assert.deepEqual(oldSelection.getAnalysisConfig().prohibitedItems, [], '保存空列表后仍为空')

  const preset = { baseUrl: 'http://127.0.0.1:5555/v1', model: 'preset', apiKey: '', concurrency: 7, timeoutSec: 80,
    defaults: { intervalSec: 5, prohibitedItems: ['phone'], analysisMode: 'single', groupSize: 3, localize: true, itemImageScalePercent: 60, behaviorImageScalePercent: 40 }
  }
  const withPreset = await scenario({ overrides: { ...overrides, DEFAULT_MODEL_MODE: 'auto' }, preset })
  assert.equal(withPreset.loadSettings().modelMode, 'preset')
  assert.equal(withPreset.loadSettings().requestConcurrency, 7)
  assert.equal(withPreset.loadSettings().intervalSec, 5)
  assert.equal(withPreset.loadSettings().analysisMode, 'single')
  assert.equal(withPreset.loadSettings().judgmentImage.scalePercent, 60)
  assert.equal(withPreset.loadSettings().behaviorImageScalePercent, 40)
  assert.deepEqual(withPreset.loadSettings().prohibitedItems, [])
  const customWithPreset = await scenario({ overrides, preset })
  assert.equal(customWithPreset.loadSettings().modelMode, 'custom')
  const unavailable = await scenario({ overrides: { DEFAULT_MODEL_MODE: 'preset' } })
  assert.equal(unavailable.loadSettings().modelMode, 'custom')
  console.log('默认配置验证：PASS（初始值、集中调整、旧配置补全、保存值优先、开发者开关、预设覆盖）')
} finally {
  if (originalDataDir === undefined) delete process.env.VIDEOREVIEW_DATA_DIR
  else process.env.VIDEOREVIEW_DATA_DIR = originalDataDir
  const resolved = fs.realpathSync(testDir)
  if (path.dirname(resolved) !== fs.realpathSync(tmp) || !path.basename(resolved).startsWith('defaults-')) {
    throw new Error('拒绝清理工作区以外的测试目录')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}
