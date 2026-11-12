# 帧上多违禁物标记框 + 时间轴聚合：前端工程方案调研

> **归档说明**：本文为历史调研归档（写于违禁物定位标记 P0 前后），引用的代码路径、组件名与结论均为当时快照；当前实现以 `src/` 与根 `README.md` 为准。原始调研内容保留不动。

> 适用项目：`framelens`（Electron 38 + React 19.3.1 + TypeScript 5.7 + electron-vite 4.0）
> 调研/核实时间：2026-11-09（npm registry、GitHub API、bundlephobia、官方文档）
> 现状：`src/renderer/src/components/TaskDetail.tsx` 的 `FrameDrawer` 只有 `<img>`；无 canvas/konva 依赖；无 UI 库；图标用 lucide-react。
> 目标：帧预览上渲染多个违禁物框 + 交互 + 跨帧聚合时间轴 + 导出。

---

## 1. 结论速览

### 1.1 推荐路线：原生 SVG 覆盖层（主）+ HTML 标签层 + OffscreenCanvas 导出

**结论：不引入 konva / fabric，用 React 直接渲染 SVG 覆盖层；框用 SVG（在"图像显示矩形"坐标系里画），标签用绝对定位的 HTML 按钮；导出带框截图用 OffscreenCanvas 按原图分辨率重绘。**

理由（按重要性排序）：

1. **数据量根本不构成压力。** 每帧通常 0–10 个违禁物框，极端 20–50 个；SVG 的 DOM 节点是几十个而不是几千个。选 canvas/konva 的性能收益在本场景≈0，却要付出依赖、体积、React 集成和导出路径的复杂度。
2. **零新增依赖、零打包体积增量。** 项目当前就 3 个运行时依赖；原生 SVG/Canvas 都是浏览器能力。`react-konva` + `konva` 大约新增 **~101 KB gzip**（konva 56.8 KB + react-konva 44.6 KB，bundlephobia 测量），`fabric` 单独约 **91.9 KB gzip**。
3. **React 19 兼容矩阵最简单。** 原生 SVG 不需要考虑任何第三方库的 React 19 peer 约束。若走 `react-konva`，**19.3.x 要求 react/react-dom ≥ 19.3.0**（release notes 明确写了 19.2 项目要 pin `~19.2.7`、React 18 用 18.x 版本线）；本项目锁的是 React 19.3.1，能用，但以后 `package.json` 里的 `^19.0.0` 一旦解析到 19.2 就会踩坑。
4. **交互、命中测试、可访问性全部"免费"。** hover/click/键盘焦点/`title` tooltip 都是浏览器原生行为；canvas 要手写 hit-test、悬停、文本换行、无障碍，konva 则要维护一层 scene graph。
5. **缩放/Retina 下线条和文字始终清晰。** SVG 是矢量的；框线用固定屏幕像素宽即可，标签用 HTML 也不会被图像缩放拉糊。canvas 需要处理 `devicePixelRatio`（见 §3.7）。
6. **导出路径与交互路径解耦。** 导出时用同一套归一化坐标在 OffscreenCanvas 上按原图分辨率重绘（见 §6.4），既可以选择"所见即所得"，也不会受 canvas 被污染（tainted canvas）影响；反过来，如果交互层用 canvas，导出还要处理跨域/缩放/DPR 三重问题。
7. **未来要"拖拽改框"也不难。** 每帧 1–20 个框，8 个缩放手柄用 SVG 手写完全可行；真到了需要 Transformer/旋转/吸附的设计器级编辑，再单独上 `react-konva` 只做编辑模式即可（只读预览继续用 SVG）。

**一句话：这个需求是"标注结果的可视化 + 轻交互"，不是"图形编辑器"，SVG 是正确抽象层级。**

### 1.2 现状差距（落地前必须先补的 3 块）

| # | 缺口 | 要改哪里 | 说明 |
| --- | --- | --- | --- |
| 1 | **数据里没有框**。`FrameRecord` 只有 verdict/categories/description/confidence，没有 detection/bbox。 | `src/shared/types.ts`、`src/main/model.ts`（prompt + `parseAnalysisObject`）、`src/main/task-manager.ts` 的 `applyAnalysis` | 新增可选字段 `detections?: Detection[]`，旧任务缺省 `[]`，不需要数据迁移/重跑。 |
| 2 | **`vr-media://` 自定义协议不满足 canvas 导出的 CORS 条件**。现在注册了 `standard/secure/supportFetchAPI/stream`，但**没有 `corsEnabled`**，`protocol.handle` 返回 `net.fetch(file://)` 也没有 `Access-Control-Allow-Origin`。`<img>` 显示没问题，但 `drawImage` 后 `toBlob/toDataURL` 会因跨源污染抛 `SecurityError`。 | `src/main/index.ts` 的 `registerSchemesAsPrivileged` + `protocol.handle` | 两条路：① 给 scheme 加 `corsEnabled: true` 并让响应带 `Access-Control-Allow-Origin`（配合 `<img crossOrigin="anonymous">`）；② 更稳：加一个 IPC 读取帧字节，用 `Blob`/`createImageBitmap` 合成，完全不碰跨域（推荐，见 §6.4）。 |
| 3 | **预览容器不是"图像显示矩形"**。现在 `.drawer-image` 用 `max-width/max-height + object-fit: contain` 居中显示，图片实际渲染区域和容器之间有 letterbox。直接按容器坐标绝对定位叠加框会错位。 | `src/renderer/src/components/TaskDetail.tsx` + `styles.css` | 包一层 `frame-viewer`，用 `computeContainRect()` 算出显示矩形（或采用 §3.5 的 SVG `viewBox + meet` 零测量法）。 |

### 1.3 什么时候该换方案（升级判据，而不是拍脑袋）

- **单帧框数长期 > 300–500，或要同时渲染几十帧缩略图并叠加框** → 交互层换 Canvas 2D（或 konva `listening: false` 静态层），SVG 只保留选中框/标签层。
- **需要拖拽改框、旋转、多选框、吸附、撤销重做** → 引入 `react-konva`，只用于"编辑模式"；预览继续 SVG。注意 React 19.3 peer 约束和 StrictMode 双挂载清理。
- **需要做"标注平台"级别的视频轨道编辑（关键帧插值、逐帧刷）** → 参考 CVAT 的 track/关键帧模型（§5.7），而不是自己硬编；框架选型已不是主要问题。
- **要做图表/大批量矢量叠加（几千个框）** → Canvas；但本项目不是。

---

## 2. 方案对比表

### 2.1 四个候选对比（针对"帧预览 + 多个框 + 标签 + 缩放/拖拽 + 导出"）

| 维度 | **原生 SVG（推荐）** | Canvas 2D（手写） | **react-konva 19.3.2** | fabric.js 7.4.0 |
| --- | --- | --- | --- | --- |
| 新增依赖 | 无 | 无 | `konva@10.9.1` + `react-konva@19.3.2`（+ react-reconciler 等 4 个传递依赖） | `fabric@7.4.0`（0 运行时依赖，但无官方 React 封装） |
| 打包体积（min / gzip） | 0 | 0 | konva 189.9 KB / **56.8 KB**；react-konva 143.4 KB / **44.6 KB**；合计 **≈101 KB gzip** | 298.7 KB / **91.9 KB gzip**（bundlephobia） |
| React 19 兼容 | 原生，无约束 | 原生，无约束 | 19.3.x **要求 react/react-dom ≥ 19.3.0**；React 18 用 18.x 线；19.2 用 `~19.2.7` | 框架无关，自己 `useEffect` 挂载；无官方 React 组件 |
| 缩放/Retina | 矢量，天然清晰；`vector-effect: non-scaling-stroke` 控线宽 | 需手写 DPR 缩放；文字/线宽自己算 | 自动；可选择 `listening:false` 优化静态层 | 自动 |
| hover/click/命中 | 浏览器原生，`pointer-events` 精确控制 | 手写 hit-test（矩形倒简单，标签/层叠要自己管） | 原生 scene graph 事件，支持 `hitStrokeWidth` | 原生对象事件 + 选择框 |
| 标签文字 | HTML 层：任意字体/省略号/tooltip/无障碍；SVG text 也可但需处理缩放 | 手写 `fillText`、省略、背景、碰撞 | `Text`/`Label`/`Tag` 现成，但缩放时文字处理要多试 | `Textbox` 现成，适合可编辑文本 |
| 与 React 状态同步 | 声明式，天然同步 | 需 `useEffect` 手动重绘，状态一致性靠自觉 | 声明式（reconciler），但事件/副作用边界多 | 命令式对象模型，需桥接状态 |
| 开发成本（本需求） | **低**（约 200–300 行组件 + 工具函数） | 中（400+ 行，且交互细节多） | 中（200 行但依赖/版本/SSR/StrictMode 坑） | 高（大量 API 用不上） |
| 导出截图 | 与渲染解耦，用同一套坐标在 canvas 重绘 | 直接 `toBlob`，但要注意跨域/DPR | `stage.toDataURL()` 方便，但受容器尺寸影响，通常还要另按原图重绘 | `canvas.toDataURL()` 类似 |
| 适用结论 | **帧预览/审核交互层：首选** | 缩略图批量叠加、导出合成：合适 | 需要框编辑/设计器能力时再引入 | 不推荐（设计编辑器定位，功能过剩） |
| 维护状态（2026-11-09） | 浏览器标准，无维护风险 | 同上 | konva 14,926★、最近 push 2026-11-05、4 open issues；react-konva 6,444★、最新 v19.3.2（2026-10-15）、0 open issues | 31,550★、活跃开发、464 open issues、v7.4.0 |

> 体积数字来自 bundlephobia API（2026-11-09 抓取），仅代表量级；实际 tree-shaking 后 konva 可能略小，但 fabric 的最小可用子集仍然远大于 SVG 的 0。

### 2.2 版本核实记录（可复现）

