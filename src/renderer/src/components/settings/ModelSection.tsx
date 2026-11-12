import { Loader2 } from 'lucide-react'
import type { JSX } from 'react'
import { IMAGE_MAX_EDGE_OPTIONS, MAX_TOKENS_OPTIONS } from '@shared/defaults'
import {
  BOX_ORDER_LABELS,
  COORDINATE_SPACE_LABELS,
  type BoxOrder,
  type CoordinateSpace
} from '@shared/localization'
import type { ConnectionTestResult } from '@shared/types'
import type { SettingsForm } from '../../hooks/useSettingsForm'

const COORDINATE_SPACE_OPTIONS: CoordinateSpace[] = [
  'normalized_1000',
  'normalized_100',
  'normalized_01',
  'absolute_px'
]

const BOX_ORDER_OPTIONS: BoxOrder[] = ['xyxy', 'yxyx']

/** 设置页「模型」卡片：预设/自定义切换、连接参数、高级配置、测试连接 */
export function ModelSection({
  form,
  presetAvailable,
  hasApiKey,
  testing,
  testResult,
  onTest
}: {
  form: SettingsForm
  presetAvailable: boolean
  hasApiKey: boolean
  testing: boolean
  testResult: ConnectionTestResult | null
  onTest: () => void
}): JSX.Element {
  return (
    <section className="settings-card">
      <h2>模型</h2>

      {presetAvailable ? (
        <div className="segmented">
          <button
            type="button"
            className={form.modelMode === 'preset' ? 'is-active' : ''}
            onClick={() => form.setModelMode('preset')}
          >
            预设
          </button>
          <button
            type="button"
            className={form.modelMode === 'custom' ? 'is-active' : ''}
            onClick={() => form.setModelMode('custom')}
          >
            自定义
          </button>
        </div>
      ) : null}

      {form.modelMode === 'custom' ? (
        <>
          <div className="form-grid">
            <label className="form-field span-2">
              <span>接口地址</span>
              <input
                value={form.baseUrl}
                onChange={(event) => form.setBaseUrl(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="form-field">
              <span>模型名称</span>
              <input
                value={form.modelName}
                onChange={(event) => form.setModelName(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="form-field">
              <span>密钥</span>
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) => {
                  form.setApiKey(event.target.value)
                  if (event.target.value) form.setClearApiKey(false)
                }}
                placeholder={hasApiKey ? '已保存' : ''}
                autoComplete="off"
                spellCheck={false}
                disabled={form.clearApiKey}
              />
              {hasApiKey ? (
                <label className="clear-key">
                  <input
                    type="checkbox"
                    checked={form.clearApiKey}
                    onChange={(event) => {
                      form.setClearApiKey(event.target.checked)
                      if (event.target.checked) form.setApiKey('')
                    }}
                  />
                  清除密钥
                </label>
              ) : null}
            </label>
          </div>

          <div className="form-subhead">高级配置</div>
          <div className="form-grid">
            <label className="form-field span-2">
              <span>额外请求体（JSON 对象）</span>
              <textarea
                value={form.extraBody}
                onChange={(event) => form.setExtraBody(event.target.value)}
                placeholder='例如 {"chat_template_kwargs":{"enable_thinking":false}}'
                spellCheck={false}
                rows={3}
              />
              <span className="field-note">
                透传给服务端的额外字段，留空表示不发送；必须是 JSON 对象。
              </span>
            </label>

            <label className="form-field">
              <span>最大 token</span>
              <input
                type="number"
                min={128}
                max={32768}
                step={1}
                list="max-token-options"
                value={form.maxTokens}
                onChange={(event) =>
                  form.setMaxTokens(event.target.value === '' ? 0 : Number(event.target.value))
                }
              />
              <datalist id="max-token-options">
                {MAX_TOKENS_OPTIONS.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </label>

            <label className="form-field">
              <span>定位图片长边</span>
              <select
                value={String(form.imageMaxEdge)}
                onChange={(event) => form.setImageMaxEdge(Number(event.target.value))}
              >
                {IMAGE_MAX_EDGE_OPTIONS.map((edge) => (
                  <option key={edge} value={edge}>
                    {edge === 0 ? '自动（1120 px）' : `${edge} px`}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                只影响“定位请求”的图片大小；判定请求仍用原始帧。外部接口建议保持默认 1120，
                越大越慢，且部分网关会内部缩放导致框偏移。
              </span>
            </label>

            <div className="form-field">
              <span>定位图片格式</span>
              <div className="segmented">
                <button
                  type="button"
                  className={form.imageFormat === 'png' ? 'is-active' : ''}
                  onClick={() => form.setImageFormat('png')}
                >
                  PNG
                </button>
                <button
                  type="button"
                  className={form.imageFormat === 'jpeg' ? 'is-active' : ''}
                  onClick={() => form.setImageFormat('jpeg')}
                >
                  JPEG
                </button>
              </div>
              <span className="field-hint">
                外部接口建议用 JPEG：体积约为 PNG 的 1/5～1/10，上传更快，框的位置通常不受影响。
              </span>
            </div>

            <div className="form-field">
              <span>提示词语言</span>
              <div className="segmented">
                <button
                  type="button"
                  className={form.promptLanguage === 'zh' ? 'is-active' : ''}
                  onClick={() => form.setPromptLanguage('zh')}
                >
                  中文
                </button>
                <button
                  type="button"
                  className={form.promptLanguage === 'en' ? 'is-active' : ''}
                  onClick={() => form.setPromptLanguage('en')}
                >
                  English
                </button>
              </div>
            </div>

            <label className="form-field">
              <span>坐标空间</span>
              <select
                value={form.coordinateSpaceOverride}
                onChange={(event) =>
                  form.setCoordinateSpaceOverride(
                    event.target.value as 'auto' | CoordinateSpace
                  )
                }
              >
                <option value="auto">自动探测</option>
                {COORDINATE_SPACE_OPTIONS.map((space) => (
                  <option key={space} value={space}>
                    {COORDINATE_SPACE_LABELS[space]}
                  </option>
                ))}
              </select>
              <span className="field-note">自动探测失败时可在此手动指定。</span>
            </label>

            <label className="form-field">
              <span>轴序</span>
              <select
                value={form.boxOrderOverride}
                onChange={(event) =>
                  form.setBoxOrderOverride(event.target.value as 'auto' | BoxOrder)
                }
              >
                <option value="auto">自动探测</option>
                {BOX_ORDER_OPTIONS.map((order) => (
                  <option key={order} value={order}>
                    {BOX_ORDER_LABELS[order]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      ) : null}

      <div className="settings-actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={onTest}
          disabled={testing || (form.modelMode === 'custom' && !form.customValid)}
        >
          {testing ? <Loader2 size={16} className="spin" /> : null}
          测试连接
        </button>
        {testResult ? (
          <span className={`test-message ${testResult.ok ? 'is-success' : 'is-error'}`}>
            {testResult.message}
          </span>
        ) : null}
      </div>
    </section>
  )
}
