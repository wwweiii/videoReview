# 视频帧违禁物多框标注：VLM 定位能力与工程化方案调研

> **归档说明**：本文为历史调研归档（写于违禁物定位标记 P0 前后），引用的代码路径、组件名与结论均为当时快照；当前实现以 `src/` 与根 `README.md` 为准。原始调研内容保留不动。

> 项目背景：Electron + React 19 桌面「视频智能审核」工具；ffmpeg 抽原始分辨率 PNG，逐帧/分组以 data URL 调 OpenAI 兼容接口 `qwen2.5-vl-32b-instruct`；模型只返回 JSON（abnormal/categories/evidence/confidence，无坐标）。目标：新增「帧上画多个违禁物标记框」。
>
> 调研时间：2026-11。来源分级：**【官方】**=厂商文档/技术报告/官方仓库代码；**【论文】**=arXiv/CVPR 等同行评议或预印本；**【二手】**=GitHub issue、博客、第三方对比。凡无法直接抓取原文的条目，文中显式标注「不确定」。
>
> 一句话结论：**当前接入的 qwen2.5-vl 系坐标是「模型内部 resize 后图像的绝对像素」，不是 [0,1000]；从 Qwen3-VL 起才改为 [0,1000] 归一化。多框功能必须按模型代数做坐标分支 + 自校验，且 VLM 框只能当“审核提示框”，不能当精确标注。**

---

## 0. 结论速览

1. **坐标体系三代不同，是最容易踩的坑**：Qwen2-VL = 归一化 `[0,1000)` + 特殊 token；Qwen2.5-VL = **输入图像绝对像素**（官方技术报告原文「directly uses the actual dimensions of the input image to represent bounding boxes」），默认 JSON `bbox_2d`；Qwen3-VL = **归一化 `[0,1000]`**（官方技术报告原文「Different from Qwen2.5-VL, we adopt a normalized coordinate system scaled to the range [0,1000]」）。三者不能共用一套换算。
2. **qwen2.5-vl 的“绝对像素”指的是 smart_resize 之后、真正送进 ViT 的那张图**，不是用户原始 PNG。官方仓库成员给出的换算公式：`resized_bbox = round(ori_bbox / [img_w,img_h,img_w,img_h] * [resized_w,resized_h,resized_w,resized_h])`（详情见 §1.1）。
3. **现有接口形态存在“二次 resize 不可见”风险**：DashScope/第三方 OpenAI 兼容服务、LM Studio、vLLM 各自用不同 `min_pixels/max_pixels` 做内部 resize；社区已有接口与本地量化模型坐标对不上的案例（Qwen issue #1030）。工程上必须让 resize 变成“恒等变换”，或做启动标定。
4. **多目标单帧可行，多图一请求出坐标不可靠**：Qwen3-VL 官方 README 给出 `add_vision_id`（`Picture 1:`/`Picture 2:`）来区分多图，但这只是文本标注，坐标归属仍是模型猜测。**建议 group 请求只做分类/triage，框必须逐帧单图请求。**
5. **精度上限要清醒**：Qwen2.5-VL-7B 在 RefCOCO 平均 `Acc@0.5 = 86.6`、72B = `90.3`（单目标、干净图像、IoU 0.5 即算对；数据见 §2.1）。会议室视频帧里多目标、遮挡、小目标、反光场景会显著更低。公开来源**缺少**针对“多目标违禁物/小目标/遮挡”的分位数统计，需自建集实测。
6. **该功能的正确产品定位**：VLM 框 = 人工复核的“提示框/初筛框”，不是最终标注框。业界主流补偿：开放词表检测器先出候选 → VLM 裁切确认/分类 → tiling 提小目标 → 多次采样 IoU 聚类投票 → SAM2 精修 → 人审。
7. **结构化输出可用但依赖部署栈**：vLLM 支持 JSON schema（xgrammar/guidance 后端，`response_format` 或 `structured_outputs`）；SGLang 有 Structured Outputs 文档。但 **DashScope/第三方兼容端点是否支持 `response_format` 需实测**；不支持时保留“解析失败重试 + JSON 修复”路径。
8. **必须把坐标空间写进 JSON 契约**（`coordinate_space: "normalized_1000" | "absolute_px"`）并让服务端按模型名分支换算；前端只接受“原始图像素”的统一内部格式。
9. **验证方法**：300–1000 帧分层标注集（物品类型 × 目标大小 × 遮挡 × 光照），指标用 `Recall@IoU0.3/0.5`、`Precision`、`mAP@0.5`、`mean IoU` 的 P10/P50/P90、负样本 FP、人工接受率；先做坐标标定实验再谈召回。
10. **风险 top3**：坐标空间误判（框整体缩放错位）、多图/多物归属错乱、小目标与遮挡下的漏检 + 幻觉框。三者都只能靠“自校验 + 多次一致性 + 人工复核”兜底。

---

## 1. 各模型坐标/输出格式对照表

| 模型（版本） | 坐标空间 | 范围 | 输出语法 | 多目标 | 换算到原图 | 来源等级 |
|---|---|---|---|---|---|---|
| **Qwen2-VL**（2024.09） | 归一化，相对图像宽高 | `[0,1000)` | `<|box_start|>(x1,y1),(x2,y2)<|box_end|>`；`<|object_ref_start|>短语<|object_ref_end|>` | 多个 box token 序列 | `x_px = x/1000*W` | 【官方】技术报告 |
| **Qwen2.5-VL**（2025.01；32B 2025.03） | **绝对像素，相对模型输入（smart_resize 后）图** | 无归一化，0..resized_w/h | 默认 JSON：`[{"bbox_2d":[x1,y1,x2,y2],"label":"..."}]`；也可特殊 token | JSON 数组多元素 | `x_orig = x * orig_w / resized_w`（比例不变时） | 【官方】技术报告 + 官方仓库 issue 回复 |
| **Qwen3-VL**（2025.09 起，32B 2025.10） | **归一化**，相对图像宽高 | `[0,1000]` | 默认 JSON `bbox_2d`（也支持 points），支持 boxes+labels 组合 | JSON 数组多元素 | `x_px = x/1000*W` | 【官方】技术报告 + 官方仓库 issue 回复 |
| **Florence-2**（large） | 量化到 1000 bins | `<loc_0>`…`<loc_999>` | `<OD>`、`<CAPTION_TO_PHRASE_GROUNDING>`、`<OPEN_VOCABULARY_DETECTION>`、`<DENSE_REGION_CAPTION>`、`<REGION_PROPOSAL>` 等任务 token | 每个短语可带多个 loc 四元组 | `(bin+0.5)*(W/1000)`（HF processor 实现） | 【官方】Microsoft 论文 + HF processor 代码 |
| **Grounding DINO** | 归一化 `cxcywh`，相对整图 | `[0,1]` | Open-set 检测：boxes + logits + phrases；阈值 `box_threshold`/`text_threshold` | 是（默认 900 queries，阈值过滤） | `boxes*[W,H,W,H]` 后 `cxcywh→xyxy` | 【官方】论文 + 官方 README/inference.py |
| **YOLO-World**（v2） | 像素 `xyxy`（Ultralytics 框架约定） | 0..W/H | 检测结果 `boxes.xyxy` + `conf` + `cls`；`set_classes([...])` 设开放词表 | 是 | 直接可用（输出即原图像素） | 【官方】论文 + Ultralytics 文档 |
| **OWLv2 / OWL-ViT** | HF pipeline 输出 box（框架内归一化/像素需按版本核对） | — | text/image-conditioned 检测，box+scores+labels | 是 | 按 HF 版本文档 | 【论文】+ HF 文档（本次未抓取，标不确定） |
| **Gemini 2.x / 3.x** | 归一化，`[ymin,xmin,ymax,xmax]`（**y 在前！**） | `0..1000` | `{"box_2d":[ymin,xmin,ymax,xmax],"label":"..."}` | 是 | `x_px=x/1000*W`, `y_px=y/1000*H` | 【官方】Google Gemini cookbook |
| **GPT-4o / GPT-5** | 无官方 bbox 输出协议；靠 prompt 约定 | 不确定 | 纯文本/JSON，需自定格式 | 视 prompt | 需解析 + 自校验 | 【二手】/不确定（见 §1.3） |
| **SAM 2 / SAM** | 输入 box/point prompt，输出 mask | — | 分割模型，不直接出 bbox；由 mask 求紧框 | 每个 prompt 一个 mask | mask → `bbox = tight(mask)` | 【论文】 |