- **React**：项目 `package-lock.json` 实际安装 `react@19.3.1` / `react-dom@19.3.1`（`package.json` 声明 `^19.0.0`）。React 19 已 stable：[React v19 官方博客](https://react.dev/blog/2024/12/05/react-19)。
- **react-konva 19.3.2**：`peerDependencies`: `konva: ^8 || ^9 || ^10`、`react: ^19.3.0`、`react-dom: ^19.3.0`；[npm registry](https://registry.npmjs.org/react-konva/latest)。发布说明明确"19.3 起最低 React 19.3.0；React 19.2 项目 pin `~19.2.7`；React 18 用 18.x 线"：[react-konva v19.3.0 release](https://github.com/konvajs/react-konva/releases/tag/v19.3.0)。
- **konva 10.9.1**：当前 latest，`type: module`，MIT，gzip 56.8 KB：[npm](https://www.npmjs.com/package/konva)、[bundlephobia](https://bundlephobia.com/package/konva@10.9.1)。
- **fabric 7.4.0**：当前 latest，`engines.node >= 20`（影响 Node 侧构建，不影响浏览器），`sideEffects: false` 可 tree-shake，但核心对象模型仍重：[npm](https://www.npmjs.com/package/fabric)、[bundlephobia](https://bundlephobia.com/package/fabric@7.4.0)。
- **react-konva 的适用定位**：官方描述是 "canvas editor / whiteboard / design editor"，与本项目"审核预览"不是同一类问题：[konvajs 文档](https://konvajs.org/docs/react/index.html)。

### 2.3 分场景选型建议

| 场景 | 建议 |
| --- | --- |
| 帧预览上的框 + 标签 + hover/click | **SVG + HTML 标签** |
| 缩略图列表（20 行/页）叠加小框 | 可不画；要画就用一个 16:9 的小 canvas 或纯 CSS 小方块，避免 20 个 SVG 树 |
| 带框截图导出 | **OffscreenCanvas 全分辨率重绘**（§6.4） |
| 框编辑（拖角、移动、撤销） | 先手写 SVG 手柄；复杂度上来再 `react-konva` |
| 时间轴 | 纯 DOM/CSS 绝对定位，不需要 canvas（段数 ≤ 几百） |

---

## 3. 坐标映射与缩放公式

### 3.1 三个坐标系，先定义清楚

1. **图像坐标（image space）**：原图像素坐标系，原点左上，单位 px，最大值 `(naturalWidth, naturalHeight)`。
2. **显示坐标（display space）**：预览容器内的 CSS px 坐标，原点在容器左上。
3. **屏幕坐标（client space）**：`PointerEvent.clientX/clientY` 的坐标，原点在视口左上。

**约定：所有落库/传给模型的框坐标一律用"相对图像坐标的归一化 0..1"（`BBox { x, y, w, h }`，x/y 是左上角，w/h 是宽高）。** 这样换分辨率、换缩略图、换导出尺寸都不用改数据；像素坐标只在渲染和导出时临时算。

### 3.2 contain（适配容器）公式

`object-fit: contain` 的几何含义 = SVG `preserveAspectRatio="xMidYMid meet"`：

```
scale = min(containerW / imageW, containerH / imageH)
dispW = imageW * scale
dispH = imageH * scale
dispLeft = (containerW - dispW) / 2   // 左右 letterbox
dispTop  = (containerH - dispH) / 2   // 上下 letterbox
```

屏幕 → 图像（无额外缩放/平移时）：

```
imageX = (clientX - wrapRect.left - dispLeft) / scale
imageY = (clientY - wrapRect.top  - dispTop)  / scale
```

反向：

```
clientX = wrapRect.left + dispLeft + imageX * scale
clientY = wrapRect.top  + dispTop  + imageY * scale
```

> ⚠️ 只有容器和图像等比时 `scale` 才同一个；`object-fit: cover` 是 `max()` 且会裁切，**不要**用它做标注预览（框会被裁掉，且映射公式完全不同）。

### 3.3 可直接使用的 `frameGeometry.ts`

```ts
// src/renderer/src/lib/frameGeometry.ts

export interface Size {
  width: number
  height: number
}

export interface Rect extends Size {
  left: number
  top: number
}

/** 预览的缩放/平移状态。zoom = 1 表示 contain 适配；pan 单位是显示坐标 px。 */
export interface ViewState {
  zoom: number
  panX: number
  panY: number
}

export const IDENTITY_VIEW: ViewState = { zoom: 1, panX: 0, panY: 0 }

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/** object-fit: contain / SVG preserveAspectRatio="xMidYMid meet" 的显示矩形 */
export function computeContainRect(container: Size, image: Size): Rect {
  if (
    container.width <= 0 ||
    container.height <= 0 ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  const scale = Math.min(container.width / image.width, container.height / image.height)
  const width = image.width * scale
  const height = image.height * scale
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height
  }
}

/** 带用户缩放/平移后的图像显示矩形：以容器中心为缩放锚点，pan 直接加在中心偏移上 */
export function imageDisplayRect(container: Size, image: Size, view: ViewState): Rect {
  const base = computeContainRect(container, image)
  const width = base.width * view.zoom
  const height = base.height * view.zoom
  return {
    left: (container.width - width) / 2 + view.panX,
    top: (container.height - height) / 2 + view.panY,
    width,
    height
  }
}

/** 屏幕（client）坐标 → 图像像素坐标；点在图像外返回 null */
export function screenToImage(
  clientX: number,
  clientY: number,
  wrapRect: DOMRect,
  container: Size,
  image: Size,
  view: ViewState
): { x: number; y: number } | null {
  const display = imageDisplayRect(container, image, view)
  const localX = clientX - wrapRect.left
  const localY = clientY - wrapRect.top
  if (
    localX < display.left ||
    localY < display.top ||
    localX > display.left + display.width ||
    localY > display.top + display.height
  ) {
    return null
  }
  const imagePerDisplayX = image.width / display.width
  const imagePerDisplayY = image.height / display.height
  return {
    x: (localX - display.left) * imagePerDisplayX,
    y: (localY - display.top) * imagePerDisplayY
  }
}

/** 图像像素坐标（归一化 0..1 也可以先乘回像素）→ 显示坐标 */
export function imageToDisplay(
  imageX: number,
  imageY: number,
  display: Rect,
  image: Size
): { x: number; y: number } {
  return {
    x: display.left + (imageX / image.width) * display.width,
    y: display.top + (imageY / image.height) * display.height
  }
}

/**
 * 以显示坐标 (px, py) 为锚点缩放：锚点下的图像内容保持不动。
 * factor > 1 放大，< 1 缩小；zoom 限制在 1..8。
 */
export function zoomAtPoint(
  view: ViewState,
  container: Size,
  image: Size,
  factor: number,
  px: number,
  py: number
): ViewState {
  const current = imageDisplayRect(container, image, view)
  if (current.width <= 0 || current.height <= 0) return view

  const nextZoom = clamp(view.zoom * factor, 1, 8)
  const before = imageDisplayRect(container, image, view)
  const u = (px - before.left) / before.width
  const v = (py - before.top) / before.height

  const nextBase = imageDisplayRect(container, image, { zoom: nextZoom, panX: 0, panY: 0 })
  return {
    zoom: nextZoom,
    panX: px - u * nextBase.width - (container.width - nextBase.width) / 2,
    panY: py - v * nextBase.height - (container.height - nextBase.height) / 2
  }
}

/** 归一化 bbox → 图像像素 bbox（导出/像素绘制时用） */
export interface NormalizedBBox {
  x: number
  y: number
  w: number
  h: number
}

export function bboxToPixels(
  bbox: NormalizedBBox,
  image: Size
): { x: number; y: number; w: number; h: number } {
  const x = Math.round(bbox.x * image.width)
  const y = Math.round(bbox.y * image.height)
  const w = Math.max(1, Math.round(bbox.w * image.width))
  const h = Math.max(1, Math.round(bbox.h * image.height))
  return { x, y, w, h }
}
```

### 3.4 容器尺寸 hook（ResizeObserver）

抽屉是弹层，宽度随窗口变化，`max-height: 43vh` 也会变；必须监听容器而不是窗口。React 19 的类型里 `useRef` 必须传初始值，`RefObject<T | null>` 可以直接给 `ref`。

```ts
// src/renderer/src/lib/useElementSize.ts
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Size } from './frameGeometry'

export function useElementSize<T extends HTMLElement>(): {
  ref: RefObject<T | null>
  size: Size
} {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = (): void => {
      const width = element.clientWidth
      const height = element.clientHeight
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { ref, size }
}
```

> 注意：`clientWidth/clientHeight` 是 padding box 尺寸，本项目容器无 padding；若以后加了 padding，改用 `getBoundingClientRect()` 并减 border/padding，或把可绘制区域再包一层。

### 3.5 SVG `viewBox` 零测量方案（可选，适合快速上线）

如果不想写 `computeContainRect`，可以让 `<svg>` 和 `<img>` 占同一个盒子，并让二者用**同一套适配规则**：

```tsx
<div className="frame-viewer">
  <img className="frame-viewer__img" src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
  <svg
    className="frame-viewer__overlay"
    viewBox={`0 0 ${image.width} ${image.height}`}
    preserveAspectRatio="xMidYMid meet"   // 与 object-fit: contain 等价
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
  >
    {boxes.map((box) => (
      <rect
        key={box.id}
        x={box.bbox.x * image.width}
        y={box.bbox.y * image.height}
        width={box.bbox.w * image.width}
        height={box.bbox.h * image.height}
        fill="transparent"
        stroke="#ff3b30"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        pointerEvents="all"
      />
    ))}
  </svg>
</div>
```

原理：`<img>` 的 `object-fit: contain` 和 SVG 的 `xMidYMid meet` 都会把图像按同一比例居中放置，所以两者的 letterbox 完全重合，框直接用图像像素坐标即可。

**代价**：标签文字如果放在 SVG 里会跟着缩放（要额外 `transform` 反向缩放），指针换算要用 `getScreenCTM().inverse()`；做 hover tooltip/省略号/按钮也不如 HTML 方便。因此本报告推荐"主方案"仍是 §3.3 + §4.4 的显示矩形 + HTML 标签。

坐标换算（任何 SVG 场景都适用，比手算可靠）：

```ts
export function clientToSvg(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  const point = svg.createSVGPoint()
  point.x = clientX
  point.y = clientY
  const matrix = svg.getScreenCTM()
  if (!matrix) return null
  const mapped = point.matrixTransform(matrix.inverse())
  return { x: mapped.x, y: mapped.y }
}
```

### 3.6 CSS `transform` 缩放下的坐标换算（容易错的部分）

如果采用 `transform: translate(tx, ty) scale(k)` 作用在舞台元素上：

- **`getBoundingClientRect()` 返回的是变换后的矩形**（宽高已经乘过 `k`）。
- 因此：`contentX = (clientX - rect.left) / k`，`contentY = (clientY - rect.top) / k`，再通过 `content → image` 的 contain 公式换算。
- **不要用 `event.offsetX/offsetY` 做持久逻辑**：它相对事件目标元素，叠加子元素/边框/变换后含义不稳定；统一用 `clientX/clientY` + `getBoundingClientRect()`（或 SVG 的 `getScreenCTM`）。
- 如果 `transform-origin` 不是 `0 0`，`rect.left/top` 仍是对的，但缩放/平移的组合要把 origin 算进去；本项目推荐 **只用 `transform-origin: 0 0` 或干脆不用 CSS transform**，把 zoom/pan 放进状态里按 §3.3 公式算显示矩形，最可控。

### 3.7 `devicePixelRatio`（Retina / Windows 125% 缩放）

**SVG 不需要处理 DPR**（矢量，浏览器自己处理）；只有 canvas 需要：

```ts
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number
): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D 不可用')
  // 之后所有绘制都用 CSS px 坐标，浏览器自动按 DPR 放大
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  return context
}
```

- 屏幕上的小 canvas 必须按上面做，否则在 125%/150% 缩放的 Windows 上会糊。
- **导出图不要用 DPR**：导出是按原图像素 1:1 重绘（§6.4），DPR 只影响"屏幕显示清晰度"，不影响证据图的像素尺寸。
- Electron 里 `devicePixelRatio` 可能随窗口缩放变化；用 `ResizeObserver` + 重新设置 canvas 尺寸（重设 `width/height` 会清空画布，需要重绘）。

### 3.8 旋转视频 / 真实帧尺寸：别用 `task.source.width/height` 做坐标空间

ffmpeg 默认会按视频的旋转元数据（`display matrix`）自动旋转输出帧；`probeVideo()` 从 `ffprobe` 文本解析的 `width×height` 可能是"旋转前"的存储分辨率。手机竖拍视频（1920×1080 + 90° 旋转）抽出来的 PNG 实际是 1080×1920。

**规则：标注坐标空间永远用图片本身的实际像素尺寸，即 `<img>` 的 `naturalWidth/naturalHeight`（或解码后的 `bitmap.width/height`），不要用 `task.source`。** 建议在 `FrameRecord` 上存 `imageWidth/imageHeight`（抽帧时用 `nativeImage` 或 `sharp` 读取），或者渲染时用 `onLoad` 回填。

```tsx
import { useState, type SyntheticEvent } from 'react'
import type { Size } from '../lib/frameGeometry'

/** 用图片自身的 naturalWidth/naturalHeight 作为标注坐标空间（避免旋转/缩放坑） */
export function useImageNaturalSize(): {
  imageSize: Size | null
  onLoad: (event: SyntheticEvent<HTMLImageElement>) => void
  reset: () => void
} {
  const [imageSize, setImageSize] = useState<Size | null>(null)
  const onLoad = (event: SyntheticEvent<HTMLImageElement>): void => {
    const { naturalWidth, naturalHeight } = event.currentTarget
    if (naturalWidth > 0 && naturalHeight > 0) {
      setImageSize({ width: naturalWidth, height: naturalHeight })
    }
  }
  const reset = (): void => setImageSize(null)
  return { imageSize, onLoad, reset }
}

// 用法：<img src={url} onLoad={onLoad} />；切换帧时调用 reset()
```

> 模型侧同理：发给模型的图如果被服务端 resize/letterbox，坐标约定必须以"模型实际看到的图"为准；所以 prompt 里明确"相对整张图片 0..1 归一化"，并在解析层做校验（§4.2）。

---

## 4. 多框渲染与标签排布细节

### 4.1 数据契约（建议直接采用）

```ts
// src/shared/types.ts —— 在现有类型上"增量"扩展，旧任务兼容
export type DetectionReview = 'pending' | 'confirmed' | 'false_positive'
export type DetectionSource = 'model' | 'human'

export interface BBox {
  /** 相对原图宽度的左上角 x，0..1 */
  x: number
  /** 相对原图高度的左上角 y，0..1 */
  y: number
  /** 相对原图宽度的宽度，0..1 */
  w: number
  /** 相对原图高度的宽度，0..1 */
  h: number
}

export interface Detection {
  /** 帧内唯一：`${frame.index}-${i}` 或模型返回的 track_id */
  id: string
  /** 展示/导出的中文名称（与 PROHIBITED_ITEM_MAP 的 label 对齐） */
  label: string
  /** 导出到 COCO/YOLO 的类别 id；渲染时按 label 取色 */
  categoryId: number
  bbox: BBox
  /** 0..1 */
  confidence: number
  source: DetectionSource
  /** 人工审核状态：误报标记 = false_positive */
  review: DetectionReview
}

export interface FrameRecord {
  // ...现有字段保持不变，新增：
  detections?: Detection[]
  /** 帧图片实际像素尺寸（旋转后），用于导出/像素换算 */
  imageWidth?: number
  imageHeight?: number
}
```

**为什么归一化而不是像素**：模型输出更接近"相对位置"；切换预览缩略图/导出分辨率不用转换；COCO/YOLO/CVAT 导出时再乘回原图尺寸。**为什么 `id` 放帧内**：单帧渲染只需要稳定 key；跨帧 track id 由聚合层生成（§5.3），不要和 `Detection.id` 混用。

`applyAnalysis`（`task-manager.ts`）里追加：

```ts
function applyAnalysis(
  frame: FrameRecord,
  analysis: ParsedAnalysis,
  confidenceThreshold: number,
  modelLabel: string
): void {
  // ...现有逻辑不变
  frame.detections = analysis.detections ?? []
}
```

`ParsedAnalysis` 增加 `detections: Detection[]`；单帧和 group 两条路径都经过 `parseAnalysisObject`，所以解析逻辑只需改一处（group 的 `frame_index` 映射已经存在）。

### 4.2 模型 prompt 与解析校验（比渲染更容易出错的地方）

**prompt 追加片段**（`model.ts` 的 `systemPrompt()`：在现有 `return [...]` 数组末尾追加以下字符串）：

```ts
// 直接加在现有 systemPrompt 返回数组的最后几项
'若画面中存在需要检查的违禁物，请额外返回 detections 数组；不存在时返回空数组 []。',
'每个元素格式：{"label":"中文物品名","confidence":0到1的小数,"bbox":[x1,y1,x2,y2]}。',
'bbox 必须使用相对整张图片的归一化坐标：左上角 (0,0)、右下角 (1,1)，不要返回像素、不要使用 0-1000 刻度。',
'x2 必须大于 x1，y2 必须大于 y1；框要紧贴物品可见区域，不要包含大面积背景。',
'最多返回 20 个框；同一物品只返回一个框；无法确定位置时不要编造，把 need_human_review 设为 true。',
'label 只使用上面列出的违禁物名称，不要自创名称。'
```

**解析层校验**（注意：不能只信 prompt，模型经常返回像素坐标或 0–1000 坐标）：

```ts
// clamp01 来自上面的 frameGeometry.ts；image 是帧图片的实际像素尺寸（§3.8）
export type CoordMode = 'normalized' | 'permille' | 'pixel' | 'auto'

export function normalizeDetections(
  value: unknown,
  image: { width: number; height: number },
  labels: string[],
  mode: CoordMode = 'auto',
  maxCount = 20
): Detection[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set(labels)
  const result: Detection[] = []

  for (const [index, item] of value.entries()) {
    if (result.length >= maxCount) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const raw = record.bbox ?? record.box ?? record.xyxy
    if (!Array.isArray(raw) || raw.length !== 4) continue

    const numbers = raw.map((entry) =>
      typeof entry === 'number' ? entry : Number.parseFloat(String(entry))
    )
    if (numbers.some((entry) => !Number.isFinite(entry))) continue

    let [x1, y1, x2, y2] = numbers

    // ---- 坐标单位归一化 ----
    let divisorX = 1
    let divisorY = 1
    const maxAbs = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2))
    const effectiveMode =
      mode === 'auto'
        ? maxAbs <= 1.0001
          ? 'normalized'
          : maxAbs <= 1000.5
            ? 'permille'
            : 'pixel'
        : mode
    if (effectiveMode === 'permille') {
      divisorX = 1000
      divisorY = 1000
    } else if (effectiveMode === 'pixel') {
      divisorX = image.width
      divisorY = image.height
    }

    let nx1 = x1 / divisorX
    let nx2 = x2 / divisorX
    let ny1 = y1 / divisorY
    let ny2 = y2 / divisorY
    if (nx2 < nx1) [nx1, nx2] = [nx2, nx1]
    if (ny2 < ny1) [ny1, ny2] = [ny2, ny1]

    const x = clamp01(nx1)
    const y = clamp01(ny1)
    const w = clamp01(nx2) - x
    const h = clamp01(ny2) - y
    // 丢弃过小/退化的框（约小于原图 0.4% 边长）
    if (w < 0.004 || h < 0.004) continue

    const rawLabel = String(record.label ?? record.category ?? '').trim()
    if (!rawLabel) continue
    const label =
      labels.find((known) => known === rawLabel) ??
      labels.find((known) => rawLabel.includes(known) || known.includes(rawLabel))
    if (!label || (allowed.size > 0 && !allowed.has(label))) continue

    const confidenceRaw = Number(record.confidence ?? record.score ?? 0.5)
    const confidence = Number.isFinite(confidenceRaw) ? clamp01(confidenceRaw) : 0.5

    result.push({
      id: `det-${index}`,
      label,
      categoryId: 0, // 导出前由任务级类别映射补齐
      bbox: { x, y, w, h },
      confidence,
      source: 'model',
      review: 'pending'
    })
  }

  return result
}
```

在 `parseAnalysisObject` 中接入：

```ts
return {
  // ...现有字段
  detections: normalizeDetections(
    value.detections ?? value.boxes ?? value.objects_with_boxes,
    image, // 需要把帧实际尺寸传进 parse 层，或使用 task.source（注意 §3.8）
    configuredLabels,
    config.detectionCoordMode ?? 'auto'
  )
}
```

> `auto` 只是兜底；生产上建议在设置里给"坐标格式"一个选项（normalized / 0-1000 / 像素），或至少记录模型版本与解析结果，便于定位"框整体偏移"的问题。`auto` 对 640×360 图片的像素坐标（≤1000）会误判为 0–1000 刻度——这是已知局限，需要 prompt 强约束 + 抽样验收。

### 4.3 渲染分层与可点击区域

推荐 DOM 结构（`position: relative` 的视口内 4 层）：

```
.frame-viewer                ← 测量容器；overflow: hidden；touch-action: none
├── <img>                    ← 绝对定位，left/top/width/height = 显示矩形；pointer-events: none
├── <svg> 覆盖层              ← inset:0；pointer-events: none（父级）
│   └── <g> per box
│       ├── <rect> 边框      ← fill 透明 + fill="transparent" + pointerEvents="all" 才有命中
│       └── （可选）加粗的选中框
└── .frame-labels            ← HTML 标签层；pointer-events: none
    └── <button> per label   ← pointer-events: auto；可 tooltip/焦点/键盘
```

关键细节：

1. **可点击区域**：SVG 默认 `pointer-events: visiblePainted`，`fill="none"` 或透明填充不会命中；显式写 `fill="transparent"` + `pointerEvents="all"`。如果框太小（< 8px），额外渲染一个 `inflate(rect, 4)` 的透明命中矩形（`fill="transparent"`），视觉框保持原样。
2. **层级**：按面积从大到小绘框（小框后画、盖在大框上，方便点中小目标）；选中框最后画并加外发光/加粗。不要用 z-index 控制 SVG 内部顺序，DOM 顺序即层级。
3. **标签层在 SVG 之上**，标签按钮 `onPointerDown` 必须 `stopPropagation()`，否则会被视口的平移拖拽逻辑吃掉点击。
4. **导航按钮**（现有的左右翻页 `.drawer-nav`）在 `frame-viewer` 之外或设置更高 z-index，避免被标签层挡住。
5. **无障碍**：HTML 标签按钮本身就是可聚焦控件；给 `aria-label` 描述"时间 + 物品 + 置信度"；选中状态用 `aria-pressed`。颜色不能是唯一编码（见 §4.6）。
6. **React 19 提醒**：文件里用 `JSX.Element` 时要 `import type { JSX } from 'react'`（全局 `JSX` 命名空间在 React 19 类型里已移除）；`useRef` 必须给初始值。

### 4.4 `FrameViewer` 组件（可直接落地，约 200 行）

```tsx
// src/renderer/src/components/FrameViewer.tsx
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { Detection } from '@shared/types'
import {
  clamp,
  imageDisplayRect,
  zoomAtPoint,
  type Size,
  type ViewState
} from '../lib/frameGeometry'
import { useElementSize } from '../lib/useElementSize'

const LABEL_FONT =
  '600 12px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
const LABEL_HEIGHT = 20
const LABEL_PAD_X = 6
const LABEL_GAP = 2

const PALETTE = [
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#00c7be',
  '#007aff',
  '#5856d6',
  '#af52de'
]

function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

export function colorForLabel(label: string): string {
  return PALETTE[hashString(label) % PALETTE.length]
}

interface BoxLayout {
  detection: Detection
  x: number
  y: number
  width: number
  height: number
}

interface LabelLayout {
  detection: Detection
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

let textMeasureContext: CanvasRenderingContext2D | null = null

function measureTextWidth(text: string): number {
  if (!textMeasureContext) {
    textMeasureContext = document.createElement('canvas').getContext('2d')
  }
  if (!textMeasureContext) return text.length * 12
  textMeasureContext.font = LABEL_FONT
  return Math.ceil(textMeasureContext.measureText(text).width)
}

function intersects(a: LabelLayout, b: LabelLayout, gap = LABEL_GAP): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  )
}

function placeLabels(
  boxes: BoxLayout[],
  viewport: Size,
  selectedId: string | null
): LabelLayout[] {
  if (viewport.width <= 0 || viewport.height <= 0) return []

  const sorted = [...boxes].sort((a, b) => {
    if (a.detection.id === selectedId) return -1
    if (b.detection.id === selectedId) return 1
    return b.detection.confidence - a.detection.confidence
  })

  const placed: LabelLayout[] = []
  const claimed: LabelLayout[] = []

  for (const box of sorted) {
    const text = `${box.detection.label} ${Math.round(box.detection.confidence * 100)}%`
    const width = Math.min(viewport.width - 4, measureTextWidth(text) + LABEL_PAD_X * 2)
    const height = LABEL_HEIGHT

    // 候选位置：框上方左对齐、上方右对齐、框内左上、框内右上、下方左对齐、下方右对齐
    const candidates: Array<{ x: number; y: number }> = [
      { x: box.x, y: box.y - height - 2 },
      { x: box.x + box.width - width, y: box.y - height - 2 },
      { x: box.x + 2, y: box.y + 2 },
      { x: box.x + box.width - width - 2, y: box.y + 2 },
      { x: box.x, y: box.y + box.height + 2 },
      { x: box.x + box.width - width, y: box.y + box.height + 2 }
    ]

    const maxX = Math.max(2, viewport.width - width - 2)
    const maxY = Math.max(2, viewport.height - height - 2)

    let chosen: LabelLayout | null = null
    for (const candidate of candidates) {
      const layout: LabelLayout = {
        detection: box.detection,
        x: clamp(candidate.x, 2, maxX),
        y: clamp(candidate.y, 2, maxY),
        width,
        height,
        visible: true
      }
      if (!claimed.some((other) => intersects(layout, other))) {
        chosen = layout
        break
      }
    }

    if (!chosen) {
      chosen = {
        detection: box.detection,
        x: clamp(box.x, 2, maxX),
        y: clamp(box.y - height - 2, 2, maxY),
        width,
        height,
        // 碰撞时隐藏标签，但选中项永远显示；完整信息仍可从右侧列表/tooltip 看到
        visible: box.detection.id === selectedId
      }
    }

    placed.push(chosen)
    if (chosen.visible) claimed.push(chosen)
  }

  return placed
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  panX: number
  panY: number
  moved: boolean
}

export interface FrameViewerProps {
  imageUrl: string
  image: Size
  detections: Detection[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onZoomChange?: (zoom: number) => void
}

export function FrameViewer({
  imageUrl,
  image,
  detections,
  selectedId,
  onSelect,
  onZoomChange
}: FrameViewerProps): JSX.Element {
  const { ref, size } = useElementSize<HTMLDivElement>()
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 })
  const dragRef = useRef<DragState | null>(null)

  useEffect(() => {
    setView({ zoom: 1, panX: 0, panY: 0 })
  }, [imageUrl])

  const display = useMemo(
    () => imageDisplayRect(size, image, view),
    [size, image, view]
  )

  const boxes = useMemo<BoxLayout[]>(() => {
    if (display.width <= 0 || display.height <= 0) return []
    return detections.map((detection) => ({
      detection,
      x: display.left + detection.bbox.x * display.width,
      y: display.top + detection.bbox.y * display.height,
      width: detection.bbox.w * display.width,
      height: detection.bbox.h * display.height
    }))
  }, [detections, display])

  // 面积大的先画，小的后画（小框在上层，方便点中）
  const renderBoxes = useMemo(() => {
    const ordered = [...boxes].sort(
      (a, b) => b.width * b.height - a.width * a.height
    )
    const selectedIndex = ordered.findIndex(
      (box) => box.detection.id === selectedId
    )
    if (selectedIndex >= 0) {
      const [selected] = ordered.splice(selectedIndex, 1)
      ordered.push(selected)
    }
    return ordered
  }, [boxes, selectedId])

  const labels = useMemo(
    () => placeLabels(boxes, size, selectedId),
    [boxes, size, selectedId]
  )

  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      setView((current) => zoomAtPoint(current, size, image, factor, px, py))
    },
    [size, image]
  )

  // React 的 onWheel 在部分版本里是 passive，无法 preventDefault；这里用原生监听
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      // deltaMode=1 是"行"，统一折算成像素量级
      const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      const factor = Math.exp(-deltaY * 0.0015)
      zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [ref, zoomAt])

  useEffect(() => {
    onZoomChange?.(view.zoom)
  }, [view.zoom, onZoomChange])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: view.panX,
      panY: view.panY,
      moved: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) > 3) drag.moved = true
    if (!drag.moved) return
    setView((current) => ({
      ...current,
      panX: drag.panX + dx,
      panY: drag.panY + dy
    }))
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // 点击空白（未拖动）清空选中
    if (drag && !drag.moved) onSelect(null)
  }

  return (
    <div
      ref={ref}
      className="frame-viewer"
      style={{ cursor: view.zoom > 1 ? 'grab' : 'default' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={() => setView({ zoom: 1, panX: 0, panY: 0 })}
    >
      <img
        className="frame-viewer__img"
        src={imageUrl}
        alt=""
        draggable={false}
        style={{
          left: display.left,
          top: display.top,
          width: display.width,
          height: display.height
        }}
      />

      <svg className="frame-viewer__overlay" width={size.width} height={size.height}>
        {renderBoxes.map((box) => {
          const color = colorForLabel(box.detection.label)
          const selected = box.detection.id === selectedId
          return (
            <g key={box.detection.id}>
              <rect
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.height}
                fill="transparent"
                stroke={color}
                strokeWidth={selected ? 3 : 2}
                strokeDasharray={
                  box.detection.review === 'pending' &&
                  box.detection.confidence < 0.5
                    ? '6 4'
                    : undefined
                }
                style={{ cursor: 'pointer' }}
                pointerEvents="all"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelect(box.detection.id)
                }}
              />
              {selected ? (
                <rect
                  x={box.x - 2}
                  y={box.y - 2}
                  width={box.width + 4}
                  height={box.height + 4}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={1}
                  pointerEvents="none"
                />
              ) : null}
            </g>
          )
        })}
      </svg>

      <div className="frame-labels">
        {labels.map((label) =>
          label.visible ? (
            <button
              key={label.detection.id}
              type="button"
              className={`frame-label ${
                label.detection.id === selectedId ? 'is-selected' : ''
              }`}
              style={{
                transform: `translate(${label.x}px, ${label.y}px)`,
                width: label.width,
                height: label.height,
                color: colorForLabel(label.detection.label),
                borderColor: colorForLabel(label.detection.label)
              }}
              title={`${label.detection.label} · 置信度 ${Math.round(
                label.detection.confidence * 100
              )}%`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(label.detection.id)
              }}
            >
              {label.detection.label}
            </button>
          ) : null
        )}
      </div>
    </div>
  )
}
```

配套 CSS（加到 `styles.css`）：

```css
.frame-viewer {
  position: relative;
  overflow: hidden;
  background: #111827;
  touch-action: none;
  user-select: none;
}

.frame-viewer__img {
  position: absolute;
  max-width: none;
  max-height: none;
  pointer-events: none;
  -webkit-user-drag: none;
}

.frame-viewer__overlay {
  position: absolute;
  inset: 0;
  pointer-events: none; /* 子元素 rect 显式 pointer-events: all 才能命中 */
  overflow: visible;
}

.frame-labels {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.frame-label {
  position: absolute;
  top: 0;
  left: 0;
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.86);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: auto;
  cursor: pointer;
}

.frame-label.is-selected {
  background: #fff;
  color: #111827 !important;
  border-color: #111827 !important;
}
```

抽屉里的接入方式（替换现有 `.drawer-image-wrap` 内部）：

```tsx
// 在 FrameDrawer 中用这个小组件替换原来的 <img>；imageSize 由 §3.8 的 onLoad 读取后传入
// 需在 TaskDetail.tsx 顶部补充 import：FrameViewer、type Detection、type Size
interface DrawerImageProps {
  imageUrl: string
  imageSize: Size | null
  detections: Detection[]
  imageError: boolean
}

function DrawerImage({
  imageUrl,
  imageSize,
  detections,
  imageError
}: DrawerImageProps): JSX.Element {
  const [selectedDetectionId, setSelectedDetectionId] = useState<string | null>(null)

  if (imageError) return <div className="image-state">图片加载失败</div>
  if (!imageSize) return <div className="image-state">正在读取画面尺寸</div>

  return (
    <FrameViewer
      imageUrl={imageUrl}
      image={imageSize}
      detections={detections}
      selectedId={selectedDetectionId}
      onSelect={setSelectedDetectionId}
    />
  )
}
```

更省事的做法：`FrameViewer` 内部维护 `naturalWidth/naturalHeight`，外部只传 `detections`。但要注意 `FrameViewer` 的显示矩形依赖 `image` 尺寸，先渲染占位、`onLoad` 后再画框，避免首帧错位。

### 4.5 标签排布细节（为什么上面的算法够用）

- **候选位置**：框上方优先（最不挡内容），其次框内/下方；左右两种对齐方式用来处理靠边和遮挡。
- **碰撞检测**：按"选中 > 置信度高"优先级依次放置，`O(n²)`；n ≤ 50 时完全够用（50² = 2500 次矩形相交，微秒级）。真正的标注平台会用模拟退火/贪心（如 d3fc 的 `layoutGreedy`/`layoutRemoveOverlaps`，包体积仅 5.3 KB/2.3 KB gzip，但仍需要 d3-array/d3-scale/d3-selection 三个 peer），本项目没必要引入。
- **放不下时**：隐藏标签而不是叠成一团；但选中项的标签永远显示，且右侧详情面板/框 tooltip 保留完整信息。可再提供"显示全部标签"开关。
- **文本测量**：用离屏 canvas 的 `measureText`，字体必须与 CSS 完全一致（`LABEL_FONT` 常量同时用于 canvas 和 `font`/`font-size`），否则宽度估算偏 10–20%。中文按字体回退（Windows 上是 Microsoft YaHei），`system-ui` 栈里显式带上中文字体更稳。
- **边界**：clamp 到图像显示矩形内，不要超出容器；框贴顶时标签自动改到框内/下方。
- **标签长度**：`label` 来自模型/预设，限制最大 24 个字符并允许 CSS `text-overflow: ellipsis`；不要用 `dangerouslySetInnerHTML`（React 默认转义即可）。

### 4.6 颜色与置信度编码

```ts
export function detectionStroke(detection: Detection): {
  color: string
  opacity: number
  dash?: string
} {
  return {
    color: colorForLabel(detection.label),
    // 置信度越低越淡（0.45 ~ 1）
    opacity: 0.45 + 0.55 * clamp01(detection.confidence),
    // 低置信度用虚线；已确认实线；误报不渲染（或渲染成灰色删除线）
    dash:
      detection.review === 'pending' && detection.confidence < 0.5
        ? '6 4'
        : undefined
  }
}
```

- 颜色按 **label** 哈希到固定调色板，保证同一物品跨帧同色。
- **不要只靠颜色区分异常/待复核**：风险等级用线宽/虚线/角标文字表达；色盲友好可用 Okabe–Ito 调色板（`#D55E00, #0072B2, #009E73, #CC79A7, #E69F00, #56B4E9, #F0E442, #000000`）。
- 框内不要铺半透明色（会遮挡证据画面）；如需要，仅 hover/选中时铺 8%–12% 透明色。

### 4.7 审核员工作流与快捷键（直接决定好不好用）

建议的交互闭环（基于现有 `FrameDrawer` 的 `Escape`/`←`/`→` 扩展）：

| 操作 | 建议键位 | 行为 |
| --- | --- | --- |
| 上一帧 / 下一帧 | `←` / `→` | 保持现有逻辑；切换后重置缩放/选中框 |
| 关闭抽屉 | `Esc` | 保持现有；若正在平移则先取消平移 |
| 选中下一个/上一个框 | `Tab` / `Shift+Tab` 或 `J` / `K` | 在框列表内循环，自动把选中框滚入视野（大图缩放时） |
| 确认本帧（无异常） | `Enter` 或 `N` | 写回 `verdict = normal` + 审核人/时间（新增字段） |
| 标记误报 | `X` | 对选中 detection 设 `review = 'false_positive'`，框变灰/消失，记录日志 |
| 逐框确认 | `Space` | 选中 detection `review = 'confirmed'`（可批量"全部确认"） |
| 放大 / 缩小 / 复位 | `+` / `-` / `0` | 以图像中心为锚点缩放；`0` 复位 |
| 打开时间轴 | `T` | 跳转到"事件"视图 |
| 快速跳帧 | `[` / `]` 或输入时间码 | 跳 ±1s / ±10s |

产品建议：

1. **列表优先**：SVG 框负责"看"，右侧（或抽屉底部）用列表负责"审"——每项显示 label、置信度、时间、复核状态、确认/误报按钮；键盘可在列表里连续操作，比在框上点更高效。
2. **置信度分级**：≥ 0.8 绿色系/实线；0.5–0.8 橙色/实线；< 0.5 红色/虚线 + "建议复核"。
3. **误报沉淀**：`false_positive` 只影响展示与导出，不删除原始模型结果（`rawResponse` 保留），方便回溯/训练数据回流。
4. **批量操作**：时间轴选中一个事件后可"整段确认/整段误报"，但底层仍逐帧写，保持可追溯。
5. **不要自动跳帧**：审核员切换框时视野不要跳，只有点击时间轴段或"定位"按钮才 seek。

---

## 5. 跨帧聚合 / 时间轴设计

### 5.1 现实约束：这是"稀疏采样 + 独立 VLM 判定"，不是连续视频跟踪

本项目每 `intervalSec`（默认按用户配置，常见 1–5s）抽一帧，每帧独立（或小组）请求 VLM。因此：

- 两帧之间可能隔 1–5 秒，目标可能已经移动半屏甚至进出画面——**相邻帧 IoU 可能为 0**，直接拿 IoU > 0.5 做匹配会大量断链。
- 没有连续的检测流，Kalman 滤波/运动模型（SORT/ByteTrack 的核心）没有意义；ByteTrack 的"低分框二次关联"也依赖密集帧。
- 因此 v1 用**轻量关联**：同 label + IoU + 中心距 + 尺寸相似度 + 允许跨 1–2 个采样间隔的 gap 连接；目标是"事件片段"，不是精确轨迹。

**ByteTrack/SORT 只在"能拿到高帧率连续检测"时才值得上**（例如未来接入本地 YOLO 实时检测或对整段视频逐帧推理）。ByteTrack 论文：<https://arxiv.org/abs/2110.06864>；SORT 论文：<https://arxiv.org/abs/1602.00763>。

### 5.2 聚合算法（建议 v1 就用这个）

```
输入：frames（按 index 升序，含 detections）+ intervalMs
1. 逐帧：对每个 detection 尝试匹配"活跃 track"
   - 候选：label 相同、且距上次出现的帧数 ≤ maxGapFrames（默认 2）
   - 相似度 score = 0.5*IoU + 0.3*(1/(1+中心距/平均对角线)) + 0.2*面积比
   - 贪心：所有候选对按 score 降序，依次绑定（每帧/每 track 只用一次）
2. 未匹配的 detection → 新建 track
3. track 内按帧序切段：相邻点帧号差 > maxGapFrames 就断段
4. 段 = { label, startMs, endMs, frameIndices, peakConfidence }
5. 同 label 的段如果时间重叠/相邻（≤ intervalMs），合并
```

> 段边界精度 = ±intervalSec。UI 上要明确标注"基于每 N 秒抽帧推断"，不要伪装成逐帧精确区间。事件时长展示建议用 `start ~ end（约）`。

### 5.3 聚合代码 `tracking.ts`

```ts
// src/renderer/src/lib/tracking.ts
import type { Detection, FrameRecord } from '@shared/types'

export interface DetectionPoint {
  frameIndex: number
  timestampMs: number
  detection: Detection
}

export interface Track {
  id: string
  label: string
  points: DetectionPoint[]
}

export interface ViolationSegment {
  id: string
  label: string
  startMs: number
  endMs: number
  frameIndices: number[]
  peakConfidence: number
}

export interface FrameDetections {
  frameIndex: number
  timestampMs: number
  detections: Detection[]
}

function area(bbox: Detection['bbox']): number {
  return bbox.w * bbox.h
}

export function iou(a: Detection['bbox'], b: Detection['bbox']): number {
  const ax2 = a.x + a.w
  const ay2 = a.y + a.h
  const bx2 = b.x + b.w
  const by2 = b.y + b.h
  const intersectionWidth = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x))
  const intersectionHeight = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y))
  const intersection = intersectionWidth * intersectionHeight
  const union = area(a) + area(b) - intersection
  return union <= 0 ? 0 : intersection / union
}

/** 中心距 / 平均对角线，0 最近 */
function normalizedCenterDistance(a: Detection['bbox'], b: Detection['bbox']): number {
  const acx = a.x + a.w / 2
  const acy = a.y + a.h / 2
  const bcx = b.x + b.w / 2
  const bcy = b.y + b.h / 2
  const averageDiagonal =
    (Math.hypot(a.w, a.h) + Math.hypot(b.w, b.h)) / 2
  if (averageDiagonal <= 0) return Number.POSITIVE_INFINITY
  return Math.hypot(acx - bcx, acy - bcy) / averageDiagonal
}

/** 同一 label 的相似度；不同 label 返回 -1 */
export function detectionSimilarity(a: Detection, b: Detection): number {
  if (a.label !== b.label) return -1
  const overlap = iou(a.bbox, b.bbox)
  const centerScore = 1 / (1 + normalizedCenterDistance(a.bbox, b.bbox))
  const areaScore =
    Math.min(area(a.bbox), area(b.bbox)) / Math.max(area(a.bbox), area(b.bbox))
  return 0.5 * overlap + 0.3 * centerScore + 0.2 * areaScore
}

export interface BuildTracksOptions {
  /** 相似度阈值，稀疏采样建议 0.3–0.4 */
  minScore?: number
  /** 允许跨越的采样帧数（中间短暂漏检仍连上） */
  maxGapFrames?: number
}

export function buildTracks(
  frames: FrameDetections[],
  options: BuildTracksOptions = {}
): Track[] {
  const minScore = options.minScore ?? 0.35
  const maxGapFrames = options.maxGapFrames ?? 2

  const tracks: Track[] = []
  let active: Track[] = []

  for (const frame of frames) {
    const usedDetectionIds = new Set<string>()
    const assignments: Array<{ track: Track; detection: Detection; score: number }> = []

    for (const track of active) {
      const last = track.points[track.points.length - 1]
      if (frame.frameIndex - last.frameIndex > maxGapFrames) continue
      let best: { detection: Detection; score: number } | null = null
      for (const detection of frame.detections) {
        if (usedDetectionIds.has(detection.id)) continue
        const score = detectionSimilarity(last.detection, detection)
        if (score >= minScore && (!best || score > best.score)) {
          best = { detection, score }
        }
      }
      if (best) assignments.push({ track, ...best })
    }

    assignments.sort((a, b) => b.score - a.score)
    for (const { track, detection } of assignments) {
      if (usedDetectionIds.has(detection.id)) continue
      usedDetectionIds.add(detection.id)
      track.points.push({
        frameIndex: frame.frameIndex,
        timestampMs: frame.timestampMs,
        detection
      })
    }

    for (const detection of frame.detections) {
      if (usedDetectionIds.has(detection.id)) continue
      tracks.push({
        id: `track-${tracks.length + 1}`,
        label: detection.label,
        points: [
          {
            frameIndex: frame.frameIndex,
            timestampMs: frame.timestampMs,
            detection
          }
        ]
      })
    }

    active = tracks.filter((track) => {
      const last = track.points[track.points.length - 1]
      return frame.frameIndex - last.frameIndex <= maxGapFrames
    })
  }

  return tracks
}

/** track → 事件片段；相邻采样点帧号差超过 maxGapFrames 就断段 */
export function buildSegments(
  tracks: Track[],
  intervalMs: number,
  maxGapFrames = 2
): ViolationSegment[] {
  const segments: ViolationSegment[] = []

  for (const track of tracks) {
    let current: ViolationSegment | null = null
    let lastFrameIndex = -1

    for (const point of track.points) {
      const segmentEnd = point.timestampMs + intervalMs
      if (
        !current ||
        point.frameIndex - lastFrameIndex > maxGapFrames
      ) {
        current = {
          id: `${track.id}-seg-${segments.length + 1}`,
          label: track.label,
          startMs: point.timestampMs,
          endMs: segmentEnd,
          frameIndices: [point.frameIndex],
          peakConfidence: point.detection.confidence
        }
        segments.push(current)
      } else {
        current.endMs = segmentEnd
        current.frameIndices.push(point.frameIndex)
        current.peakConfidence = Math.max(
          current.peakConfidence,
          point.detection.confidence
        )
      }
      lastFrameIndex = point.frameIndex
    }
  }

  // 同 label、时间相邻（重合或相差 ≤ intervalMs）的段合并
  const merged: ViolationSegment[] = []
  for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.label === segment.label &&
      segment.startMs - previous.endMs <= intervalMs
    ) {
      previous.endMs = Math.max(previous.endMs, segment.endMs)
      previous.frameIndices.push(...segment.frameIndices)
      previous.peakConfidence = Math.max(previous.peakConfidence, segment.peakConfidence)
    } else {
      merged.push({ ...segment, frameIndices: [...segment.frameIndices] })
    }
  }

  return merged
}

/** 从 FrameRecord[] 构造聚合输入（过滤误报/失败帧） */
export function collectFrameDetections(frames: FrameRecord[]): FrameDetections[] {
  return frames
    .filter((frame) => frame.status === 'completed')
    .map((frame) => ({
      frameIndex: frame.index,
      timestampMs: frame.timestampMs,
      detections: (frame.detections ?? []).filter(
        (detection) => detection.review !== 'false_positive'
      )
    }))
    .sort((a, b) => a.frameIndex - b.frameIndex)
}

export function aggregateViolations(frames: FrameRecord[], intervalSec: number): ViolationSegment[] {
  const intervalMs = Math.max(1, intervalSec) * 1000
  const tracks = buildTracks(collectFrameDetections(frames))
  return buildSegments(tracks, intervalMs)
}
```

复杂度：`O(帧数 × 每帧框数 × 活跃 track 数)`，几万帧/几百框也是毫秒级；不需要 Web Worker，`useMemo` 缓存即可。

### 5.4 无框数据的降级聚合（旧任务 / 模型没返回框）

不能因为"没有框"就让时间轴空白。用现有 `frame.categories + verdict` 按 label 聚合连续帧：

```ts
export function buildCategorySegments(
  frames: FrameRecord[],
  intervalMs: number,
  maxGapFrames = 1
): ViolationSegment[] {
  const byLabel = new Map<string, FrameRecord[]>()
  for (const frame of frames) {
    if (frame.verdict !== 'abnormal' && frame.verdict !== 'review') continue
    for (const label of frame.categories) {
      const list = byLabel.get(label) ?? []
      list.push(frame)
      byLabel.set(label, list)
    }
  }

  const segments: ViolationSegment[] = []
  for (const [label, list] of byLabel) {
    list.sort((a, b) => a.index - b.index)
    let current: ViolationSegment | null = null
    let lastIndex = -1
    for (const frame of list) {
      if (current && frame.index - lastIndex <= maxGapFrames) {
        current.endMs = frame.timestampMs + intervalMs
        current.frameIndices.push(frame.index)
        current.peakConfidence = Math.max(current.peakConfidence, frame.confidence ?? 0)
      } else {
        current = {
          id: `category-${label}-${segments.length + 1}`,
          label,
          startMs: frame.timestampMs,
          endMs: frame.timestampMs + intervalMs,
          frameIndices: [frame.index],
          peakConfidence: frame.confidence ?? 0
        }
        segments.push(current)
      }
      lastIndex = frame.index
    }
  }
  return segments.sort((a, b) => a.startMs - b.startMs)
}
```

> UI 上区分"有框聚合"（可点击定位到框）与"无框聚合"（只能定位到帧，标记为"推断区间"）。

### 5.5 时间轴组件骨架

```tsx
// src/renderer/src/components/ViolationTimeline.tsx
import { useMemo, type JSX } from 'react'
import { formatTimeMs } from '@shared/constants'
import type { TaskRecord } from '@shared/types'
import type { ViolationSegment } from '../lib/tracking'

export interface ViolationTimelineProps {
  task: TaskRecord
  segments: ViolationSegment[]
  currentFrameIndex: number
  onSeek: (frameIndex: number) => void
}

export function ViolationTimeline({
  task,
  segments,
  currentFrameIndex,
  onSeek
}: ViolationTimelineProps): JSX.Element {
  const durationMs = Math.max(1, task.source.durationMs)

  const lanes = useMemo(() => {
    const map = new Map<string, ViolationSegment[]>()
    for (const segment of segments) {
      const list = map.get(segment.label) ?? []
      list.push(segment)
      map.set(segment.label, list)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
  }, [segments])

  return (
    <section className="timeline" aria-label="违规事件时间轴">
      <div className="timeline__ruler">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <span key={ratio} style={{ left: `${ratio * 100}%` }}>
            {formatTimeMs(durationMs * ratio)}
          </span>
        ))}
      </div>

      {lanes.length === 0 ? (
        <div className="timeline__empty">未检测到违规事件</div>
      ) : (
        lanes.map(([label, items]) => (
          <div className="timeline__lane" key={label}>
            <span className="timeline__lane-label" title={label}>
              {label}
            </span>
            <div className="timeline__track">
              {items.map((segment) => {
                const active = segment.frameIndices.includes(currentFrameIndex)
                return (
                  <button
                    key={segment.id}
                    type="button"
                    className={`timeline__segment ${active ? 'is-active' : ''}`}
                    style={{
                      left: `${(segment.startMs / durationMs) * 100}%`,
                      width: `${Math.max(
                        0.6,
                        ((segment.endMs - segment.startMs) / durationMs) * 100
                      )}%`
                    }}
                    title={`${label} · ${formatTimeMs(segment.startMs)}–${formatTimeMs(
                      segment.endMs
                    )} · 峰值置信度 ${Math.round(segment.peakConfidence * 100)}%`}
                    onClick={() => onSeek(segment.frameIndices[0])}
                  >
                    {Math.round(segment.peakConfidence * 100)}%
                  </button>
                )
              })}
            </div>
          </div>
        ))
      )}

      <div className="timeline__hint">
        区间由每 {task.config.intervalSec} 秒采样帧推断，边界误差约 ±{task.config.intervalSec}s
      </div>
    </section>
  )
}
```

CSS 骨架：

```css
.timeline { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
.timeline__ruler { position: relative; height: 18px; margin-left: 90px; color: var(--text-3); font-size: 12px; }
.timeline__ruler span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.timeline__lane { display: flex; align-items: center; gap: 10px; }
.timeline__lane-label { width: 80px; flex: 0 0 auto; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timeline__track { position: relative; flex: 1; height: 22px; background: var(--soft); border-radius: 6px; overflow: hidden; }
.timeline__segment { position: absolute; top: 2px; bottom: 2px; border: 0; border-radius: 4px; background: rgba(255, 59, 48, .75); color: #fff; font-size: 11px; cursor: pointer; overflow: hidden; white-space: nowrap; padding: 0 4px; }
.timeline__segment.is-active { background: #ff3b30; box-shadow: 0 0 0 2px rgba(255, 59, 48, .25); }
.timeline__hint { margin-left: 90px; color: var(--text-3); font-size: 12px; }
.timeline__empty { padding: 12px; color: var(--text-3); font-size: 13px; }
```

### 5.6 时间轴交互与精度

- **点击段 → 跳到对应帧**：`onSeek(segment.frameIndices[0])`，`setSelectedIndex`；随后抽屉自动滚动到该帧。
- **当前帧高亮**：`segment.frameIndices.includes(currentFrameIndex)`；若当前帧属于事件但来自"无框聚合"，高亮对应段即可。
- **拖拽 scrub**：只有播放器才需要；本工具没有视频播放，可提供"点击轨道空白处 → 跳到最近帧"：`nearestFrameIndex = frames.reduce(...)`（按 `timestampMs` 就近）。加上键盘 `←/→` 已有。
- **时间轴缩放**：段数少时不需要；若事件很多，给轨道加 `overflow-x: auto` + 内部宽度 `duration / windowMs * 100%`，而不是改 DOM transform。
- **精度文案**：必须展示"±intervalSec 误差"；不要把段边界当精确时间戳（会影响报告可信度）。
- **性能**：段数 < 2000 时纯 DOM 无压力；超过则虚拟化/只渲染视窗内段。
- **联动**：hover 段 → 高亮对应帧列表行；点段 → 抽屉定位 + 选中该段内置信度最高的框。

### 5.7 参考工具的实现思路（可借鉴的抽象）

| 工具 | 关键机制 | 对本项目的启示 | 链接 |
| --- | --- | --- | --- |
| **CVAT** | "Track mode"：一个 track 属于一个物体，只在关键帧画框，其余帧线性插值；导出 XML 用 `<track><box frame=... keyframe=... outside=.../></track>`，视频任务用 `mode=interpolation` | 事件 = track；关键帧 = 有模型结果的采样帧；"outside" 表达进出画面。这正是我们要的"段"语义 | [Track mode](https://docs.cvat.ai/docs/annotation/manual-annotation/modes/track-mode-basics/)、[CVAT 格式文档](https://docs.cvat.ai/docs/dataset_management/formats/format-cvat/) |
| **Label Studio** | `<TimelineLabels>` 在时间轴上标注区间（多标签分类），`<Video frameRate>` 必须正确否则提交的标注会错位；有 LSTM 后端做时序预测 | 时间轴"区间"交互 + 帧率/采样率对齐的坑；可直接参考其"区间条 + 轨道"UI | [TimelineLabels 文档](https://labelstud.io/guide/ml_tutorials/yolo_timeline_labels)、[Video frame classification](https://labelstud.io/templates/video_frame_classification) |
| **FiftyOne** | 视频样本 + 每帧 detection label；标注只打关键帧，插值补齐中间帧；支持按帧抽样/查看 | 数据模型：视频级标签 + 帧级检测；"关键帧 + 插值"同样适用于稀疏采样场景 | [插值术语](https://voxel51.com/glossary/video-annotation-interpolation)、[FiftyOne 文档](https://docs.voxel51.com/user_guide/using_datasets.html) |
| **Ultralytics supervision** | 视频逐帧推理后接 tracker（ByteTrack），`sv.process_video` 输出带 track id 的视频；**注意：`sv.ByteTrack` 已在 supervision 0.31.0 移除，改用外部 `trackers` 包的 `ByteTrackTracker`** | 如果未来接入本地逐帧检测，直接复用其 tracking + annotator 思路；稀疏采样阶段不要上 ByteTrack | [Track Objects 指南](https://supervision.roboflow.com/latest/how_to/track_objects/) |
| **Roboflow** | 云端/边缘推理 + 跟踪 + 数据集导出（COCO/YOLO 等）；Inference 包统一模型输出格式 | 导出格式与"检测结果 → 标准格式"的映射；模型输出统一为 `{x,y,w,h,confidence,class}` | [Roboflow Docs](https://docs.roboflow.com/)、[Inference](https://inference.roboflow.com/) |

---

## 6. 导出与截图方案

### 6.1 标注格式对比（本项目的取舍）

| 格式 | 结构 | 坐标 | 适合 | 本项目建议 |
| --- | --- | --- | --- | --- |
| **COCO JSON** | `images[]`、`annotations[]`、`categories[]`；annotation: `bbox [x,y,w,h]`、`area`、`iscrowd`、`image_id`、`category_id` | **绝对像素，左上角 + 宽高** | 训练/评测、多数工具导入 | **首选通用交换格式** |
| **YOLO txt** | 每图一个 `.txt`，每行 `class cx cy w h`；类名在 `data.yaml`/`classes.txt` | **归一化 0..1，中心点 + 宽高，class 从 0 开始** | 训练 | 需要训练时导出 |
| **LabelMe JSON** | 每图一个 JSON：`shapes[{label, points, shape_type:'rectangle', flags}]`、`imagePath`、`imageHeight/Width` | **像素**，矩形是 `[[x1,y1],[x2,y2]]` 两个对角点 | 手工标注/纠错 | 可选（注意 CVAT 的 "LabelMe" 是 XML，见下） |
| **CVAT XML** | 图像任务：`<image><box xtl ytl xbr ybr label occluded z_order/>`；视频任务：`<track><box frame xtl ytl xbr ybr outside keyframe occluded/></track>` | 像素 | 与 CVAT 往返、人工复核 | 需要交给标注团队时导出 |
| **CSV（已有）** | 现有 `exportTaskCsv` | 时间/判定/说明 | 报告/归档 | 扩展一列 `detections` JSON 或"标注图路径" |

来源：COCO 官方格式 <https://cocodataset.org/#format-data>；YOLO 官方说明 <https://docs.ultralytics.com/datasets/detect/>；CVAT 格式规范 <https://docs.cvat.ai/docs/dataset_management/formats/format-cvat/>；LabelMe 原生 JSON 见 <https://github.com/wkentaro/labelme>（⚠️ CVAT/Datumaro 的 "LabelMe" 导出是每图 XML，不是 labelme 原生 JSON：<https://docs.cvat.ai/docs/dataset_management/formats/format-labelme/>）。

### 6.2 导出代码（COCO / YOLO / LabelMe / CVAT）

```ts
// src/main/export-annotations.ts（放在主进程，方便写文件；类型从 shared 引）
import type { Detection, FrameRecord, TaskRecord } from '@shared/types'

export interface ExportCategory {
  id: number
  name: string
}

function bboxToPixels(
  bbox: Detection['bbox'],
  frame: FrameRecord
): { x: number; y: number; w: number; h: number } {
  const width = frame.imageWidth ?? 0
  const height = frame.imageHeight ?? 0
  return {
    x: Math.round(bbox.x * width),
    y: Math.round(bbox.y * height),
    w: Math.max(1, Math.round(bbox.w * width)),
    h: Math.max(1, Math.round(bbox.h * height))
  }
}

function activeDetections(frame: FrameRecord): Detection[] {
  return (frame.detections ?? []).filter(
    (detection) => detection.review !== 'false_positive'
  )
}

// ---------- COCO ----------
export function buildCoco(
  task: TaskRecord,
  categories: ExportCategory[]
): Record<string, unknown> {
  const images: Array<Record<string, unknown>> = []
  const annotations: Array<Record<string, unknown>> = []
  const categoryIdByName = new Map(categories.map((item) => [item.name, item.id]))
  let annotationId = 1

  for (const frame of task.frames) {
    if (frame.status !== 'completed') continue
    const imageId = frame.index + 1 // COCO 的 id 只需唯一；用 index+1 避免 0
    images.push({
      id: imageId,
      file_name: frame.fileName,
      width: frame.imageWidth ?? task.source.width,
      height: frame.imageHeight ?? task.source.height,
      date_captured: new Date(frame.timestampMs).toISOString()
    })
    for (const detection of activeDetections(frame)) {
      const bbox = bboxToPixels(detection.bbox, frame)
      annotations.push({
        id: annotationId,
        image_id: imageId,
        category_id: categoryIdByName.get(detection.label) ?? 0,
        bbox: [bbox.x, bbox.y, bbox.w, bbox.h],
        area: bbox.w * bbox.h,
        iscrowd: 0,
        // COCO 规范里 GT 没有 score；训练工具一般忽略额外字段，需要时保留
        score: Math.round(detection.confidence * 1000) / 1000
      })
      annotationId += 1
    }
  }

  return {
    info: {
      description: `framelens 审核导出：${task.name}`,
      version: '1.0',
      date_created: new Date().toISOString()
    },
    licenses: [],
    images,
    annotations,
    categories: categories.map((item) => ({
      id: item.id,
      name: item.name,
      supercategory: 'prohibited'
    }))
  }
}

// ---------- YOLO ----------
export function buildYoloLabels(
  task: TaskRecord,
  categories: ExportCategory[]
): Array<{ fileName: string; content: string }> {
  const yoloIndexByName = new Map(categories.map((item) => [item.name, item.id - 1]))
  return task.frames
    .filter((frame) => frame.status === 'completed')
    .map((frame) => {
      const lines = activeDetections(frame).map((detection) => {
        const classIndex = yoloIndexByName.get(detection.label) ?? 0
        const cx = detection.bbox.x + detection.bbox.w / 2
        const cy = detection.bbox.y + detection.bbox.h / 2
        return `${classIndex} ${cx.toFixed(6)} ${cy.toFixed(6)} ${detection.bbox.w.toFixed(
          6
        )} ${detection.bbox.h.toFixed(6)}`
      })
      return {
        fileName: frame.fileName.replace(/\.png$/i, '.txt'),
        content: lines.join('\n')
      }
    })
}

// ---------- LabelMe（原生 JSON） ----------
export function buildLabelMe(frame: FrameRecord): string {
  const width = frame.imageWidth ?? 0
  const height = frame.imageHeight ?? 0
  const shapes = activeDetections(frame).map((detection) => {
    const bbox = bboxToPixels(detection.bbox, frame)
    return {
      label: detection.label,
      points: [
        [bbox.x, bbox.y],
        [bbox.x + bbox.w, bbox.y + bbox.h]
      ],
      group_id: null,
      shape_type: 'rectangle',
      flags: {}
    }
  })
  return JSON.stringify(
    {
      version: '5.0.1',
      flags: {},
      shapes,
      imagePath: frame.fileName,
      imageData: null,
      imageHeight: height,
      imageWidth: width
    },
    null,
    2
  )
}

// ---------- CVAT for video XML（每个采样点都是 keyframe，不做插值声明） ----------
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildCvatVideoXml(
  task: TaskRecord,
  tracks: Array<{ label: string; points: Array<{ frameIndex: number; detection: Detection }> }>
): string {
  const labels = [...new Set(tracks.map((track) => track.label))]
  const labelXml = labels
    .map((label) => `<label><name>${escapeXml(label)}</name><attributes></attributes></label>`)
    .join('')
  const width = task.source.width
  const height = task.source.height

  const trackXml = tracks
    .map((track, index) => {
      const boxes = track.points
        .map((point) => {
          const frame = task.frames[point.frameIndex]
          if (!frame) return ''
          const bbox = bboxToPixels(point.detection.bbox, frame)
          return `<box frame="${point.frameIndex}" xtl="${bbox.x}" ytl="${bbox.y}" xbr="${
            bbox.x + bbox.w
          }" ybr="${bbox.y + bbox.h}" outside="0" occluded="0" keyframe="1"/>`
        })
        .join('')
      return `<track id="${index}" label="${escapeXml(track.label)}" source="auto">${boxes}</track>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="utf-8"?>
<annotations>
  <version>1.1</version>
  <meta>
    <task>
      <id>0</id>
      <name>${escapeXml(task.name)}</name>
      <size>${task.frames.length}</size>
      <mode>interpolation</mode>
      <overlap>0</overlap>
      <flipped>False</flipped>
      <created>${new Date().toISOString()}</created>
      <updated>${new Date().toISOString()}</updated>
      <labels>${labelXml}</labels>
      <original_size><width>${width}</width><height>${height}</height></original_size>
    </task>
  </meta>
${trackXml}
</annotations>`
}
```

> CVAT XML 的 `<meta>` 字段在导入时会被校验；不同 CVAT 版本要求略有差异，生成后务必用目标 CVAT 版本试导入。若只是为了互换，**COCO 或 LabelMe 更稳**。

### 6.3 带框截图：推荐"前端按原图分辨率合成"

两种主流做法：

1. **前端 canvas 合成（推荐）**：渲染进程拿到帧的原始 PNG 字节（IPC 读取，避免自定义协议跨域污染），`createImageBitmap` 解码，按原图像素尺寸画图，再按归一化坐标画框和标签，`convertToBlob` 得到 PNG，回传主进程保存。
   - 优点：WYSIWYG 与页面同一套配色/标签逻辑；分辨率 = 原图；无新依赖；不依赖 ffmpeg 字体与转义。
   - 缺点：大图内存（4K RGBA ≈ 33 MB，可接受）；需要新增 IPC 读帧字节/写图。
2. **主进程 ffmpeg 合成**：`ffmpeg -i frame.png -vf "drawbox=x=..:y=..:w=..:h=..:color=red@0.8:t=3" out.png`。
   - 优点：批量/后台任务方便，已有 ffmpeg 二进制。
   - 缺点：标签文字要 `drawtext`（需要 fontfile、Windows 字体路径、中文转义地狱），多框时 filter 字符串很长；颜色/圆角/背景块难以做到和页面一致。**只建议用于"不要文字、只要框"的批量导出。**

> 补充：不要用 `canvas.toDataURL()` 作为主路径——它返回 base64，体积膨胀约 33%，且编码在主线程同步完成；用 `canvas.toBlob()` / `OffscreenCanvas.convertToBlob()` 直接拿二进制，再走 IPC 传 `Uint8Array` 更省内存、也避免 base64 二次解码。

参考：ffmpeg `drawbox` 滤镜 <https://ffmpeg.org/ffmpeg-filters.html#drawbox>。

### 6.4 合成 PNG 代码（可直接用）

新增 IPC（`src/shared/api.ts` + `src/preload/index.ts` + `src/main/ipc.ts`）：

```ts
// src/shared/api.ts —— 在现有 FramelensApi 接口里追加
export interface FramelensApi {
  // ...现有方法不变
  readFrameBytes(taskId: string, fileName: string): Promise<ArrayBuffer>
  saveAnnotatedPng(taskId: string, frameIndex: number, png: Uint8Array): Promise<ExportResult>
}
```

主进程实现要点：

```ts
// main/ipc.ts —— 读取帧字节（复用现有路径校验逻辑）
ipcMain.handle('frame:readBytes', async (_event, taskId: string, fileName: string) => {
  const framesDir = getFramesDir(taskId)
  const resolved = path.resolve(framesDir, fileName)
  if (!resolved.startsWith(path.resolve(framesDir) + path.sep)) {
    throw new Error('非法文件名')
  }
  const buffer = await fs.promises.readFile(resolved)
  // 注意：ArrayBuffer 可直接通过 structured clone 传输，避免 base64 的 33% 膨胀
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
})

ipcMain.handle(
  'frame:saveAnnotatedPng',
  async (_event, taskId: string, frameIndex: number, png: Uint8Array) => {
    const reportDir = path.join(getTaskDir(taskId), 'report')
    await fs.promises.mkdir(reportDir, { recursive: true })
    const target = path.join(reportDir, `frame-${String(frameIndex).padStart(6, '0')}.png`)
    await fs.promises.writeFile(target, png)
    return { saved: true, path: target }
  }
)
```

渲染进程合成：

```ts
// src/renderer/src/lib/annotatedImage.ts
import type { Detection } from '@shared/types'

export interface ComposeAnnotatedOptions {
  palette?: Record<string, string>
  showLabels?: boolean
  /** 输出缩放：1 = 原图分辨率；0.5 = 一半（报告缩略图） */
  scale?: number
}

function defaultColor(_label: string): string {
  // 与页面 colorForLabel 保持同一实现/同一调色板
  return '#ff3b30'
}

export async function composeAnnotatedPng(
  frameBytes: ArrayBuffer,
  detections: Detection[],
  options: ComposeAnnotatedOptions = {}
): Promise<Blob> {
  const bitmap = await createImageBitmap(new Blob([frameBytes], { type: 'image/png' }))
  try {
    const scale = options.scale ?? 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
    if (!context) throw new Error('Canvas 2D 不可用')

    context.drawImage(bitmap, 0, 0, width, height)

    const strokeWidth = Math.max(2, Math.round(Math.min(width, height) / 480))
    const fontSize = Math.max(12, Math.round(Math.min(width, height) / 60))
    context.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`
    context.textBaseline = 'middle'

    for (const detection of detections) {
      if (detection.review === 'false_positive') continue
      const x = detection.bbox.x * width
      const y = detection.bbox.y * height
      const w = detection.bbox.w * width
      const h = detection.bbox.h * height
      const color = options.palette?.[detection.label] ?? defaultColor(detection.label)

      context.lineWidth = strokeWidth
      context.strokeStyle = color
      context.strokeRect(x, y, w, h)

      if (options.showLabels === false) continue

      const text = `${detection.label} ${Math.round(detection.confidence * 100)}%`
      const padding = Math.round(fontSize * 0.35)
      const textWidth = context.measureText(text).width
      const labelHeight = fontSize + padding * 2
      const labelX = Math.min(Math.max(0, x), Math.max(0, width - textWidth - padding * 2))
      const labelY = y - labelHeight - strokeWidth >= 0 ? y - labelHeight - strokeWidth : y + strokeWidth

      context.fillStyle = 'rgba(15, 23, 42, 0.86)'
      context.fillRect(labelX, labelY, textWidth + padding * 2, labelHeight)
      context.fillStyle = '#ffffff'
      context.fillText(text, labelX + padding, labelY + labelHeight / 2)
    }

    return await canvas.convertToBlob({ type: 'image/png' })
  } finally {
    bitmap.close()
  }
}

/** 触发一次"带框截图"：读字节 → 合成 → 存盘 */
export async function exportAnnotatedFrame(
  taskId: string,
  frameIndex: number,
  fileName: string,
  detections: Detection[]
): Promise<string | undefined> {
  const bytes = await window.framelens.readFrameBytes(taskId, fileName)
  const blob = await composeAnnotatedPng(bytes, detections)
  const png = new Uint8Array(await blob.arrayBuffer())
  const result = await window.framelens.saveAnnotatedPng(taskId, frameIndex, png)
  return result.path
}
```

> 如果之后仍想让页面 `<img>` 直接用于 canvas（而不是 IPC 读字节），需要同时满足：`protocol.registerSchemesAsPrivileged` 里加 `corsEnabled: true` + 响应头 `Access-Control-Allow-Origin` + `<img crossOrigin="anonymous">`。参考 Electron 自定义协议权限结构 <https://www.electronjs.org/docs/latest/api/structures/custom-scheme>、协议处理 <https://www.electronjs.org/docs/latest/api/protocol>，以及 canvas 跨域污染规则 <https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image>。

### 6.5 其他截图方案与取舍

| 方案 | 适用 | 问题 |
| --- | --- | --- |
| **OffscreenCanvas 全分辨率合成（推荐）** | 证据图、报告图 | 需新增读字节 IPC；大图内存；但不跨域、可控 |
| **ffmpeg `drawbox`** | 批量、无标签框 | 标签要 `drawtext`，中文字体/转义麻烦；与页面样式不一致 |
| **Electron `webContents.capturePage`** | 截应用界面（报告封面/操作留痕） | 只能截当前窗口，分辨率受窗口大小限制；把抽屉里的 43vh 预览截下来不是"证据原图"：<https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect> |
| **SVG 导出** | 文档/邮件里嵌矢量框 | 需要把原图 base64 内嵌（文件大）；Word/PDF 兼容性一般 |
| **html2canvas / dom-to-image** | 不想重写绘制 | 新增依赖 + 还原度差（阴影/字体/滚动），不建议 |

### 6.6 报告产物组织建议

```
data/tasks/<taskId>/
├── frames/000001.png            # 原始帧（已有）
├── thumbs/000001.jpg            # 列表缩略图（已有）
├── report/
│   ├── frame-000001.png         # 带框证据图（全分辨率）
│   ├── report.html              # 可选：内嵌图片路径/结论
│   └── annotations.json         # 导出数据（COCO/LabelMe）
```

- 带框截图存 `report/`，通过现有 `vr-media://` 协议扩展 host（或新增 `vr-media://report/...`）在应用内展示；也可以只把路径写进 CSV/HTML。
- 报告内每帧一行：时间码、判定、品类、置信度、框数量、证据图缩略图、审核状态。
- 导出 ZIP 需要额外依赖（Node 无内置 zip）；v1 建议导出到用户选择的目录（`dialog.showOpenDialog({ properties: ['openDirectory'] })`），或沿用现有"另存为单文件"模式先只导出 COCO JSON + CSV。

---

## 7. 坑清单

> 按"会不会真的踩"排序，前 8 条是落地时最容易翻车的。

1. **`vr-media://` 的 canvas 污染**：自定义协议默认 `corsEnabled: false`，且当前 handler 返回的 `net.fetch(file://)` 没有 CORS 头；`drawImage` 后 `toBlob/toDataURL` 会 `SecurityError`。→ 用 IPC 读字节（推荐），或补 `corsEnabled + ACAO + crossOrigin="anonymous"`。参考 [CustomScheme](https://www.electronjs.org/docs/latest/api/structures/custom-scheme)、[CORS-enabled image](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image)。
2. **旋转视频的坐标系**：`task.source.width/height` 可能是旋转前的尺寸，ffmpeg 输出的 PNG 是旋转后的。→ 一律以 `img.naturalWidth/naturalHeight`（或解码 bitmap 尺寸）为标注坐标空间，存 `imageWidth/imageHeight`。
3. **模型坐标约定不统一**：VLM 可能返回像素、0–1000、0–1，甚至带 resize/letterbox 偏移。Qwen3-VL grounding 文档明确使用相对坐标；不同模型/服务版本行为不同，必须 prompt 写死并在解析层做范围校验+丢弃退化框。→ 见 §4.2；抽样用合成图验收。
4. **`object-fit: contain` 与绝对定位叠加错位**：容器有 letterbox，直接按容器宽高百分比放框会整体偏移/拉伸。→ `computeContainRect` 或 SVG `viewBox + meet`。参考 [object-fit](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/object-fit)、[preserveAspectRatio](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/preserveAspectRatio)。
5. **React 19 的 `JSX` 命名空间 / `useRef` 初值**：React 19 的 `@types/react` 移除了全局 `JSX` 命名空间，需要 `import type { JSX } from 'react'`；`useRef<T>()` 必须传初值。现有 `TaskDetail.tsx` 已经这么写了，新组件保持一致。
6. **`react-konva` 版本对齐**：如果最终引入，19.3.x 要求 React/ReactDOM ≥ 19.3.0；`package.json` 的 `^19.0.0` 在重装/降级时可能解析到 19.2 导致 peer 冲突/运行时崩溃。→ 锁 `react@^19.3.0` + `react-konva@~19.3.2`，并参考 [v19.3.0 release notes](https://github.com/konvajs/react-konva/releases/tag/v19.3.0)。
7. **wheel 事件无法 `preventDefault`**：React 的 `onWheel` 在部分场景是 passive；缩放必须用 `addEventListener('wheel', handler, { passive: false })`，否则 Ctrl+wheel 会触发页面/Electron 缩放，标注坐标全乱。触控板 pinch 也走 wheel（`ctrlKey=true`），同样处理。
8. **拖拽与点击冲突**：pointerdown 后移动超过 3px 就算拖拽，pointerup 不应再触发"清空选中"；框/标签按钮要 `stopPropagation`，否则点框变成拖画布。用 `setPointerCapture` 保证移出容器也能收到 pointerup 并释放。
9. **`getBoundingClientRect` 已包含 CSS transform**：按 `(clientX - rect.left) / k` 换算，不要在乘过 transform 的 rect 上再减未缩放偏移；优先用 SVG `getScreenCTM().inverse()`。
10. **DPR**：屏幕 canvas 必须设置 `canvas.width = cssW * dpr` + `ctx.setTransform(dpr,...)`；SVG 不需要。Windows 125%/150% 缩放是常见翻车点。
11. **标签文字被裁切/遮挡**：候选位置 + 边界 clamp；放不下时隐藏但保证选中项可见；字体用 canvas `measureText` 时必须和 CSS 字体完全一致。中文注意字体回退。
12. **低置信度/误报的干扰**：默认按阈值降透明度/虚线，误报 `false_positive` 不参与时间轴聚合与导出；保留原始 `rawResponse` 以便回溯。
13. **采样间隔的语义**：段边界 ±intervalSec；不要展示成精确时间。修改 `intervalSec` 后必须重新计算事件；旧任务的 `detections` 缺失时走降级聚合（§5.4）。
14. **group 模式的 `frame_index`**：`analyzeFrameGroup` 已经按 group 内下标映射；新增 detections 解析时保持同一映射，不要把全视频 index 混进去。
15. **COCO `bbox` 是 `[x, y, w, h]`，不是 `[x1,y1,x2,y2]`**；YOLO 是归一化中心点 + 宽高且 class 从 0 开始；CVAT XML 是 `xtl/ytl/xbr/ybr`。导出前写单测（取一个已知框验证 4 个数字）。
16. **`imageWidth/imageHeight` 为 0**：旧任务/失败帧没有尺寸时，COCO 导出会出 `width:0`；导出前过滤 `status === 'completed'` 且有尺寸的帧，或用 `task.source` 兜底并标注。
17. **报告截图尺寸**：不要直接截抽屉里 43vh 的预览图（分辨率不足、带 UI）；用原图合成。4K 全分辨率 PNG 可能 5–15 MB，报告批量导出要限流/压缩或提供 `scale` 参数。
18. **导出文件写入**：`saveAnnotatedPng` 的 `taskId/fileName` 必须做路径校验（复用 `vr-media` handler 的校验逻辑）；写文件用 `flushSave` 类似的串行化，避免并发写同名文件。
19. **`window.framelens` 的类型**：新增 IPC 后要同步 `src/shared/api.ts`、`src/preload/index.ts`，否则渲染进程 TS 报错；`env.d.ts` 里的全局类型也要检查（现有 `window.framelens` 应来自该文件）。
20. **安全**：`label`/`description` 是模型生成文本，React 默认转义即可；不要 `dangerouslySetInnerHTML`；限制 label 长度（≤24 字符）和 detections 数量（≤20/帧），防止布局/性能异常。
21. **无框时时间轴为空**：旧任务/模型不返回框时，时间轴必须能用 categories 降级（§5.4），否则用户会以为"没有违规"。
22. **性能**：不要为每次 pointermove 创建新数组/重排；`useMemo` 缓存 boxes/labels/segments；平移用 `requestAnimationFrame` 节流；SVG 节点数超过 ~1000 时考虑 canvas 静态层。
23. **一致性**：渲染用的调色板/置信度规则与导出 canvas 必须共用同一函数，否则"页面红色、导出橙色"。
24. **`resize` 观察者循环**：ResizeObserver 回调里改容器尺寸可能导致循环；本项目只改 canvas 内容尺寸，不动布局，问题不大，但仍建议只在数值变化时 setState（§3.4 已做）。
25. **时间轴和帧列表的双向同步**：点在帧列表某一帧时，时间轴高亮对应段；点时间轴段时，抽屉要滚动/定位到对应帧，否则用户会觉得"点了没反应"。

---

## 8. 参考链接

### 渲染/React

- React v19 官方发布说明 — <https://react.dev/blog/2024/12/05/react-19>
- react-konva v19.3.0 发布说明（React 19.3 对齐、升级要求） — <https://github.com/konvajs/react-konva/releases/tag/v19.3.0>
- react-konva npm — <https://www.npmjs.com/package/react-konva>
- react-konva GitHub — <https://github.com/konvajs/react-konva>
- Konva npm（10.9.1） — <https://www.npmjs.com/package/konva>
- Konva GitHub — <https://github.com/konvajs/konva>
- Konva React 文档 — <https://konvajs.org/docs/react/index.html>
- Konva 性能：`listening: false` — <https://konvajs.org/docs/performance/Listening_False.html>
- fabric.js npm — <https://www.npmjs.com/package/fabric>
- fabric.js GitHub — <https://github.com/fabricjs/fabric.js>
- bundlephobia：konva — <https://bundlephobia.com/package/konva@10.9.1>
- bundlephobia：react-konva — <https://bundlephobia.com/package/react-konva@19.3.2>
- bundlephobia：fabric — <https://bundlephobia.com/package/fabric@7.4.0>
- bundlephobia：@d3fc/d3fc-label-layout（标签防碰撞参考） — <https://bundlephobia.com/package/@d3fc/d3fc-label-layout>
- d3fc label layout README — <https://github.com/d3fc/d3fc/blob/master/packages/d3fc-label-layout/README.md>

### 坐标/浏览器基础

- CSS `object-fit`（contain/cover 语义） — <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/object-fit>
- SVG `preserveAspectRatio`（meet/slice） — <https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/preserveAspectRatio>
- SVG `vector-effect`（non-scaling-stroke） — <https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/vector-effect>
- `Element.setPointerCapture()` — <https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture>
- Canvas 跨域污染 / CORS-enabled image — <https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image>
- `devicePixelRatio` — <https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio>
- `ResizeObserver` — <https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver>
- `SVGGraphicsElement.getBBox`（如需精确测量 SVG 文本） — <https://developer.mozilla.org/en-US/docs/Web/API/SVGGraphicsElement/getBBox>

### 时间轴/跟踪/标注工具

- ByteTrack 论文 — <https://arxiv.org/abs/2110.06864>
- SORT 论文 — <https://arxiv.org/abs/1602.00763>
- Ultralytics supervision：Track Objects（含 ByteTrack 现状说明） — <https://supervision.roboflow.com/latest/how_to/track_objects/>
- CVAT Track mode — <https://docs.cvat.ai/docs/annotation/manual-annotation/modes/track-mode-basics/>
- CVAT 数据格式（CVAT for image/video XML 规范） — <https://docs.cvat.ai/docs/dataset_management/formats/format-cvat/>
- Label Studio TimelineLabels 文档 — <https://labelstud.io/guide/ml_tutorials/yolo_timeline_labels>
- Label Studio 视频帧分类模板 — <https://labelstud.io/templates/video_frame_classification>
- FiftyOne 视频标注插值概念 — <https://voxel51.com/glossary/video-annotation-interpolation>
- FiftyOne 数据集文档（视频标签） — <https://docs.voxel51.com/user_guide/using_datasets.html>

### 导出/截图/Electron

- COCO 数据格式 — <https://cocodataset.org/#format-data>
- Ultralytics YOLO 数据集格式（归一化 xywh、class 从 0 起） — <https://docs.ultralytics.com/datasets/detect/>
- LabelMe 仓库 — <https://github.com/wkentaro/labelme>
- CVAT LabelMe 格式说明（注意是 XML） — <https://docs.cvat.ai/docs/dataset_management/formats/format-labelme/>
- Datumaro COCO 格式说明（含 score/is_crowd 等字段） — <https://open-edge-platform.github.io/datumaro/stable/docs/data-formats/formats/coco.html>
- Datumaro LabelMe 格式说明 — <https://open-edge-platform.github.io/datumaro/stable/docs/data-formats/formats/labelme.html>
- ffmpeg `drawbox` 滤镜 — <https://ffmpeg.org/ffmpeg-filters.html#drawbox>
- Electron 自定义协议权限（`corsEnabled` 等） — <https://www.electronjs.org/docs/latest/api/structures/custom-scheme>
- Electron `protocol` 模块 — <https://www.electronjs.org/docs/latest/api/protocol>
- Electron `webContents.capturePage` — <https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect>
- `OffscreenCanvas` — <https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas>

### VLM 坐标约定

- Qwen3-VL 仓库/README（2D grounding 使用相对坐标的 cookbook 说明） — <https://github.com/QwenLM/Qwen3-VL>
- Qwen3-VL 2D grounding cookbook — <https://github.com/QwenLM/Qwen3-VL/blob/main/cookbooks/2d_grounding.ipynb>
- vLLM 论坛：Qwen3-VL 2D grounding 的图像尺寸讨论（说明模型输入 resize 会影响坐标） — <https://discuss.vllm.ai/t/qwen3-vl-2d-grounding/2648>

---

## 附：最小落地顺序（给实现同学的 5 步）

1. **数据契约**：`types.ts` 加 `Detection/BBox` 可选字段；`model.ts` prompt + `normalizeDetections` + `parseAnalysisObject`；`task-manager.applyAnalysis` 写 `detections`。（旧任务自动兼容）
2. **预览叠加**：抽 `frameGeometry.ts` + `useElementSize.ts` + `FrameViewer`；`FrameDrawer` 用一个隐藏 `<img>` 读 natural size 后挂载；先只做"框+标签+hover/click"，不做缩放。
3. **审核交互**：右侧 detection 列表 + 确认/误报（`review` 状态写回，走 IPC），快捷键接现有 keydown。
4. **时间轴**：`tracking.ts` 聚合 + `ViolationTimeline` 组件；先按 label 分轨、点击定位、当前帧高亮；文案标注采样误差。
5. **导出**：先 COCO（一套 JSON）验证坐标正确；再加"带框截图"IPC（读字节 + OffscreenCanvas + 写 `report/`）；YOLO/LabelMe/CVAT 按需补。

> 所有代码片段按"无新依赖、React 19 + TypeScript"编写；接入项目时把 import alias (`@shared`) 换成项目现有配置即可。
