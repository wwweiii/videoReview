# 视频违规定位（多框）增强：竞品 / 开源 / 学术 / 落地调研

> **归档说明**：本文为历史调研归档（写于违禁物定位标记 P0 前后），引用的代码路径、组件名与结论均为当时快照；当前实现以 `src/` 与根 `README.md` 为准。原始调研内容保留不动。

> 任务：team task-3（research-industry）｜检索时间：2026-11-09
> 目标：为「抽帧 → Qwen2.5-VL 判违禁物 → 人工复核」的桌面工具，评估「在帧上标出违禁物位置、允许多个框」以及更值得推荐的产品/技术思路。
>
> **证据分级（全文统一）**
> - **【事实】**＝官方产品文档 / API Reference / 论文原文，已核对原始页面并附可点击 URL。
> - **【宣传】**＝厂商博客/自述/技术报告中的效果宣称，未做独立复现。
> - **【推测】**＝基于工程经验的推断或估算，**本项目必须自测/校准后才能当结论**。
> - 未能在公开文档中核到的字段，一律写「未核实」，不脑补。

---

## 一、结论速览（TL;DR）

1. **内容审核产品几乎不给「物品级 bbox」**：阿里云、腾讯云、网易易盾、AWS、Google、Azure、Hive 的审核结果都以「**时间点/时间范围 + 命中截图 + 标签 + 评分**」呈现；bbox 只出现在它们的**通用目标检测/跟踪**能力里。【事实，见第二节对照表】
2. **唯一在审核结果里给位置的是网易易盾，但只限「人脸 / logo / 关键词」**（`x1,y1,x2,y2` 相对坐标），不是通用物品；这反证了「审核结果里的物件框」在工业界并非默认能力。【事实】<https://support.dun.163.com/documents/2018041903?docId=150440627406032896&locale=zh-cn>
3. **VLM 直接出多框：技术上可行，但不能当唯一来源。** Qwen2.5-VL 官方博客宣称可用 bbox/point 输出稳定 JSON【宣传】<https://qwenlm.github.io/blog/qwen2.5-vl/>；但第三方基准 **GroundingME**（25 个 SOTA MLLM、1,005 个难题）显示**最好模型仅 45.1% 准确率、大多数模型在「不可定位应拒答」任务上得 0%**【事实】<https://arxiv.org/abs/2512.17495>。
4. **更推荐的思路（一句话）：把审核单位从「帧」升级为「事件」，把定位做成「分层」——能拿精框就用检测器/跟踪，拿不到就退到网格/区域文本；VLM 负责判定与解释，检测器负责多框，人工复核负责最终结论与数据反哺。**
5. **准确率量级**：零样本开放词表检测在 COCO 上可到 52.5 AP，但跨域基准 ODinW 只有 26.1 AP（Grounding DINO）【事实】<https://arxiv.org/abs/2303.05499>；自有数据微调的小检测器通常是审核场景里最稳的多框来源（mAP 量级需自测，属【推测】）；小目标用 SAHI 切片可带来 5%–15% AP 级提升【事实】<https://arxiv.org/abs/2202.06934>。
6. **投入产出比最高的两件事**：① **事件化审核 + 分层定位（bbox→网格→区域文本兜底）**；② **人工复核闭环 + 小检测器级联**。两者都不依赖"VLM 一次就框准"。
7. **合规**：机器结论只能定位为「疑似/初审」，人脸等属于个人信息（可能构成敏感个人信息），证据链必须保留「原帧 + hash + 框坐标与坐标空间 + 模型/提示词版本 + 原始返回 + 审核操作日志」。

---

## 二、竞品呈现方式对照表（是否给 bbox / 时间轴 / 截图 / 置信度）

> 说明：本节只采用**官方文档/API 字段**，不采用市场页宣传语。「定位」指是否能从返回结构中拿到与该违规内容对应的空间坐标。