### 1.1 Qwen 三代坐标的证据链（重点）

- **Qwen2-VL【官方】**：论文明确 "bounding box coordinates are normalized within [0, 1000) and represented as (Xtop left,Ytop left),(Xbottom right,Ybottom right)"，并用 `<|box_start|>/<|box_end|>`、`<|object_ref_start|>/<|object_ref_end|>` 分隔。来源：[arXiv 2409.12191, §2.2.1](https://arxiv.org/html/2409.12191v1)。
- **Qwen2.5-VL【官方】**：技术报告 §2.1.2 与 §2.2.1 明确 "Unlike traditional models that normalize coordinates, our model directly uses the actual dimensions of the input image to represent bounding boxes, points, and other spatial features."。来源：[arXiv 2502.13923](https://arxiv.org/html/2502.13923v1)。
- **Qwen2.5-VL 官方换算公式【官方仓库回复，非正式文档】**：Qwen 仓库维护者在 issue 中给出：
  - `resized_h, resized_w = smart_resize(img_h, img_w, factor=28 或 32, min_pixels, max_pixels)`（Qwen2.5-VL 用 28，Qwen3-VL 用 32；官方 processor 推理时自动做，但训练 GT 需要自己算）；
  - **2.5-VL**：`resized_bbox = round(ori_bbox / [img_w,img_h,img_w,img_h] * [resized_w,resized_h,resized_w,resized_h])`，即模型输出对应 resize 后的绝对像素；
  - **3-VL**：`resized_bbox = round(ori_bbox / [img_w,img_h,img_w,img_h] * [1000,1000,1000,1000])`，即 0–1000 归一化；
  - 并明确建议："it is recommended to use option A for qwen2.5-vl and option B for qwen3-vl"。来源：[QwenLM/Qwen3-VL issue #1616 comment](https://github.com/QwenLM/Qwen3-VL/issues/1616#issuecomment-3408996327)。
- **Qwen2.5-VL 输出 JSON 格式【官方】**：官方博客给的多目标 grounding 示例即 `{"bbox_2d":[341,258,397,360],"label":"motorcyclist"}`，并称"stable JSON outputs for coordinates"，说明 2.5-VL 的默认 grounding 输出是 JSON 而非特殊 token。来源：[Qwen2.5-VL 官方博客](https://qwenlm.github.io/blog/qwen2.5-vl/)。
- **Qwen3-VL 归一化【官方】**：技术报告 §3.2.4 原文 "Different from Qwen2.5-VL, we adopt a normalized coordinate system scaled to the range [0,1000] in this version. This design improves robustness to variations in image resolution and aspect ratio..."。来源：[arXiv 2511.21631](https://arxiv.org/html/2511.21631v1)。官方 README 的 cookbook 描述也写 "Using relative position coordinates, it supports both boxes and points"（[Qwen3-VL README](https://github.com/QwenLM/Qwen3-VL/blob/main/README.md)）。
- **二次 resize 风险【二手，但来自官方 issue】**：有用户用 LM Studio/MLX 量化版 qwen2.5-vl 时发现坐标对不上，原图按 `smart_resize` 尺寸换算无效；官方 DashScope API 上同一套代码可对齐。说明**坐标对应的尺寸与推理侧 resize 实现强绑定**。来源：[QwenLM/Qwen3-VL issue #1030](https://github.com/QwenLM/Qwen3-VL/issues/1030)。
- **多图输入【官方】**：Qwen3-VL README 提供 `add_vision_id=True`，模板会生成 `Picture 1:`、`Picture 2:` 前缀，用于区分多图；文档说明多图场景"helpful to add labels"。来源：[Qwen3-VL README · Add ids for Multiple Visual Inputs](https://github.com/QwenLM/Qwen3-VL/blob/main/README.md)。

> ⚠️ 版本行为提醒：
> - “Qwen2.5-VL 也支持 0–1000 归一化”这一说法在社区中广泛流传，但**与官方技术报告冲突**；本项目应以其训练/推理实际行为为准，即默认按“resize 后绝对像素”处理，且用启动标定兜底（§3.2）。
> - Qwen2.5-VL 的 32B 版本是 2025-03 发布（见 [Qwen3-VL README News](https://github.com/QwenLM/Qwen3-VL/blob/main/README.md)），技术报告 v1 只覆盖 3B/7B/72B，32B 的坐标行为沿用同一套训练数据规范（推断，非逐字证据）。

#### 1.1.1 版本识别与上线自检清单（必做）

- [ ] 用 `GET /v1/models` 或配置里的模型名确认实际模型标识（`qwen2.5-vl-32b-instruct` vs `qwen3-vl-*`）；不要只信 UI 显示名。
- [ ] 网关是否支持 `response_format`/`structured_outputs`：发一个最小 JSON Schema 请求，看返回是否严格符合。
- [ ] 发 3 张标定图，记录返回坐标的 `max` 与分布；按 §3.2 判定坐标模式（normalized_1000 / absolute_px / 未知）。
- [ ] 同一张图分别按原尺寸与 ×2 尺寸发送，比较坐标比值是否等于尺寸比：可区分“相对归一化”与“绝对像素”。
- [ ] `max_tokens` 是否足够：每框 JSON 约 80–150 tokens，20 框 + 描述 ≈ 2000–3000 tokens；现有默认 `max_tokens: 500`（`requestChat`）对多框明显偏小。
- [ ] 检查前后端是否有人对 bbox 二次缩放（典型 bug：把 normalized 当像素又乘一次宽高）。
- [ ] 检查 `temperature`：现有调用固定 0（`model.ts:168`），利于稳定；但做多采样投票时需要显式提高温度或改 prompt 扰动。

### 1.2 其他可选项（开放词表检测 / 专用定位模型）

- **Florence-2【官方/论文】**：微软多任务统一模型，用任务 token 切换任务，`<OD>`、`<CAPTION_TO_PHRASE_GROUNDING>`、`<OPEN_VOCABULARY_DETECTION>`、`<DENSE_REGION_CAPTION>`、`<REGION_PROPOSAL>`、`<REFERRING_EXPRESSION_SEGMENTATION>` 等；坐标被量化成 `<loc_0>`~`<loc_999>` 的 1000 bins。HF `Florence2Processor` 的 `quantize_bins=(1000,1000)`、`dequantize` 用 `(bin+0.5)*(W/1000)` 还原到原图像素。**结论：坐标可行，但模型能力偏“通用 caption/检测”，中文违禁物长尾与遮挡鲁棒性不如现代 Qwen3-VL；作为轻量备选。** 来源：[arXiv 2311.06242](https://arxiv.org/abs/2311.06242)、[Microsoft 论文页](https://www.microsoft.com/en-us/research/publication/florence-2-advancing-a-unified-representation-for-a-variety-of-vision-tasks/)、[transformers processing_florence2.py](https://github.com/huggingface/transformers/blob/main/src/transformers/models/florence2/processing_florence2.py)。
- **Grounding DINO【官方/论文】**：开放词表检测，输入 `(image, text)`，输出 900 个 query 的归一化 `cxcywh` + 每词相似度；官方 README 称 COCO zero-shot 48.4 AP（T）/56.7 AP（B），摘要宣称 52.5 AP。推理代码 `predict()` 返回 box 为归一化 `cxcywh`，`annotate()` 里 `boxes*[w,h,w,h]` 再转 `xyxy`。**适合当“先检测”的候选框生成器**，尤其词表是封闭禁用物清单时。来源：[arXiv 2303.05499](https://arxiv.org/abs/2303.05499)、[README](https://github.com/IDEA-Research/GroundingDINO)、[inference.py](https://github.com/IDEA-Research/GroundingDINO/blob/main/groundingdino/util/inference.py)。
- **YOLO-World（Ultralytics）【官方/论文】**：实时开放词表检测，`set_classes(["person","bus"])` 动态设词表，COCO zero-shot `mAP50-95` 37.4–47.1（s–x 各档），可离线保存词表。**适合边缘/本地实时预筛，不适合长尾细类语义判断。** 来源：[arXiv 2401.17270](https://arxiv.org/abs/2401.17270)、[Ultralytics YOLO-World 文档](https://docs.ultralytics.com/models/yolo-world/)。
- **OWLv2 / OWL-ViT【论文】**：自训练扩展开放词表检测，LVIS rare 类 AP 31.2→44.6。适合作为“候选框 + 开放词”生成，但工程集成成本高于 Grounding DINO（本次未核对 HF 输出坐标细节，标不确定）。来源：[arXiv 2306.09683](https://arxiv.org/abs/2306.09683)。
- **SAM 2 / SAM【论文】**：promptable segmentation，支持 box/point prompt；**不是检测器**，但可以“用 VLM 粗框当 prompt → mask → 紧 bbox”把框精修到物体轮廓，同时用 mask 面积/形状过滤幻觉框。来源：[arXiv 2408.00714](https://arxiv.org/abs/2408.00714)、[SAM 2 代码库](https://github.com/facebookresearch/sam2)。

### 1.3 Gemini 与 GPT 的 bbox 能力

- **Gemini 2.x/3.x【官方】**：官方 cookbook（Apache-2.0）明确：模型"is trained to always use this format with a label and the coordinates of the bounding box in a `box_2d` array"；**y 坐标在前（`[ymin,xmin,ymax,xmax]`）**；归一化到 0–1000，绘图代码为 `abs_y1 = int(box_2d[0]/1000*height)`、`abs_x1 = int(box_2d[1]/1000*width)`。并提醒 "There's no 'magical prompt'"。来源：[google-gemini/cookbook · Spatial_understanding.ipynb](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Spatial_understanding.ipynb)、[Gemini API Image understanding 文档](https://ai.google.dev/gemini-api/docs/image-understanding)。
  - **不确定项**：Gemini 1.5 时代的 Object detection 示例在官方 cookbook 的 `gemini-1.5-archive` 分支，坐标约定可能是另一套（0–1）；若接入 Gemini 必须按具体模型代际核对，本次未逐条验证。
- **GPT 系列【不确定】**：OpenAI 没有像 Gemini 那样的官方 bbox 输出协议/文档章节；必须 prompt 约定格式，且没有“坐标归一化范围”的官方承诺。**结论：不建议作为本项目主定位模型**；如要用，必须按 §3.5 做严格自校验与人工复核。本次调研未找到可引用的官方 bbox 准确率数据（明确标注不确定）。

---

## 2. 可靠性证据

### 2.1 公开 benchmark 的“上限”在哪

- Qwen2.5-VL 在 RefCOCO/+/g 的 `Acc@0.5`（单目标指代、干净图、IoU≥0.5 即算对），第三方论文表格引用：**Qwen2.5-VL-7B 平均 86.6**（RefCOCO val 90.0 / testA 92.5 / testB 85.4；RefCOCO+ val 84.2 / testA 89.1 / testB 76.9；RefCOCOg 87.2），**Qwen2.5-VL-72B 平均 90.3**。32B 在同表“工具条件下”约 testA 89.9–95.1、testB 82.1–90.8 区间（受 PiTER 协议影响，非纯模型裸跑）。来源：【论文】[VG-Refiner, arXiv 2512.06373, Table 1/3](https://arxiv.org/html/2512.06373v1)。
- **解读**：这是“单目标 + clean + IoU 0.5”的宽松指标，不是多目标检测 mAP。多目标、遮挡、小目标、视频压缩伪影下会明显下降；因此**不能把 86–90 当作本项目预期**。
- 开放词表检测器的参考量级（用于“先检测”路线）：Grounding DINO COCO zero-shot 48.4–56.7 AP；YOLO-World COCO mAP50-95 37.4–47.1。来源同上（【官方】README/文档）。

### 2.2 已知失败模式（有出处）

1. **检测工具的框常常不准，会误导下游 VLM 产生幻觉推理**。VG-Refiner 论文开篇即指出 "inaccurate detection tool predictions often mislead TiVR models into generating hallucinated reasoning"，并说明 REC 场景中检测工具 "frequently produce inaccurate or misleading results"。来源：【论文】[arXiv 2512.06373](https://arxiv.org/html/2512.06373v1)。
2. **VLM 自己的 grounding 训练数据也是“机器合成 + 过滤”的**。Qwen3-VL 技术报告 §3.2.4 描述其 box grounding 数据来自 COCO/Objects365/OpenImages/RefCOCO + 合成管线：先用 Qwen2.5-VL 提候选，再用 Grounding DINO 与 Qwen2.5-VL 标注，然后按置信度/准确性过滤。说明**单模型直接标注天然带噪**，官方都要靠“多模型 + 过滤”。来源：【官方】[Qwen3-VL 技术报告](https://arxiv.org/html/2511.21631v1)。Qwen2.5-VL 报告同样提到用 Grounding DINO 和 SAM 合成数据（【官方】[arXiv 2502.13923](https://arxiv.org/html/2502.13923v1)）。
3. **小目标检测是公认难点**：SAHI 论文指出小目标/远处目标像素少、细节不足，常规检测器难检出；在 VisDrone/xView 上，切片推理可把 FCOS/VFNet/TOOD 的 AP 提升 6.8%/5.1%/5.3%，切片微调再叠加可达 12.7%/13.4%/14.5%。→ 对“画面角落的手机/桌面小物件”必须 tiling。来源：【论文】[arXiv 2202.06934](https://arxiv.org/abs/2202.06934)。
4. **resize 不一致直接导致框错位**：官方 issue 中量化模型/LM Studio 场景出现“abs_x1 对但其余坐标被整体缩放”的现象，根因是内部 resize 与假设不一致。来源：【二手/官方仓库 issue】[#1030](https://github.com/QwenLM/Qwen3-VL/issues/1030)。
5. **多图场景没有可靠的坐标归属机制**：官方只提供 `Picture 1:` 文本前缀（`add_vision_id`）帮助模型区分图片，没有任何“坐标必须绑定到某张图”的强制约束。来源：【官方】[Qwen3-VL README](https://github.com/QwenLM/Qwen3-VL/blob/main/README.md)。
6. **旧坐标格式兼容问题**：Qwen2.5-VL 默认 JSON `bbox_2d`，若误用 Qwen2-VL 的 `<|box_start|>` 提示与解析逻辑，会得到空结果或解析失败；vLLM 在 Qwen3-VL 部署文档里也强调 `transformers>=4.57.0`、`vllm>=0.11.0` 等版本要求。来源：【官方】[Qwen3-VL README](https://github.com/QwenLM/Qwen3-VL/blob/main/README.md)。

### 2.3 缺失/不确定的量化证据

- 公开来源**没有**针对“VLM 在会议室监控帧上输出多框”的 IoU 误差分位数（P10/P50/P90）、小目标漏检率、遮挡召回率统计。网上零散博客不可作为依据。→ **必须自建标定集测**（§5）。
- GPT 系列 bbox 的官方能力边界无文档；Gemini 的 bbox 精度也缺官方定量指标。两者都标为不确定。

### 2.4 误差来源分解（工程推断，用于排障排序）

| 误差来源 | 典型表现 | 是否可离线测 | 缓解手段 |
|---|---|---|---|
| 坐标空间/resize 不匹配 | 框整体等比例缩小/偏移，所有框同向错 | 可（标定图） | §3.2 恒等 resize + 标定 + 范围校验 |
| 模型定位能力上限 | 框大致对但边缘不准（IoU 0.4–0.7），小目标漏 | 可（评测集） | tiling、crop 复检、SAM2 精修 |
| 训练数据噪声 | 相似物体混淆、把海报/屏幕图案当实物 | 可（难例集） | prompt 约束 + 二次确认 + 人审 |
| 遮挡/截断 | 只框可见部分或框到遮挡物 | 可（分层评测） | 专门标注遮挡样本，`visibility` 字段 |
| prompt 敏感 | 换措辞后框数量/位置变化大 | 可（消融） | 固定模板 + 少样本示例 + 输出约束 |
| 解析/格式错误 | 字段缺失、坐标字符串、JSON 截断 | 可（单测） | JSON 修复、schema 约束、重试 |

> 排障顺序建议：先排除坐标空间问题（否则会把“系统性错位”误判成“模型不准”），再评估模型能力，最后调 prompt。

---

## 3. 工程化补偿手段（按优先级）

### 3.1 角色分工：VLM 不负责精确框

推荐流水线（从便宜到贵）：

```
ffmpeg 抽帧
  → 帧级 VLM 判定（现有能力，先判断 abnormal + categories）
  → 若 abnormal：进入定位分支
       A. 开放词表检测器（Grounding DINO / YOLO-World）对禁用物词表出候选框
       B. 无检测器时：VLM 单图直接出粗框（本报告 §4 prompt）
  → 候选框裁切放大 + 二次 VLM 确认（crop & recheck）
  → tiling（SAHI 式）+ 全图结果合并
  → 多次采样 / 多提示 IoU 聚类投票
  → SAM2 box-prompt 精修（可选，若需贴合物体的紧框）
  → 坐标自校验 + 原始图像素归一 → 前端画框 + 人审队列
```

### 3.2 坐标空间标定（本项目的头号工程问题）

对 **qwen2.5-vl-32b-instruct**，按以下步骤消除“内部 resize 不可见”：

1. **自己先做恒等化 resize**：把抽帧 PNG 缩放到长边约 1000–1280、宽高均为 `28` 的整数倍、像素面积处于常见 `min_pixels/max_pixels` 区间内（Qwen2.5-VL 的 patch/压缩比是 28，见官方技术报告 §2.1）。这样推理侧 `smart_resize` 大概率是恒等变换，即使不是，缩放比例也可由我们自己的发送尺寸推出。
2. **请求里带“发送图尺寸”元信息**（在 prompt 文本里写明 `image_width/resized_width` 或让模型不关心，服务端自己记），解析时用 `x_orig = x_model * (orig_w / sent_w)`。
3. **启动标定（推荐必做）**：构造一张或多张合成标定图（纯色背景，在已知归一化坐标画 2–3 个矩形 + 文字标签），发一次 grounding 请求；把模型返回坐标与期望坐标做线性回归，得到 `scale_x, scale_y, offset`。若 `max(coord) <= 1100` 且明显集中在 0–1000 → 归一化模式；若坐标接近 sent_w/sent_h → 绝对像素模式；若都解释不通 → 该端点不可用于定位，降级为“只判定不出框”。缓存标定结果（按 baseUrl+model 键）。
4. **运行期兜底**：解析时若 `x2 > W*1.5` 或 `y2 > H*1.5`，按“模型内部尺寸未知”处理：先按 `maxCoord` 推断缩放分母（`scale = maxCoord/1000` 等启发式），并把这些框标记 `needs_review=true`，不要静默画到前端。

> 对 **Qwen3-VL**：直接用 `x_px = x/1000*W`，无需 resize 恒等化；但仍需 clamp（模型可能输出 1000+ 或负值）。

参考实现（TypeScript，放进 `src/main/` 的坐标工具模块）：

```ts
type CoordSpace = 'normalized_1000' | 'absolute_px'

/** qwen2.5-vl: 把图缩到 28 倍数、长边 ≤1280，使推理侧 smart_resize 尽量恒等 */
export function resizeForQwen25Vl(w: number, h: number): { w: number; h: number } {
  const factor = 28
  const maxLong = 1280
  const scale = Math.min(1, maxLong / Math.max(w, h))
  const rw = Math.max(factor, Math.floor((w * scale) / factor) * factor)
  const rh = Math.max(factor, Math.floor((h * scale) / factor) * factor)
  return { w: rw, h: rh }
}

/** 把模型返回框换算成“原始帧像素”，并返回是否可信 */
export function toOriginalBox(
  box: number[],
  space: CoordSpace,
  sent: { w: number; h: number },
  orig: { w: number; h: number }
): { x1: number; y1: number; x2: number; y2: number; suspicious: boolean } {
  let [x1, y1, x2, y2] = box
  let suspicious = false
  if (space === 'normalized_1000') {
    if (Math.max(x1, y1, x2, y2) > 1010) suspicious = true // 越界
    x1 = (x1 / 1000) * orig.w; x2 = (x2 / 1000) * orig.w
    y1 = (y1 / 1000) * orig.h; y2 = (y2 / 1000) * orig.h
  } else {
    const sx = orig.w / sent.w, sy = orig.h / sent.h
    if (Math.max(x1, y1, x2, y2) > Math.max(sent.w, sent.h) * 1.2) suspicious = true
    x1 *= sx; x2 *= sx; y1 *= sy; y2 *= sy
  }
  if (x1 > x2) [x1, x2] = [x2, x1]
  if (y1 > y2) [y1, y2] = [y2, y1]
  return { x1, y1, x2, y2, suspicious }
}
```

### 3.3 Tiling / 滑窗（小目标必做）

- 做法：对每帧生成 1 张全图 + 2×2（或 3×3）重叠 tile（overlap 15–25%）；每张 tile 单独请求/检测；把 tile 坐标加偏移回投到全图；NMS/聚类合并。
- 证据：SAHI 在 VisDrone/xView 上对三种检测器 AP 提升 5.1–6.8%，切片微调再叠加到 12.7–14.5%（【论文】[arXiv 2202.06934](https://arxiv.org/abs/2202.06934)）。
- 成本控制：仅对“首轮 abnormal 或画面中存在候选”的帧做 tiling；tile 可降分辨率；每帧并发上限+超时。

### 3.4 裁切二次确认（crop & recheck）

- 对候选框外扩 1.2–1.5 倍（保留上下文），裁剪后放大到模型友好尺寸（长边 ~800–1024），再发一次“只回答：该裁剪中是否存在 X？给出紧框”。
- 好处：① 大幅提高小目标清晰度；② 二次确认降低误报；③ 返回的紧框可与首轮框做 IoU 一致性检查。
- 坐标回映射：`x_full = x_crop * (crop_w / sent_w) + crop_x0`，注意裁剪边界截断。

### 3.5 坐标自校验（服务端解析层）

对每个 `bbox_2d` 依次执行：

1. 数值合法性：4 个有限数字；若为百分比字符串（`"12.3%"`）→ 解析后除以 100。
2. 单调性：`x1<x2, y1<y2`（否则交换并记 warning）。
3. 范围：clamp 到 `[0, W]/[0, H]`；若 `> 边界*1.05` 视为坐标空间异常（触发 §3.2 启发式，不要 clamp 后直接用）。
4. 最小面积：`area >= 0.0005 * W*H`（约万分之五，可按项目调），否则丢弃并记 `too_small`。
5. 最大面积：`area <= 0.95 * W*H`，否则视为“整图幻觉框”丢弃。
6. 去重：同 label 且 IoU>0.7 的框合并（保留 confidence 高者）。
7. 置信度：`score < 阈值` → `need_human_review=true`，前端用虚线框。
8. 数量上限：每帧/每类最多 N 个（例如 20），防止模型刷框。

参考实现（与前端共享的 `shared` 类型，最终只存原图像素 `xyxy`）：

```ts
interface DetectedObject {
  label: string
  bbox: { x1: number; y1: number; x2: number; y2: number } // 原始帧像素
  confidence: number
  visibility: 'clear' | 'partial' | 'occluded' | 'blurry' | 'tiny'
  evidence: string
  needHumanReview: boolean
}

function validateObjects(
  objects: DetectedObject[],
  W: number,
  H: number,
  opts = { minAreaRatio: 0.0005, maxAreaRatio: 0.95, maxPerFrame: 20, duplicateIou: 0.7 }
): DetectedObject[] {
  const frameArea = W * H
  const kept: DetectedObject[] = []
  for (const obj of objects.slice(0, opts.maxPerFrame)) {
    const { x1, y1, x2, y2 } = obj.bbox
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue
    const w = Math.min(W, Math.max(0, x2)) - Math.min(W, Math.max(0, x1))
    const h = Math.min(H, Math.max(0, y2)) - Math.min(H, Math.max(0, y1))
    if (w <= 1 || h <= 1) continue
    const ratio = (w * h) / frameArea
    if (ratio < opts.minAreaRatio || ratio > opts.maxAreaRatio) continue
    if (obj.confidence < 0.3) obj.needHumanReview = true
    kept.push(obj)
  }
  // 同 label 高 IoU 去重，保留 confidence 最高者（略，见 §3.6 聚类）
  return kept
}
```

### 3.6 多次采样 / IoU 聚类投票（降幻觉）

- 由于现有调用固定 `temperature: 0`，可通过 **提示词扰动**（不同描述顺序、是否要求先列举再出框）+ **tiling 变体** 得到 k=3–5 组结果；对全部框按 label 做 IoU 聚类，保留“support ≥ 2”的簇，框坐标取簇内中位数；`support=k/k` 的框给高置信。
- 方法参考：self-consistency（多采样投票，[arXiv 2203.11171](https://arxiv.org/abs/2203.11171)）、Weighted Boxes Fusion（框集成，[arXiv 1910.13302](https://arxiv.org/abs/1910.13302)）；这是通用方法，未在本项目数据上验证。
- 成本：k 倍调用；建议只对“已判定 abnormal 且需要出框”的帧执行。

### 3.7 SAM2 精修（可选，第二阶段）

- 把粗框作为 box prompt 输入 SAM2，得到 mask；由 mask 求紧 bbox，通常能把 VLM 的“松散框”收紧到物体轮廓。
- 用 mask 做合理性过滤：mask 面积/bbox 面积比过低、mask 碎片化 → 疑似幻觉框，降级或丢弃。
- 代价：需要本地部署 SAM2（GPU）或调用分割服务；建议只在人工复核界面“精修”按钮触发，不进入全自动链路。
- 来源：【论文】[SAM 2, arXiv 2408.00714](https://arxiv.org/abs/2408.00714)（box/point prompt 是 promptable segmentation 的标准输入）。

### 3.8 多图 / 分组场景的坐标归属

- **强建议**：分组请求（一请求多帧）只做“逐帧 abnormal/categories/evidence”判定（现有能力），**不要在同一请求里出多帧坐标**。
- 若必须多帧同请求出框：① 每张图前加显式文本 `Picture i (frame_index=i):`（对齐 Qwen `add_vision_id` 机制）；② JSON 里每帧独立 `objects` 数组并带 `frame_index`；③ 服务端按 `frame_index` 拆分后，**对每帧再单独发一次单图定位请求做交叉验证**，不一致则进人审。
- 原因：坐标是相对“某一张图”的，多图拼接会让模型在“图 i 的坐标系/图 j 的坐标系”之间漂移（官方只提供文本前缀，无强制约束）。

### 3.9 结构化输出 / vLLM / SGLang

- **vLLM【官方】**：支持 Structured Outputs，后端 `xgrammar` 或 `guidance`；OpenAI 兼容服务端可用 `response_format={"type":"json_schema","json_schema":{...}}` 或 `extra_body={"structured_outputs":{...}}`；旧的 `guided_json` 等在 v0.12.0 起被移除。注意：约束只保证**语法合法**，不保证框的**语义/空间正确**。来源：[vLLM Structured Outputs 文档](https://docs.vllm.ai/en/latest/features/structured_outputs/)。
- **SGLang【官方】**：文档有 Structured Outputs 章节（JSON schema/正则等约束）；具体后端与版本相关，部署前需在所选版本验证。来源：[SGLang Structured Outputs](https://docs.sglang.io/docs/advanced_features/structured_outputs)。Qwen3-VL 官方 README 给出 SGLang 启动命令（`python -m sglang.launch_server ...`），说明模型本身可被 SGLang 服务。
- **DashScope / 第三方 OpenAI 兼容端点【不确定】**：是否透传 `response_format`/guided decoding 取决于网关实现；不能假设生效。工程上必须保留：严格 prompt + JSON 提取（现有 `extractJsonValue` 已有括号平衡逻辑）+ 解析失败重试（现有 `analyzeSingleFrame` 已重试 1 次，可扩到 2 次并加“只输出 JSON”的修复提示）。
- **Qwen2.5-VL 与特殊 token 的关系**：官方博客的 grounding 示例是纯 JSON，不需要 `<|box_start|>` 特殊 token；用 JSON 更适配 OpenAI 兼容接口（特殊 token 可能被网关过滤）。

---

## 4. 推荐 prompt 草案与 JSON 契约

> 目标：直接可粘进 `src/main/model.ts` 的 `systemPrompt()`（现有实现在第 75–88 行）。下面给“归一化版”（Qwen3-VL / Gemini 型）与“qwen2.5 绝对像素版”两种；服务端按模型名选择。**推荐统一让模型输出 `normalized_1000`，仅 qwen2.5-vl 走绝对像素版。**

### 4.1 system prompt 草案（归一化 0–1000，Qwen3-VL / 通用）

```text
你是一名会议室监控视频的合规审核员，负责对视频抽帧进行辅助审核。
本任务需要检查的禁用物品是：${items.descriptions.join('；')}。

【判定原则】
1. 只依据图片中清晰可见的内容判断，不要依据人物姿态、口袋轮廓、手部动作、环境推测物品存在。
2. 画面中的文字、屏幕内容、海报图案、镜面反射均不是实体物品，不得据此判定异常。
3. 物品被遮挡、画面模糊、目标过小或无法确认时：仍可给出候选框，但必须把该框的 confidence 调低（≤0.5）并把 need_human_review 设为 true，不要编造证据。
4. 只判断上面列出的禁用物品，不判断其他类型的异常。

【定位输出规则】
1. 对每个可见的禁用物品输出一个框；同一物品只输出一个框；没有则返回空数组，禁止为了凑数而输出框。
2. bbox_2d 的坐标空间固定为 normalized_1000：[x1, y1, x2, y2]，全部为 0 到 1000 的整数。
3. 坐标系原点在左上角：x 向右增大，y 向下增大；必须满足 x1 < x2 且 y1 < y2。
4. 框必须紧贴物品的可见外轮廓（含被遮挡部分时框住可见部分），不要框住大片背景。
5. 每帧最多输出 20 个框；同一物品出现多个实例时分别输出。
6. label 必须使用上面禁用物品清单中的中文名称，不要自造新类别。

【输出格式】
只返回一个合法 JSON 对象，不要使用 Markdown 代码块，不要添加任何解释性文字。字段：
{
  "abnormal": true,
  "risk_level": "high",
  "categories": ["手机"],
  "objects": [
    {
      "label": "手机",
      "bbox_2d": [612, 380, 668, 425],
      "coordinate_space": "normalized_1000",
      "confidence": 0.82,
      "visibility": "clear",
      "evidence": "画面左侧桌面上的黑色手机，屏幕朝上",
      "need_human_review": false
    }
  ],
  "description": "画面左侧桌面出现一部手机",
  "evidence": "手机位于桌面左上区域，清晰可见",
  "confidence": 0.8,
  "need_human_review": false
}
说明：
- objects 仅在 abnormal=true 时非空；abnormal=false 时 objects 必须为 []，categories 为 []。
- bbox_2d 为整数；如模型只能输出小数，保留 1 位小数并在 coordinate_space 中注明 "normalized_1000_float"。
- 不确定的框：confidence ≤ 0.5 且 need_human_review=true。
```

### 4.2 qwen2.5-vl-32b-instruct 专用变体（绝对像素）

仅替换【定位输出规则】与 `coordinate_space` 字段：

```text
【定位输出规则（qwen2.5-vl 绝对像素版）】
1. bbox_2d 的坐标空间固定为 absolute_px：[x1, y1, x2, y2]，单位是像素。
2. 坐标必须相对于“本次请求实际输入给模型的这张图片”的宽高（图片宽 W_used、高 H_used）；必须满足 0 ≤ x1 < x2 ≤ W_used、0 ≤ y1 < y2 ≤ H_used。
3. 框必须紧贴物品的可见外轮廓，不要框住大片背景；同一物品只输出一个框；没有则 objects 为空数组。
4. 每帧最多输出 20 个框；label 必须使用禁用物品清单中的中文名称。
```

并在 `objects[]` 中要求：

```json
{
  "label": "手机",
  "bbox_2d": [612, 380, 668, 425],
  "coordinate_space": "absolute_px",
  "confidence": 0.82,
  "visibility": "clear",
  "evidence": "……",
  "need_human_review": false
}
```

> 服务端解析：`absolute_px` 必须除以“发送给模型的图片尺寸”（由本应用记录，不是原始帧尺寸）得到归一化值，再乘原始帧尺寸；若无法确定发送尺寸，直接判 `needs_review`。
>
> 推荐实现：**在发送前把帧 resize 成长边 ≤1280、宽高为 28 倍数的 PNG**，并在请求元数据/日志中记录 `sent_w/sent_h`；解析时 `x_orig = x_abs * orig_w / sent_w`。

### 4.3 分组（多帧一请求）模式草案

仅用于分类/triage；如确需坐标，给每帧独立数组 + 明确前缀：

```text
下面按顺序提供同一段视频中的 N 帧，请逐帧独立判断是否出现禁用物品。
Picture 1 = frame_index 0（视频时间 00:00:03）；Picture 2 = frame_index 1（00:00:06）……
输出 JSON：
{"frames":[{"frame_index":0,"abnormal":true,"risk_level":"high","categories":["手机"],
  "objects":[{"label":"手机","bbox_2d":[...],"coordinate_space":"normalized_1000","confidence":0.7,"visibility":"clear","evidence":"...","need_human_review":true}],
  "description":"...","evidence":"...","confidence":0.7,"need_human_review":true}]}
frames 数组必须覆盖每一帧，frame_index 必须与输入帧编号一致；objects 的坐标只相对于该 frame_index 对应的那一张图。
```

### 4.4 供 vLLM / 网关用的 JSON Schema（可直接用于 `response_format`）

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["abnormal", "risk_level", "categories", "objects", "description", "evidence", "confidence", "need_human_review"],
  "properties": {
    "abnormal": {"type": "boolean"},
    "risk_level": {"enum": ["high", "medium", "low", "none"]},
    "categories": {"type": "array", "items": {"type": "string"}},
    "objects": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["label", "bbox_2d", "coordinate_space", "confidence", "visibility", "evidence", "need_human_review"],
        "properties": {
          "label": {"type": "string"},
          "bbox_2d": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "number"}},
          "coordinate_space": {"enum": ["normalized_1000", "normalized_1000_float", "absolute_px"]},
          "confidence": {"type": "number", "minimum": 0, "maximum": 1},
          "visibility": {"enum": ["clear", "partial", "occluded", "blurry", "tiny"]},
          "evidence": {"type": "string"},
          "need_human_review": {"type": "boolean"}
        }
      }
    },
    "description": {"type": "string"},
    "evidence": {"type": "string"},
    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    "need_human_review": {"type": "boolean"}
  }
}
```

**兼容/兜底策略**（网关不支持 `response_format` 时必须）：

1. `extractJsonValue` 失败 → 追加一次“修复请求”：把模型原始输出回传，要求“只输出修复后的 JSON，不要解释”。
2. 常见修复：去掉 ```json 围栏、补全被截断的 `]}`、把坐标字符串 `"612"` 转数字、把 `bbox_2d` 为 2 个数的点坐标扩展为 4 个数（点坐标时用 `[x-5,y-5,x+5,y+5]` 近似，标 `needs_review`）。
3. 仍失败 → 该帧降级为“只判定不出框”，`need_human_review=true`。
4. 多框输出时 `max_tokens` 至少给到 `600 + 150*maxBoxes`；若返回 `finish_reason=length`，直接重试并降低最大框数。

### 4.5 与现有代码的接入点（只读分析，本次不改代码）

- `src/main/model.ts:75-88` `systemPrompt()`：替换为 §4.1/4.2 版本（按 `config.model` 选择坐标模式）。
- `src/main/model.ts:96-113` `buildSingleMessages()`：可加入“本次输入图片宽高”文本（若走绝对像素版）。
- `src/main/model.ts:115-148` `buildGroupMessages()`：分组结构建议保持“只判定”，暂不扩坐标。
- `src/main/model.ts:403-445` `parseAnalysisObject()`：新增 `objects` 解析；复用 `normalizeConfidence`、`toStringArray`；新增 bbox 校验函数（§3.5）。
- `src/main/model.ts:295-336` `extractJsonValue()`：现有 JSON 提取/括号平衡逻辑可复用；建议保底再增加“截断修复”（补 `]}`）与一次重试。
- `src/shared/types.ts`：新增 `BBox`、`DetectedObject` 类型与 `coordinate_space` 字段（前端统一用原始帧像素 `xyxy`）。
- `src/main/ffmpeg.ts`：抽帧后如需发送前缩放，新增 `sent_w/sent_h` 记录（不要把缩放后的图当原图存）。

---

## 5. 风险与验证计划

### 5.1 风险清单

| 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|
| 坐标空间判断错误（2.5 绝对像素 vs 3.0 归一化） | 所有框整体错位/缩放，功能不可用 | 高 | 按模型名分支 + 启动标定 + 范围自校验 |
| 推理侧内部 resize 不可见 | 框系统性偏移（尤其在非 28 倍数/超大图时） | 高 | 发送前自主 resize 恒等化 + 记录 sent_w/h + 标定 |
| 多帧一请求坐标归属错乱 | 框画到错误帧 | 中高 | 分组只做分类；出框逐帧单图；`frame_index` + 交叉验证 |
| 小目标/遮挡漏检 | 违禁物漏审 | 高 | tiling + crop 复检 + 人审兜底 |
| 幻觉框（无物品也出框） | 误报、用户不信任 | 中高 | 空数组 prompt + 多采样投票 + 面积/边界校验 + 负样本集评估 |
| 模型 JSON 格式漂移/被截断 | 解析失败、重试成本 | 中 | `max_tokens` 提高、严格 prompt、JSON 修复重试、结构化输出（若网关支持） |
| 成本/时延（每帧多请求） | 审核变慢、费用上升 | 中 | 先分类后定位；只对 abnormal 帧出框；tiling 限流；本地检测器分流 |
| 无 GT 无法量化 | 无法判断上线是否达标 | 高 | 先建 300–1000 帧标注集（§5.2） |

### 5.2 验证计划（建议按顺序执行）

1. **坐标标定实验（0.5 人日）**：合成标定图（已知位置矩形）+ 3 张真实帧；对每个候选模型/端点测：返回坐标分布 → 判定坐标模式 → 用人工框算 `IoU` 与 `scale error`。产出：每种 `baseUrl+model` 的坐标模式与换算参数。
2. **构建评测集（2–3 人日）**：300–1000 帧，按“禁用物类型 × 目标大小（大/中/小，按框面积占比分桶）× 遮挡程度（无/部分/严重）× 光照/反光”分层；每帧 2 名标注员独立标框，计算标注一致性（IoU≥0.5 视为一致），冲突仲裁。**必须包含 20% 以上负样本帧**（无禁用物）用于测误报。
3. **离线主实验**：对比 A) 现模型单图裸出框；B) +tiling；C) +crop 复检；D) +多采样投票；E) +SAM2 精修。每方案跑全评测集，记录时延/成本。
4. **指标**：
   - 定位：`Recall@IoU{0.3,0.5}`、`Precision`、`mAP@0.5`、`mean IoU` 的 `P10/P50/P90`、中心点命中率；
   - 分类：`label` 准确率、类别混淆矩阵；
   - 误报：负样本帧上的 `FP/帧`；
   - 决策：`need_human_review` 的召回率/精确率（是否把该人审的漏掉）；
   - 工程：P50/P90 单帧时延、每帧成本、解析失败率。
5. **消融**：prompt 版本（是否要求先列清单、是否限制数量）、温度/采样数、tiling 重叠率、crop 外扩倍数、置信度阈值。
6. **线上灰度**：先只对 `abnormal=true` 的帧出框，前端默认虚线提示 + “确认/修正”按钮；统计人工接受率、修正幅度（IoU 提升）、审核耗时变化。
7. **验收门槛建议（可按业务调）**：大/中目标 `Recall@0.5 ≥ 0.7`、`mean IoU P50 ≥ 0.6`、负样本 `FP/帧 ≤ 5%`、`P90 时延 ≤ 8s/帧`；不达标的类别退回“只判定不出框”。

**标注规范（给标注员，减少 GT 噪声）**：

- 框住物体**可见部分**的外接矩形；被遮挡时框可见区域，并在 `visibility` 标 `partial/occluded`。
- 最小可标边长约 8px（1080p 下）；更小的目标不标，但记 `tiny`，评测时单列一档。
- 同一物品只标一个框；多实例逐个标；类别必须来自固定禁令清单，禁止自造。
- 屏幕/海报上的物品图片：按“实物是否存在”标，禁止根据屏幕内容标框（与 prompt 原则一致）。
- 20% 负样本帧必须标“无目标”，用于测 FP；标注员间 IoU≥0.5 视为一致，冲突由第三人或规则仲裁。

**离线实验矩阵（按顺序跑，避免一次性上全套）**：

| 方案 | 做法 | 主要验证目标 | 额外成本 |
|---|---|---|---|
| A | 单图裸 prompt（§4.1/4.2） | 基线命中率/坐标正确性 | 1× |
| B | A + tiling（2×2，overlap 20%） | 小目标召回增益 | ~3–5× 调用 |
| C | B + crop 二次确认 | 误报下降、框收紧 | ~2× 额外调用 |
| D | C + 3 次 prompt 扰动投票 | 幻觉框下降 | 3× 调用 |
| E | D + SAM2 精修 | IoU 提升上限 | 本地 GPU |
| F | Grounding DINO/YOLO-World 先出框 + VLM 确认 | 成本/时延最优解 | 检测器部署 |

### 5.3 上线策略建议

- **MVP（1–2 周）**：单图 + qwen2.5-vl（绝对像素版）+ 严格 JSON + 坐标自校验 + 人审；前端画“提示框”（虚线、半透明、可拖拽修正）。
- **增强（1–2 月）**：接管本地 Grounding DINO/YOLO-World 先检测 → VLM 裁切确认；tiling；多采样投票。
- **精修（按需）**：SAM2 框→mask→紧框；或者用人工修正数据微调检测器（若误报/漏检集中）。

---

## 6. 参考链接列表

### 官方文档 / 技术报告 / 官方代码（优先引用）

1. Qwen2-VL 论文（坐标 `[0,1000)` + 特殊 token）：<https://arxiv.org/html/2409.12191v1>
2. Qwen2.5-VL 技术报告（绝对像素坐标 + smart_resize 28）：<https://arxiv.org/html/2502.13923v1>
3. Qwen3-VL 技术报告（`[0,1000]` 归一化，§3.2.4 原文）：<https://arxiv.org/html/2511.21631v1>
4. Qwen3-VL GitHub README（vLLM≥0.11.0、SGLang、`add_vision_id`、32 压缩比、cookbook 列表）：<https://github.com/QwenLM/Qwen3-VL/blob/main/README.md>
5. Qwen2.5-VL 官方博客（JSON `bbox_2d` grounding 示例）：<https://qwenlm.github.io/blog/qwen2.5-vl/>
6. Qwen 官方仓库 issue #1616（2.5-VL/3-VL 坐标换算公式，维护者回复）：<https://github.com/QwenLM/Qwen3-VL/issues/1616#issuecomment-3408996327>
7. Qwen 官方仓库 issue #1030（resize 不一致导致坐标错位案例）：<https://github.com/QwenLM/Qwen3-VL/issues/1030>
8. vLLM Structured Outputs（xgrammar/guidance、`response_format`、`structured_outputs`）：<https://docs.vllm.ai/en/latest/features/structured_outputs/>
9. vLLM Qwen2.5-VL 部署 recipe：<https://docs.vllm.ai/projects/recipes/en/latest/Qwen/Qwen2.5-VL.html>
10. SGLang Structured Outputs 文档：<https://docs.sglang.io/docs/advanced_features/structured_outputs>
11. Google Gemini 官方 cookbook · 2D spatial understanding（`box_2d`、0–1000、y 在前）：<https://github.com/google-gemini/cookbook/blob/main/quickstarts/Spatial_understanding.ipynb>
12. Gemini API Image understanding 文档（object detection 章节）：<https://ai.google.dev/gemini-api/docs/image-understanding>
13. Florence-2 论文：<https://arxiv.org/abs/2311.06242>
14. HuggingFace transformers `processing_florence2.py`（loc bins 0–999、dequantize 公式）：<https://github.com/huggingface/transformers/blob/main/src/transformers/models/florence2/processing_florence2.py>
15. Grounding DINO 论文：<https://arxiv.org/abs/2303.05499>
16. Grounding DINO README（开放词表、COCO zero-shot AP）：<https://github.com/IDEA-Research/GroundingDINO>
17. Grounding DINO `inference.py`（归一化 cxcywh → 像素 xyxy）：<https://github.com/IDEA-Research/GroundingDINO/blob/main/groundingdino/util/inference.py>
18. YOLO-World 论文：<https://arxiv.org/abs/2401.17270>
19. Ultralytics YOLO-World 文档（`set_classes`、COCO zero-shot mAP）：<https://docs.ultralytics.com/models/yolo-world/>
20. OWLv2 论文（开放词表检测 + 自训练）：<https://arxiv.org/abs/2306.09683>
21. SAM 2 论文：<https://arxiv.org/abs/2408.00714>
22. SAM 2 代码库：<https://github.com/facebookresearch/sam2>

### 论文 / 方法（用于工程化补偿）

23. SAHI：小目标切片推理（AP 提升 5.1–6.8%，微调再 +12.7–14.5%）：<https://arxiv.org/abs/2202.06934>
24. VG-Refiner：RefCOCO 上 Qwen2.5-VL 7B/72B 的 `Acc@0.5` 数据 + “检测工具输出不可靠会引发幻觉”论述：<https://arxiv.org/html/2512.06373v1>
25. Self-consistency（多采样投票方法参考）：<https://arxiv.org/abs/2203.11171>
26. Weighted Boxes Fusion（框集成方法参考）：<https://arxiv.org/abs/1910.13302>

### 二手 / 待核实

27. Qwen2.5-VL-32B 发布信息（Qwen3-VL README News 中 2025-03-25 条目）：<https://github.com/QwenLM/Qwen3-VL/blob/main/README.md>
28. Gemini 1.5 旧版 object detection 示例（cookbook `gemini-1.5-archive` 分支，坐标约定可能与现行不同，**未逐条核对**）：<https://github.com/google-gemini/cookbook/blob/gemini-1.5-archive/examples/Object_detection.ipynb>
29. GPT 系列 bbox 能力：无官方文档/指标，**本次无法给出可信结论，标为不确定**。

> 说明：本次调研中 HuggingFace 模型卡、阿里云百炼 qwen-vl API 文档、Google Cloud 边界框检测文档在当前网络环境多次抓取失败，相关结论已改用官方技术报告/官方 cookbook/官方仓库代码交叉验证；未能抓取的条目已在正文标注。
