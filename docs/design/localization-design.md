# 违禁物定位标记（Bounding Box）设计方案

> 面向当前 `framelens / 视频智能审核` 0.1.0（Electron 38 + React 19 + TS）的增量设计方案。
> 前置约束：**内网部署、模型可替换（含客户自微调模型）** —— 所有设计都以"不绑定具体模型"为前提。
> 结论：**你的思路可行，且有成熟先例；但要加一层"模型适配层"，并把"判定"和"定位"拆成两段式流水线。**
> **状态：P0 已在当前仓库实现并通过自动化验证（见 §9「P0 实现说明」）。**

> **文档状态**
>
> - 本文写于 **P0 阶段**（违禁物定位标记首次落地），记录的是当时的设计推导、代码事实与验证结果。
> - 文中出现的 `src/main/*.ts`、`src/renderer/src/components/*` 等路径与行号均为**当时结构**；当前仓库已完成模块化重构，代码路径以 `src/` 的当前结构为准（主进程见 `src/main/{app,config,model,localization,task,media}/` 与根级 `index.ts`/`ipc.ts`/`paths.ts`/`logger.ts`；共享层见 `src/shared/`）。
> - 设计结论（两段式判定/定位、探针 + 方言链、分层降级、按需显示框）仍然有效，实现细节与文件位置请以代码为准。
> - §9 为 P0 及后续轮次的实现记录，可作为功能行为的补充说明；引用原始调研见 `docs/archive/research/`。

---

## 0. 结论先行（TL;DR）

1. **"模型输出 4 个坐标 → 应用画框"是可行且标准做法。** 专用检测器（YOLO、Florence-2、Grounding DINO）和 Qwen-VL 系列 grounding 输出的就是这类结构。
2. **硬约束：内网模型可替换 → 必须做"能力自适应"的适配层（本方案最高优先级）。** 调研确认：主流开源 VLM **没有统一的 grounding 协议**——至少 7 种方言（JSON `bbox_2d` / `<box>` / `<ref><box>` / `<|begin_of_box|>` / `<points coords>` / `<loc_n>` / 纯坐标文本）、4 种坐标空间（0–1 / 0–100 / 0–1000 / 绝对像素）、2 种轴序（xyxy / yxyx），且同族换代即变。做法：**两尺寸探针（同一张图发 1120×672 与 560×336，唯一能区分"绝对像素 vs 归一化"的办法）+ ModelProfile 缓存 + 解析方言链 + 配置覆盖**（§2.5、§3.3.4–3.3.7）。同时把请求层、响应层、提示词、检测类别、图片发送参数全部配置化。**否则每换一个客户就要改一次代码。**
3. **但"物品级紧框"在工业界不是审核接口的默认能力，而且 VLM 直接出框并不可靠。** 竞品调研（见 §8）显示：阿里云/腾讯云/AWS/Google/Azure/Hive 的**审核**结果普遍是「时间点 + 命中截图 + 标签 + 评分」，bbox 只出现在它们的**检测/跟踪**能力里；唯一在审核结果里给坐标的网易易盾，也仅限人脸/logo/关键词。学术侧第三方基准 GroundingME 评测 25 个 SOTA 多模态模型，**定位难题最好成绩只有 45.1%，且大多数模型在"无法定位应拒答"上得 0%**（<https://arxiv.org/abs/2512.17495>）。→ **框必须做成分层降级的"辅助线索"，不能当作唯一依据。**
4. **坐标空间是第二难的事**：Qwen2.5-VL 输出的是**模型实际看到的那张（按 28 倍数 resize 后的）图的绝对像素**，Qwen3-VL 才是 `[0,1000]` 归一化，其它模型/微调模型又各不同。→ **发送前统一 resize + 记录发送尺寸 + 探针实测，三层保险（§3.3）。**
5. **不要让同一个请求既做判定又出框。** 推荐两段式：
   - 第 1 段：现有判定逻辑**完全不动**（逐帧/分组都行，纯 JSON，不带坐标）；
   - 第 2 段：只对 `abnormal` / `review` 的帧，单独发"定位请求"，输出多个框。
   - 收益：不破坏已调好的判定准确率；成本只与异常帧数相关；定位可以用不同 prompt / 不同模型；失败可单独重试。
6. **定位分层（L0–L4）**：精框 > 粗框 > 网格高亮 > 九宫格区域文本 > 无位置。每层都记录来源，前端永远标注"这个位置是怎么来的"。VLM 框不可信时自动降级，产品仍然可用、可解释。
7. **多框完全支持**：去重（同类别 IoU 合并）+ 上限（默认 8）+ 置信度排序 + 低置信虚线框。
8. **最能提升"可信度"的三招**（比换模型更划算）：
   - **裁切二次确认**：把框裁出来（外扩 15–20%）再问一次模型"这里是否真的有手机"，通过的才画实线框（论文侧的 Chain-of-Spot / Set-of-Mark 都支持"放大/加标记再问"这条路线）；
   - **跨帧事件聚合**：把连续帧里同一类别的框合并成"事件/片段"，审核从"按帧"升级为"按事件"，时间轴呈现；
   - **九宫格/网格兜底**：VLM 说不准坐标时，退回"区域文本"或"网格命中"，永不空手。
9. **想更强**：可选本地专用检测器（YOLO-World / Grounding DINO / Florence-2）做定位——它天然与模型无关，反而更适合多客户的通用交付；VLM 只做语义判定。
10. **落地顺序**：P0 模型适配层 + 两段式 + 坐标探测 + 粗框/分层兜底（5–7 天）→ P1 裁切二次确认 + 类别别名 + 导出（2–3 天）→ P2 事件聚合 + 时间轴 + 人工确认闭环（3–5 天）→ P3 本地检测器 + 微调（可选）。
11. **一句话**：思路可行，但"画个框"只是起点；真正决定这个功能能不能交付的是**模型适配 + 坐标准确 + 可降级 + 事件化 + 人工可订正**。

---

## 1. 现状梳理（代码事实，供后面方案对齐）

| 环节 | 实现 | 位置 |
| --- | --- | --- |
| 视频探测 | 跑 ffmpeg `-i`，从 stderr 正则解析时长/分辨率 | `src/main/ffmpeg.ts:58-146` |
| 抽帧 | `fps=1/intervalSec,showinfo`，原始分辨率 PNG，文件 `%06d.png` | `src/main/ffmpeg.ts:148-287` |
| 模型调用 | OpenAI 兼容 `/chat/completions`，图片以 data URL 内联 base64，`temperature=0`，`max_tokens=500`（分组时 `max(700, n*350)`） | `src/main/model.ts:90-242` |
| 判定 Prompt | 只要求 `abnormal / risk_level / categories / description / evidence / confidence / need_human_review` | `src/main/model.ts:75-88` |
| 分组 Prompt | 一请求最多 8 帧，要求 `{frames:[{frame_index,...}]}` | `src/main/model.ts:115-148` |
| 解析容错 | 去 ```json 围栏 + 括号平衡找 JSON；字段别名映射、布尔/数值/数组归一化 | `src/main/model.ts:295-445` |
| 并发 | worker pool，并发数默认 2（`DEFAULT_CONCURRENCY`） | `src/main/task-manager.ts:360-466` |
| 结果落盘 | 整任务一个 `task.json`，700ms 防抖 + 临时文件原子 rename | `src/main/task-manager.ts:153-194` |
| 数据模型 | `FrameRecord` 只有 verdict/riskLevel/categories/description/evidence/confidence/rawResponse 等，**无位置字段** | `src/shared/types.ts:34-50` |
| 渲染 | `TaskDetail` 结果表 + `FrameDrawer`（`<img>` + 上一帧/下一帧/ESC） | `src/renderer/src/components/TaskDetail.tsx:431-573` |
| 缩略图 | `nativeImage` 缩到 480px JPEG，经自定义协议 `vr-media://` 提供 | `src/main/index.ts:86-158` |
| 导出 | CSV（序号/时间/判定/类型/说明/证据/置信度/帧文件/错误） | `src/main/task-manager.ts:566-603` |

关键缺口正好是这次要补的：**`FrameRecord` 没有位置字段、prompt 没有坐标要求、请求 token 上限只有 500、分组模式一次最多 8 图。**

---

## 2. 对你设想的逐条评估

### 2.1 "模型分析出问题后，输出 4 个坐标" —— 可行

三点必须注意：

1. **坐标语义必须写死在契约里，而且要先标定。** 不同模型/版本差异很大（详见 §3.3.1）：
   - Qwen2-VL：归一化 `[0,1000)` + `<|box_start|>` 特殊 token；
   - **Qwen2.5-VL（当前内置 `qwen2.5-vl-32b-instruct`）：模型实际输入图的绝对像素**（ViT 前会把宽高 resize 到 28 的倍数），JSON `bbox_2d`；
   - Qwen3-VL：归一化 `[0,1000]`，JSON `bbox_2d`（官方 cookbook 明确 "relative position coordinates"）；
   - Gemini：`box_2d:[ymin,xmin,ymax,xmax]`，**y 在前**，0–1000。

   所以：**不要假设模型"自然知道"用哪种坐标**，在 prompt 里明确写死坐标系；解析层做"标定 + 分支 + 范围自校验"，绝不靠猜。