| 产品 / 接口 | 违规内容的呈现方式（文档口径） | 物品级 bbox | 时间轴/时间点 | 命中截图 | 置信度/评分 | 证据等级 |
|---|---|---|---|---|---|---|
| **阿里云 VOD 智能审核** `GetMediaAuditResultTimeline` | 返回 `Porn/Terrorism/Logo/Live/Ad` 五类时间线数组，每项 `{Timestamp(ms), Label, Score(0–100)}`；默认只返回违规/疑似违规的截图详情 | ❌ 字段中无坐标 | ✅ 毫秒时间点 | 接口语义是「违规内容截图的时间点」；截图详情由审核结果接口另行返回 | ✅ `Score` | 【事实】[API 元数据](https://next.api.alibabacloud.com/meta/v1/products/vod/versions/2017-03-21/apis/GetMediaAuditResultTimeline/api?language=EN_US) · [帮助文档](https://help.aliyun.com/zh/vod/developer-reference/api-vod-2017-03-21-getmediaauditresulttimeline) |
| **腾讯云 COS（数据万象）视频审核** | 按截图返回 `Snapshot`：`snapshotTime`(ms)、`url`(截图访问地址)、`text`(截图 OCR)、以及 `pornInfo/politicsInfo/terrorismInfo/adsInfo`（各场景含 `label/score/subLabel/objectResults` 等） | ❌ | ✅ 截图毫秒时间 | ✅ 截图 URL | ✅ `score`（0–100） | 【事实】[查询视频审核结果](https://www.tencentcloud.com/document/product/436/48250) · [Snapshot 字段](http://cos-android-sdk-doc-1253960454.file.myqcloud.com/com/tencent/cos/xml/model/tag/audit/get/GetVideoAuditJobResponse.Snapshot.html) |
| **网易易盾 视频检测 v3** | `evidence{beginTime,endTime,type,url,frontPics}` + `labels{subLabels{rate,details{hitLocationInfos}}}`；`hitLocationInfos` 给 `x1,y1,x2,y2` 相对坐标，但文档明确**仅人脸、logo、关键词支持位置信息** | ⚠️ 仅特定类别，非通用物品框 | ✅ 起止毫秒 | ✅ 证据 URL + 命中前 3 张截图 | ✅ `rate`(0–1) + `level`(1 不确定/2 确定) | 【事实】[视频检测开发文档](https://support.dun.163.com/documents/2018041903?docId=150440627406032896&locale=zh-cn) |
| **AWS Rekognition Content Moderation（视频）** | `ContentModerationDetection`：`Timestamp`、`Start/EndTimestampMillis`、`DurationMillis`、`ModerationLabel{Name,ParentName,Confidence,TaxonomyLevel}`、`ContentTypes` | ❌ | ✅ 时间点 + 连续段 | ❌（需自行抽帧） | ✅ `Confidence` | 【事实】[ContentModerationDetection](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_ContentModerationDetection.html) · [ModerationLabel](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_ModerationLabel.html) |
| **AWS Rekognition Label Detection（对照）** | `LabelDetection` + `Label.Instances`：**常见物体**（人/车/家具/服装/宠物）返回检测框 | ✅ 仅常见物体 | ✅ 段 | ❌ | ✅ | 【事实】[LabelDetection](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_LabelDetection.html) · [Label.Instances](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_Label.html) |
| **Google Cloud Video Intelligence** | 显式内容：`ExplicitContentFrame{timeOffset, pornographyLikelihood}` 逐帧，**无框**；对象跟踪：`ObjectTrackingFrame{normalizedBoundingBox, timeOffset}`，按帧给位置+跟踪 | 审核类 ❌；对象跟踪 ✅ | ✅ 微秒 `timeOffset` | ❌ | ✅ likelihood | 【事实】[ExplicitContentFrame](https://googleapis.dev/ruby/google-api-client/v0.34.0/Google/Apis/VideointelligenceV1p2beta1/GoogleCloudVideointelligenceV1ExplicitContentFrame.html) · [ObjectTrackingFrame](https://googleapis.dev/ruby/google-api-client/v0.34.0/Google/Apis/VideointelligenceV1p2beta1/GoogleCloudVideointelligenceV1ObjectTrackingFrame.html) · [对象跟踪功能文档](https://cloud.google.com/video-intelligence/docs/feature-object-tracking) |
| **Azure AI Video Indexer / Content Understanding** | VI：每类洞察带**时间范围**，包含对象检测、人脸（每条含缩略图）、标签等；CU 视频：`keyFrameTimesMs`、`cameraShotTimesMs` + 自定义字段抽取（字段值可带时间戳），文档所列视频元素中**无 bbox** | 对象检测能力存在（字段级未核实）；CU 视频 ❌ | ✅ | ✅ VI 人脸洞察含缩略图 | 未核实 | 【事实】[VI insights](https://learn.microsoft.com/en-us/azure/azure-video-indexer/insights-overview) · [CU 视频元素](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/video/elements) |
| **Hive** | 分类模型：逐帧 `{time, classes[{class,score}]}`；检测模型：`{time, bounding_poly}`；异步模式每帧可带 `media_link`（处理帧图 URL） | 分类 ❌；检测模型 ✅ | ✅ 帧时间 | ✅ 异步 `media_link` | ✅ `score` | 【事实】[Submitting Video](https://docs.thehive.ai/reference/video) |

### 对照表读出来的 4 条规律

1. **「审核」与「定位」在产品上是两层能力**：审核层输出「时间 + 截图 + 标签 + 评分」，定位层由检测/跟踪模型承担（AWS Label Detection、Google Object Tracking、Hive Detector、Azure VI 对象检测）。做「多框」本质上是引入定位层，而不是给审核接口加字段。【事实，依据上表】
2. **截图是审核产品的通用证据形态**：腾讯云直接给 `url`，易盾给 `url + frontPics`，Hive 异步给 `media_link`；阿里云的时间线接口以「违规截图的时间点」为核心语义。**"截图 + 时间点"是工业界已经验证过的呈现方式，"逐帧多框"不是。**【事实+归纳】
3. **置信度普遍存在，但语义不同**：AWS/腾讯/易盾是 0–100 或 0–1 分数；易盾额外区分「确定/不确定」；审核产品普遍允许低分转人工。【事实】
4. **没有厂商把「物品级框」当作审核结果的必选项**：这与学术结论一致——细粒度开放词表定位本身仍不稳定（见第四节）。【归纳+事实】

---

## 三、开源生态可复用点

| 项目 | 可直接复用的能力（已核实） | 多框 | 时间聚合 | 对本项目的用法 / 注意 |
|---|---|---|---|---|
| **NVIDIA DeepStream** | `NvDsObjectMeta` 标准结构：`detector_bbox_info`、`tracker_bbox_info`、`object_id`（跟踪 ID）、`confidence`、`rect_params`、`obj_label` | ✅ 原生多目标 | ✅ 跟踪器 + 时间戳 | 参考它的**数据契约**（框+跟踪 ID+置信度+类别）；C/GStreamer 部署重，不建议整体引入。【事实】<https://archive.docs.nvidia.com/metropolis/deepstream/8.0/sdk-api/struct__NvDsObjectMeta.html> |
| **Frigate** | 基于 bbox **底部中心**判定是否进入 zone；`inertia` 要求对象连续 N 帧在区域内才确认；review item / 快照机制 | ✅ | ✅ 连续帧确认 + 事件 | 直接借鉴「多帧确认」「事件化」思路；NVR 型项目，不建议嵌入 Electron。【事实】<https://docs.frigate.video/configuration/zones/> |
| **Ultralytics YOLO + supervision** | `Detections` 数据结构、Box/Label/Mask/HeatMap 等 annotator、视频跟踪（ByteTrack）、分区计数等 how-to | ✅ | ✅ 跟踪 | 前端叠加与检测器后处理的参考实现；**许可证需自行核实**（Ultralytics 系通常为 AGPL-3.0，商用要评估）。【事实】<https://supervision.roboflow.com/latest/detection/annotators/> |
| **Label Studio + ML backend** | 预标注 / 交互式标注（矩形、多边形、掩码、关键点）；官方 ML backend 仓库里已有 **Grounding DINO** 示例；支持「预测 → 人工修正 → 训练」闭环 | ✅ | 视频需配合帧管理 | 「复核闭环 + 数据反哺」的现成形态参考，也可直接用它做标注平台。【事实】<https://labelstud.io/guide/ml.html> · <https://github.com/HumanSignal/label-studio-ml-backend> |
| **FiftyOne** | 检测结果可视化与模型评估（mAP 等） | ✅ | 视频数据集支持 | 用于离线评估「VLM 框 / 检测器框」的精度，避免拍脑袋上线。【事实】<https://docs.voxel51.com/user_guide/evaluation/> |
| **Roboflow Workflows** | 可视化编排视频处理流水线（检测/跟踪/区域等 block） | ✅ | ✅ | 若不想自研流水线可评估；引入托管平台的合规/成本需单独评估。【事实】<https://docs.roboflow.com/workflows> |
| **Qwen 官方 cookbook** | `2d_grounding`（相对坐标、box/point）、`video_understanding` 等 notebook | ✅ | — | 提示词与坐标格式可直接借鉴；**坐标口径要按模型族实测**（见 5.5）。【事实】<https://github.com/QwenLM/Qwen3-VL> |

**生态结论**：开源侧真正缺的不是"框"，而是**「检测器输出 → 多帧关联 → 事件 → 复核 → 数据反哺」这条链路**。Frigate/Label Studio/DeepStream 各自给出了其中一段的成熟做法，本项目可以只借"模式"，不必引入重依赖。【归纳】

---

## 四、学术 SOTA 与准确率量级

### 4.1 开放词表检测（Open-Vocabulary Detection）

| 方法 | 论文 | 可核实指标 | 对定位的启示 |
|---|---|---|---|
| **Grounding DINO** | <https://arxiv.org/abs/2303.05499> | **COCO zero-shot 52.5 AP**（未用 COCO 训练）；**ODinW zero-shot 平均 26.1 AP** | 零样本「认识概念」可以，但跨域真实场景只有 26 AP 量级——**直接拿零样本模型上生产不够** |
| **YOLO-World** | <https://arxiv.org/abs/2401.17270> | **LVIS 35.4 AP @ 52 FPS（V100）** | 实时开放词表可行，适合做"候选框生成器"，再由 VLM/规则复核 |
| **Grounded SAM** | <https://arxiv.org/abs/2401.14159> | SegInW zero-shot **48.7 mean AP**（Grounding DINO-Base + SAM-Huge） | 检测+分割组合是成熟范式，但部署重、需 GPU |

### 4.2 VLM 的视觉定位能力边界（最关键的一节）

- **GroundingME**（arXiv 2512.17495，1,005 个多人核验难题，四维度：区分相似物 / 复杂空间关系 / 遮挡与小目标 / **不可定位应拒答**）：评测 25 个 SOTA MLLM，**最好模型仅 45.1% 准确率，大多数模型在 rejection 任务上 0%**；作者用 test-time scaling 提升最多 4.5%，用数据混合训练把 rejection 从 0% 提到 27.9%。【事实】<https://arxiv.org/abs/2512.17495>
  → **含义：VLM 在「难样本 + 小目标 + 遮挡」上会自信地给出错误框，而且几乎不会说"我找不到"。这正好是监控画面里手机/录音笔的典型形态。**
- **Qwen2.5-VL 官方博客**宣称"能生成 bbox 或 point，并给出稳定的坐标 JSON"，示例格式 `{"bbox_2d":[x1,y1,x2,y2],"label":"...","sub_label":"..."}`。【宣传】<https://qwenlm.github.io/blog/qwen2.5-vl/>
  → 这是**厂商自述**；与技术报告同源，不能当作独立验证。
- **Qwen3-VL** 官方 README 增加 "2D grounding（相对坐标，支持 box/point）""3D grounding""video grounding" 等 cookbook。【宣传/官方文档】<https://github.com/QwenLM/Qwen3-VL>；技术报告 <https://arxiv.org/pdf/2511.21631>
- **Set-of-Mark（SoM）**：先用 SAM/SEEM 把图切成区域并叠加编号/框，再让 GPT-4V 回答；在 RefCOCOg 上 **zero-shot 的 GPT-4V+SoM 超过全监督微调的 SOTA REC 模型**。【事实】<https://arxiv.org/abs/2310.11441>
  → **含义：给 VLM 一个"可选的标记集合"（网格/候选框）比让它凭空回归坐标可靠得多。**
- **Chain-of-Spot**：对问题相关 ROI 做交互式放大再推理，多个多模态基准一致提升。【事实】<https://arxiv.org/abs/2403.12966>
  → **含义："先粗定位、再裁切放大二确认"是论文支持的路线**，正好可用于手机等小目标。

### 4.3 小目标与切片推理

- **SAHI**：在 VisDrone/xView 上，纯推理切片即可让 FCOS/VFNet/TOOD 的 AP 分别 **+6.8%/+5.1%/+5.3%**；配合切片微调累计 **+12.7%/+13.4%/+14.5% AP**。【事实】<https://arxiv.org/abs/2202.06934> · 代码 <https://github.com/obss/sahi>
  → 会议视频抽的是 1080p/4K 整帧，手机可能只有几十像素；**切片/裁切是必选项而不是优化项**。

### 4.4 分割（掩码）路线

- **SAM 2**：视频可提示分割，流式记忆、实时处理；视频分割"用 3 倍更少交互达到更好精度"，图像分割比 SAM **快 6 倍**且更准。【事实】<https://arxiv.org/abs/2408.00714>
- **Florence-2**：统一 prompt 表示，支持 caption/detection/grounding/segmentation，零样本+微调。【事实】<https://arxiv.org/abs/2311.06242>
  → 掩码技术上成熟，但**审核展示的核心诉求是"指给审核员看在哪"，掩码的边际收益低于其部署/性能成本**（见 5.3）。

### 4.5 视频时序定位（Video Temporal Grounding, VTG）

- 主流指标是 **R@1 @ IoU 阈值**（如 IoU=0.5/0.7）与 mIoU，而不是物品级 mAP；不同数据集（Charades-STA/ActivityNet Captions 等）绝对值不可横向硬比。【事实-指标口径】
- **EVIDENT**（2026）指出：把 MLLM 微调用于 VTG，域内提升、**域外（domain shift）显著退化**；用实体证据约束可提升跨域鲁棒性。【事实】<https://arxiv.org/abs/2605.26104>
  → 对本项目的启示：**"视频级事件定位"不能只靠单帧判定堆叠，需要显式的时间聚合与实体关联**；同时要警惕"换个会议室/摄像头就掉点"。

### 4.6 视频异常检测（Anomaly Detection）

- **UCF-Crime**（CVPR 2018）：1,900 段真实监控、128 小时、13 类异常；**弱监督（视频级标签）**，模型输出片段级异常分数。【事实】<https://arxiv.org/abs/1801.04264>
  → 异常检测解决的是"哪段可疑"，**不直接给物品实例框**；对本项目只能作为"时间窗筛选器"，不能替代定位。

### 4.7 准确率量级速查

| 任务 | 指标 | 公开可核实的量级 | 说明 |
|---|---|---|---|
| 开放词表零样本检测 | AP | COCO 52.5 / ODinW 26.1 | 跨域掉一半以上，真实场景要微调 |
| 实时开放词表检测 | AP @ FPS | LVIS 35.4 @ 52 FPS(V100) | 可做本地候选框生成 |
| VLM 难样本定位 | accuracy | 最好 45.1%；rejection 多数 0% | **不能作为唯一框来源** |
| 小目标切片 | AP 提升 | +5%～15% AP | 1080p 监控帧里的手机属于小目标 |
| 自有数据微调检测器 | mAP50 | 通常 0.85–0.95 量级【推测】 | 依赖标注质量与场景覆盖，需自测 |
| 弱监督异常检测 | AUC/片段 | 视频级/片段级，无实例框 | 只能做时间筛选 |

---

## 五、8 个增强思路逐条评估

> 工作量单位＝**人日（单人，含前后端联调，粗估【推测】）**；适配性针对本项目现状：Electron + TypeScript、全部走 OpenAI 兼容的 VLM API（`src/main/model.ts`）、抽帧为 PNG（`src/main/ffmpeg.ts`）、任务 JSON 存储（`src/main/task-manager.ts`）、审核 UI 为分页帧列表（`TaskDetail.tsx`，`PAGE_SIZE=20`）、无本地模型运行时。

### a) 先 VLM 判定，再裁切放大定位（crop-and-zoom / 两阶段）

- **做法**：第一遍只在全图上判 `abnormal + 粗区域`（九宫格/粗框）；命中后按区域裁切放大 2–3 张，二次请求让模型给多框/确认；最后把框映射回原图坐标。
- **优点**：复用现有模型与 API；小目标、遮挡明显改善（Chain-of-Spot、SoM 均支持这一方向）；成本只增加在异常帧；裁剪图本身就是证据。
- **缺点**：异常帧延迟翻倍；二次结果依赖首轮粗定位；两次调用成本；裁剪与坐标映射有工程细节（缩放比、padding、多框边界）。
- **对本项目适配性**：**高**。`analyzeSingleFrame` 可直接复用；裁切可用 sharp/ffmpeg；`FrameRecord` 增加 crops/boxes 即可。注意现有 group 模式一请求多帧（`model.ts:115-148`）不适合做精定位，**建议 group 只做 triage，框走 single 二次请求**。
- **预估工作量**：**3–5 人日**
- **结论**：**推荐（P1）**，作为"VLM 出框"的正确打开方式。

### b) 规则引擎 + 专用检测器（含微调）

- **做法**：本地/服务端跑 YOLO-World 或 Grounding DINO（先零样本），输出多框 + 跟踪 ID；规则层（区域、连续帧、类别组合、置信度）决定是否送 VLM 复核；后续用复核数据微调 phone/camera/recorder 等。
- **优点**：多框天然稳定；低延迟、低 token 成本；可跟踪、可跨帧合并；不依赖 VLM 坐标；可解释（类别+置信度+pixel）；可离线。
- **缺点**：需要标注数据与训练；类目固定（新物品要么重训要么开放词表）；Electron 打包 onnxruntime / Python sidecar 增加复杂度；跨场景泛化要持续喂数据；零样本精度有限（ODinW 26.1 AP）。
- **对本项目适配性**：**中高**。当前项目没有任何本地模型运行时，建议**先以独立本地服务（FastAPI + Python，127.0.0.1）接入**，验证后再考虑内置；类别正好是有限的电子设备（8 类），非常适合检测器。
- **预估工作量**：零样本接入 **8–12 人日**；加标注+微调 **再 +10–20 人日**
- **结论**：**长期主线（P2）**，但零样本原型应尽早做（1–2 天能验证可行性）。

### c) 分割掩码（SAM2 / Florence-2）替代矩形框

- **做法**：检测/提示生成 mask，前端半透明叠加。
- **优点**：遮挡、不规则物体更精确；演示/汇报效果好。
- **缺点**：审核只需要"指位置"，掩码边际收益低；SAM2 视频分割要显存、集成重；mask 与框两套数据结构；打包与跨平台麻烦。
- **对本项目适配性**：**低**。这是标注工具的形态，不是审核工具的形态。
- **预估工作量**：**10–20 人日**
- **结论**：**不建议优先**（除非后续产品扩展到"标注/训练平台"）。

### d) 帧差 / 运动检测辅助定位

- **做法**：背景建模/帧差找"新出现/移动"区域，作为候选区域。
- **优点**：几乎零成本；对"从包里拿出手机"这类动作有信号；可减少全图搜索。
- **缺点**：会议场景人动、光照、投影变化导致大量误检；**静止放在桌上的手机不产生运动**；阈值调参成本高。
- **对本项目适配性**：**中低**。只适合做"候选区域生成器"或"误报抑制"，不能当主定位。
- **预估工作量**：**3–5 人日**
- **结论**：**可选（P3）**，收益有限。

### e) 网格命中 / 热力图（grid cell）替代紧框

- **做法**：在图上叠加 4×4 或 6×6 网格编号，让 VLM 返回"命中格子编号 + 标签"；前端高亮格子或做热区；可选把多帧热区叠加成时间热力图。
- **优点**：**抗坐标幻觉**（只需分类格子，不需回归精确坐标）；多目标天然（一格可多个标签）；实现极简（prompt + 前端）；对分辨率不敏感；SoM 论文证明"标记提示"能显著提升 grounding 能力。【事实 <https://arxiv.org/abs/2310.11441>】
- **缺点**：精度受网格粒度限制；无法给紧框；格子多时模型可能漏/错；同一格多个物品难区分。
- **对本项目适配性**：**很高**。纯 prompt + 前端，不改架构；**适合作为 bbox 失败/低置信时的降级方案，也适合作为第一版"能定位"的快速交付**。
- **预估工作量**：**2–3 人日**
- **结论**：**推荐（P0/P1 兜底 + 快速首发）**。

### f) 只给「区域描述」文本（左上/中央/右下）

- **做法**：VLM 输出九宫格语义位置（"画面左中桌面"），不要求坐标。
- **优点**：零成本、最稳定、可解释；审核员能快速扫视；不需要任何新依赖。
- **缺点**：无精确位置；多目标描述易混；无法画框。
- **对本项目适配性**：**很高**。当前 prompt 已要求 `description/evidence`，加一句"给出九宫格方位"即可；作为最终兜底与降级层。
- **预估工作量**：**0.5–1 人日**
- **结论**：**推荐（P0 兜底）**。

### g) 多帧投票 + 事件级判定

- **做法**：把相邻帧同类命中聚合为**事件**（`start/end/峰值帧/多帧多框/最大置信度/复核状态`）；多帧投票（如 3 帧中 2 帧命中）降误报；UI 从"帧列表"升级为"事件时间轴"。
- **优点**：贴合审核工作流（30 分钟 2s 间隔＝900 帧，逐帧看不现实）；降误报；可跨帧关联同一物品的多个框；为时间轴 UI 打基础。
- **缺点**：需要事件模型 + UI 改造；事件切分规则（时间窗/间隔）要调；跨帧框关联需要 IoU/中心距离或 tracker。
- **对本项目适配性**：**很高**。现有 `TaskDetail.tsx` 是分页列表（`PAGE_SIZE=20`），改为"事件卡片 + 时间轴"是体验质变；Frigate 的 `inertia`（连续帧确认）可直接借鉴。【事实 <https://docs.frigate.video/configuration/zones/>】
- **预估工作量**：**5–8 人日**
- **结论**：**强烈推荐（P0 产品层）**。

### h) 人工复核闭环（审核员点选/订正框，反哺数据）

- **做法**：每个命中支持「确认违规 / 误报 / 拖拽订正框 / 新增框 / 标记漏报」；保存原帧+crop+框+标签；统计每类 precision/recall；导出 JSONL/COCO 供训练。
- **优点**：直接提升信任与准确率；**积累数据资产（检测器微调的前提）**；合规留痕；可量化模型表现；Label Studio 的预标注/交互标注就是成熟参照。【事实 <https://labelstud.io/guide/ml.html>】
- **缺点**：UI 交互工作量；需要标注规范与权限控制；数据存储与脱敏。
- **对本项目适配性**：**很高**。`FrameRecord` 已有 `rawResponse/model`（证据链基础，`src/shared/types.ts:34-50`），加 `review` 字段与导出即可。
- **预估工作量**：**5–8 人日**（含导出与统计）
- **结论**：**强烈推荐（P0）**。

### 组合建议

| 组合 | 内容 | 交付价值 |
|---|---|---|
| **近期（3–4 周）** | f 区域描述 + e 网格 + g 事件化 + h 复核闭环 | 能定位（粗）、能复核、能积累，且不赌 VLM 框的精度 |
| **中期（4–8 周）** | a 裁切放大二确认 + b 零样本检测器 + 多框合并 | 多框基本可用，异常帧精度明显提升 |
| **长期（8 周+）** | b 微调检测器 + 跟踪 + 与 VLM 级联 + FiftyOne 评估 | 稳定多框、低 token 成本、可量化 |

---

## 六、按投入产出比排序的推荐路线

### 6.1 ROI 排序

| 排名 | 动作 | 预估人日 | 收益 | 风险 | 阶段 |
|---|---|---|---|---|---|
| 1 | **h 人工复核闭环**（确认/驳回/订正框/新增框/导出） | 5–8 | 高：信任+数据+合规 | 低 | P0 |
| 2 | **g 事件聚合 + 时间轴/事件卡片** | 5–8 | 高：审核效率质变 | 中（UI 改造） | P0 |
| 3 | **f 区域描述（九宫格方位）** | 0.5–1 | 中：零成本可解释 | 低 | P0 |
| 4 | **e 网格命中 + 高亮** | 2–3 | 中：抗坐标幻觉、多目标 | 低 | P0/P1 |
| 5 | **a 裁切放大二次确认** | 3–5 | 中高：小目标精度 | 中（双调用/坐标映射） | P1 |
| 6 | **b 零样本检测器（YOLO-World/Grounding DINO）** | 8–12 | 高：稳定多框 | 中（部署/许可） | P1/P2 |
| 7 | **b 微调检测器（phone/camera/recorder…）** | +10–20 | 高：精度上限 | 高（数据/场景漂移） | P2 |
| 8 | **d 帧差/运动辅助** | 3–5 | 低 | 中（误检） | P3 |
| 9 | **c 分割掩码** | 10–20 | 低 | 高（部署） | P3 |

### 6.2 最推荐的两个思路（也是回给 lead 的结论）

1. **「事件化审核 + 分层定位」**：审核单位从"帧"改成"事件"；位置按可信度分层展示——**检测器/跟踪可给精框 → 否则 VLM 粗框 → 否则网格高亮 → 否则九宫格区域文本**。这样"多框"只是事件详情的一部分，而不是产品的地基；即使 VLM 框不准，产品仍然可用、可解释。
2. **「人工复核闭环 + 小检测器级联」**：审核员的每次确认/订正都是训练数据；积累 500–2,000 帧后微调一个 8 类小检测器（手机/平板/笔电/相机/录音笔/手表/耳机/其他），由它负责多框与跟踪，VLM 退居"判定 + 解释 + 疑难复核"。这是把"多框"做准、做便宜的长期解。

### 6.3 具体落地设计（供实现参考）

**（1）定位分层（建议写入产品与数据结构）**

| 层级 | 形态 | 生成方式 | 何时使用 |
|---|---|---|---|
| L0 | 无位置 | 模型未返回/校验失败 | 现状；只显示文字证据 |
| L1 | 区域文本 | VLM 九宫格方位（左上/上中/右上/左中/中央/右中/左下/下中/右下） | 最终兜底 |
| L2 | 网格高亮 | VLM 返回 cell 编号（4×4/6×6） | 框不可信时 |
| L3 | 粗框（1–3 个） | VLM 返回 bbox + 校验 | 异常帧首选（快） |
| L4 | 精框（多框 + 跟踪） | 检测器/跟踪 | 长期主力 |
| L5 | 掩码 | 分割模型 | 可选，P3 |

所有层级都记录 `located_by: 'vlm' | 'detector' | 'grid' | 'region_text' | 'manual'` 与 `locate_confidence`，**前端永远显示定位来源**（可解释性/证据链）。

**（2）多框 JSON 契约（在现有 JSON 基础上扩展）**

```json
{
  "abnormal": true,
  "risk_level": "high",
  "categories": ["手机"],
  "description": "画面中央桌面出现一部手机",
  "evidence": "黑色直板手机，屏幕朝向镜头",
  "confidence": 0.82,
  "need_human_review": false,
  "objects": [
    {"label": "手机", "bbox": [0.42, 0.51, 0.49, 0.66], "confidence": 0.8},
    {"label": "手机", "bbox": [0.71, 0.30, 0.76, 0.42], "confidence": 0.6}
  ],
  "region": "中央"
}
```

**校验规则（服务端/主进程）**：`bbox` 统一归一化到 0–1；`x1<x2, y1<y2`；面积/长宽比过滤；同类 IoU>0.5 去重；最多 8 框；非法/超限 → 丢弃并降级到 `region`/`grid`，**不要因解析失败让整帧失败**（现有 `analyzeSingleFrame` 是"解析失败重试一次后抛错"，需改成"降级"语义）。

**（3）现有代码的改动点（不改代码，仅调研建议）**

- `src/shared/types.ts`：`FrameRecord` 增加 `boxes?: BoundingBox[]`、`locateSource`、`region`、`gridCells?`、`review?`；旧任务 `normalizeTask` 补默认值（向后兼容）。
- `src/main/model.ts`：prompt 增加 `objects[]` 规范与**坐标口径说明**；`max_tokens` 目前单帧 500、分组 `frames*350`（`model.ts:169`、`model.ts:493-495`），多框 JSON 容易截断，**建议 800–1200**；分组模式不适合要求精确框（一请求 4 帧，坐标归属易混）。
- `src/main/ffmpeg.ts`：抽帧时可顺便记录每帧 SHA-256（证据链）；当前帧为 PNG 全尺寸，适合后续裁切/切片。
- `src/renderer/.../TaskDetail.tsx`：图片容器加绝对定位 overlay（CSS `%`），框与列表联动；新增"事件时间轴"视图（可保留原分页列表作为"全部帧"）。
- `src/main/task-manager.ts`：CSV 导出（`task-manager.ts:582-600`）增加「框坐标、坐标来源、定位置信度、帧 SHA-256、模型/prompt 版本」列；新增事件级导出。
- 新增模块建议：`locate.ts`（裁切/坐标映射/去重）、`events.ts`（事件聚合/多帧投票）、`evidence.ts`（hash/证据包导出）。

**（4）成本与性能提醒**

- 逐帧多框不现实：30 分钟视频按 2s 抽帧约 900 帧，全部出框+人工看框只会更慢；**只在 abnormal/review 帧出框**，normal 帧最多保留候选。
- 二次裁剪请求会放大异常帧成本；建议对 `confidence < 阈值` 或 `need_human_review` 的帧才做二确认。
- 现有并发是 2（`DEFAULT_CONCURRENCY=2`），接入第二阶段时注意速率限制与超时（120s）。

**（5）模型升级选项**

- 继续用 Qwen2.5-VL：Prompt 里要求 `objects[]` + 九宫格/网格；Qwen2.5 博客示例坐标为**像素**（如 `[341,258,397,360]`）→ 需按输入图尺寸归一化。【宣传 + 工程注意】
- 升级 Qwen3-VL：官方 README 明确提供 **2D grounding（相对坐标，box/point）**、3D grounding、video grounding cookbook，且 DashScope 兼容 OpenAI 接口（现有链路可直接换模型）。【事实 <https://github.com/QwenLM/Qwen3-VL>】但**坐标口径不同（相对 vs 像素），必须实测校准**；效果提升属【宣传】，需 A/B。
- 若走检测器：优先零样本 YOLO-World/Grounding DINO 验证，再微调；评估用 FiftyOne/SAHI。

---

## 七、合规与证据链注意点

> 本节为产品与合规建议，不构成法律意见；具体以法务/安全评审为准。

1. **结论定性**：机器输出只能是「疑似/初审」，**最终结论必须由人工复核产生**；导出的报告应显著标注"辅助审核结果，不构成对个人的最终认定"。
2. **个人信息**：会议室视频包含人脸、工位、屏幕内容，属于个人信息；**人脸可能构成敏感个人信息（生物识别）**，处理需具备合法性基础、告知同意、最小必要、严格保护。【事实】《个人信息保护法》<http://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html>
   - 优先**本地处理**（本工具已是 Electron 本地抽帧+本地存储，这是优势）；
   - 调用第三方云端 VLM 时属于委托处理/可能涉及数据出境，需告知、签数据处理协议、评估必要性；
   - 存储加密、访问控制、保留期限与到期删除；
   - 导出物（截图/CSV）应脱敏或限内部使用。
3. **日志留存**：网络安全法要求采取监测记录措施、**留存相关网络日志不少于六个月**。【事实】<https://www.cac.gov.cn/2016-11/07/c_1119867116_2.htm>（注意：法条指"网络日志"，不等于视频证据；但审计轨迹建议≥6 个月且防篡改。）
4. **证据链 6 要素（建议落库/落盘）**：
   - ① 原帧文件（不可变）+ **SHA-256**；
   - ② 框坐标 + **坐标空间**（归一化 0–1 / 像素）+ 生成方式（vlm/detector/grid/manual）；
   - ③ 模型名+版本、API 端点、**提示词版本**；
   - ④ **模型原始返回**（现有 `FrameRecord.rawResponse` 已保存，`src/shared/types.ts:47`，这是很好的基础）；
   - ⑤ 时间戳：帧时间（`timestampMs`）+ 分析时间（`analyzedAt`）；
   - ⑥ 审核员操作日志（谁、何时、确认/驳回/订正/新增框）。
5. **可解释性**：每个命中展示「命中截图 + 框 + 裁剪放大图 + 文字证据 + 置信度 + 定位来源」；低置信/无定位时明确写"位置待人工确认"，不能伪装成精确框。
6. **导出与删除**：导出应做成**证据包**（CSV/JSON + 命中截图 + hash 清单 + 模型信息），不要只导出文字；删除任务时同步清理证据包并留删除日志。
7. **密钥安全**：当前内置 preset 用固定密钥 AES 加密（`src/main/preset.ts`），属于**混淆而非安全**；建议改用系统凭据（Windows DPAPI / keychain）或本地代理，避免密钥可被逆向提取。【推测/安全建议】

---

## 八、参考链接

### 商业产品文档
- 阿里云 VOD 智能审核时间线（字段级 API 元数据）：<https://next.api.alibabacloud.com/meta/v1/products/vod/versions/2017-03-21/apis/GetMediaAuditResultTimeline/api?language=EN_US>
- 阿里云 VOD `GetMediaAuditResultTimeline` 帮助文档：<https://help.aliyun.com/zh/vod/developer-reference/api-vod-2017-03-21-getmediaauditresulttimeline>
- 腾讯云 COS 视频审核结果查询：<https://www.tencentcloud.com/document/product/436/48250>
- 腾讯云 `Snapshot` 字段（截图 URL / snapshotTime / 场景结果 / score）：<http://cos-android-sdk-doc-1253960454.file.myqcloud.com/com/tencent/cos/xml/model/tag/audit/get/GetVideoAuditJobResponse.Snapshot.html>
- 网易易盾 视频检测 v3 开发文档（evidence/frontPics/hitLocationInfos）：<https://support.dun.163.com/documents/2018041903?docId=150440627406032896&locale=zh-cn>
- 网易易盾 视频检测 v3 文档入口：<https://dun.163.com/documents/2018041903?docId=150440859531399168>
- AWS Rekognition ContentModerationDetection：<https://docs.aws.amazon.com/rekognition/latest/APIReference/API_ContentModerationDetection.html>
- AWS Rekognition ModerationLabel：<https://docs.aws.amazon.com/rekognition/latest/APIReference/API_ModerationLabel.html>
- AWS Rekognition LabelDetection：<https://docs.aws.amazon.com/rekognition/latest/APIReference/API_LabelDetection.html>
- AWS Rekognition Label（Instances 含常见物体框）：<https://docs.aws.amazon.com/rekognition/latest/APIReference/API_Label.html>
- Google Cloud Video Intelligence 对象跟踪功能：<https://cloud.google.com/video-intelligence/docs/feature-object-tracking>
- Google `ExplicitContentFrame`：<https://googleapis.dev/ruby/google-api-client/v0.34.0/Google/Apis/VideointelligenceV1p2beta1/GoogleCloudVideointelligenceV1ExplicitContentFrame.html>
- Google `ObjectTrackingFrame`：<https://googleapis.dev/ruby/google-api-client/v0.34.0/Google/Apis/VideointelligenceV1p2beta1/GoogleCloudVideointelligenceV1ObjectTrackingFrame.html>
- Azure AI Video Indexer insights：<https://learn.microsoft.com/en-us/azure/azure-video-indexer/insights-overview>
- Azure Content Understanding 视频元素：<https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/video/elements>
- Hive Submitting Video：<https://docs.thehive.ai/reference/video>

### 开源与工具
- NVIDIA DeepStream `NvDsObjectMeta`：<https://archive.docs.nvidia.com/metropolis/deepstream/8.0/sdk-api/struct__NvDsObjectMeta.html>
- Frigate Zones（bottom-center / inertia）：<https://docs.frigate.video/configuration/zones/>
- supervision Annotators：<https://supervision.roboflow.com/latest/detection/annotators/>
- Label Studio ML 集成：<https://labelstud.io/guide/ml.html>
- label-studio-ml-backend（含 Grounding DINO 示例）：<https://github.com/HumanSignal/label-studio-ml-backend>
- FiftyOne 模型评估：<https://docs.voxel51.com/user_guide/evaluation/>
- Roboflow Workflows：<https://docs.roboflow.com/workflows>
- Qwen3-VL 官方仓库（cookbooks：2D grounding / video understanding）：<https://github.com/QwenLM/Qwen3-VL>

### 模型与论文
- Qwen2.5-VL 官方博客（厂商宣传）：<https://qwenlm.github.io/blog/qwen2.5-vl/>
- Qwen2.5-VL Technical Report：<https://arxiv.org/abs/2502.13923>
- Qwen3-VL Technical Report：<https://arxiv.org/pdf/2511.21631>
- GroundingME（VLM 定位能力差距）：<https://arxiv.org/abs/2512.17495>
- Chain-of-Spot（ROI 放大）：<https://arxiv.org/abs/2403.12966>
- Set-of-Mark（标记提示提升 grounding）：<https://arxiv.org/abs/2310.11441>
- Grounding DINO：<https://arxiv.org/abs/2303.05499>
- YOLO-World：<https://arxiv.org/abs/2401.17270>
- SAHI（小目标切片）：<https://arxiv.org/abs/2202.06934>
- SAM 2：<https://arxiv.org/abs/2408.00714>
- Florence-2：<https://arxiv.org/abs/2311.06242>
- Grounded SAM：<https://arxiv.org/abs/2401.14159>
- EVIDENT（VTG 域外退化）：<https://arxiv.org/abs/2605.26104>
- UCF-Crime（弱监督异常检测数据集）：<https://arxiv.org/abs/1801.04264>

### 合规
- 中华人民共和国个人信息保护法（NPC）：<http://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html>
- 中华人民共和国网络安全法（CAC）：<https://www.cac.gov.cn/2016-11/07/c_1119867116_2.htm>