2. **VLM 出框 ≠ 检测器出框。** 公开数据能说明上限：Qwen2.5-VL-7B 在 RefCOCO 上 `Acc@0.5=86.6`、72B=90.3（**单目标、干净图、IoU 0.5 就算对**，来自第三方论文整理 [arXiv 2512.06373](https://arxiv.org/html/2512.06373v1)）；而 GroundingME 的多难例评测最好只有 45.1%。会议室帧里的多目标、遮挡、小目标、反光会显著更差。所以需要后处理（校验/去重/上限）、裁切二次确认与人工复核兜底。
3. **框的用途是"辅助人工复核"，不是"自动判定"。** UI 与文案要把这点说清楚（现有 README 也写明"结果用于辅助审核，仍需人工复核"）；每个框都要能答"这个位置是怎么来的"（模型/检测器/网格/人工）。

### 2.2 "应用根据坐标渲染标记框" —— 可行，且零依赖

- 当前抽屉里是 `<img class="drawer-image">`（`styles.css:921-932`）。只要外面包一个 `position: relative` 的定位容器，叠一层 SVG（用百分比坐标）即可，**不需要引入 canvas/konva/fabric 任何库**。
- 两种等价写法（容器收缩包裹用百分比 / `viewBox + preserveAspectRatio` 用像素）的取舍见 §3.6。

### 2.3 "一张图多个违禁物 → 多个框" —— 可行

需要的约束：

- **数量上限**：prompt 限 8 个，解析再截断（防模型写 50 个框刷爆 token）；
- **去重**：同类别框 IoU > 0.6 视为重复，保留置信度高的；
- **排序**：按置信度降序，列表与渲染顺序一致；
- **标签排布**：标签默认放框上方，贴顶时自动放框内/下方，避免被裁掉；
- **颜色**：按类别分配色相（手机红、相机橙、录音笔紫……），重叠时也能区分。

### 2.4 六个坑（建议写进验收清单）

| 坑 | 表现 | 对策 |
| --- | --- | --- |
| **坐标空间判断错**（最致命） | 所有框整体等比例缩小/偏移，看着像"模型不会出框" | 发送前 resize 恒等化 + 记录 sentW/sentH + 启动标定 + 范围自校验（§3.3） |
| 推理侧内部二次 resize 不可见 | 框系统性偏移（尤其非 28 倍数/超大图） | 同上；标定结果缓存；`suspicious` 框不显示为实线 |
| 端点顺序错 | `x2<x1`、`y2<y1`，框画不出来 | 解析时交换端点（若单独一个轴反向也交换） |
| 分组请求归属错 | 8 帧一请求，框都算到第 0 帧 | **分组模式不出坐标**；定位单独逐帧发（两段式的核心好处） |
| 输出被截断 | 多框 JSON 到一半被 `max_tokens` 截断 → 整帧解析失败 | 定位请求单独抬高 `max_tokens`；解析失败降级为"未定位"，不拖累帧判定 |
| 旋转视频 | `probeVideo` 的 width/height 是编码分辨率，旋转 90° 后 PNG 是竖的，框坐标全错位 | 以 **PNG 实际尺寸**为准（读文件头或 `nativeImage.getSize()`），前端用图片实际比例 |

### 2.5 硬约束：内网模型可替换 → 必须"能力自适应"，不能按模型名写死

**这是本方案的最高优先级约束。** 交付给不同客户时，模型可能是 Qwen2.5-VL / Qwen3-VL / InternVL / MiniCPM-V / GLM-4.5V / Molmo / Florence-2，也可能是客户自己微调的模型。调研结论：**不存在跨模型统一的 grounding 协议**——至少 **7 种方言**、**4 种坐标空间**（0–1 / 0–100 / 0–1000 / 绝对像素）、**2 种轴序**（xyxy / yxyx），同一族换代就会变（Qwen2.5-VL 绝对像素 → Qwen3-VL 0–1000）。

**结论：不要写 `if (model.includes('qwen2.5'))` 这种分支。** 正确做法是把"模型差异"收敛到 6 个可配置/可探测的适配点：

| 适配层 | 差异来源 | 做法 |
| --- | --- | --- |
| ① **请求层** | 图片字段形态（对象/字符串）、`max_tokens` vs `max_completion_tokens`、是否支持 `response_format`、`image_url.detail` 是否被接受、`chat_template_kwargs`（关思考） | 请求参数全部可配：`extraBody`（JSON 透传）、`maxTokens`、`maxTokensField`、`imageFieldStyle`、`sendImageDetail`；失败自动降级重试 |
| ② **响应层** | 思考字段名不同（vLLM `reasoning`、SGLang/百炼 `reasoning_content`）、content 可能是数组、`choice.text` | 按优先级 `content → reasoning → reasoning_content → text` 读取；统一 `pickContent` |
| ③ **提示词层** | 中文/英文效果不同、多框能力不同、坐标系不同 | Prompt 模板化：语言、坐标规则段落（0–1000/0–100/0–1/像素）、框数上限、场景描述 |
| ④ **解析层（方言链）** | JSON `bbox_2d` / `bbox` / `<box>` / `<ref><box>` / `<\|begin_of_box\|>` / `<points coords>` / `<loc_n>` / 纯文本 | **解析器链 + 中间表示**：先抽原始数字，再统一映射；全部失败 → 降级 L1/L2，绝不抛错拖垮判定 |
| ⑤ **坐标层** | 0–1 / 0–100 / 0–1000 / 绝对像素；xyxy / yxyx；原图 / resize 后图 | **两尺寸探针**自动判定（不是按模型名查表）+ profile 缓存 + 手动覆盖 |
| ⑥ **类别层** | 微调模型用英文名/自定义类目/自造 ID | 自定义检测项 + 别名映射；对不上时保留原始 label 并标 `itemId=null` |

**能力分档（无论换什么模型，产品都要能跑）：**

| 能力 | 强模型 | 普通/微调模型可能的样子 | 应用的降级动作 |
| --- | --- | --- | --- |
| 判定 | JSON 稳定 | 输出带解释文字/```json 围栏/字段名不同 | 现有容错解析 + 深嵌套查找 + 修复重试 |
| JSON | 稳定 | 思考文本混进 content、被截断 | 剥离 `<think>`/`思考` 区块 → 括号平衡 → 修复重试 |
| 坐标 | 多框紧框 | 不出框 / 只给 1 框 / 给 `<box>` token / 尺度不对 / 轴序反了 | 方言链 + 探针；失败 → L2 网格 / L1 区域文本 |
| 多框 | 支持 | 只返回一个框 | 接受单框（L3），UI 标注"模型仅支持单目标定位" |
| 结构化输出 | 支持 `response_format` | 不支持 | prompt 约束 + 解析兜底（不作为前置条件） |
| 多图 | 支持 | 支持但坐标混乱 | 分组只做判定，定位永远单图 |
| 思考模式 | 无 / 可关 | 独立 checkpoint，关不掉 | `stripThinking` 兜底 + 调大 `maxTokens` + 优先选 Instruct 版本 |

**当前代码里与"模型可替换"直接冲突的点（都要改）：**

| 位置 | 现状 | 通用化改法 |
| --- | --- | --- |
| `src/shared/constants.ts:11-22` `PROHIBITED_ITEMS` | 写死 8 类（手机/平板/…） | 支持自定义检测项（id/label/prompt/aliases），并能与模型输出标签做别名匹配；微调模型的类别直接配上 |
| `src/main/model.ts:75-88` `systemPrompt` | 写死"会议室监控视频的合规审核员" | 场景描述、语气、输出契约均可配置（预设可覆盖） |
| `src/main/model.ts:164-170` 请求体 | 固定 `temperature:0`、`max_tokens` | 加 `extraBody`（透传 `chat_template_kwargs`/`repetition_penalty` 等）、可配 `maxTokens`；思考模型需要更大上限 |
| `src/main/model.ts:276-293` `extractResponseContent` | 只读 `choices[0].message.content`/`choice.text` | 兼容 `message.reasoning_content`/`reasoning`、content 数组多类型、多 choices |
| `src/main/model.ts:403-445` 解析 | 只认固定字段别名、只取顶层对象 | 加"递归找对象"、`result/data/output` 包裹层、坐标字段的多种命名 |
| 图片发送（`dataUrlForImage`） | 原分辨率 PNG data URL | 可配长边/格式/质量（JPEG 可显著降体积，兼容更多内网网关） |
| `src/main/settings.ts` | 只有一套模型配置 | 至少支持"多套模型档案 + 导入导出"，方便一个客户一个配置 |

> 这条约束会让 P0 多 1–2 天（适配层 + 探针 + 方言链），但它决定了这个功能"能不能交付到第二个客户"。**先做通用，再谈精度**——否则每换一个模型就要改一次代码。

---

## 3. 推荐方案

### 3.1 总体架构：两段式流水线

```text
probeVideo → extractFrames(原始 PNG)
                         │
                         ▼
        ┌───────────────────────────────────┐
        │ 第 1 段：判定（现状，几乎不改）      │
        │ single / group，纯 JSON，无坐标     │
        │ → FrameRecord.verdict/categories…  │
        └───────────────────────────────────┘
                         │
             abnormal / review 的帧（通常 5%~20%）
                         ▼
        ┌───────────────────────────────────────────────┐
        │ 第 2 段：定位（新增）                          │
        │   ┌─────────────────────────────────────┐     │
        │   │ 模型适配层（模型无关）                │     │
        │   │  ModelProfile：请求参数 / prompt 模板 │     │
        │   │  / 解析方言链 / 坐标空间与标定系数    │     │
        │   └─────────────────────────────────────┘     │
        │ 逐帧单图请求 → objects[]                      │
        │ → FrameRecord.regions[]                       │
        │ （可选）裁切二次确认 → verified                │
        └───────────────────────────────────────────────┘
                         │
                         ▼
              UI：帧预览叠框 + 事件时间轴 + 导出
```

> **适配层是"模型无关"的落点**：判定/定位的业务代码只面向内部统一结构（`ParsedAnalysis` / `ParsedRegion`），所有模型差异都被 `ModelProfile` + 方言解析链吸收；换模型时改配置/重跑探针，不改业务代码。

**为什么这样拆：**

- 判定为 `normal` 的帧没有画框的必要，省掉 80%+ 的定位请求；
- 分组模式（一次 8 图）继续走判定，便宜；定位逐帧发，坐标归属不会错；
- 判定 prompt 保持不变 → 不会因为加坐标要求而让原有准确率回退（这是最大的实际风险）；
- 定位单独失败只影响"框"，不影响"这帧是否异常"的结论；
- 将来可以换定位模型/检测器而不动判定链路。

任务状态机基本不变：`analyzing` 里先跑判定，再跑定位，`phaseMessage` 依次为"正在分析"/"正在定位违禁物"。进度按"判定帧数 + 定位帧数"加权。

#### 定位分层（L0–L4，建议写进产品契约）

既然 VLM 框不可靠，产品就不该"有框才可用"。把定位做成可信度分层，任何一层都能交付价值：

| 层级 | 形态 | 生成方式 | 何时使用 | 前端表现 |
| --- | --- | --- | --- | --- |
| L4 | 精框（多框 + 跟踪） | 专用检测器 / 微调模型 | 长期主力 | 实线框 + 类别 + 置信度 |
| L3 | 粗框（1–3 个） | VLM grounding + 校验 | 异常帧首选（快） | 实线/虚线框 + "模型提示"标记 |
| L2 | 网格高亮 | VLM 返回 4×4/6×6 网格编号 | 框不可信/低置信 | 九宫格热区高亮 |
| L1 | 区域文本 | VLM 九宫格方位（左上/中央/右下…） | 最终兜底 | 缩略图上角标"画面中央" |
| L0 | 无位置 | 模型未返回/校验失败 | 现状 | 只显示文字证据 + "位置待人工确认" |

每条 `RegionRecord` 都带 `level` 与 `locatedBy`，**前端永远显示定位来源**（可解释性 + 证据链）。这套分层有个额外好处：**第一版可以只做 L1+L2，不需要赌 VLM 框的精度**，两三天就能上线"能看到大致位置"，再逐步升级到 L3/L4。

### 3.2 数据契约（`src/shared/types.ts`）

```ts
export type RegionStatus = 'none' | 'pending' | 'ok' | 'partial' | 'failed' | 'unsupported'
export type RegionSource = 'model' | 'verified' | 'manual'
/** 定位可信度分层，见 §3.1 表 */
export type LocateLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
export type LocatedBy = 'vlm' | 'detector' | 'grid' | 'region_text' | 'manual'

/** 归一化框：0..1，原点左上，x 向右、y 向下 */
export type RegionBox = [x1: number, y1: number, x2: number, y2: number]

export interface RegionRecord {
  id: string                // 稳定 id，前端 selectedId 用
  itemId: string | null     // 对应 PROHIBITED_ITEMS 的 id（能对上时）
  category: string          // 中文类别名（手机/相机…）
  box: RegionBox
  confidence: number | null
  /** model=模型原始；verified=裁切二次确认通过；manual=人工订正 */
  source: RegionSource
  /** null=未做二次确认，true/false=确认结论 */
  verified: boolean | null
  /** 坐标校验可疑（越界/比例异常），前端只画虚线并提示 */
  suspicious: boolean
  level: LocateLevel
  locatedBy: LocatedBy
  note: string              // 模型给的 evidence（"画面左下方桌面"）
}

export interface FrameRecord {
  // …现有字段保持不变…
  regions: RegionRecord[]
  regionStatus: RegionStatus
  regionLevel: LocateLevel  // 该帧最终达到的定位层级
  regionModel: string
  regionError: string       // 定位失败原因（不回写 frame.error）
  regionRaw: string         // 定位请求原始返回（证据链，截断 4KB）
}
```

- `TaskRecord` 增加 `frameWidth / frameHeight`（从第一张 PNG 实际尺寸读，解决旋转视频问题）与 `regionCalibration`（坐标空间/探针结论快照，便于排障）；
- `normalizeTask()` 里补默认值：`regions: []`、`regionStatus: 'none'`、`regionLevel: 'L0'`、`regionError: ''` → **旧任务文件可直接打开**（`src/main/task-manager.ts:60-77` 已是这个模式）；
- **归一化存储的额外好处**：历史任务与模型解耦。换模型/换部署后，旧任务里已存的框仍能正确渲染（如果存像素坐标，发送尺寸一变就全废了）；
- `FrameRecord` 每帧多几个框 ≈ 200~500 字节，`task.json` 体积无压力。

### 3.3 坐标与解析：用"探测 + 方言链"适配任意模型（最容易翻车的地方）

**存储**：归一化 0–1 浮点，`[x1,y1,x2,y2]`。
理由：与分辨率解耦（重采样/缩放/裁切都不用改数据）；导出 COCO/YOLO 时乘宽高即可；前端直接 `x * 100 + '%'`。

#### 3.3.1 已知方言参考（不是分支依据，只用于探针的期望值）

下表只是"内网常见模型会输出什么"的参考样本（完整证据见 `docs/archive/research/model-dialects.md`）。**实现上不按这张表写 `if (model === ...)`**——具体用哪种，由 §3.3.6 的探针在运行时测出来，并可被运维手动覆盖。

| 模型族 | 输出语法（示例） | 坐标空间 | 多框 | 备注 |
| --- | --- | --- | --- | --- |
| **Qwen2.5-VL** | JSON `[{"bbox_2d":[341,258,397,360],"label":"motorcyclist"}]` | **模型实际输入图（28 倍数后）绝对像素** | ✅ | 最坑的一代 |
| Qwen3-VL | JSON `[{"bbox_2d":[300,300,600,700],"label":"dog"}]` | `[0,1000]` 归一化 | ✅ | Thinking 是**独立 checkpoint**，不是开关 |
| Qwen2-VL（历史） | `<|box_start|>(x1,y1),(x2,y2)<|box_end|>` | `[0,1000)` | ✅ | 特殊 token 可能被网关过滤 |
| **InternVL 2.5/3/3.5** | `<ref>the woman</ref><box>[[x1,y1,x2,y2]]</box>`（**双中括号**） | `[0,1000]` 归一化 | ✅ | 输入侧 `<box>` 还能做区域提示 |
| **MiniCPM-V 4.5** | 单目标 `<box>x1 y1 x2 y2</box>`；多目标 JSON `[{"name_en","name_zh","box":"x1 y1 x2 y2"}]`（**字符串**） | `[0,1000]` | ✅ | 官方 cookbook 除以 1000 再乘宽高 |
| **GLM-4.5V/4.6V** | `<|begin_of_box|>[[x1,y1,x2,y2],…]<|end_of_box|>`（括号风格 `[]`/`[[]]`/`()`/`<>` 都可能） | 归一化后 ×1000 | ✅ | 有 Thinking Mode 开关；模板随版本变 |
| **Molmo（0924）** | `<point x="12.3" y="45.6" alt="dog">dog</point>` | **`[0,100]`** | 点序列 | 代际差异大 |
| **Molmo2（2026）** | `<points coords="1 123 456 2 234 567">label</points>`（`idx x y` 三元组） | `[0,1000]` | ✅ | 视频用 `<tracks coords="…">` |
| **Florence-2** | `<OD>dog<loc_123><loc_45><loc_456><loc_234>` | 1000 bins 量化 | ✅ | `<loc_*>` 是 special token，普通解码会丢 |
| **Gemini / Gemma 4（参照）** | `{"box_2d":[ymin,xmin,ymax,xmax],"label":"…"}` | `[0,1000]` | ✅ | **y 在前**，需要轴序翻转 |
| 部分自微调 / LFM2-VL 系 | 自定义 JSON，常见 `{"label":"…","bbox":[x1,y1,x2,y2]}` | 可能 `[0,1]` / `[0,1000]` / 像素 | 视训练 | 最大不确定源，必须探针 |
| Gemma 3 / Llama 3.2 Vision / Step-1o | 官方材料**无** bbox 输出协议 | — | — | 只能 prompt 约定 + 探针；探针失败就降级 |

**三种坐标空间 + 两种轴序，必须都覆盖：**

| 维度 | 取值 | 典型来源 |
| --- | --- | --- |
| 坐标空间 | `normalized_1000` / `normalized_100` / `normalized_01` / `absolute_px` | Qwen3-VL 等 / Molmo 0924 / 部分微调 / Qwen2.5-VL |
| 轴序 | `xyxy`（多数）/ `yxyx`（Gemini、Gemma4 的 `box_2d`） | 见上 |
| 字段形态 | 数组 / 空格分隔字符串 / 双中括号嵌套 / 独立字段 | MiniCPM、InternVL、部分微调 |

证据（关键几条）：

- Qwen2.5-VL 技术报告 §2.1.2：*"Unlike traditional approaches that normalize coordinates, our model directly uses the actual dimensions of the input image to represent bounding boxes, points, and other spatial features."*（[arXiv 2502.13923](https://arxiv.org/html/2502.13923v1)）
- 同一报告 §2.1：*"During both training and inference, the height and width of the input images are resized to multiples of 28 before being fed into the ViT."* → **"input image" = 28 倍数化之后的那张图**，所以模型输出的是它实际看到的尺寸下的像素，**不是原始 PNG 的像素**。若直接把 1920×1080 的帧发过去，处理器会把宽高取整到 28 的倍数（如 1932×1092），坐标会系统性差 0.5%~1%（1080p 上约 10px）；分辨率越高、比例越"不整"，偏得越多。
- Qwen3-VL 技术报告 §3.2.4：*"Different from Qwen2.5-VL, we adopt a normalized coordinate system scaled to the range [0,1000] in this version."*（[arXiv 2511.21631](https://arxiv.org/html/2511.21631v1)）
- InternVL 论文 §3.3：`<ref></ref>` 包住目标名，`<box></box>` 里是 `[[x1,y1,x2,y2]]`，坐标 0–1000（[arXiv 2410.16261](https://arxiv.org/html/2410.16261v1)）。
- GLM-V README：*"each value is normalized by the image width (for x) or height (for y) and scaled by 1000"*（[zai-org/GLM-V](https://github.com/zai-org/GLM-V/blob/main/README.md)）。
- Molmo 论文 §4：*"the model outputs points as plain-text coordinates normalized between 0 and 100"*（[arXiv 2409.17146](https://arxiv.org/html/2409.17146v2)）。
- ms-swift 官方文档明确：*"qwen2.5-vl uses absolute coordinates, while qwen2/3-vl and internvl2.5 require bounding box coordinates to be normalized to the thousandth scale"*（[ms-swift Custom-dataset](https://github.com/modelscope/ms-swift/blob/main/docs/source_en/Customization/Custom-dataset.md)）。
- 官方仓库 issue 里维护者给出的两代换算公式与"qwen2.5 用 resize 后像素、qwen3 乘 1000"的建议（[issue #1616](https://github.com/QwenLM/Qwen3-VL/issues/1616)）；以及"内部 resize 不一致导致坐标整体错位"的实例（[issue #1030](https://github.com/QwenLM/Qwen3-VL/issues/1030)）。

> ⚠️ **坐标空间 + 轴序 + 方言三者任一判断错，框就会整体错位/变形/不显示。** 这不是"某几个模型的问题"，而是"任何模型都可能发生"，所以下面四层保险都要做。

#### 3.3.2 四层保险（模型无关的兜底链）

1. **发送前自己统一 resize（恒等化）**：把帧缩放到同时是 28 和 32 整数倍、长边 ≤ 1280 的尺寸（如 `1120×672`、`896×672`），并记录 `sentWidth/sentHeight`。这样 Qwen 系/InternVL 系的预处理都大概率是恒等变换；即使不是，比例也只取决于我们自己的发送尺寸。
2. **prompt 里写清"本次输入图片的尺寸"**：绝对像素版必须告诉模型 `图片宽 W_used、高 H_used`，并要求坐标落在 `[0,W_used]×[0,H_used]`。相对坐标版则明确"0~1000 相对宽高"。
3. **解析用方言链 + 坐标/轴序映射 + 范围自校验**：先认出方言（返回原始数字 + 空间/轴序线索），再按 `ModelProfile` 一次性映射到归一化坐标；越界/比例异常的框标 `suspicious`。
4. **首次使用前跑探针（§3.3.6）**：用"同一张图发两个尺寸"的办法自动区分绝对像素与归一化（这是唯一可靠的办法），并缓存结论；探针失败就降级（区域文本/网格/关闭定位），**绝不因为"这个模型不会出框"让整个功能崩掉**。


#### 3.3.3 坐标工具（`src/main/regions.ts` 新增）

```ts
export type CoordinateSpace = 'normalized_1000' | 'absolute_px'

export interface SentImageInfo {
  /** 实际发送给模型的图片尺寸（模型坐标空间的基准） */
  sentWidth: number
  sentHeight: number
  /** 原始帧尺寸（PNG 实际像素，含旋转后的方向） */
  originWidth: number
  originHeight: number
  space: CoordinateSpace
  /** 启动标定得到的补偿系数，仅当发现服务端还有额外内部 resize 时使用 */
  scaleX?: number
  scaleY?: number
}

/** 发送前缩放到 factor 的整数倍、长边 ≤1280，让服务端 smart_resize 尽量恒等 */
export function resizeForModel(
  width: number,
  height: number,
  factor: 28 | 32
): { width: number; height: number } {
  const maxLongEdge = 1280
  const scale = Math.min(1, maxLongEdge / Math.max(width, height))
  const resizedWidth = Math.max(factor, Math.floor((width * scale) / factor) * factor)
  const resizedHeight = Math.max(factor, Math.floor((height * scale) / factor) * factor)
  return { width: resizedWidth, height: resizedHeight }
}

export interface BoxParseResult {
  box: RegionBox | null
  suspicious: boolean
  reason: string
}

const MIN_AREA = 0.0002 // 约 0.02% 画面，过滤噪声小框
const MAX_AREA = 0.95   // 几乎整屏的框多为幻觉

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function coerceQuad(raw: unknown): number[] | null {
  if (typeof raw === 'string') {
    const numbers = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
    return numbers.length === 4 ? numbers : null
  }
  if (Array.isArray(raw) && raw.length === 4) {
    const numbers = raw.map((value) => Number(value))
    return numbers.every((value) => Number.isFinite(value)) ? numbers : null
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const object = raw as Record<string, unknown>
    const keys = ['x1', 'y1', 'x2', 'y2']
    if (keys.every((key) => key in object)) return keys.map((key) => Number(object[key]))
    // 兼容 {x,y,w,h}
    if (['x', 'y', 'w', 'h'].every((key) => key in object)) {
      const [x, y, w, h] = [object.x, object.y, object.w, object.h].map(Number)
      return [x, y, x + w, y + h]
    }
  }
  return null
}

/** 把模型给的四个数换成归一化框；坐标空间不明/越界时返回 suspicious，宁可无框也不要错框 */
export function parseRegionBox(raw: unknown, info: SentImageInfo): BoxParseResult {
  const quad = coerceQuad(raw)
  if (!quad) return { box: null, suspicious: false, reason: 'not-4-numbers' }
  let [x1, y1, x2, y2] = quad
  const maxRaw = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2))

  if (maxRaw <= 1.05) {
    // 模型直接给了 0..1，直接用
  } else if (info.space === 'normalized_1000') {
    if (maxRaw > 1010 || Math.min(x1, y1, x2, y2) < -1) {
      return { box: null, suspicious: true, reason: 'normalized-out-of-range' }
    }
    x1 /= 1000
    y1 /= 1000
    x2 /= 1000
    y2 /= 1000
  } else {
    // absolute_px：模型坐标相对“实际发送尺寸”，先换算成归一化
    if (!(info.sentWidth > 0) || !(info.sentHeight > 0)) {
      return { box: null, suspicious: true, reason: 'missing-sent-size' }
    }
    if (maxRaw > Math.max(info.sentWidth, info.sentHeight) * 1.2) {
      return { box: null, suspicious: true, reason: 'absolute-out-of-range' }
    }
    const scaleX = info.scaleX ?? 1
    const scaleY = info.scaleY ?? 1
    x1 = (x1 / info.sentWidth) * scaleX
    y1 = (y1 / info.sentHeight) * scaleY
    x2 = (x2 / info.sentWidth) * scaleX
    y2 = (y2 / info.sentHeight) * scaleY
  }

  // 端点顺序容错
  if (x2 < x1) [x1, x2] = [x2, x1]
  if (y2 < y1) [y1, y2] = [y2, y1]

  const box: RegionBox = [clamp01(x1), clamp01(y1), clamp01(x2), clamp01(y2)]
  const width = box[2] - box[0]
  const height = box[3] - box[1]
  if (width <= 0 || height <= 0) return { box: null, suspicious: false, reason: 'empty' }
  const area = width * height
  if (area < MIN_AREA) return { box: null, suspicious: false, reason: 'too-small' }
  if (area > MAX_AREA) return { box: null, suspicious: true, reason: 'too-large' }
  return { box, suspicious: false, reason: 'ok' }
}

export function iou(a: RegionBox, b: RegionBox): number {
  const x1 = Math.max(a[0], b[0])
  const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[2], b[2])
  const y2 = Math.min(a[3], b[3])
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  if (inter <= 0) return 0
  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  return inter / (areaA + areaB - inter)
}
```

#### 3.3.4 ModelProfile：把"模型差异"收敛成一份可缓存、可覆盖、可导出的配置

> 这一段是"内网可换模型"的核心。**业务代码只认 `ModelProfile`，不认模型名。**

```ts
export type CoordinateSpace =
  | 'normalized_1000'  // Qwen3-VL / InternVL / MiniCPM / GLM / Molmo2 / Gemini
  | 'normalized_100'   // Molmo 0924
  | 'normalized_01'    // 部分自微调 / LFM2-VL 类
  | 'absolute_px'      // Qwen2.5-VL（模型实际输入图像素）

export type BoxOrder = 'xyxy' | 'yxyx'   // yxyx: Gemini / Gemma4 的 box_2d（ymin,xmin,ymax,xmax）

export type ParseDialect =
  | 'json_objects'     // {"objects":[{"label":"手机","bbox":[x1,y1,x2,y2]}]}（通用微调/自定义）
  | 'json_bbox_2d'     // [{"bbox_2d":[x1,y1,x2,y2],"label":"手机"}]（Qwen2.5/3 原生）
  | 'json_nested'      // {"result":{"objects":[...]}} 等带包裹层
  | 'box_tokens'       // <|box_start|>(x1,y1),(x2,y2)<|box_end|>（Qwen2-VL）
  | 'ref_box_tokens'   // <ref>手机</ref><box>[[x1,y1,x2,y2]]</box>（InternVL，双中括号）
  | 'minicpm_box'      // <box>x1 y1 x2 y2</box> / JSON box 字符串（MiniCPM-V）
  | 'glm_box'          // <|begin_of_box|>[[...]]<|end_of_box|>（GLM-4.5V）
  | 'molmo_points'     // <points coords="idx x y …">（Molmo2，0-1000）；x1="…" y1="…"（Molmo，0-100）
  | 'loc_bins'         // <loc_123><loc_456>…（Florence-2 系，1000 bins）
  | 'plain_coords'     // 手机: (120,340,260,520) 纯文本
  | 'none'

export interface ModelProfile {
  /** 缓存键：normalize(baseUrl)|model|promptFingerprint */
  id: string
  baseUrl: string
  model: string
  /** 探针结论 */
  jsonOk: boolean
  localizationOk: boolean
  coordinateSpace: CoordinateSpace
  boxOrder: BoxOrder
  parseDialects: ParseDialect[]   // 按优先级，命中后置顶
  /** 探测到的额外缩放（服务端还偷偷 resize 时） */
  scaleX: number
  scaleY: number
  /** 能力与运行时特征 */
  maxBoxes: number
  supportsMultiImage: boolean
  thinkingSeparated: boolean       // reasoning 字段独立返回
  thinkingPollutesContent: boolean // 思考混进 content
  tokenLeak: boolean               // 特殊 token 未被网关过滤
  /** 失效控制：模型/提示词变了就重新探测 */
  probedAt: string
  promptFingerprint: string
}
```

- 存储：`data/model-profiles.json`（一个部署一份，可随预设一起分发）；
- 查找键包含 **prompt 指纹**：改了提示词就自动失效，避免"旧标定配新 prompt"；
- **手动覆盖**：设置页可强制指定 `coordinateSpace` / `boxOrder` / `parseDialects`，给"探针失败但运维知道怎么配"的场景兜底；
- 导入导出 JSON，方便运维在 A 机器标定一次、批量分发到 B/C/D 机器。

#### 3.3.5 解析方言链（模型无关的关键）

**核心原则：解析阶段只"抽数字"，不在这里乘宽高。** 先得到统一中间表示（IR），再按 profile 一次性映射坐标空间/轴序，避免"边解析边换算"导致的错上加错。

```ts
/** 解析 IR：只抽原始四元组，空间/轴序留到映射阶段 */
interface RawBox {
  label: string
  coords: [number, number, number, number]
  /** 解析器能推断出的空间/轴序线索（可选，最终以 profile 为准） */
  spaceHint?: CoordinateSpace
  orderHint?: 'xyxy' | 'yxyx'
  source: 'json' | 'token' | 'loc_bins' | 'text'
  parser: string
  confidence: number
}

type DialectParser = (text: string) => RawBox[]

export function parseGrounding(
  raw: string,
  profile: ModelProfile
): { boxes: RawBox[]; noTarget: boolean } {
  const text = stripThinking(stripFences(raw)) // 思考块/围栏不进主解析
  const parsers = DIALECT_PARSERS            // 见下表
  // 结构化程度从高到低：json → token → molmo → loc_bins → plain
  const order = orderParsers(profile.parseDialects, parsers)

  for (const dialect of order) {
    try {
      const boxes = parsers[dialect](text).slice(0, profile.maxBoxes)
      if (boxes.length === 0) continue
      // 命中必须"可用"：至少一个框能通过坐标校验，否则视为误判，继续下一个
      if (!boxes.some((box) => isValidRawBox(box, profile))) continue
      // 命中即记住（下次置顶），但设置页可重置，避免一次误判永久污染
      profile.parseDialects = [dialect, ...profile.parseDialects.filter((d) => d !== dialect)]
      return { boxes, noTarget: false }
    } catch {
      // 该方言解析失败，继续下一个
    }
  }
  return { boxes: [], noTarget: isRefusal(text) }
}

/** 拒答识别：必须有明确否定词，且全文没有任何数字坐标，才判"无目标" */
function isRefusal(text: string): boolean {
  const hasNegation = /no objects?|there are none|not present|未发现|没有发现|不存在|无目标|无异常/i.test(text)
  const hasQuad = /[\[(]\s*-?\d+(?:\.\d+)?\s*[,\s]\s*-?\d+(?:\.\d+)?\s*[,\s]\s*-?\d+/i.test(text)
  return hasNegation && !hasQuad
}
```

**解析器清单（按自动探测优先级）：**

| 优先级 | 解析器 | 触发特征 | 要点 | 误判风险 |
| --- | --- | --- | --- | --- |
| 1 | `json_multi` | 文本含 `{`/`[` | 括号平衡扫描所有顶层数组/对象；取"含 `label/bbox/bbox_2d/box` 字段的 dict 最多"的数组；兼容 Markdown 围栏、单引号、截断数组、schema 回显 | 把 prompt 示例数组当结果 → 只接受 dict 形 |
| 2 | `box_tokens` | 含 `<box>`、`<|box_start|>`、`<|begin_of_box|>`、`</box>` | 宽松 begin/end 匹配，允许 `[[ ]]`/`( )`/`,`/空格；InternVL 是**双中括号**；MiniCPM 是 `<box>x1 y1 x2 y2</box>`；GLM 是 `<|begin_of_box|>[[…]]<|end_of_box|>` | 缺闭合、括号风格漂移、思考里的"草稿框" |
| 3 | `molmo_points` | 含 `<points`/`<point ` | Molmo2 `<points coords="idx x y idx x y …">`（0–1000）；Molmo 0924 `x1="12.3" y1="45.6"`（0–100） | 首 token 是序号不是坐标；0–100 与 0–1000 混淆 |
| 4 | `loc_bins` | 含 `<loc_`（必须在未过滤 special token 的文本上） | 连续 4 个 `<loc_N>` 成框，`(N+0.5)*尺寸/1000` | 解码时 special token 被丢弃 → 永远匹配不到，误判"无框" |
| 5 | `plain_coords` | 含 `[[x1,y1,x2,y2]]`、`(x1,y1),(x2,y2)`、每行 4 数字 | 限制"一行只取一个框"，避免把叙述数字拼成框 | 尺寸/时间戳/评分被当坐标 |

**坐标映射（二次归一）：**

```ts
export function resolveBox(raw: RawBox, profile: ModelProfile): RegionBox | null {
  const space = raw.spaceHint ?? profile.coordinateSpace
  const order = raw.orderHint ?? profile.boxOrder
  let [x1, y1, x2, y2] = raw.coords
  if (order === 'yxyx') [x1, y1, x2, y2] = [y1, x1, y2, x2]   // Gemini/Gemma 的 box_2d 是 ymin,xmin,ymax,xmax

  const divisor = { normalized_1000: 1000, normalized_100: 100, normalized_01: 1 }[space] ?? 1
  if (space === 'absolute_px') {
    // 绝对像素相对"发送尺寸"，还要乘探针得到的补偿系数
    x1 = (x1 / profile.sentWidth) * profile.scaleX
    y1 = (y1 / profile.sentHeight) * profile.scaleY
    x2 = (x2 / profile.sentWidth) * profile.scaleX
    y2 = (y2 / profile.sentHeight) * profile.scaleY
  } else {
    x1 /= divisor; x2 /= divisor
    y1 /= divisor; y2 /= divisor
  }
  return validateAndClamp([x1, y1, x2, y2])   // 端点排序 / clamp / 面积过滤（§3.3.3）
}
```

**方言链的防误判规则（重要）：**

1. **命中必须"可用"**：解析出的框至少一个能通过坐标校验（面积/越界），全 invalid 视为未命中，继续下一个方言；
2. **方言与坐标空间解耦**：`box_tokens` 出来的数字可能是 0–1000 也可能是像素，仍按 `ModelProfile` 换算；
3. **prompt 优先要 JSON**：JSON 是跨模型最通用的格式；特殊 token 方言只作为"客户模型只能这么输出"的兼容手段；
4. **容错策略照抄成熟做法**：Markdown 围栏、前后散文、截断数组补闭合、单引号、schema 回显过滤、重复框去重——业内没有成熟的通用 bbox 解析库，可参考 LibreYOLO 的纯函数解析思路（Apache-2.0，需评估许可证）；
5. **方言自学习可回滚**：命中即记住，但设置页显示"当前方言 / 坐标空间 / 轴序"并可重置。

#### 3.3.6 探针（模型能力自检，替代"按模型名查表"）

模型一换、或同一个模型换个量化版/推理框架，行为就可能变。**不要相信模型自述，也不要相信模型名，直接测。**

**关键设计：同一张图发两个尺寸。** 这是区分"绝对像素"与"归一化"的唯一可靠办法——只发一张图时，小框坐标可能同时落在 0–1000 和像素范围内，无法区分。

- **R1**：探针图 `1120×672`（同时是 28 和 32 的倍数）→ 定位请求；
- **R2**：同一张图缩到 `560×336`（内容相同）→ 同一 prompt；
- 若 R1 没出框，补一次"只问最明显的红矩形"的 R3（降低难度，区分"不会 grounding"与"prompt 不适配"）；总请求 ≤3 次。

探针图：白底 + 5 个纯色矩形（大/中/小/细长/贴边各一），GT 像素坐标写死；**图上不要写"坐标用 0-1000"之类的提示**，避免诱导模型。

```text
你是图像定位能力自检器。图中有若干彩色矩形。请只返回一个 JSON 数组，不要输出任何解释文字。
每个元素格式：{"label":"red","bbox":[x1,y1,x2,y2]}
坐标请使用你训练时的原生坐标表示，不要做任何换算。
```

**判定算法（自动写 profile）：**

| 结论 | 判定方式 |
| --- | --- |
| 方言 | 哪个解析器命中；R1/R2 命中不一致 → `mixed`，保守取 JSON |
| 坐标空间 | 对每个假设算 meanIoU：`abs_px`（R1≈GT 像素，且 R2≈R1×0.5）；`normalized_*`（R2≈R1）；`yxyx`（交换后 IoU 提升 >0.2 才采纳）；`xywh` 变体同理 |
| 采纳门槛 | 最佳 meanIoU ≥ 0.5 **且**领先次优 ≥ 0.15，否则 `unknown`（不要猜） |
| JSON 稳定性 | R1/R2 都能严格解析且 schema 合法 → `jsonOk=true`；任一失败 → `false` |
| 思考污染 | `reasoning`/`reasoning_content` 非空且 content 合法 → `thinkingSeparated=true`；content 里含 `<think`/大段解释后才出现 JSON → `thinkingPolluted=true` |
| 特殊 token 泄漏 | content 出现 `<\|box_start\|>`/`<\|begin_of_box\|>`/`<loc_` → `tokenLeak=true`（记录，提示网关未过滤） |
| 多框能力 | 返回框数 ≥2 → `multiTarget=true`；只 1 个 → 定位层降为 L3 并提示 |
| 定位能力 | 最佳假设 meanIoU ≥ 0.5 → `localizationOk=true`；否则 `false` 并降级 |

**探针触发时机**：首次启动、切换模型/接口地址、修改定位 prompt 之后（`promptFingerprint` 变化）；设置页提供「重新探测」按钮与结果展示（耗时、方言、坐标空间、轴序、多框能力）。

**探针失败时的产品行为（必须优雅）：**

| 情况 | 行为 |
| --- | --- |
| 探针请求失败（网络/鉴权） | 显示"模型不可用"，判定功能本身也失败（与现状一致） |
| 能判定但 JSON 不稳 | 用现有容错解析；定位关闭 |
| 能判定但不能出框 | `localizationOk=false`：定位功能关闭；UI 提示"当前模型不支持位置输出，可换支持 grounding 的模型或开启区域描述降级" |
| 出框但坐标空间无法判定 | 框标 `suspicious`，只画虚线 + "未标定"角标；同时提示运维手动指定坐标空间 |
| 只出单框 | 接受（L3），UI 标注"模型仅支持单目标定位" |

> 排障顺序很重要：**先排除坐标空间/轴序问题，再评价"模型准不准"**。否则会把系统性错位误判成模型能力不行。

#### 3.3.7 请求层适配（换模型最先踩的坑）

现有 `requestChat()`（`src/main/model.ts:150-242`）需要通用化：

```ts
interface RequestOptions {
  /** 透传到请求体的额外字段：vLLM 的 chat_template_kwargs、repetition_penalty、top_k 等 */
  extraBody?: Record<string, unknown>
  maxTokens?: number
  /** 部分网关只认 max_completion_tokens */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  temperature?: number
  /** 结构化输出（网关支持才生效，失败自动忽略） */
  responseFormat?: 'json_object' | null
}

function buildRequestBody(config: ResolvedModelConfig, messages: ChatMessage[], options: RequestOptions) {
  const field = options.maxTokensField ?? 'max_tokens'
  return {
    model: config.model,
    messages,
    temperature: options.temperature ?? 0,
    [field]: options.maxTokens ?? 500,
    ...(options.responseFormat ? { response_format: { type: options.responseFormat } } : {}),
    ...(options.extraBody ?? {})
  }
}
```

**响应解析也要通用化**（`extractResponseContent`）：

```ts
const choice = data.choices?.[0]
const message = choice?.message
// 字段名各栈不同：vLLM 已把 reasoning_content 改名 reasoning；SGLang / 阿里云百炼仍是 reasoning_content
// 读取顺序：content → reasoning → reasoning_content → choice.text
const content =
  pickContent(message?.content) ||
  pickContent(message?.reasoning) ||
  pickContent(message?.reasoning_content) ||
  choice?.text ||
  ''
```

**部署差异矩阵（调用层必须做"参数降级"，不能假设 OpenAI 一致）：**

| 部署 | data URL | 最大 token 参数 | 思考字段 | 关键坑 |
| --- | --- | --- | --- | --- |
| **vLLM**（0.11+ 支持 Qwen3-VL） | ✅ | `max_completion_tokens` 官方示例；`max_tokens` 也支持 | **`reasoning`**（旧名 `reasoning_content`） | `image_url.detail` **明确不支持**（当前 `buildGroupMessages` 里传了 `detail:'high'`，需要做成可选/自动剥离）；`--reasoning-parser` 不开启则思考混进 content |
| **SGLang** | 未明示（需实测） | 示例用 `max_tokens` | `message.reasoning_content` | `separate_reasoning` 默认 True；关掉会把思考并回 content |
| **Ollama** | ✅ 仅 base64 data URL，**不支持图片 URL**；且示例 `image_url` 是**字符串**形式 | 仅 `max_tokens` | `reasoning_effort` | 标准对象形式可能 400 → 需要"字符串形式重试"降级 |
| **LM Studio** | 未文档化 | 仅 `max_tokens` | 文档分散 | 结构化输出支持 JSON Schema（GGUF/MLX 不同后端） |
| **Xinference** | ✅ | 取决于后端 | 取决于后端 | 多模态默认最多 2 个媒体项（vLLM 后端） |
| **阿里云百炼（兼容模式）** | ✅ | `max_tokens` | `reasoning_content`；`clear_thinking` 控制多轮回传 | 可按 content part 传 `min_pixels/max_pixels/total_pixels`；默认值随模型变（Qwen2.5-VL 图 3136/1003520）；非流式超时 ≥300s |

**工程结论：**

1. **默认发 `max_tokens`**，只有确认网关支持时才叠加 `max_completion_tokens`（Ollama/LM Studio 只认前者）；
2. **`image_url` 先发标准对象 `{url}`**，遇到 400 再降级为字符串形式（Ollama）；
3. **`image_url.detail` 做成可选**（vLLM 不支持；当前代码分组模式固定传 `detail:'high'`，应改成配置/按 profile 决定）；
4. **`response_format` 只做"可选增强"**：不支持就忽略，不能当前置条件；
5. **思考字段按 `reasoning` → `reasoning_content` → content 内 `<think>` 的顺序读取**，并把"思考是否污染 content"写进 profile；
6. 图片一律用 **data URL**，不用 URL（避免服务端外呼、SSRF、超时；vLLM 对 HTTP 图片默认 5s 超时）。

**两个高频配置项：**

- `extraBody: {"chat_template_kwargs": {"enable_thinking": false}}` —— Qwen3 混合模型（非 VL Thinking 独立 checkpoint）可关；但注意：社区反馈（vLLM 论坛 2025-10、vLLM issue #26239/#27118）**Qwen3-VL-Thinking 是独立 checkpoint，chat template 里写死了 `<think>`，`enable_thinking=false` 不一定生效**。所以不能只靠开关，必须同时做**输出侧兜底：`stripThinking()` 剥离 `<think>…</think>` / "思考：" 区块后再解析**；
- 选型建议：内网部署优先用 **Instruct（非 Thinking）版本**——思考模式会让单帧耗时涨 3–10 倍、token 成本翻几倍（Qwen3-VL 官方评测 Thinking 给到 `out_seq_length=40960`），而审核场景要的是"快而稳"，不是长推理；
- `maxTokens` —— 思考模型需要更大预算（判定 1500+，定位 2000+），现在的 500 会把 JSON 截断。


### 3.4 定位 Prompt：模板化（中/英 × 坐标规则段落）

在 `src/main/model.ts` 新增 `buildLocalizeMessages()`，与判定 prompt 分离。**prompt 由"固定骨架 + 可替换段落"拼装**，这样才能适配不同模型：

```ts
interface PromptTemplate {
  language: 'zh' | 'en'
  /** 由 ModelProfile 决定：0-1000 / 0-100 / 0-1 / 绝对像素 */
  coordinateInstruction: 'normalized_1000' | 'normalized_100' | 'normalized_01' | 'absolute_px'
  maxBoxes: number
  /** 场景描述可配：不同客户是会议室/车间/柜台… */
  scene: string
}
```

固定骨架（中文版，归一化坐标；绝对像素版只替换第 2 条坐标规则与示例）：

```text
你是一名视觉定位助手。你的唯一任务是：在给定的一张{场景}画面中，找出指定物品，并输出每个物品的外接矩形框。

坐标规则（必须严格遵守）：
1. 以图片左上角为原点，x 轴向右，y 轴向下。
2. 使用归一化坐标：取值 0~1000 的整数，x 相对图片宽度、y 相对图片高度。
3. 每个框写成 [x1, y1, x2, y2]，(x1,y1) 是左上角，(x2,y2) 是右下角，且 x1<x2、y1<y2。
4. 不要输出像素值，不要输出 0~1 的小数。

标注规则：
1. 只标注图片中清晰可见、可确认的实体物品；同一物品只标注一次。
2. 文字、屏幕里的画面、海报图案、镜面反射、倒影都不是实体物品，不要标注。
3. 框要贴近物品外边缘，不要框住大片背景；物品被明显遮挡时只框可见部分。
4. 最多输出 {N} 个框，按置信度从高到低排列。
5. 如果图片中没有目标物品，返回 {"objects": []}；找不到时禁止猜测位置。

只输出一个合法的 JSON 对象，不要使用 Markdown 代码块，不要添加任何解释文字。
JSON 结构：
{"objects":[{"category":"手机","box":[120,340,260,520],"confidence":0.86,"evidence":"画面左下方桌面上"}]}
```

**绝对像素版的第 2 条**（运行时时把 `{W}`/`{H}` 换成真实发送尺寸）：

```text
2. 使用像素坐标：[x1, y1, x2, y2]，单位是像素，坐标范围必须在 0 ≤ x ≤ {W}、0 ≤ y ≤ {H} 之内（即本次输入图片的宽 {W}、高 {H}）。
3. 不要输出归一化小数，不要输出百分比。
```

**英文版**（部分国际/微调模型在英文 prompt 下更稳）由同一骨架翻译，字段名保持一致，便于方言链解析。

**user：**

```text
这是视频 {HH:MM:SS} 处的一帧。请定位以下物品：{手机、相机、录音设备…}。只输出 JSON。
```

要点说明：

- 明确列出"禁止猜测"——这是压误框最有效的一句话；
- 给出完整示例 JSON——比描述格式更稳；
- 明确 `x1<x2` 与"右下角"语义——模型经常把顺序搞反；
- 绝对像素版必须把"本次输入图片的真实宽高"写进 prompt（否则模型只能猜）；
- 让模型自述 `coordinate_space` 可以，但**不要信模型自述的坐标空间**，以探针结果为准；
- **框数上限 N 跟着 `ModelProfile.maxBoxes` 走**：探针发现只肯给 1 个框的模型，N 就设 1，避免它"为了凑数硬编"；
- `max_tokens`：`Math.max(700, 180 * 物品数 + 300)`（思考模型再 ×3），默认 500 一定不够；
- **prompt 指纹**（模板 + 语言 + N）参与 `ModelProfile` 的缓存键：改 prompt 自动触发重新探测。


### 3.5 裁切二次确认（crop-and-verify）—— 性价比最高的提质手段

主进程已有 `nativeImage`，裁图零依赖（`nativeImage.crop()`）：

```ts
// src/main/regions.ts（新增）
function cropRegion(framePath: string, box: RegionBox, padding = 0.18): Buffer | null {
  const image = nativeImage.createFromPath(framePath)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const boxWidth = (box[2] - box[0]) * width
  const boxHeight = (box[3] - box[1]) * height
  const padX = boxWidth * padding
  const padY = boxHeight * padding
  const x = Math.max(0, Math.floor(box[0] * width - padX))
  const y = Math.max(0, Math.floor(box[1] * height - padY))
  const right = Math.min(width, Math.ceil(box[2] * width + padX))
  const bottom = Math.min(height, Math.ceil(box[3] * height + padY))
  if (right - x < 16 || bottom - y < 16) return null
  return image.crop({ x, y, width: right - x, height: bottom - y }).toJPEG(88)
}
```

**确认请求**（同一模型即可，图片很小、很快）：

```text
这是从一张视频画面中裁出的局部图片。请只回答：图中是否清晰可见「{category}」？
只输出 JSON：{"present":true,"confidence":0.9,"reason":""}
仅当能明确看到该物品的整体轮廓或关键特征时才判定 true；看不清、只有相似形状或屏幕/照片中的影像都判 false。
```

判定规则：

- `present === true` 且 `confidence >= 0.6` → `verified = true`，UI 实线框；
- `present === false` 且 `confidence >= 0.7` → `verified = false`，UI 虚线框 + 标"存疑"，默认折叠；
- 其他情况 → `verified = null`，正常显示。

成本：只对异常帧执行，每框一次小图请求；异常帧通常 5%~20%，相当于总请求数 +5%~20%，但**误框率显著下降**，审核员信任度更高。

**进阶（P2）裁切精修**：把外扩后的裁切图再发一次"在这张局部图里定位该物品"，用返回的框反算回全图（`fullX = cropX + boxX * cropW`）。模型在放大图上定位更准，能修掉"框大一圈/偏一半"的问题。

### 3.6 前端渲染：原生 SVG + HTML 标签（零新增依赖）

**选型结论：不要引入 konva / fabric / canvas。** 理由（版本与体积已核实）：

- 每帧 0–10 个框、极端 20–50 个，SVG 的 DOM 节点是几十个，canvas 的性能优势在本场景≈0；
- `react-konva@19.3.2` + `konva@10.9.1` ≈ **101 KB gzip**，且 19.3.x 要求 `react/react-dom ≥ 19.3.0`（本项目 lock 到 19.3.1 能用，但 `package.json` 的 `^19.0.0` 一旦解析到 19.2 会踩 peer 约束）；`fabric@7.4.0` ≈ **91.9 KB gzip**；原生 SVG/Canvas **0 KB**；
- hover/click/键盘焦点/`title` tooltip/无障碍全部是浏览器原生能力；
- 矢量在缩放与 Retina 下始终清晰，不需要处理 `devicePixelRatio`；
- 未来要"拖拽改框"时，再单独引入 konva 只做编辑模式，只读预览继续用 SVG。

**实现上有两种等价写法，选一种即可：**

| 写法 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. 容器收缩包裹**（本文推荐，零测量） | `.frame-stage` 收缩到图片显示尺寸，SVG/标签用 **百分比** 定位 | 不需要任何测量/公式；标签直接 `left/top: %` | 依赖 CSS 收缩包裹，极端布局下要调一点样式 |
| B. contain 显示矩形 + `viewBox` | `<img object-fit:contain>` + `<svg viewBox="0 0 W H" preserveAspectRatio="xMidYMid meet">`，框用图像像素坐标 | 与 `object-fit` 语义严格等价；无需知道容器尺寸 | 标签文字要反向缩放，指针换算要用 `getScreenCTM()` |

两种的本质相同：**把"图像显示矩形"当作叠加层的坐标系**。A 方案的 DOM 结构：

```tsx
<div className="frame-viewport">
  <div className="frame-stage">
    <img
      className={`frame-stage-image ${imageLoaded ? 'is-loaded' : ''}`}
      src={frameImageUrl(task.id, frame.fileName, false)}
      onLoad={(event) => {
        // 关键：标注坐标空间以图片实际尺寸为准（ffmpeg 会自动按旋转元数据转帧）
        setNaturalSize({
          width: event.currentTarget.naturalWidth,
          height: event.currentTarget.naturalHeight
        })
      }}
      alt=""
    />
    {regions.length > 0 ? (
      <>
        <svg className="region-layer" aria-hidden="true">
          {regions.map((region) => (
            <rect
              key={region.id}
              className={[
                'region-rect',
                region.source === 'verified' ? 'is-verified' : '',
                region.verified === false ? 'is-doubtful' : '',
                region.id === activeRegionId ? 'is-active' : ''
              ].join(' ')}
              x={`${region.box[0] * 100}%`}
              y={`${region.box[1] * 100}%`}
              width={`${(region.box[2] - region.box[0]) * 100}%`}
              height={`${(region.box[3] - region.box[1]) * 100}%`}
              vectorEffect="non-scaling-stroke"
              onClick={() => setActiveRegionId(region.id)}
            />
          ))}
        </svg>
        {regions.map((region) => (
          <span
            key={`${region.id}-label`}
            className="region-label"
            style={{
              left: `${region.box[0] * 100}%`,
              top: `${region.box[1] * 100}%`,
              // 贴顶时把标签翻到框内，避免被容器裁掉
              transform: region.box[1] < 0.06 ? 'translateY(0)' : 'translateY(-100%)'
            }}
          >
            {region.category}
          </span>
        ))}
      </>
    ) : null}
  </div>
</div>
```

**CSS 关键点：**

```css
.frame-viewport { position: relative; display: flex; align-items: center; justify-content: center;
  max-height: 43vh; overflow: hidden; background: var(--soft); }
.frame-stage { position: relative; display: block; width: fit-content; line-height: 0; }
.frame-stage-image { display: block; max-width: 100%; max-height: 43vh; width: auto; height: auto;
  object-fit: contain; opacity: 0; transition: opacity .2s ease; }
.frame-stage-image.is-loaded { opacity: 1; }
.region-layer { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.region-rect { fill: rgba(255, 77, 79, .08); stroke: #ff4d4f; stroke-width: 2; cursor: pointer;
  vector-effect: non-scaling-stroke; transition: fill .15s ease; }
.region-rect.is-verified { stroke: #d4380d; fill: rgba(212, 56, 13, .12); }
.region-rect.is-doubtful { stroke-dasharray: 6 4; opacity: .55; }
.region-rect.is-active { stroke-width: 3; fill: rgba(255, 77, 79, .2); }
.region-label { position: absolute; padding: 1px 6px; border-radius: 4px; background: rgba(31,35,41,.82);
  color: #fff; font-size: 12px; line-height: 18px; white-space: nowrap; pointer-events: none;
  transform: translateY(-100%); }
```

> **为什么标签用 HTML 而不是 SVG `<text>`？** SVG 文本会随 `viewBox` 缩放，字号/描边要反向换算；HTML 标签永远是正常排版，还能用省略号/tooltip/按钮语义。
>
> **为什么不用 canvas？** 只有"单帧框数长期 >300–500"或"批量渲染几十帧缩略图都叠框"时才值得换 canvas；本项目不是。

**交互：**

- 框 hover：`opacity` 提升 + 其他框降到 0.35，便于定位；
- 点击框：`activeRegionId` 联动右侧"检测对象"列表项；
- 缩放：在 `.frame-viewport` 上监听 `wheel`，**必须 `addEventListener('wheel', handler, { passive: false })`**（React 的 `onWheel` 在部分场景是 passive，调 `preventDefault()` 无效，会导致页面/Electron 整体缩放、坐标全乱）；缩放锚点保持在鼠标处，双击复位；
- 键盘：现有 `←/→` 切帧保留，新增 `Esc` 关闭，`F` 切换"显示/隐藏标记"。

**未定位兜底**（很重要）：

| `regionStatus` | 抽屉里显示 |
| --- | --- |
| `none` | 不显示区域（正常帧） |
| `ok` | 叠框 + "检测对象"列表 |
| `partial` | 部分框可用 + "其余位置未能定位" |
| `failed` | "已判定异常，但定位失败" + [重试定位] 按钮 |
| `unsupported` | "当前模型不支持位置输出"（提示去设置里换模型/开启降级区域描述） |

**列表缩略图小框**：`.frame-thumb` 外面套 `position:relative`，用同样百分比画 1px 小框（不显示标签）。一眼能在结果列表里看到"哪几帧画面里有东西"。

### 3.7 跨帧事件聚合（把"框"变成"违规片段"）

固定间隔抽帧（默认 2s）下，同一部手机连续出现 10s = 5 帧 5 条记录，审核员要点 5 次。聚合后是 1 个事件。

> **前提：这是"稀疏采样 + 独立 VLM 判定"，不是连续视频跟踪。** 帧间隔 0.5–60s，ByteTrack/SORT 那套"逐帧运动模型 + 卡尔曼预测"在这里没有意义，反而会因为"中间帧根本不存在"而失效。正确做法是**基于稀疏观测的贪心关联**：同类别 + IoU/中心距/面积相似度 + 允许跨少量空档（gap 桥接）。

**算法（`src/shared/events.ts`，主/渲染进程共用）：**

```ts
export interface ViolationEvent {
  id: string
  itemId: string | null
  category: string
  startMs: number
  endMs: number
  frameIndices: number[]
  representativeFrameIndex: number   // 置信度最高的帧
  maxConfidence: number | null
  lastBox: RegionBox | null
  lastFrameIndex: number
}

const MAX_FRAME_GAP = 2        // 允许中间空 1~2 个采样帧（物体短暂出画/漏检）
const MIN_IOU = 0.3            // 同一物体的位置连续性
const MAX_CENTER_SHIFT = 0.25  // 无框时退化为中心距阈值（相对画面对角线）

function centerDistance(a: RegionBox, b: RegionBox): number {
  const cx1 = (a[0] + a[2]) / 2
  const cy1 = (a[1] + a[3]) / 2
  const cx2 = (b[0] + b[2]) / 2
  const cy2 = (b[1] + b[3]) / 2
  return Math.hypot(cx1 - cx2, cy1 - cy2) / Math.SQRT2
}

export function buildViolationEvents(frames: FrameRecord[]): ViolationEvent[] {
  const events: ViolationEvent[] = []
  const open = new Map<string, ViolationEvent>()
  const ordered = [...frames].sort((a, b) => a.index - b.index)

  for (const frame of ordered) {
    const seen = new Set<string>()
    for (const region of frame.regions ?? []) {
      const key = region.itemId ?? region.category
      seen.add(key)
      const current = open.get(key)
      const adjacent = current ? frame.index - current.lastFrameIndex <= MAX_FRAME_GAP : false
      const linked =
        Boolean(current) &&
        adjacent &&
        (current!.lastBox
          ? iou(current!.lastBox, region.box) > MIN_IOU ||
            centerDistance(current!.lastBox, region.box) < MAX_CENTER_SHIFT
          : true)
      if (current && linked) {
        current.endMs = frame.timestampMs
        current.lastFrameIndex = frame.index
        current.lastBox = region.box
        current.frameIndices.push(frame.index)
        if ((region.confidence ?? 0) > (current.maxConfidence ?? 0)) {
          current.maxConfidence = region.confidence
          current.representativeFrameIndex = frame.index
        }
      } else {
        const event: ViolationEvent = {
          id: `${key}-${frame.index}`,
          itemId: region.itemId,
          category: region.category,
          startMs: frame.timestampMs,
          endMs: frame.timestampMs,
          frameIndices: [frame.index],
          representativeFrameIndex: frame.index,
          maxConfidence: region.confidence,
          lastBox: region.box,
          lastFrameIndex: frame.index
        }
        events.push(event)
        open.set(key, event)
      }
    }
    // 该帧没出现的类别，事件"关掉"，避免跨长时间断档继续合并
    for (const key of [...open.keys()]) {
      if (!seen.has(key)) open.delete(key)
    }
  }
  return events
}
```

**几个必须写进 UI 的语义：**

- **边界误差 ±intervalSec**：2s 抽帧只能说明"在这两个采样点之间出现过"，不要展示成精确起止；文案写"约 00:00:12–00:00:18"；
- **gap 桥接**：物体中间漏检 1~2 帧不应切成两个事件；
- **改抽帧间隔后事件要重算**（事件是纯函数产物，不要落库成"真相"）；
- **没有框的旧任务**：用 `categories` + 相邻帧做降级聚合（只到"时间段"粒度），否则时间轴空白会让人误以为"没有违规"。

**UI**：结果列表上方加一条横向时间轴（`violation-timeline`），每个事件一个色块（left/width 按时间比例），颜色按类别；点击色块跳转到 `representativeFrameIndex`；tooltip 显示"手机 约 00:00:12–00:00:18（3 帧）"。审核从"逐帧翻"变成"先看事件，再点进去看帧"。

### 3.8 导出与证据链

1. **CSV 增列**（改 `exportTaskCsv`）：`检测对象数`、`检测框(归一化)`（`手机:[0.12,0.34,0.26,0.52]; ...`）、`定位层级`（L3/L4）、`定位来源`（vlm/detector）、`定位状态`；
2. **新增 JSON 导出**：`task.json` 已是完整数据，另存一份去掉 `rawResponse` 的精简版即可（方便对接下游/做数据集）；同时附 COCO / YOLO / LabelMe 三种格式（COCO 的 `bbox` 是 `[x,y,w,h]`，YOLO 是归一化中心点+宽高且 class 从 0 起，别搞混）；
3. **带框截图**（审核报告最有说服力）——**有一个必须绕开的坑**：

   > ⚠️ **不能直接用 `vr-media://` 的 `<img>` 画 canvas。** 当前自定义协议只注册了 `standard/secure/supportFetchAPI/stream`，**没有 `corsEnabled`**，`protocol.handle` 返回的 `net.fetch(file://)` 也没有 `Access-Control-Allow-Origin`；`drawImage()` 之后 `toBlob()/toDataURL()` 会因跨源污染抛 `SecurityError`。

   两条路：
   - **推荐**：新增 IPC 读取帧字节（`frame:readBytes(taskId, fileName)` → 返回 `ArrayBuffer`，structured clone 传输，无 base64 膨胀），渲染进程 `createImageBitmap(new Blob([bytes], { type: 'image/png' }))` 解码，用 `OffscreenCanvas` 按**原图分辨率**重绘（图片 + 框 + 标签），`convertToBlob()` 后回传 `frame:saveAnnotatedPng` 落盘到 `data/tasks/<id>/report/`；
   - 备选：给 scheme 加 `corsEnabled: true` 并让响应带 ACAO，`<img crossOrigin="anonymous">`（改动面更大，不推荐）。
   - 不要用主进程 ffmpeg `drawbox` 做带文字版本：中文 `drawtext` 需要 fontfile + 转义，多框 filter 串很长，且和页面配色难一致；只在"只要框不要字"的批量场景考虑。
4. **证据链**：`FrameRecord.rawResponse` 保留判定原文，新增 `regionRaw` 保留定位原文（截断到 4KB）；`RegionRecord.source` 标记框的来源（模型/已确认/人工），`TaskRecord.regionCalibration` 记录坐标空间与标定结论——审核报告里能追溯"这个框是谁画的、用的什么坐标系"。

### 3.9 设置与预设：把"换模型"变成配置，而不是改代码

`AnalysisConfig` 扩展（`src/shared/types.ts`、`src/main/settings.ts`、`src/main/preset.ts` 三处同步，preset 的 `defaults` 也要能带）：

```ts
export interface AnalysisConfig {
  // …现有…
  localize: boolean                    // 是否启用定位标记，默认 true
  localizeScope: 'abnormal' | 'all'    // 定位哪些帧，默认 'abnormal'
  verifyRegions: boolean               // 是否裁切二次确认，默认 true
  maxBoxesPerFrame: number             // 每帧最多几个框，默认 8
  labelAliases: Record<string, string[]> // 模型标签别名 → 内置物品 id/中文名
}

export interface ModelRuntimeConfig {
  // …现有 baseUrl/model/apiKey/concurrency/timeoutSec/extraHeaders…
  extraBody: string                    // JSON 透传：chat_template_kwargs / repetition_penalty 等
  maxTokens: number                    // 判定请求上限，默认 1200（思考模型 3000+）
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
  responseFormat: 'json_object' | 'none'
  /** 发送图片：长边上限 / 格式 / 质量（兼容低配网关、降体积） */
  imageMaxEdge: number                 // 默认 1280；0 = 原图
  imageFormat: 'png' | 'jpeg'
  imageQuality: number                 // JPEG 质量 60~95
  /** 图片字段形态：标准对象 / 字符串（Ollama 兼容） */
  imageFieldStyle: 'object' | 'string'
  /** 是否发送 image_url.detail（vLLM 不支持，默认不发送） */
  sendImageDetail: boolean
  /** 提示词：语言、场景、坐标规则覆盖 */
  promptLanguage: 'zh' | 'en'
  sceneDescription: string             // 默认"会议室"，按客户场景改
  /** 坐标覆盖：自动探测，或手动强制（运维排障/已知模型） */
  coordinateSpaceOverride: 'auto' | 'normalized_1000' | 'normalized_100' | 'normalized_01' | 'absolute_px'
  boxOrderOverride: 'auto' | 'xyxy' | 'yxyx'
  parseDialectOverride: 'auto' | ParseDialect[]
  /** 思考字段读取顺序与开关（vLLM reasoning / SGLang·百炼 reasoning_content） */
  reasoningField: 'auto' | 'reasoning' | 'reasoning_content' | 'none'
  /** 能力探测结果（只读展示 + 重置） */
  profileStatus: 'unprobed' | 'ok' | 'json_only' | 'unsupported'
}
```

UI（`SettingsPage.tsx`）：

- 「分析」卡片：标记违禁物位置、仅异常帧定位、二次确认、每帧最大框数；
- 「模型」卡片：额外请求体（JSON）、max tokens、图片长边/格式/字段形态、提示词语言、场景描述、坐标空间/轴序覆盖；
- 新增「模型能力」卡片：显示 `profileStatus`、方言、坐标空间、轴序、多框能力、探测时间、判定/定位耗时，提供 [重新探测] [导出配置] [导入配置] 按钮；
- **检测项**：把现在的 8 项硬编码改成可增删改（id / 中文名 / 提示词 / **别名**），微调模型的类别直接配上，别名用于把模型输出的 "phone"/"智能手机"/"mobile phone" 映射回 "手机"。

老设置文件缺字段时用默认值（`normalizeStored` 已是这个模式），保证升级不炸。

### 3.10 进度、取消、失败与重试

- **进度**：判定阶段按现有算法；定位阶段 `phaseMessage = '正在定位违禁物'`，进度 = 已定位/需定位帧数。总量 = 帧数 + 需定位帧数，避免进度条倒退；
- **取消**：复用同一个 `AbortController`，定位循环里检查 `signal.aborted`；
- **失败隔离（换模型后尤其重要）**：
  - 单帧定位失败只写 `regionStatus='failed'` + `regionError`，**不要把 `frame.status` 改成 failed**（判定结果是有效的）；
  - 连续失败 ≥4 帧 → **停止定位阶段**（大概率是模型不支持/参数不对），剩余帧标 `regionStatus='failed'`，任务仍以"判定完成"结束，并在摘要里提示"定位阶段中止：{原因}"；
  - 鉴权失败（401/403）→ 定位阶段中止但不影响已完成判定；提示用户检查配置；
  - 图片过大被网关拒绝（413/400）→ 自动降到 `imageMaxEdge` 的一半重试一次，再失败则跳过该帧；
- **重试**：新增 IPC `task:relocalize(taskId, frameIndices?)`，只重跑定位；抽屉里失败帧显示 [重试定位]；**换模型后可以只重跑定位，不重跑判定**（省钱且快）；
- **事件推送**：定位完成后 `emitFrame(task, frame)`，`App.tsx` 现有的 `frame` 事件合并逻辑（`App.tsx:131-139`）天然支持，不用改 IPC 协议。

### 3.11 模块划分与改造清单（按"模型无关"重构）

**新增模块：**

```text
src/main/adapters/
├─ types.ts        # ModelProfile / CoordinateSpace / ParseDialect / RawRegion
├─ request.ts      # buildRequestBody、extractContent（兼容 reasoning_content / content 数组）
├─ dialects.ts     # 各解析器 + parseRegions 方言链 + stripThinking
└─ probe.ts        # 探针：生成合成标定图、发起探测、判定能力与坐标空间
src/main/model-profiles.ts   # profile 读写/缓存/失效/导入导出（data/model-profiles.json）
src/main/regions.ts          # resizeForModel、parseRegionBox、cropRegion
src/shared/regions.ts        # RegionBox/RegionRecord 类型 + iou + 事件聚合（主/渲染共用）
src/renderer/src/components/RegionOverlay.tsx  # SVG 叠框 + 标签 + 列表联动
```

**改造顺序（按风险从低到高，每一步都可单独上线）：**

1. `model.ts`：把 `systemPrompt` / `buildSingleMessages` / `buildGroupMessages` 改成接收 `PromptTemplate`（默认值 = 现状，**零行为变化**）；
2. `model.ts`：`requestChat` 加 `RequestOptions`（`extraBody` / `maxTokens` / `maxTokensField` / `responseFormat`）；`extractResponseContent` 兼容 `reasoning_content`；
3. `model.ts`：判定解析加"深嵌套查找"（`result`/`data`/`output` 包裹层）与更多字段别名；
4. `model.ts`：新增 `analyzeFrameRegions()`（第二段，单帧）；
5. `task-manager.ts`：`runTask` 增加定位阶段与失败隔离；`applyAnalysis` 增加 regions 写入；
6. `settings.ts` / `preset.ts` / `types.ts`：新配置项 + 默认值 + preset 可带 localization 默认；
7. renderer：`RegionOverlay` + 抽屉"检测对象"列表 + 未定位兜底 + 导出；
8. `scripts/mock-model-server.mjs`：用 `MOCK_DIALECT=json|bbox_2d|box_tokens|plain|single_box|none` 环境变量模拟不同模型——**这是"通用适配"的自动化回归手段**，没有它就只能靠手工换真模型验证。

**验收标准（通用性专项）：**

> 同一份构建产物，**只改设置里的接口地址 / 模型名 / 额外请求体**，在 6 种 mock 方言与至少 2 个真实模型下，都能做到：① 判定正常；② 定位要么正确出框、要么按分层规则优雅降级；③ 不崩溃、不阻塞、不产生错误框。

---

## 4. 更强 / 替代思路（按"投入产出比"排序）

| # | 思路 | 优点 | 缺点 / 成本 | 适配度 |
| --- | --- | --- | --- | --- |
| 1 | **模型无关适配层**（ModelProfile + 探针 + 方言链，§3.3.4–3.3.7） | 换模型/换客户不改代码；探针把不确定性挡在上线前 | 1–2 人日；探针需维护误判规则 | ★★★★★ 最高优先级（内网硬约束） |
| 2 | **两段式：判定→定位**（§3.1） | 不破坏现有准确率、成本可控、可独立重试 | 每异常帧多一次请求 | ★★★★★ 强烈推荐 |
| 3 | **坐标标定 + 恒等 resize**（§3.3） | 不做的话框整体错位，功能看着"不可用" | 0.5–1 人日，一次性 | ★★★★★ 必做 |
| 4 | **裁切二次确认**（§3.5） | 误框率大幅下降，审核信任度提升；论文支持"放大再问"（Chain-of-Spot / Set-of-Mark） | 请求数 +5~20%，延迟 +1~3s/帧 | ★★★★★ |
| 5 | **跨帧事件聚合 + 时间轴**（§3.7） | 审核效率质变（按事件而非按帧）；一次 30 分钟 2s 抽帧 ≈ 900 帧，逐帧看不现实 | 纯前端计算 + UI，几百行 | ★★★★★ |
| 6 | **定位分层 + 兜底**（§3.1 L0–L4） | 不赌 VLM 框精度也能上线；可解释 | 多一层 UI 适配 | ★★★★★ 建议首发就做 |
| 7 | **人工复核闭环**（确认/误报/拖动订正框） | 审核结论可追责；积累标注数据；是后续微调检测器的前提 | 编辑交互（konva/fabric）+ review 状态存储 | ★★★★★ |
| 8 | **本地专用检测器做定位**（YOLO-World / Grounding DINO / Florence-2 / RT-DETR） | 框更准更快（CPU 也能跑）、可离线、可训练、可跟踪；**与模型无关，天然适配多客户** | 要引入 onnxruntime-node + 权重（几十~几百 MB）；零样本跨域只有 ODinW 26.1 AP 量级，需微调 | ★★★★ 若内网有 GPU 或能给用户装模型 |
| 9 | **ROI 关注区域**（首帧人工框选桌面/手部区域，或固定区域配置） | 显著降低"墙上海报/屏幕里手机"类误报；小目标可单独放大检测 | 加一个 ROI 编辑交互 | ★★★★ 会议室场景收益大 |
| 10 | **小目标切片（SAHI 式 tiling）** | 1080p 整帧里手机可能只有几十像素；切片实测 +5~15 AP | 调用量 3–5×，只对异常帧做 | ★★★ |
| 11 | **降级：区域文本描述**（九宫格方位，不出坐标） | 最稳、零坐标风险；模型拒答率低；**任何模型都能做** | 定位粗 | ★★★ 兜底层（弱模型必选） |
| 12 | **网格命中**（模型输出 4×4/6×6 网格编号） | 分类而非回归，抗坐标幻觉；SoM 证明"加标记再问"有效 | 定位粗 | ★★★ 首发快速交付 |
| 13 | **分割掩码**（SAM2 / Florence-2 region proposal） | 视觉效果好、可抠图 | 依赖重、导出/存储膨胀、审核用不上 | ★ 不建议 |
| 14 | **视频原生多模态模型**（Qwen3-VL video、Gemini） | 直接时序定位，不用抽帧 | 改架构、内网部署难、成本高 | ★★ 中长期 |

**推荐组合**：`现有 VLM 判定` + `两段式定位` + `坐标标定` + `裁切二次确认` + `事件聚合` + `人工确认闭环`；如果有 GPU/可装模型，再加 `本地检测器` 做定位与召回补充（VLM 负责"是什么/是否违规"，检测器负责"在哪"）。

---

## 5. 风险与验证

### 5.1 风险表

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **换模型后行为变化**（方言/坐标/JSON/思考模式都变） | 一个客户的适配经验到另一个客户失效 | 探针 + profile 缓存 + 手动覆盖 + 配置导入导出（§3.3.4–3.3.7）；profile 按 prompt 指纹失效 |
| **坐标空间判断错**（绝对像素 vs 归一化 vs 网关内部 resize） | 所有框整体缩放/偏移，功能看着不可用 | 发送前恒等 resize + 记录 sentW/H + 探针 + 范围自校验（§3.3） |
| 模型框不准/框飘/幻觉框 | 审核员不信任，反而更慢 | 二次确认 + 低置信虚线 + 分层降级 + 人工可订正；实测接受率不达标就退回 L1/L2 |
| 端点顺序/越界 | 框画不出来或画满屏 | 交换端点 + clamp + 面积过滤 + `suspicious` 标记 |
| `max_tokens` 截断（尤其思考模型） | 整帧定位解析失败 | 定位请求独立、可配上限、按物品数估算；解析失败仅降级为"未定位" |
| 微调模型类别不同（英文名/自造类目） | 框出来了但对不上内置物品 | 自定义检测项 + 别名映射；对不上时保留模型原始 label 并标 `itemId=null` |
| 小目标/遮挡漏检 | 违禁物漏审 | 切片（SAHI）+ 裁切复检 + 人工复核兜底 |
| 旋转视频坐标错位 | 框整体错位 | 以 PNG 实际尺寸为准；前端用图片实际比例 |
| 请求量/延迟上升 | 任务变慢、成本上升 | 只定位异常帧；二次确认可选/只对低置信框；并发数可调 |
| 旧任务不兼容 | 打不开历史任务 | `normalizeTask` 补默认值；UI 对 `regions` 缺失做空态 |
| 合规/可解释性 | 结论无法追溯 | `rawResponse`/`regionRaw` 留存，框标来源与坐标空间，导出证据图 |

### 5.2 验证方法

1. **先跑模型探针（0.5–1 人日，必做）**：合成标定图 + 1~2 次请求，确定"能否出框/方言/坐标空间/是否思考污染/多框能力"；产出 `data/model-profiles.json`；**换模型、换部署、改 prompt 都要重新探测**；
2. **造评测集**：300–1000 张分层帧（物品类型 × 目标大小 × 遮挡 × 光照），人工标框（2 人独立标，IoU≥0.5 视为一致），**必须含 20% 以上负样本帧**（无违禁物，用于测误报）；
3. **多模型横评**：同一评测集至少在 2–3 个候选模型上跑（如现场实际模型 + 一个备用模型），确认"换模型不掉链子"，把每个模型的 profile 结论归档；
4. **算指标**：`Recall@IoU{0.3,0.5}`、`Precision`、`mAP@0.5`、`mean IoU` 的 P10/P50/P90、负样本 `FP/帧`；另看"框数偏差"（模型多画/少画）；
5. **拒答能力**：GroundingME 的关键结论是"多数模型在该拒答时给了错框"（<https://arxiv.org/abs/2512.17495>）——所以要把"该帧确实无目标时是否返回空数组"单独当指标测；
6. **代理指标**：二次确认通过率（`verified=true / 总框数`）——不需要标注就能日常监控；
7. **灰度**：默认关定位，内部试用 1–2 周再默认开；二次确认先默认开，稳定后按需关；记录人工接受率与订正幅度；
8. **成本核对**：每任务额外请求数、额外 token、额外耗时（日志里加一行统计）。

### 5.3 关键指标建议

| 指标 | 目标（经验值） |
| --- | --- |
| 框命中率（框内确实有目标） | ≥ 85%（二次确认后 ≥ 95%） |
| 目标漏框率（有目标却没画框） | ≤ 20%（不追求检测器级） |
| 平均框数/异常帧 | ≤ 2.5（过多说明模型在乱标） |
| 异常帧额外耗时 | ≤ 3s/帧（二次确认开启时） |

---

## 6. 分期实施

> 结论：**先做"不赌模型精度"的部分（分层兜底 + 事件化 + 复核闭环），再逐步升级到精框。** 这样第一版不会因为框不准而废掉。

### P0（5–7 天）：通用适配 + 最小闭环，能看位置
1. **模型适配层（通用性打底，1.5–2 天）**：`ModelProfile` + 两尺寸探针（同一张图发 1120×672 / 560×336，自动判定方言/坐标空间/轴序/思考污染/多框能力）+ 解析方言链（先支持 `json_objects`/`json_bbox_2d`/`box_tokens`/`molmo_points`/`plain_coords` 五种，其余按客户需要补）+ `extraBody`/`maxTokens`/图片长边与格式可配；设置页「模型能力」卡片 + 导入导出；
2. **数据契约**：`types.ts` 加 `RegionRecord` / `FrameRecord.regions` / `regionStatus` / `regionLevel`，`normalizeTask` 补默认值（旧任务自动兼容）；
3. **业务接入**：`buildLocalizeMessages`（模板化，中/英 × 三种坐标规则）+ `parseRegionBox` + `resizeForModel` + 去重；`task-manager.ts` 判定后跑第二段（仅 abnormal/review）；`mock-model-server.mjs` 支持多种方言便于联调；
4. **预览叠加**：`frame-stage` + SVG 百分比叠框 + 标签 + "检测对象"列表 + 未定位/不支持兜底态；
5. **验收**：
   - 用 mock 服务分别模拟"JSON 方言 / box token 方言 / Molmo 方言 / 只返回单框 / 完全不出框"五种模型，应用都要正确降级、不崩；
   - 真实模型：探针结论与人工框 IoU ≥ 0.4；换一个不同模型重跑探针，无需改代码即可出框。

### P1（2–3 天）：框更可信
- 裁切二次确认（`nativeImage.crop` + 确认请求 + `verified` 状态）；
- 设置项（定位开关/范围/二次确认/框数上限）+ preset 默认值；
- 自定义检测项 + 标签别名映射（微调模型类别适配）；
- 失败态与[重试定位] IPC；
- CSV 增列 + 带框截图导出（IPC 读字节 + OffscreenCanvas）；
- 验收：二次确认能稳定否决"屏幕里的手机"类误框；换中文/英文模型均能对上类别。

### P2（3–5 天）：从"帧"到"事件"
- `shared/events.ts` 聚合 + 时间轴组件 + 点击跳帧（按 §3.7 的稀疏采样规则）；
- 人工确认/误报（帧级/框级 `reviewStatus`）；
- 列表缩略图小框 + 抽屉缩放/拖拽；
- 验收：一段 10 分钟视频的审核步数下降 50%+。

### P3（可选）：更强
- 人工拖拽订正框（konva/fabric，仅编辑模式）→ 积累标注；
- 本地检测器插件（onnxruntime-node + YOLO-World/Florence-2）；
- ROI 关注区域；
- 事件附近加密抽帧（ffmpeg `-ss`）复核短事件。

---

## 7. 需要与模型服务方确认的问题清单

这些问题的答案是"探针"和"配置项"的输入，建议一次问清（换客户时再问一遍）：

1. **服务端栈**：vLLM / SGLang / LM Studio / Ollama / 其他？版本？是否 OpenAI 兼容完整（图片 data URL、`max_tokens`、`response_format`）？
2. **模型**：确切名称/版本？是 Qwen2.5-VL、Qwen3-VL、InternVL、MiniCPM-V、GLM 系，还是自微调模型？是否有模型卡说明 grounding 格式？
3. **坐标口径**：该模型 grounding 输出的是 0–1 / 0–1000 / 绝对像素？基于"原图"还是"模型实际输入图"？**能否给一张测试图 + 期望输出做对照**（这比任何文档都可靠）。
4. **图像预处理**：`min_pixels / max_pixels` 配置？是否会自动缩放/letterbox？**这是坐标错位的头号来源**。
5. **思考模式**：是否默认输出思考过程（Qwen3 Thinking 系）？能否通过 `chat_template_kwargs: {"enable_thinking": false}` 关闭？返回里是否单独给 `reasoning_content`？
6. **参数限制**：`max_tokens` 上限？是否支持 `response_format`/structured outputs？并发限制多少？
7. **特殊 token**：返回内容是否保留 `<|box_start|>`、`<ref>`、`<box>`、`<loc_n>` 之类 token，还是被网关过滤？
8. **测试环境**：能否提供测试环境做探针与评测（换模型后必须重建 profile）。

---

## 8. 附：参考资料（均已核对原始页面）

### 模型坐标体系与方言（核心）

- Qwen2.5-VL 技术报告（§2.1.2 绝对像素、§2.1 宽高 resize 到 28 倍数）：<https://arxiv.org/html/2502.13923v1>
- Qwen3-VL 技术报告（§3.2.4 改为 `[0,1000]` 归一化）：<https://arxiv.org/html/2511.21631v1>
- Qwen2-VL 论文（`[0,1000)` + special token）：<https://arxiv.org/html/2409.12191v1>
- Qwen2.5-VL 官方博客（JSON `bbox_2d` grounding 示例）：<https://qwenlm.github.io/blog/qwen2.5-vl/>
- Qwen3-VL 仓库 / 2D grounding cookbook（相对坐标、box/point、add_vision_id）：<https://github.com/QwenLM/Qwen3-VL> · <https://github.com/QwenLM/Qwen3-VL/blob/main/cookbooks/2d_grounding.ipynb>
- 官方 issue：两代坐标换算公式（维护者回复）<https://github.com/QwenLM/Qwen3-VL/issues/1616>；内部 resize 不一致案例 <https://github.com/QwenLM/Qwen3-VL/issues/1030>
- InternVL 论文 §3.3（`<ref></ref><box>[[x1,y1,x2,y2]]</box>`，0–1000）：<https://arxiv.org/html/2410.16261v1>
- MiniCPM-V 官方 Cookbook Grounding（`<box>`、除以 1000 还原）：<https://opensqz.github.io/MiniCPM-V-CookBook/site/zh/v4.5/inference/grounding.html>
- GLM-V README（`<|begin_of_box|>`、归一化后 ×1000、括号风格不固定）：<https://github.com/zai-org/GLM-V/blob/main/README.md>
- Molmo 论文 §4（0–100 归一化）<https://arxiv.org/html/2409.17146v2>；Molmo2 坐标格式化代码（0–1000、`<points coords>`）<https://github.com/allenai/molmo2/blob/main/olmo/preprocessing/point_formatter.py>
- Florence-2 后处理（`<loc_*>` bins、`(bin+0.5)*size/1000`）：<https://github.com/huggingface/transformers/blob/main/src/transformers/models/florence2/processing_florence2.py>
- Gemini 官方 cookbook（`box_2d`、0–1000、y 在前）：<https://github.com/google-gemini/cookbook/blob/main/quickstarts/Spatial_understanding.ipynb>
- ms-swift 微调 grounding 数据格式（模型无关 `<ref-object>/<bbox>`、bbox_type=real/norm1、QWENVL_BBOX_FORMAT）：<https://github.com/modelscope/ms-swift/blob/main/docs/source_en/Customization/Custom-dataset.md>
- vLLM 结构化输出：<https://docs.vllm.ai/en/latest/features/structured_outputs/>

### OpenAI 兼容部署差异（调用层）

- vLLM OpenAI 兼容服务：<https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/>
- vLLM 多模态输入（data URL、`image_url.detail` 不支持、HTTP 图片 5s 超时）：<https://docs.vllm.ai/en/latest/features/multimodal_inputs.html>
- vLLM reasoning 输出（`reasoning` 字段、`--reasoning-parser`）：<https://docs.vllm.ai/en/latest/features/reasoning_outputs.html>
- vLLM 论坛：Qwen3-VL-Thinking 逐请求关思考的限制：<https://discuss.vllm.ai/t/disabling-reasoning-of-qwen3-vl-8b-thinking-per-request/1800>
- SGLang OpenAI 兼容 / 视觉输入 / 结构化输出：<https://docs.sglang.io/docs/basic_usage/openai_api_completions>
- Ollama OpenAI 兼容（仅 base64 data URL、字符串 image_url、仅 max_tokens）：<https://docs.ollama.com/api/openai-compatibility>
- LM Studio OpenAI 兼容 / 结构化输出：<https://lmstudio.ai/docs/developer/openai-compat/chat-completions>
- Xinference 多模态（URL 与 data URL、limit_mm_per_prompt）：<https://inference.readthedocs.io/en/latest/models/model_abilities/multimodal.html>
- 阿里云百炼 OpenAI 兼容（data URL、reasoning_content、min/max pixels 默认值）：<https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions>
- LibreYOLO 容错解析实现（可借鉴，非依赖）：<https://github.com/LibreYOLO/libreyolo/blob/main/libreyolo/models/vlm/parsing.py>

### 可靠性证据

- GroundingME（25 个 SOTA MLLM，最好 45.1%，多数在"应拒答"上 0%）：<https://arxiv.org/abs/2512.17495>
- RefCOCO 上 Qwen2.5-VL-7B/72B Acc@0.5 = 86.6/90.3（单目标干净图，只能当宽松上限）：<https://arxiv.org/html/2512.06373v1>
- SAHI（小目标切片 +5~15 AP）：<https://arxiv.org/abs/2202.06934>
- Set-of-Mark（"加标记再问"提升 grounding）：<https://arxiv.org/abs/2310.11441>
- Chain-of-Spot（ROI 放大再推理）：<https://arxiv.org/abs/2403.12966>
- Grounding DINO（COCO zero-shot 52.5 AP / ODinW 26.1 AP）：<https://arxiv.org/abs/2303.05499>
- YOLO-World（LVIS 35.4 AP @ 52 FPS）：<https://arxiv.org/abs/2401.17270>
- Florence-2（统一任务 token，含 OD / phrase grounding）：<https://arxiv.org/abs/2311.06242>
- SAM 2（box/point prompt 分割）：<https://arxiv.org/abs/2408.00714>

### 竞品与工业实践

- 网易易盾视频检测 v3（`hitLocationInfos` 仅人脸/logo/关键词给相对坐标）：<https://support.dun.163.com/documents/2018041903?docId=150440627406032896&locale=zh-cn>
- AWS Rekognition `ContentModerationDetection`（有时间段、无框）vs `LabelDetection`（有框）：<https://docs.aws.amazon.com/rekognition/latest/APIReference/API_ContentModerationDetection.html> · <https://docs.aws.amazon.com/rekognition/latest/APIReference/API_LabelDetection.html>
- Google Video Intelligence（`ExplicitContentFrame` 无框 / `ObjectTrackingFrame` 有归一化框）：<https://cloud.google.com/video-intelligence/docs/feature-object-tracking>
- 阿里云 VOD 智能审核时间线（`Timestamp/Label/Score`）：<https://help.aliyun.com/zh/vod/developer-reference/api-vod-2017-03-21-getmediaauditresulttimeline>
- Frigate zones（连续帧确认 inertia / 事件化）：<https://docs.frigate.video/configuration/zones/>
- DeepStream `NvDsObjectMeta`（框 + track id + 置信度契约参考）：<https://archive.docs.nvidia.com/metropolis/deepstream/8.0/sdk-api/struct__NvDsObjectMeta.html>
- supervision annotators：<https://supervision.roboflow.com/latest/detection/annotators/>

### 前端渲染 / 导出 / Electron

- MDN `object-fit`：<https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/object-fit>
- MDN `preserveAspectRatio`：<https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/preserveAspectRatio>
- MDN `vector-effect`：<https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/vector-effect>
- MDN CORS-enabled image（canvas 污染）：<https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image>
- Electron 自定义协议权限（`corsEnabled`）：<https://www.electronjs.org/docs/latest/api/structures/custom-scheme>
- `OffscreenCanvas`：<https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas>
- react-konva 19.3.0 release notes（React ≥19.3.0 约束）：<https://github.com/konvajs/react-konva/releases/tag/v19.3.0>
- COCO 格式（`bbox=[x,y,w,h]`）：<https://cocodataset.org/#format-data>

### 合规

- 《个人信息保护法》（人脸可能属敏感个人信息）：<http://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html>
- 《网络安全法》（日志留存要求）：<https://www.cac.gov.cn/2016-11/07/c_1119867116_2.htm>

### 本次调研的原始报告（放在仓库里，方便后续查阅）

- 模型坐标/定位能力：`docs/archive/research/vlm-grounding.md`（三代坐标证据链、prompt 草案、标定与评测计划）
- 各模型族方言 + 部署差异（模型无关适配的依据）：`docs/archive/research/model-dialects.md`
- 前端渲染/交互/时间轴/导出：`docs/archive/research/ui-tracking.md`（选型对比、`FrameViewer` 组件代码、25 条坑清单）
- 竞品/开源/学术 + 增强思路评估：`docs/archive/research/industry-survey.md`（厂商字段口径、8 个思路 ROI、合规证据链）

---

## 9. P0 实现说明（已落地，可直接跑）

> 本方案 P0 已在当前仓库实现并通过自动化验证。以下是"实际做了什么、怎么验、还差什么"。

### 9.1 实现范围（P0）

| 模块 | 文件 | 内容 |
| --- | --- | --- |
| 共享约定 | `src/shared/localization/profile.ts` | `ModelProfile` / `CoordinateSpace` / `BoxOrder` / `ParseDialect` / `LocateContext` |
| 方言链 | `src/shared/localization/dialects.ts` | JSON 多 schema / 特殊 token（`<box>`/`<ref>`/`<\|begin_of_box\|>`）/ Florence loc bins / 纯坐标文本；`resolveBox` 坐标映射、`validateBox`、`iou`、`dedupeBoxes`、拒答识别、thinking 剥离 |
| 提示词 | `src/shared/localization/prompts.ts` | 中/英 × 4 种坐标空间的定位 prompt；探针 prompt（含“能力自检”标记） |
| 请求契约 | `src/shared/localization/request.ts` | `buildRequestBody`（extraBody / maxTokens / response_format）+ `extractMessageContent`（兼容 content / reasoning / reasoning_content / text） |
| 探针 | `src/shared/localization/probe.ts` | 标定图矩形定义、两尺寸判定算法（4 空间 × 2 轴序假设评分 + 领先幅度门槛） |
| 标定图 | `src/main/probe-image.ts` | 纯 Node PNG 编码器，生成 1120×672 / 560×336 标定图 |
| 档案 | `src/main/profiles.ts` | `model-profiles.json` 读写、prompt 指纹失效、手动覆盖 |
| 定位实现 | `src/main/localization.ts` | `ensureProfile`（探针编排）、`prepareImage`（nativeImage 缩放 + 28 倍数 + data URL）、`localizeFrame`、类别别名映射 |
| 任务编排 | `src/main/task-manager.ts` | 两段式：判定 → 定位（只对异常/复核帧）；进度/取消/失败隔离/重跑定位；CSV 增列 |
| 设置/IPC | `src/main/settings.ts`、`ipc.ts`、`preload/index.ts` | 定位开关、每帧框数、模型高级配置、`model:probe`、`task:relocalize` |
| 渲染层 | `TaskDetail.tsx`、`SettingsPage.tsx`、`styles.css`、`lib/ui.ts` | SVG 百分比叠框 + 标签 + 检测对象列表 + 缩略图迷你框 + 未定位兜底；设置页定位开关/高级配置/模型能力卡片；`重新定位` 按钮 |
| 测试 | `scripts/verify-localization.mjs`、`scripts/smoke/*`、`scripts/mock-model-server.mjs` | 73 项纯逻辑/端到端（mock）验证 + 16 项 Electron 端到端冒烟 |

### 9.2 验证结果（可复现）

```bash
npm run typecheck            # 主进程/渲染进程均通过
npm run verify:localization  # 73 PASS / 0 FAIL（4 坐标空间 × 4 方言探针 + 解析 + 落点 + 判定语义）
npm run smoke:localization   # 16 PASS / 0 FAIL（真实 ffmpeg 抽帧 → 判定 → 定位 → task.json → 重定位）
npm run build                # 生产构建通过
```

冒烟测试的关键断言：探针正确识别 `normalized_1000` / `absolute_px`；定位框数=2、类别映射到 `phone/camera`、坐标归一化；正常帧不带框；`task.json` 持久化 regions；重定位后仍有框。

### 9.3 与设计的差异（P0 未做，P1/P2 计划）

| 设计项 | 状态 |
| --- | --- |
| 裁切二次确认（crop-and-verify） | ⬜ P1 |
| 跨帧事件聚合 + 时间轴 | ⬜ P2 |
| 人工确认/误报/拖拽订正框 | ⬜ P2/P3 |
| 带框截图导出（OffscreenCanvas） | ⬜ P1（当前 CSV 已含框坐标） |
| 模型能力档案导入导出 UI | ⬜ P1（当前档案已落盘，可按机器分发文件） |
| ROI 关注区域 / 本地检测器 | ⬜ P3 |
| 区域文本/网格兜底（L1/L2） | ⬜ 模型不支持定位时当前直接关闭定位并提示 |

### 9.4 已知限制

1. **VLM 框精度有限**：框是辅助线索；遮挡/小目标/反光场景会明显偏差，必须人工复核。
2. **探针需要 1–2 次额外请求**：首次使用某模型时多几秒；结论缓存后不再探测（除非换模型/改提示词）。
3. **思考模型需要手工调大 max tokens**：Qwen3-VL-Thinking 之类优先换 Instruct 版本，或在高级配置里把 maxTokens 调到 2000+。
4. **实测覆盖**：已验证 mock 的 json / bbox_2d / box_tokens / plain / single / none 方言与 4 种坐标空间；Florence `loc_bins` 解析器已实现但**未用真实 Florence 模型验证**（special token 常被网关过滤）。
5. **Windows 验证**：当前只在 Windows x64 构建/运行验证。

### 9.5 试用步骤（内网真模型 / mock 均可）

1. 设置 → 模型：填接口地址（如 `http://127.0.0.1:8899/v1`）、模型名（mock 为 `mock-vl`）；按需填额外请求体（如关思考）；
2. 设置 → 分析：确认“标记违禁物位置”开启、每帧最大框数（默认 8）；
3. 设置 → 模型能力 → 点「探测模型能力」：看到“定位可用”及坐标空间/轴序/方言后再开始分析；
4. 工作台选视频 → 开始分析 → 任务详情里看列表小框与抽屉叠框；
5. 换了模型后：回设置重新探测，或在任务详情点「重新定位」只重跑定位。

### 9.6 性能优化（首轮实测后补充）

首轮外部 API 实测暴露的问题不是"没有框"，而是**定位结果比异常识别慢很多**：判定结束时框还没出来。根因与修复：

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| 框要等全部判定结束才出现 | 原实现是"先跑完判定，再整段跑定位"的串行两段式 | 改成**流水线**：判定出一帧异常立刻入队定位，判定与定位重叠；定位并发 2–3 个请求 |
| 首帧定位前多等一次探针 | 探针在定位阶段开始时才发 | 探针改为**懒启动 + 与判定并行预热**：第一帧需要定位时启动，等判定跑完时档案通常已就绪；无异常帧的任务不发探针 |
| 单帧定位很慢 | `imageMaxEdge=0`（原图 2048×1080 PNG）直接上传外部网关，且网关内部还可能 resize | 定位请求**始终按已知尺寸发送**：0 视为自动 1120，长边不超过配置值；28 倍数对齐，保证 `absolute_px` 标定一致 |
| 外部网关一次抖动把能力档案打成失败 | 探针无重试，且失败会覆盖旧档案 | 探针**失败自动重测一次取更优**；新探测失败但旧档案可用时**沿用旧档案**，不降级 |
| 单帧卡住拖慢整段 | 定位复用了判定的大超时（120s） | 单帧定位超时单独压到 **60s**，连续失败 4 次才中止 |
| 不知道进度 | 只显示"正在定位违禁物" | 进度显示 `正在分析（已定位 N）` / `正在定位违禁物 x/y`；日志记录每帧耗时；任务列表行显示「定位 N」 |

补充建议：外部接口把「定位图片格式」设为 **JPEG**，体积约为 PNG 的 1/5～1/10，上传更快，框的位置通常不受影响。

验证：`npm run typecheck`、`npm run verify:localization`（73 项）、`npm run smoke:localization`（16 项端到端）均通过；冒烟日志可看到定位在判定过程中逐帧完成。

---

## 9.7 违禁物清单改造 + 判定/定位一致性修复（第二轮实测后补充）

### 9.7.1 清单模型

| 类型 | 规则 |
| --- | --- |
| 内置物品 | 「笔、水杯、水壶、手机」四项固定检测：不可删除、不可取消勾选（`BUILTIN_PROHIBITED_ITEMS`） |
| 自定义物品 | 用户可添加（≤12 字、最多 20 个），可勾选/取消、可删除；ID 形如 `custom:xxxx`，保存在 `settings.json` |
| 快照 | 创建任务时把「选中 ID + 自定义物品定义」写入 `TaskRecord.config`，之后改设置不影响历史任务 |
| 兼容 | 旧设置里的历史 ID 被忽略，内置四项自动补齐；旧任务配置里缺失的字段按空值兜底 |

提示词/定位/类别归一化统一走 `resolveProhibitedItems()`，模型返回的别名（如"杯子"→"水杯"、"手机/phone"→"手机"）会自动映射到标准中文名。

### 9.7.2 实测发现的"异常对象 ≠ 定位对象"问题

真实任务（2048×1080 视频、外部 MaaS 的 qwen3.8-27b）日志与 `task.json` 显示两类问题：

1. **坐标基准不一致**：定位请求把图压到 1120×588 发送，但模型返回的是**原图 2048×1080 像素坐标**。原实现按发送尺寸换算，y 超过 588 的框被当成越界丢弃 → 同一帧里"较大的平板电脑框"被丢掉，"较小的手表框"反而保留，看起来就是"判平板、框手表"。
2. **定位提示词没有约束判定对象**：提示词列的是全部勾选物品，模型会顺手把画面里其他违禁物也框出来，导致判定类别与定位类别不一致。

### 9.7.3 修复

| 问题 | 修复 |
| --- | --- |
| 坐标基准 | 新增 `mapRawBoxesAdaptive()`：先按发送尺寸映射；`absolute_px` 下若按原图尺寸能解析出更多有效框，则自动改用原图尺寸换算并记录告警 |
| 对象不一致 | 定位提示词带入"本帧已判定存在：X，请只定位这些对象；找不到返回空数组，不要用其他物品代替" |
| 结果不一致 | 定位结果按本帧判定类别过滤；被过滤的框计入 `filteredOut`，全部过滤时在帧上提示"定位结果与判定对象不一致（已过滤 N 个框）"；日志记录 focus/过滤数 |
| 可观测性 | `data/logs/app.log` 会记录"使用原图坐标系换算""定位结果与判定对象不一致，已过滤" |

验证：`npm run verify:localization` 新增 2 条回归用例（真实失败样本的"原图坐标兜底"），75 项全通过；`npm run smoke:localization` 18 项全通过（含内置四项固定 + 自定义物品快照）。

---

## 9.8 框的显示交互调整（第三轮反馈）

用户反馈：定位框默认全画在画面上会干扰查看。调整为"按需显示"：

| 操作 | 行为 |
| --- | --- |
| 打开帧预览（默认） | 画面上**不画任何框**，也不显示任何提示文字 |
| 鼠标悬浮「检测对象」某项 | 立即在画面上显示该项的框 + 类别标签；移出后消失 |
| 点击「检测对象」某项 | 把该框**固定**在画面上（再点一次取消）；**支持同时固定多个**；固定后再悬浮其他对象，会临时同时显示 |
| 缩略图 | 保留迷你框（用于快速扫出哪些帧有定位），不参与悬浮交互 |

实现：`FrameDrawer` 改为 `visibleRegionIds = {固定项} ∪ {悬浮项}`，只渲染可见集合的 SVG/标签；列表项增加 `aria-pressed` 状态。默认不画框后，框的点击固定入口改为"列表点击"，避免空画面无从点起。

---

## 附：一句话回答"这个思路如何"

**思路对、方向对，但"四个坐标"只是表象，真正的四个成败点是：① 模型不能写死——用"两尺寸探针 + ModelProfile + 方言链"把任意模型/微调模型的差异挡在适配层（内网换模型不改代码）；② 坐标空间必须实测（7 种方言、4 种坐标空间、2 种轴序，Qwen2.5-VL 和 Qwen3-VL 都不是一套坐标）；③ 框要做成可降级的辅助线索（精框 → 粗框 → 网格 → 区域文本），不能赌 VLM 一次框准；④ 产品单位要从"帧"升级为"事件"，并让人工复核能确认/订正。补上这四点，得到的就不只是"画个框"，而是一条能在不同客户现场都跑得通的定位证据链。**
