# 模型无关 VLM grounding 方言适配调研（视频审核工具）

> **归档说明**：本文为历史调研归档（写于违禁物定位标记 P0 前后），引用的代码路径、组件名与结论均为当时快照；当前实现以 `src/` 与根 `README.md` 为准。原始调研内容保留不动。

> 背景：内网桌面「视频智能审核」工具（Electron + React 19，主进程 ffmpeg 抽帧为 PNG，OpenAI 兼容 `/chat/completions` + data URL 调多模态模型）。**关键约束：不能绑定具体模型**——不同客户可能部署 Qwen2.5-VL / Qwen3-VL / InternVL / MiniCPM-V / GLM-4.5V / Molmo / Florence-2 / 自微调模型。
> 目标：给出「提示词层 / 解析层 / 配置层」三层的模型无关事实清单，指导把 VLM 从「只输出 abnormal 判定」升级为「可输出提示框」。
> 调研时间：2026-11。证据分级：**【官方】**=厂商文档/模型卡/官方仓库代码/官方 issue 回复；**【论文】**=arXiv/技术报告；**【二手】**=第三方 wrapper、博客、社区 issue；**【不确定】**=本次未拿到逐字原文或版本未核实。凡关键结论均给可点击 URL；本文件只做调研，不修改 `src/`。

---

## 0. 结论速览

1. **不存在跨模型统一的 grounding 输出协议**。至少 7 种方言并存：Qwen 系 JSON `bbox_2d`、InternVL `<ref></ref><box>[[...]]</box>`、MiniCPM `<box>x1 y1 x2 y2</box>`、GLM `<|begin_of_box|>...<|end_of_box|>`、Molmo HTML-like `<points coords="...">`、Florence `<loc_0>~<loc_999>` bins、以及纯 prompt 约定的通用 JSON。**解析层必须多方言 + 自动探测，不能硬编码一种。**
2. **坐标空间分四派**：`[0,1000]` 归一化（Qwen3-VL、InternVL、MiniCPM-V、GLM、Molmo2、Gemini/Gemma4）、`[0,1]` 归一化（部分 LFM2-VL/自微调）、`[0,100]` 归一化（原版 Molmo 0924）、**模型内部 resize 后的绝对像素**（Qwen2.5-VL，最坑）。同一模型族换代就会变——Qwen2.5-VL→Qwen3-VL 已从绝对像素改为 0–1000。
3. **Qwen2.5-VL 的「绝对像素」指 smart_resize 后的输入图，不是用户原图**；必须按 `smart_resize(img_h,img_w, factor=28)` 反算，官方维护者在 issue 里给了完整公式（见 §1.2）。**这是当前项目（内置 qwen2.5-vl-32b-instruct）最容易踩的坑。**
4. **“Thinking” 与 “bbox” 是两个正交维度**：Qwen3-VL 的 Thinking 是**独立 checkpoint**（不是开关）；Qwen3 混合模型可用 `chat_template_kwargs.enable_thinking=false` 关；GLM-4.5V 有 thinking mode 开关；**思考文本会占用 completion token 预算并把 JSON 顶出 `max_tokens`**（Qwen3-VL 官方评测对 Thinking 模型给到 `out_seq_length=40960`）。
5. **推理字段名不统一**：vLLM 已把 `reasoning_content` 改名为 **`reasoning`**；SGLang / 阿里云百炼仍返回 **`reasoning_content`**；百炼还有 `clear_thinking` 控制多轮是否回传思考。解析层必须同时读 `reasoning`、`reasoning_content`、`reasoning_content` 缺失时的 content 内 `<think>` 块。
6. **OpenAI 兼容 ≠ OpenAI 一致**：Ollama 只支持 base64 data URL、不支持图片 URL、只列 `max_tokens`；LM Studio 只列 `max_tokens`；vLLM 支持 `max_completion_tokens`、`image_url.detail` 明确不支持；SGLang 用 `max_tokens` 示例且未文档化 data URL。**调用层要做“参数降级重试”而不是假设全部可用。**
7. **微调生态已有“模型无关 grounding 数据格式”先例，但没有“模型无关 bbox 解析库”**：ms-swift 用 `<ref-object>`/`<bbox>` + `objects` 字段做模型无关训练数据，自动按模型选归一化；推理侧目前只有各 wrapper 自己写 tolerant parser（LibreYOLO 的 `BBOX_KEY`/`COORD_DIVISOR` + 容错解析是最接近的轻量参考）。**没有可直接引入的成熟通用库。**
8. **VLM 框只能当“审核提示框”，不能当精确标注**：单目标干净图 RefCOCO Acc@0.5 约 86~90，会议室小目标/遮挡/反光显著更低；必须人工复核 + 自建标定集（此结论沿用仓库既有 `docs/archive/research/vlm-grounding.md` 的实测口径）。
9. **落地建议**：配置层存「端点 profile」（dialect / coord_space / reasoning_field / 是否支持 response_format / 是否支持 data URL），首次连接跑**能力自检探针**（1 张合成标定图、2 次请求）自动写回 profile；解析层按「JSON → 模型 token → 纯坐标 → 拒答」优先级链解析；提示词层同时给 JSON 与坐标约定，**不要给模型指定具体坐标空间**（让探针测，而不是让模型自报）。
10. **必须允许“该模型不出框”**：探测失败/无法判定坐标空间/连续 2 次解析失败 → 自动降级为「只判定 abnormal，不画框」，而不是画错框。这是模型无关设计的安全底线。

---

## 1. 模型族 grounding 方言对照表

### 1.1 对照总表

| 模型族（版本） | 原生输出格式（示例） | 坐标空间 | 关键 token / 字段 | 多目标 | 证据等级 | 主要 URL |
|---|---|---|---|---|---|---|
| **Qwen3-VL**（2B/4B/8B/32B/30B-A3B/235B-A22B，Instruct/Thinking） | JSON：`[{"bbox_2d":[300,300,600,700],"label":"dog"}]`；支持 points（`point_2d` 类字段，官方未逐字给出示例） | **`[0,1000]` 归一化** | `bbox_2d`（JSON 默认）；也支持 Qwen2-VL 式 `<|box_start|>` token | JSON 数组多元素 | 【官方】技术报告 | [arXiv 2511.21631 §3.2.4](https://arxiv.org/html/2511.21631v1) |
| **Qwen2.5-VL**（3B/7B/32B/72B） | JSON：`[{"bbox_2d":[341,258,397,360],"label":"motorcyclist","sub_label":"..."}]` | **模型内部 smart_resize 后的绝对像素**（非原图、非归一化） | `bbox_2d`；prompt 可要求 label/sub_label | JSON 数组多元素 | 【官方】技术报告 + 官方博客 | [arXiv 2502.13923 §2.1.2](https://arxiv.org/html/2502.13923v1) / [Qwen 官方博客](https://qwenlm.github.io/blog/qwen2.5-vl/) |
| **Qwen2-VL**（历史版本，2024） | 特殊 token：`<|box_start|>(x1,y1),(x2,y2)<|box_end|>` + `<|object_ref_start|>词<|object_ref_end|>` | `[0,1000)` 归一化 | `<|box_start|>` 等 | 多个 token 序列 | 【论文】+【官方】 | [arXiv 2409.12191 §2.2.1](https://arxiv.org/html/2409.12191v1) |
| **InternVL 2.5 / 3 / 3.5**（1B~241B） | `<ref>the woman</ref><box>[[x1,y1,x2,y2]]</box>`（**注意双中括号**） | **`[0,1000]` 归一化** | `<ref>`、`<box>`；`<box>` 也用于输入区域提示 | 多组 ref/box | 【论文】+【官方】ms-swift 文档佐证 | [arXiv 2410.16261 §3.3](https://arxiv.org/html/2410.16261v1) / [ms-swift Grounding 文档](https://github.com/modelscope/ms-swift/blob/main/docs/source_en/Customization/Custom-dataset.md) |
| **MiniCPM-V 4.5**（openbmb） | 单目标：`<box>x1 y1 x2 y2</box>`；多目标：JSON `[{"name_en":"...","name_zh":"...","box":"x1 y1 x2 y2"}]` | **`[0,1000]` 归一化**（官方 cookbook 除以 1000 再乘宽高） | prompt 用 `<ref>airplane</ref>`；输出 `<box>` | JSON 数组 / 多 box | 【官方 cookbook】（OpenBMB/OpenSQZ） | [MiniCPM-V Cookbook Grounding](https://opensqz.github.io/MiniCPM-V-CookBook/site/zh/v4.5/inference/grounding.html) |
| **GLM-4.5V / 4.6V / 4.1V**（zai-org） | `<|begin_of_box|>[[x1,y1,x2,y2],…]<|end_of_box|>`（括号风格 `[]`/`[[]]`/`()`/`<>` 均可能出现） | **按宽/高归一化后 ×1000** | `<|begin_of_box|>`、`<|end_of_box|>`；prompt 用 `<expr>` | 多框数组 | 【官方】仓库 README（现有唯一明确文字描述） | [zai-org/GLM-V README](https://github.com/zai-org/GLM-V/blob/main/README.md) |
| **Molmo**（0924，7B/72B） | 纯文本 points：`<point x="12.3" y="45.6" alt="dog">dog</point>`；多点 `<points x1="..." y1="..." …>` | **`[0,100]` 归一化**（论文文字） | `<point>`/`<points>` x/y/alt | 多点序列（按坐标排序） | 【论文】+【官方代码】 | [arXiv 2409.17146 §4](https://arxiv.org/html/2409.17146v2) / [molmo repo](https://github.com/allenai/molmo) |
| **Molmo2**（4B/8B/7B，2026） | HTML-like：`<points coords="1 123 456 2 234 567">label</points>`；视频 `<tracks coords="0.0 1 123 456 …">label</tracks>` | **`[0,1000]` 归一化**（代码 `coordinate_scale="1000"`） | `coords` 属性、`<points>`/`<tracks>` | 多帧/多目标 | 【官方代码】 | [molmo2 point_formatter.py](https://github.com/allenai/molmo2/blob/main/olmo/preprocessing/point_formatter.py) |
| **Florence-2**（large） | 任务 token + `<loc_0>`~`<loc_999>` 四元组，如 `<OD>dog<loc_123><loc_45><loc_456><loc_234>` | **1000 bins 量化**；反量化 `(bin+0.5)*W/1000`（整幅宽高） | `<OD>`/`<CAPTION_TO_PHRASE_GROUNDING>`/`<OPEN_VOCABULARY_DETECTION>`/`<REGION_PROPOSAL>` 等 | 每个短语可多框 | 【官方代码】+【论文】 | [transformers processing_florence2.py](https://github.com/huggingface/transformers/blob/main/src/transformers/models/florence2/processing_florence2.py) / [arXiv 2311.06242](https://arxiv.org/abs/2311.06242) |
| **Gemini 2.x/3.x**（闭源，参照） | `{"box_2d":[ymin,xmin,ymax,xmax],"label":"..."}`，**y 在前** | `[0,1000]` | `box_2d` | 是 | 【官方】Google cookbook（上次调研已核对） | [google-gemini/cookbook Spatial_understanding](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Spatial_understanding.ipynb) |
| **Gemma 3**（4B/12B/27B） | 官方文档/模型卡**未见** grounding/bbox 输出协议；社区有微调做检测 | 无官方约定 | 无 | 无官方 | 【官方】能力页；【二手】社区微调 | [Gemma 图像理解官方页](https://ai.google.dev/gemma/docs/capabilities/vision/image) |
| **Gemma 4**（若客户部署） | 类 Gemini `box_2d`，`[ymin,xmin,ymax,xmax]`（二手解析器按此实现） | `[0,1000]` | `box_2d` | 是 | 【二手】+【官方】vLLM 推理模型列表含 Gemma 4 | [sglang/vllm 推理支持](https://docs.vllm.ai/en/latest/features/reasoning_outputs.html) / [LibreYOLO parsing.py](https://github.com/LibreYOLO/libreyolo/blob/main/libreyolo/models/vlm/parsing.py) |
| **Llama 3.2 Vision**（11B/90B） | 官方材料**未定义** bbox 输出协议，只能 prompt 约定 + 自校验 | 无官方约定 | 无 | 需 prompt | 【不确定】 | [HF 模型卡](https://huggingface.co/meta-llama/Llama-3.2-11B-Vision-Instruct) |
| **Step-1o**（StepFun） | 本次检索未发现官方 grounding/bbox 协议；公开材料以图像理解/推理为主 | 未知 | 未知 | 未知 | 【不确定】 | [StepFun HF 组织页](https://huggingface.co/stepfun-ai) |
| **通用自微调模型** | 由训练数据决定：`<ref>/<box>`、JSON `bbox_2d`、`<ref-object>/<bbox>` 或纯文本坐标都可能 | 由训练数据决定（real / norm1 / norm1000） | 无统一 | 视数据 | 【官方】ms-swift 文档 | [ms-swift Custom-dataset](https://github.com/modelscope/ms-swift/blob/main/docs/source_en/Customization/Custom-dataset.md) |

### 1.2 逐族证据与坑（按客户出现概率排序）

**Qwen3-VL（最可能的换代目标）**
- 官方技术报告原文：*“Different from Qwen2.5-VL, we adopt a normalized coordinate system scaled to the range [0,1000] in this version.”*（§3.2.4 Grounding and Counting）——[arXiv 2511.21631](https://arxiv.org/html/2511.21631v1)。【官方】
- README 明确支持 boxes 与 points，并称用 *relative position coordinates*；同时给出 Thinking/Instruct 双版本、`transformers>=4.57.0`、`vllm>=0.11.0`、多图 `add_vision_id`（`Picture 1:` 文本前缀）等部署事实——[Qwen3-VL README](https://github.com/QwenLM/Qwen3-VL/blob/main/README.md)。【官方】
- **JSON 输出形态**：官方 README/技术报告未逐字给出 grounding 的完整 JSON 示例；官方 cookbook `2d_grounding.ipynb` 是默认参考（维护者原话：*“You can refer to the 2d_grounding cookbook for qwen2.5-vl and qwen3-vl answer format (which is a json list by default)”*）——[issue #1616 维护者回复](https://github.com/QwenLM/Qwen3-VL/issues/1616#issuecomment-3408996327)。【官方 issue 回复】
- 第三方实测：`{"bbox_2d":[x1,y1,x2,y2],"label":"..."}`，0–1000；并给出像素/1000 的换算——[LibreYOLO qwen3vl.py](https://github.com/LibreYOLO/libreyolo/blob/main/libreyolo/models/vlm/qwen3vl.py)。【二手，注释称 empirical】→ **上线前务必用探针实测，不要把二手当契约。**
- **Thinking**：Qwen3-VL Thinking 是独立 checkpoint（不是 `enable_thinking` 开关）——[README News](https://github.com/QwenLM/Qwen3-VL/blob/main/README.md)；其评测生成参数给到 `out_seq_length=40960`，**默认 `max_tokens` 不足时 JSON 必然被截断**。若客户实际部署 Qwen3 混合模型（非 VL），才用 `enable_thinking=false` 关思考。
- **smart_resize 参数换代**：Qwen2.5-VL `factor=28`，Qwen3-VL `factor=32`；`qwen-vl-utils` 的 `image_patch_size` 14 vs 16——[README Pixel Control / qwen-vl-utils 段](https://github.com/QwenLM/Qwen3-VL/blob/main/README.md)。【官方】

**Qwen2.5-VL（当前内置模型）**
- 技术报告原文：*“Unlike traditional approaches that normalize coordinates, our model directly uses the actual dimensions of the input image to represent bounding boxes, points, and other spatial features.”*（§2.1.2）——[arXiv 2502.13923](https://arxiv.org/html/2502.13923v1)。【官方】
- 官方博客给出稳定 JSON 输出示例 `{"bbox_2d":[341,258,397,360],"label":"motorcyclist"}`，并称 *“stable JSON outputs for coordinates”*——[Qwen2.5-VL 官方博客](https://qwenlm.github.io/blog/qwen2.5-vl/)。【官方】
- **换算公式（官方维护者在 Qwen3-VL issue 中给出）**：
  ```
  resized_h, resized_w = smart_resize(img_h, img_w, factor=28, min_pixels=..., max_pixels=...)
  # 仅 Qwen2.5-VL：把 GT/输出框缩放到 resize 后绝对像素
  resized_bbox = round(ori_bbox / [img_w,img_h,img_w,img_h] * [resized_w,resized_h,resized_w,resized_h])
  # 仅 Qwen3-VL：归一化到 0-1000
  resized_bbox = round(ori_bbox / [img_w,img_h,img_w,img_h] * [1000,1000,1000,1000])
  ```
  原话 *“it is recommended to use option A for qwen2.5-vl and to use option B for qwen3-vl”*——[issue #1616#issuecomment-3408996327](https://github.com/QwenLM/Qwen3-VL/issues/1616#issuecomment-3408996327)。【官方 issue 回复】
- 坑：官方 processor 推理时自动 resize，但**训练 GT 需自己算**；API 侧还会二次 resize（不同部署 `min_pixels/max_pixels` 默认值不同，如百炼文档给 Qwen2.5-VL 默认 `min_pixels=3136`、`max_pixels=1003520`）——[阿里云百炼 OpenAI 兼容文档](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)。【官方】
- 历史 issue：量化模型在 LM Studio/MLX 下坐标整体缩放错位，社区案例见 [Qwen3-VL issue #1030](https://github.com/QwenLM/Qwen3-VL/issues/1030)。【二手，官方仓库 issue】

**InternVL 2.5 / 3 / 3.5**
- 官方论文（Mini-InternVL，§3.3 Visual Grounding Tasks）原文：*“The native support for the Visual Grounding task … allows the use of a special token, `<ref></ref>`, to enclose the name of the object to be detected. With this token, the model can be directed to provide the object's location enclosed within `<box></box>` in the format `[[x1, y1, x2, y2]]`, where the coordinates range from 0 to 1000.”*——[arXiv 2410.16261](https://arxiv.org/html/2410.16261v1)。【论文，官方团队】
- 输入侧也可用 `<box>[[x1,y1,x2,y2]]</box>` 指向区域做区域描述/区域 VQA；训练数据把各种任务统一成 VQA + 特殊 token（同上）。
- 第三方/官方生态佐证：ms-swift 文档明确 *“qwen2/3-vl and internvl2.5 require bounding box coordinates to be normalized to the thousandth scale”*——[ms-swift Grounding 文档](https://github.com/modelscope/ms-swift/blob/main/docs/source_en/Customization/Custom-dataset.md)。【官方文档（ms-swift）】
- 注意：InternVL 官方 README（2025 版）**没有** grounding 协议章节，只有模型/部署/chat 示例——[OpenGVLab/InternVL README](https://github.com/OpenGVLab/InternVL)。因此不同微调版本可能改用 Qwen 式 JSON（客户模型尤其要探测）。

**MiniCPM-V 4.x**
- 官方 cookbook（v4.5 视觉定位页）：prompt `Please provide the bounding box coordinate of the region this sentence describes: <ref>airplane</ref>`；解析正则 `<box>([\d\s]+)</box>`；绘制时 `x = int(bbox[0]/1000*w)`，即 **0–1000** 归一化——[MiniCPM-V Cookbook Grounding](https://opensqz.github.io/MiniCPM-V-CookBook/site/zh/v4.5/inference/grounding.html)。【官方 cookbook】
- 多目标：要求返回 JSON `[{"name_en","name_zh","box":"x1 y1 x2 y2"}]`，其中 `box` 是**空格分隔的字符串**字段（不是数组），官方示例还会 `re.sub(r"</?box>", "", bbox_str)` 去掉残留 `<box>` 标记（同上）。
- **版本不确定**：4.0/4.5 的 grounding 能力与格式可能不同；cookbook 同时提供中文/英文本，v4.5 页面已核对，其它小版本未逐一核对。→ 标注【不确定：版本差异】。

**GLM-4.5V / GLM-4.6V / GLM-4.1V**
- 官方 README Grounding 段：输出四元组 `[x1,y1,x2,y2]`，*“each value is normalized by the image width (for x) or height (for y) and scaled by 1000”*；响应里用 `<|begin_of_box|>` / `<|end_of_box|>` 标记；*“The bracket style may vary ([], [[]], (), <>, etc.)”*；prompt 支持 *“Help me to locate <expr> in the image and give me its bounding boxes.”*——[zai-org/GLM-V README](https://github.com/zai-org/GLM-V/blob/main/README.md)。【官方】
- GLM-4.5V 有 **Thinking Mode 开关**（README：*“introduces a Thinking Mode switch, allowing users to balance between quick responses and deep reasoning”*）；GLM-4.1V 与 GLM-4.5V 的 **对话模板不同**（README 明确提醒），微调数据 `<think>`/`<answer>` 标签规则也不同（4.5V 要去掉 `<answer>` 标签）——同上。【官方】
- 坑：括号风格不固定 + 思考文本可能混排；解析必须“先剥思考段、再在全文里找 begin/end 标记 + 宽松括号”。

**Molmo / Molmo2**
- Molmo 论文：*“For pointing, the model outputs points as plain-text coordinates normalized between 0 and 100.”*（§4 Training）——[arXiv 2409.17146](https://arxiv.org/html/2409.17146v2)。【论文】
- Molmo 代码（LegacyPointFormatting，`coordinate_scale="100"`）：单点 `<point x="12.3" y="45.6" alt="dog">dog</point>`；多点 `<points x1="..." y1="..." … alt="dog">dog</points>`；另有 compact 格式（`<points label\talt\t1 12.3 45.6/>`）和 `Click(12.3,45.6)` 历史格式——[molmo2 point_formatter.py](https://github.com/allenai/molmo2/blob/main/olmo/preprocessing/point_formatter.py)。【官方代码】
- Molmo2（2026）改用 **0–1000** 的 HTML-like 格式：`<points coords="1 123 456 2 234 567">label</points>`，视频用 `<tracks coords="0.0 1 123 456 <tab> …">`；官方解析正则 `<(?:points|tracks).*? coords="([0-9\t:;, .]+)"/?>`，坐标段内 `([0-9]+) ([0-9]{3,4}) ([0-9]{3,4})`；计数模式输出 `Counting the <points…> shows a total of N.`，空结果输出 `There are none.`——[同上代码](https://github.com/allenai/molmo2/blob/main/olmo/preprocessing/point_formatter.py)。【官方代码】
- **代际差异**：Molmo(0924)=0–100 且无 box token；Molmo2=0–1000 且支持 boxes/tracks/多图。客户说“Molmo”要问版本。

**Florence-2**
- 官方 processor 定义任务 token 到后处理类型映射：`<OD>`/`<DENSE_REGION_CAPTION>`→`description_with_bboxes`，`<CAPTION_TO_PHRASE_GROUNDING>`→`phrase_grounding`，`<OPEN_VOCABULARY_DETECTION>`→`description_with_bboxes_or_polygons`，`<REGION_PROPOSAL>`→`bboxes` 等；`quantize_bins=(1000,1000)`，反量化用 `(bin+0.5)*size/1000` 并取整——[transformers processing_florence2.py](https://github.com/huggingface/transformers/blob/main/src/transformers/models/florence2/processing_florence2.py)。【官方代码】
- 关键：`<loc_*>` 是 **special token**，用常规 `skip_special_tokens=True` 解码会丢失；必须用 `post_process_generation`/`skip_special_tokens=False` 拿 token id 序列再反量化。【官方代码行为，工程结论】
- 适合“轻量备选/离线兜底”，中文长尾与遮挡鲁棒性弱于现代 VLM（沿用上次调研结论）。【推断】

**Gemma 3 / Gemma 4 / Llama 3.2 Vision / Step-1o**
- Gemma 3：官方「图像理解」能力页只讲 VQA/文档/多图，**没有 bbox 输出协议**；社区有 `gemma3-object-detection` 这类微调方案（二手，非官方）——[Gemma 图像理解官方页](https://ai.google.dev/gemma/docs/capabilities/vision/image)、[社区微调仓库](https://github.com/ariG23498/gemma3-object-detection)。→ 结论：**不建议作为出框模型**；若客户已微调，必须探针。
- Gemma 4：vLLM 推理模型列表已收录 *Gemma 4 series*（说明客户可能部署）；二手解析器按 Gemini 的 `box_2d` `[ymin,xmin,ymax,xmax]` 处理——[vLLM reasoning 文档](https://docs.vllm.ai/en/latest/features/reasoning_outputs.html)、[LibreYOLO parsing.py](https://github.com/LibreYOLO/libreyolo/blob/main/libreyolo/models/vlm/parsing.py)。【二手，需实测确认】
- Llama 3.2 Vision：官方材料无 bbox 输出协议（本次未找到；模型卡以图像理解/图表/文档为主）——[HF 模型卡](https://huggingface.co/meta-llama/Llama-3.2-11B-Vision-Instruct)。【不确定】
- Step-1o：本次检索未发现官方 grounding/bbox 输出协议；若客户使用只能按“通用 JSON + 探针”处理——[StepFun HF](https://huggingface.co/stepfun-ai)。【不确定】

---

## 2. 微调模型的常见输出约定

### 2.1 两条主流路线（ms-swift 官方文档，信息量最大）

ms-swift《Custom Dataset》Grounding 节把微调数据分成两种：

1. **模型原生格式**（每个模型一套 token/字段）：官方示例 Qwen2-VL 用 `<|object_ref_start|>a dog<|object_ref_end|><|box_start|>(221,423),(569,886)<|box_end|>`；同一文档明确警告：
   - *“Different models have different special characters and data format for the grounding task.”*
   - *“The handling of bounding box normalization varies across different models: for example, qwen2.5-vl uses absolute coordinates, while qwen2/3-vl and internvl2.5 require bounding box coordinates to be normalized to the thousandth scale.”*
   - 用 Qwen2.5-VL 原生格式时需**预先 resize 图片（宽高为 28 的倍数）并同步缩放坐标**；官方建议的替代是走路线 2 让 ms-swift 处理。
2. **ms-swift 的模型无关格式**：messages 里写占位符 `<ref-object>` / `<bbox>`，另加 `objects` 字段：
   ```json
   {"messages":[{"role":"user","content":"<image>Find the <ref-object> in the image"},
                {"role":"assistant","content":"<bbox><bbox>"}],
    "images":["/xxx/x.jpg"],
    "objects":{"ref":["sheep"],"bbox":[[90.9,160.8,135,212.8],[360.9,480.8,495,532.8]]}}
   ```
   - `objects.bbox_type`：`'real'`（默认，真实像素）或 `'norm1'`（0–1 归一化）；`image_id` 处理多图。
   - **Qwen2.5-VL/Qwen3-VL 可设环境变量 `QWENVL_BBOX_FORMAT='new'` 对齐官方 cookbook 的 JSON 风格**：`[{"bbox_2d": <bbox>, "label": "<ref-object>"}]`。
   - 训练样本级还可用 `chat_template_kwargs` 控制 `min_pixels/max_pixels/fps/enable_thinking`。

来源：[ms-swift Custom-dataset 官方文档](https://github.com/modelscope/ms-swift/blob/main/docs/source_en/Customization/Custom-dataset.md)。【官方文档】
配套证据：ms-swift 有专门的 grounding 重构 PR，处理特殊字符/归一化——[PR #3000](https://github.com/modelscope/ms-swift/pull/3000)。【官方仓库】

### 2.2 LLaMA-Factory 侧现状

- LLaMA-Factory 的 VLM 微调数据是 ShareGPT/`messages` + `images` 路径；**grounding 没有独立的官方“模型无关 schema”**，官方示例/issue 讨论靠手写模型原生 token（如 Qwen 的 `<|object_ref_start|>`/`<|box_start|>`）。
- 社区真实困惑（官方仓库 open issue）：*是否需要手写特殊 token*、*bbox 是否要按内部 resize 手动缩放*——[LLaMA-Factory issue #9279](https://github.com/hiyouga/LLaMA-Factory/issues/9279)、[Qwen3-VL issue #1616](https://github.com/QwenLM/Qwen3-VL/issues/1616)。这两个 issue 本身是【二手/社区】，但 Qwen 维护者的回复是【官方 issue 回复】（见 §1.2 公式）。
- 结论：**客户自微调模型 = 最大不确定源**。可能继承官方方言，也可能被训练成 `{"label","bbox":[x1,y1,x2,y2]}` 自定义 JSON（`bbox` 而非 `bbox_2d`，值域 0–1/0–1000/像素任意）。→ 必须探针 + 支持“用户手工指定 profile”。

### 2.3 常见训练/推理约定速查

| 约定项 | 常见取值 | 谁在用 | 处理建议 |
|---|---|---|---|
| bbox 字段名 | `bbox_2d` / `bbox` / `box` / `boxes` / `region` | Qwen3-VL、Qwen2.5-VL、MiniCPM JSON、第三方 wrapper | JSON 归一化时做别名表，按优先级取值 |
| 字段形态 | 4 元素数组 / `"x1 y1 x2 y2"` 字符串 / 4 个独立字段 / 双中括号嵌套 | MiniCPM 字符串、InternVL 双中括号、部分微调 | 统一转 `[x1,y1,x2,y2]` 数字数组 |
| 坐标量纲 | 绝对像素 / 0–1 / 0–100 / 0–1000 | 见 §1 表 | 不能靠猜；探针 + profile |
| 顺序 | `xyxy`（多数）/ `yxyx`（Gemini、Gemma4 box_2d） | Gemini/Gemma4 | profile 记录 `box_order`，支持转置 |
| 归一化基准 | 原图 / resize 后图 | Qwen2.5-VL 是 resize 后 | Qwen2.5-VL 按 §1.2 公式反算 |
| 特殊 token | `<|box_start|>`、`<box>`、`<|begin_of_box|>`、`<loc_*>`、`<ref>` | 各族 | 解析前保留原文；Florence 必须 skip_special_tokens=False |
| 训练数据是否要求手写 token | 不一定（Qwen 维护者称 grounding 特殊 token 非必须，JSON list 为默认） | Qwen 官方 | 提示词层不要假设 token 存在 |

依据：Qwen 维护者回复（[issue comment](https://github.com/QwenLM/Qwen3-VL/issues/1616#issuecomment-3408996327)）【官方】；其余为 §1 各族官方材料归纳。

### 2.4 有没有成熟的“通用 bbox 解析库”？

- **没有可直接依赖的成熟库**。现状是“每个推理 wrapper 自己写解析”：
  - LibreYOLO 的 VLM 层用 `BBOX_KEY` + `COORD_DIVISOR` + `box_format` 三个配置适配不同模型族（LFM2-VL `[0,1]`、Qwen3-VL `bbox_2d`/1000、Gemma4/Gemini `box_2d` yxyx），并有专门的 tolerant parser（markdown fence、前后散文、截断数组、单引号、schema 回显、重复框去重、IoU 去重）——[libreyolo parsing.py](https://github.com/LibreYOLO/libreyolo/blob/main/libreyolo/models/vlm/parsing.py)、[qwen3vl.py](https://github.com/LibreYOLO/libreyolo/blob/main/libreyolo/models/vlm/qwen3vl.py)。【二手，Apache-2.0 可参考实现】
  - 评测框架（lmms-eval / VLMEvalKit）是“每个模型一个 parser/evaluator”，不是通用库；Qwen3-VL README 明确评测用这两个框架——[Qwen3-VL README](https://github.com/QwenLM/Qwen3-VL/blob/main/README.md)。
  - 结论：**自研解析层，但直接借鉴 LibreYOLO 的容错策略与配置化思路**（不要引入其模型加载依赖；解析文件是纯函数、无 torch 依赖，可移植核心逻辑）。

---

## 3. OpenAI 兼容部署差异矩阵

### 3.1 主矩阵（直接影响调用层）

| 部署 | 图片字段 | data URL（base64） | 最大 token 参数 | 结构化输出 | 思考开关 / 思考字段 | 主要坑 | 证据 |
|---|---|---|---|---|---|---|---|
| **vLLM**（0.11+ 支持 Qwen3-VL） | `image_url:{url}`；支持 http(s)/`file://`/data URL | ✅ 支持（文档多处用 `data:image/jpeg;base64,…`） | `max_completion_tokens` 文档示例使用；`max_tokens` 也支持 | `structured_outputs` extra_body（官方服务文档明确）；`response_format` 走 Structured Outputs 文档（未逐字复核） | `chat_template_kwargs`（如 `enable_thinking:false`）；`--reasoning-parser qwen3`；返回 **`reasoning`** | `image_url.detail` 明确不支持；`--reasoning-parser` 必须服务端开启，否则思考混入 content；`reasoning_content` 已更名 `reasoning`，旧客户端会读到空 | 【官方】[OpenAI server](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/)、[multimodal](https://docs.vllm.ai/en/latest/features/multimodal_inputs.html)、[reasoning](https://docs.vllm.ai/en/latest/features/reasoning_outputs.html) |
| **SGLang** | `image_url:{url}`；http URL 有官方示例 | 文档未明示（示例仅 URL）→ 需实测 | 示例用 `max_tokens`；`max_completion_tokens` 未见文档 | Structured Outputs（JSON/regex/EBNF）官方文档 | `extra_body.chat_template_kwargs`（`enable_thinking`/`thinking`）；`separate_reasoning` 默认 True；返回 **`reasoning_content`** | 关掉 `separate_reasoning` 会把思考并入 content；Qwen3 默认开思考；Thinking 模型不支持 `enable_thinking` | 【官方】[completions](https://docs.sglang.io/docs/basic_usage/openai_api_completions)、[vision](https://docs.sglang.io/docs/basic_usage/openai_api_vision) |
| **Ollama** | `image_url` 支持 **base64 data URL**；**不支持图片 URL**（文档明确 `[ ] Image URL`） | ⚠️ 仅 base64；且示例把 `image_url` 写成**字符串**而非 `{url:…}` 对象 | 仅列 `max_tokens`（**未列** `max_completion_tokens`） | `response_format`（JSON mode）✅ | `reasoning_effort` / `reasoning.effort`；无 `chat_template_kwargs` | 无 `tool_choice`/`logit_bias`/`user`/`n`；不同模型支持的 reasoning effort 名字不同 | 【官方】[Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) |
| **LM Studio** | 支持文本+图片（端点页声明），图片字段细节未文档化 | 未文档化 → 需实测 | 仅列 `max_tokens`（**未列** `max_completion_tokens`） | `response_format` JSON Schema ✅（GGUF 用 grammar，MLX 用 Outlines） | 思考控制文档分散在 Responses 页；chat 负载参数表未列 reasoning 相关 | 支持参数表很短（无 `response_format` 之外的 OpenAI 高级项）；结构化输出依赖模型能力 | 【官方】[chat completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)、[structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output) |
| **Xinference** | `image_url:{url}`，URL 与 data URL 均可（官方示例两种） | ✅ | 未在该页说明（取决于后端） | 未在该页说明（取决于后端） | 取决于后端（vLLM/SGLang/transformers/MLX） | 多模态上限用 `limit_mm_per_prompt`（仅 vLLM 后端生效）；无显式限制且无法可靠计数时回退为每模态最多 2 项 | 【官方】[Xinference multimodal](https://inference.readthedocs.io/en/latest/models/model_abilities/multimodal.html) |
| **阿里云百炼 DashScope**（兼容模式） | `image_url:{url}`，URL 或 **Base64 Data URL** | ✅ | 请求体参数文档未逐项对照（`max_tokens` 通用） | 文档另有结构化输出页（未逐字核对兼容模式支持范围） | `extra_body.enable_thinking`；返回 **`reasoning_content`**；`clear_thinking` 控制多轮回传思考（GLM 系） | `min_pixels/max_pixels/total_pixels` 可**按 content part 传**；默认值随模型不同（Qwen2.5-VL 图 3136/1003520）；非流式超时至少 300s | 【官方】[OpenAI 兼容 Chat](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) |

### 3.2 逐项说明与工程结论

1. **`max_tokens` vs `max_completion_tokens`**：vLLM 明确支持/示例 `max_completion_tokens`；SGLang、Ollama、LM Studio 的文档示例/参数表只列 `max_tokens`。→ **调用层默认发 `max_tokens`，对支持 `max_completion_tokens` 的服务可选叠加；不要只发后者**（否则 Ollama/LM Studio 可能 400/忽略）。证据同上表。
2. **思考字段**：
   - vLLM：*“`reasoning` used to be called `reasoning_content`. To migrate, directly replace…”*；`include_reasoning=false` 可抑制返回——[vLLM reasoning 文档](https://docs.vllm.ai/en/latest/features/reasoning_outputs.html)。【官方】
   - SGLang：`separate_reasoning` 默认 True，思考在 `message.reasoning_content`；False 则并回 content——[SGLang 文档](https://docs.sglang.io/docs/basic_usage/openai_api_completions)。【官方】
   - 百炼：响应含 `reasoning_content`（`clear_thinking` 语义直接引用该字段名）——[阿里云文档](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)。【官方】
   - **工程结论**：解析层读取顺序 `content` → `reasoning` → `reasoning_content` → 全部 message 文本里找 `<think>…<｜end▁of▁thinking｜>`；**并记录“思考是否污染 content”为 profile 字段**。
3. **结构化输出**：vLLM/SGLang/LM Studio/Ollama 都有 JSON 约束能力，但 Ollama 仅 `response_format` JSON mode（对 schema 支持有限）、LM Studio 明确 JSON Schema；**不能假设 `response_format` 一定被接受**——现有 `model.ts` 未使用它，建议做成“可选增强 + 失败降级”。
4. **图片字段的兼容写法**（按兼容性从高到低）：`{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,…"}}`（vLLM/SGLang/百炼/Xinference/LM Studio 常规）→ Ollama 示例用 `"image_url":"data:…"` 字符串形式。→ 调用层可先发标准对象形式，400 时重试字符串形式（Ollama 专用降级）。
5. **data URL 体积**：当前主进程把 ffmpeg 抽的 PNG 直接 base64（`src/main/model.ts` 的 `dataUrlForImage`）。1080p PNG 常见 1–3MB，base64 后 +33%，单请求 body 可达 3–4MB；内网代理/网关常有 body 上限。→ 建议抽帧输出 JPEG（q≈85）或降采样到长边 1280 再送审，并在配置里留“图片压缩参数”。（工程推断，非官方文档；Ollama/百炼的媒体限制见上表。）
6. **图片获取超时/SSRF**：vLLM 对 HTTP 图片默认 **5s** 超时、视频 30s，并建议 `--allowed-media-domains` 限制 SSRF——[vLLM multimodal 文档](https://docs.vllm.ai/en/latest/features/multimodal_inputs.html)。【官方】→ 内网工具应始终用 data URL，避免服务端外呼。
7. **多图请求**：Qwen3-VL 只提供 `add_vision_id` 文本前缀 `Picture 1:`，**坐标归属仍是模型猜测**——[Qwen3-VL README](https://github.com/QwenLM/Qwen3-VL/blob/main/README.md)。【官方】→ 沿用仓库结论：分组请求只做 triage，**框必须逐帧单图请求**。
8. **`temperature=0` 不等于确定性**：现有调用固定 `temperature:0`（`src/main/model.ts:168`），但服务端批处理/采样实现仍可能抖动；探针需重复 2 次验证 JSON 稳定性。

---

## 4. 解析方言链建议

### 4.1 总体流程（先保真、再归一、最后判可信）

```
raw 响应 JSON
  → 取 message：content + reasoning/reasoning_content（保留原文）
  → 剥 Markdown fence / 前后散文 / <think> 段（思考只做 fallback 来源，默认不采信）
  → 方言链解析（按 profile 优先，未知时并行打分）
  → 统一 IR：{label, coords:[x1,y1,x2,y2], raw_space, source, parser, confidence}
  → 坐标解析：按 profile 的 space/order/divisor 映射到“原图像素”
  → 校验/清洗：x1<x2, y1<y2, clamp, 去退化框, 同标签 IoU>0.8 去重, 上限 N
  → 输出：boxes + diagnostics（dialect, space, parse_ok, json_ok, thinking_polluted, raw_snippet）
```

### 4.2 中间表示（IR）建议

```ts
interface RawBox { label: string; coords: [number, number, number, number];
  space: 'normalized_1'|'normalized_100'|'normalized_1000'|'abs_px'|'unknown';
  order: 'xyxy'|'yxyx'; source: 'json'|'token'|'loc_bins'|'bare'|'text';
  parser: string; confidence: number }
```

- 只把 `coords` 当“待解释数字”，**不要在解析阶段就乘宽高**；统一在坐标解析阶段做一次映射。
- `confidence` 由 parser 命中完整度 + 坐标合理性（是否在 [0, 维度×1.5] 内、宽高比是否极端）综合；低于阈值 → 交人工复核，不画框。

### 4.3 解析器优先级（从结构化到非结构化）

| 优先级 | parser | 触发特征 | 正则/要点 | 误判风险 |
|---|---|---|---|---|
| 1 | **JSON 多 schema** | 文本含 `{`/`[` | 括号平衡扫描所有顶层数组/对象；取含 detection 形 dict（有 `label`/`bbox`/`bbox_2d`/`box`）最多的数组；支持 Markdown fence、单引号、截断闭合 | schema 回显/示例数组被当成结果；`[0,1]` 散文被误当框（必须要求 dict 形） |
| 2 | **`<box>` 系**（InternVL/MiniCPM/Qwen2-VL） | 含 `<box>`、`<|box_start|>`、`<|begin_of_box|>`、`<|end_of_box|>` | 宽松匹配 begin/end 或 `<box>…</box>`，允许 `[[ ]]`/`( )`/`,`/空格 分隔；4 数字 | 双中括号嵌套、缺闭合、GLM 括号风格漂移；思考文本中“草稿框” |
| 3 | **Molmo/Molmo2 HTML-like** | 含 `<points`/`<point ` | `<points coords="…">label</points>` 取 coords，再按 `(idx x y)` 三元组；legacy `x\d*="…" y\d*="…"`；`Click(x,y)` | 首 token 是帧号/序号不是坐标；0–100 vs 0–1000 混淆 |
| 4 | **Florence loc bins** | 原文含 `<loc_`（必须在未过滤 special token 的 token 序列上） | 连续 4 个 `<loc_N>` 成框；`(N+0.5)*W/1000`/`(N+0.5)*H/1000`；任务 token 决定语义 | 文本解码已丢 token → regex 永远匹配不到，误判“无框”；多边形 `<poly>` 混排 |
| 5 | **纯坐标文本**（通用微调） | 含 `[[x1,y1,x2,y2],…]`、`(x1,y1),(x2,y2)`、每行 4 数字、`x1 y1 x2 y2` | 见下方代码块；限制“一行只取一个框”，避免把叙述数字拼框 | 把尺寸/时间戳/评分当坐标；0–1 小数与 0–1000 整数混淆 |
| 6 | **拒答/无目标** | 文本含 `There are none`/`no objects`/`not present`/`未发现`/`无` 且无数字 | 返回空列表 + `no_target=true`，**不报错** | “no” 出现在 “no helmet” 等否定描述里 → 必须要求“无任何数字坐标”才判空 |

### 4.4 关键正则（可直接抄）

```ts
// 通用 JSON 提取（balanced）：伪代码
function extractJsonCandidates(text: string): unknown[]  // 扫描所有平衡 []/{}，逐个 JSON.parse，失败跳过

// InternVL / MiniCPM / Qwen2-VL box token（宽松）
const BOX_TOKEN = /<\|?box_start\|?>|<\|?begin_of_box\|?>/g;         // 定位起始
const BOX_BODY  = /[\[\(]?\s*([-\d.]+)\s*[,\s]\s*([-\d.]+)\s*[,\s]\s*([-\d.]+)\s*[,\s]\s*([-\d.]+)\s*[\]\)]?/g;
const BOX_CLOSE = /<\s*\/\s*box\s*>|<\|?box_end\|?>|<\|?end_of_box\|?>/g;   // 注意 <box>…</box> 与裸 token 两种

// Molmo2 新版
const MOLMO2 = /<points\s+coords="([^"]+)"[^>]*>([\s\S]*?)<\/points>/g;
const MOLMO2_TRIPLE = /(\d+)\s+(\d{3,4})\s+(\d{3,4})/g;             // idx x y（0-1000）

// Molmo 旧版
const MOLMO_LEGACY_PAIR = /x\d*="\s*([\d.]+)"\s+y\d*="\s*([\d.]+)"/g; // 0-100 一/多点
const CLICK = /Click\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g;

// Florence（仅在 skip_special_tokens=false 的文本上）
const LOC = /<loc_(\d+)>/g;   // 每 4 个成一组；坐标 = (bin+0.5)*size/1000

// 纯坐标 4 元组（限制单行，避免跨行拼接）
const QUAD_BRACKET = /\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]/g;
const QUAD_PAREN   = /\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)\s*[,;]?\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g;
const QUAD_PLAIN   = /^[ \t]*([-\d.]+)[, \t]+([-\d.]+)[, \t]+([-\d.]+)[, \t]+([-\d.]+)[ \t]*$/gm;
```

### 4.5 伪代码（方言链主函数）

```ts
function parseGrounding(rawContent: string, profile: DialectProfile): ParseResult {
  const text = stripFences(stripThinkBlocks(rawContent));          // 思考段不进主解析
  const parsers = orderParsers(profile.dialect);                   // profile 已知 → 对应 parser 置顶
  const results: RawBox[] = [];
  for (const p of parsers) {
    const boxes = p.parse(text);                                   // 每个 parser 返回 IR 列表
    if (boxes.length) { results.push(...boxes); if (profile.dialect !== 'auto') break; }
  }
  if (!results.length && profile.dialect === 'auto') {
    const scored = parsers.flatMap(p => score(p.parse(text)));     // 并行打分：命中数 + schema 完整度 + 坐标合理性
    const best = pickBest(scored);                                 // 分差 < 20% → ambiguous
    if (best) results.push(...best.boxes); else return { boxes: [], no_target: isRefusal(text) };
  }
  return finalize(resolveCoordinates(results, profile), profile);  // 空间/顺序映射 + 清洗 + 诊断
}

function resolveCoordinates(boxes, profile) {
  return boxes.map(b => {
    let [x1,y1,x2,y2] = b.coords;
    if (b.order === 'yxyx' || profile.boxOrder === 'yxyx') [y1,x1,y2,x2] = [x1,y1,x2,y2]; // ymin,xmin,ymax,xmax → xyxy
    const div = { normalized_1: 1, normalized_100: 100, normalized_1000: 1000, abs_px: 1 }[b.space ?? profile.coordSpace];
    const w = profile.imageWidth, h = profile.imageHeight;
    const px = (b.space === 'abs_px' || profile.coordSpace === 'abs_px')
      ? [x1,y1,x2,y2]                                           // 绝对像素（Qwen2.5-VL 为 resize 后，需外部先反算）
      : [x1/div*w, y1/div*h, x2/div*w, y2/div*h];
    return clampAndValidate(px, w, h);
  });
}
```

**自动探测优先级（dialect 未知时）**：JSON 多 schema（1）> box token（2）> Molmo（3）> loc bins（4）> 纯坐标（5）。理由：结构化程度越高，误判率越低；纯坐标解析最容易把散文数字当框，必须放最后且加“单行/成对”约束。

---

## 5. 能力自检探针设计（1 张图 + 2 次请求）

### 5.1 标定图（合成，程序绘制，不依赖素材库）

- 画布 **1280×720** 白底，黑色 2px 边框（便于检查是否整体偏移）。
- 5 个纯色矩形（GT 像素坐标写死）：
  - 红 `[100,80,300,240]`、蓝 `[900,400,1100,600]`、绿 `[640,340,700,400]`（小目标）、黄 `[200,600,900,640]`（细长）、黑 `[40,40,120,120]`。
- 中心叠加大号文字 `CAL-1`（用于 OCR/描述自检，不参与坐标判定）。
- 探针图不要出现文字提示“坐标用 0-1000”，**避免诱导模型**。

### 5.2 两次请求

- **R1**：原图（1280×720）→ prompt：
  ```
  你是图像定位能力自检器。图中有若干彩色矩形。请只返回一个 JSON 数组，不要输出任何解释文字。
  每个元素格式：{"label":"red","bbox":[x1,y1,x2,y2]}
  坐标请使用你训练时的原生坐标表示，不要做任何换算。
  ```
- **R2**：把同一张图**缩放到 640×360** 再发（内容相同），prompt 同 R1（或加“请保持坐标格式不变”）。用途：区分绝对像素 vs 归一化；同时验证 JSON 稳定性。
- 若 R1 未出框：补一次“单目标、最简单”的 R3（只问红色矩形，降低任务难度）以区分“模型不会 grounding”与“prompt/格式不适配”；总请求数控制在 ≤3 次。
- 记录原始响应全文（脱敏后）：`choices[0].message` 的所有键、`finish_reason`、`usage`、延迟。

### 5.3 判定算法（自动写 profile）

```
输入：R1/R2 解析结果（用 §4 方言链，profile=auto，坐标暂不映射）
1. 方言判定：命中 parser 及命中数 → dialect（若 R1/R2 不一致 → dialect='mixed'，保守取 JSON）
2. 坐标空间判定（对每个假设 h 计算 meanIoU）：
   h ∈ {abs_px, norm_1000, norm_1, norm_100, yxyx 变体, xywh 变体}
   - abs_px：R1 坐标约等于 GT；R2 坐标应 ≈ R1 坐标 × 0.5（同比例）
   - norm_*：R2 坐标 ≈ R1 坐标（尺寸变化不影响归一化值）
   - yxyx：交换后 IoU 提升 > 0.2 才采纳
   - 若 R1 与 R2 都 ≤ 1.01 → norm_1；都 ≤ 100.5 且带小数 → norm_100（Molmo 旧版特征）
   - 若 max(coord) > 1000 且 ≤ 1.2×max(W,H) → abs_px
3. 置信门槛：最佳 meanIoU ≥ 0.5 且领先次优 ≥ 0.15 → 采纳；否则 coordSpace='unknown'
4. JSON 稳定性：R1、R2 均严格 JSON 可解析且 schema 合法 → json_ok=true；任一次失败/需修复 → json_ok=false
5. 思考污染：message 同时有非空 reasoning/reasoning_content 且 content 合法 → thinking_separated=true；
   content 内含 <｜end▁of▁thinking｜>/<think>/大段解释后才出现 JSON → thinking_polluted=true
6. 特殊 token 泄漏：content 出现 <|box_start|>/<|begin_of_box|>/<loc_ → token_leak=true（记录）
7. 失败兜底：coordSpace=unknown 或 json_ok=false → 该端点降级为“只判定、不出框”
输出 profile（见 5.4），写回配置；探针结果缓存，附日期与模型名，模型名变化时重跑。
```

- **歧义处理**：当 `norm_1000` 与 `abs_px` 的 IoU 接近（例如标定图小、框都 <1000），不要猜：用 R2 的“坐标是否随图像缩放”做裁决；仍歧义 → `unknown`。
- **多目标退化**：若 R1 只出 1 个框，只验证该框的坐标空间，`multiTarget=false` 写入 profile（影不影响画框由业务决定）。
- **温度与重试**：`temperature=0`；R1 失败重试 1 次（网络/格式），仍失败则 `unsupported`。

### 5.4 端点 profile（配置层建议）

```jsonc
{
  "endpoint_id": "intranet-a",
  "base_url": "http://10.0.0.10:8000/v1",
  "model": "qwen3-vl-32b-instruct",
  "dialect": "qwen3vl_json",            // 枚举：qwen3vl_json / qwen25vl_json / internvl_refbox / minicpm_box / glm_box / molmo2_points / florence_loc / generic_json / unknown
  "coordSpace": "normalized_1000",       // abs_px / normalized_1000 / normalized_100 / normalized_1 / unknown
  "boxOrder": "xyxy",                    // xyxy / yxyx
  "bboxKey": "bbox_2d",
  "imageField": "image_url_object",      // image_url_object / image_url_string（Ollama 降级）
  "supportsDataUrl": true,
  "maxTokensField": "max_tokens",        // max_tokens / max_completion_tokens
  "supportsResponseFormat": false,
  "reasoningField": "reasoning",         // reasoning / reasoning_content / none
  "thinkingPollutesContent": false,
  "specialTokensLeak": false,
  "multiTarget": true,
  "jsonReliable": true,
  "degradeToVerdictOnly": false,
  "probe": { "date": "2026-11-09", "r1MeanIoU": 0.83, "r2MeanIoU": 0.81, "confidence": "high" }
}
```

**配置层原则**：profile 是“能力事实”不是“模型名分支”；同一 base_url 换模型必须重跑探针；允许人工覆盖（客户自微调模型探针失败时，让集成方手填 dialect/space）。

---

## 6. 风险清单（按严重度排序）

| # | 风险 | 表现 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | **坐标空间误判** | 框整体等比缩小/放大、四角向中心收缩 | 画错框，审核员不信任 | 探针 + profile；未知不画框；范围校验（>1.5×图像尺寸直接丢弃） |
| 2 | **Qwen2.5-VL smart_resize 反算错** | 框整体偏移/缩放（尤其非 1:1 宽高比） | 同上 | 用官方公式（§1.2）+ 服务端 `min_pixels/max_pixels` 固定；或改用 Qwen3-VL 归一化 |
| 3 | **Thinking 吞 token / 污染 content** | `finish_reason=length`、JSON 截断、思考混入 | 解析失败/幻觉框 | max_tokens 给足（≥2048，Thinking 更大）；优先 `enable_thinking=false` 或 Instruct 版本；读 `reasoning*` 字段 |
| 4 | **思考字段名差异** | 读 `reasoning_content` 在 vLLM 新版本为空 | 误判“模型没思考” | 同时读 `reasoning`/`reasoning_content`；记录 profile |
| 5 | **特殊 token 被过滤** | `<loc_*>`/`<|box_start|>` 直接消失 | Florence 完全无框、Qwen2-VL token 解析不到 | Florence 必须 skip_special_tokens=False；token 系模型优先 JSON 提示 |
| 6 | **结构化输出不可用** | `response_format` 400/被忽略 | 返回非 JSON | 参数降级 + 解析重试 + JSON 修复；不把 schema 当契约 |
| 7 | **多图坐标归属错乱** | 框画到别的帧 | 审核错位 | 逐帧单图请求；分组只 triage |
| 8 | **data URL 体积/媒体限制** | 413/超时/服务端拒收 | 请求失败 | PNG→JPEG、降采样；探测服务端上限；始终 data URL（避免 SSRF/超时） |
| 9 | **模型版本漂移** | 升级后方言/坐标变化（Qwen2.5→Qwen3 已发生） | 线上突然全错 | `/v1/models` 名 + 探针缓存失效；升级即重跑探针 |
| 10 | **客户自微调方言** | 自定义 JSON 字段/值域 | 解析不到 | 人工 profile + 开放“自定义正则/字段映射”配置 |
| 11 | **精度上限与幻觉框** | 小目标漏检、遮挡框大、把海报/屏幕当实物 | 漏检/误报 | 提示词约束（仓库现有 system prompt 已有）+ 人工复核 + 小目标 tiling + 多次采样投票 |
| 12 | **探针被提示词带偏** | 探针 prompt 暗示坐标空间，测出假 profile | 线上错 | 探针 prompt 不指定坐标空间；用两块不同尺寸图交叉验证 |

---

## 7. 参考链接（按证据等级分组）

### 7.1 官方文档 / 模型卡 / 官方仓库

- Qwen3-VL README（模型、Thinking、部署版本、多图、pixel 控制）：<https://github.com/QwenLM/Qwen3-VL/blob/main/README.md>
- Qwen3-VL 维护者关于 grounding 格式/换算的回复：<https://github.com/QwenLM/Qwen3-VL/issues/1616#issuecomment-3408996327>
- Qwen2.5-VL 官方博客（JSON `bbox_2d` 示例）：<https://qwenlm.github.io/blog/qwen2.5-vl/>
- InternVL 官方仓库：<https://github.com/OpenGVLab/InternVL>
- MiniCPM-V 官方 Cookbook · 视觉定位：<https://opensqz.github.io/MiniCPM-V-CookBook/site/zh/v4.5/inference/grounding.html>
- GLM-V 官方仓库（Grounding / Thinking / 微调格式）：<https://github.com/zai-org/GLM-V/blob/main/README.md>
- Molmo 官方仓库：<https://github.com/allenai/molmo>
- Molmo2 官方仓库：<https://github.com/allenai/molmo2>
- Florence-2 官方处理代码（transformers）：<https://github.com/huggingface/transformers/blob/main/src/transformers/models/florence2/processing_florence2.py>
- Gemma 图像理解（官方能力页）：<https://ai.google.dev/gemma/docs/capabilities/vision/image>
- ms-swift 官方数据集文档（Grounding 节）：<https://github.com/modelscope/ms-swift/blob/main/docs/source_en/Customization/Custom-dataset.md>
- ms-swift grounding 重构 PR：<https://github.com/modelscope/ms-swift/pull/3000>
- vLLM OpenAI 兼容服务：<https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/>
- vLLM 多模态输入：<https://docs.vllm.ai/en/latest/features/multimodal_inputs.html>
- vLLM 推理输出（`reasoning` 字段改名）：<https://docs.vllm.ai/en/latest/features/reasoning_outputs.html>
- SGLang OpenAI 补全（`chat_template_kwargs`/`reasoning_content`）：<https://docs.sglang.io/docs/basic_usage/openai_api_completions>
- SGLang 视觉 API：<https://docs.sglang.io/docs/basic_usage/openai_api_vision>
- Ollama OpenAI 兼容性（支持字段清单）：<https://docs.ollama.com/api/openai-compatibility>
- LM Studio OpenAI 兼容 Chat：<https://lmstudio.ai/docs/developer/openai-compat/chat-completions>
- LM Studio 结构化输出：<https://lmstudio.ai/docs/developer/openai-compat/structured-output>
- Xinference 多模态：<https://inference.readthedocs.io/en/latest/models/model_abilities/multimodal.html>
- 阿里云百炼 OpenAI 兼容 Chat（data URL / min_pixels / reasoning_content）：<https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions>

### 7.2 论文 / 技术报告

- Qwen3-VL Technical Report（§3.2.4 归一化 0–1000）：<https://arxiv.org/abs/2511.21631>（HTML：<https://arxiv.org/html/2511.21631v1>）
- Qwen2.5-VL Technical Report（§2.1.2 绝对坐标）：<https://arxiv.org/abs/2502.13923>（HTML：<https://arxiv.org/html/2502.13923v1>）
- Qwen2-VL（`[0,1000)` + box token）：<https://arxiv.org/abs/2409.12191>
- Mini-InternVL（§3.3 `<ref></ref><box>[[…]]</box>` 0–1000）：<https://arxiv.org/html/2410.16261v1>
- Molmo & PixMo（points 0–100）：<https://arxiv.org/html/2409.17146v2>
- Molmo2（video pointing/tracking）：<https://arxiv.org/html/2601.10611v4>
- Florence-2：<https://arxiv.org/abs/2311.06242>
- GLM-4.5V / GLM-4.1V 技术报告：<https://arxiv.org/abs/2507.01006>

### 7.3 二手参考（仅作实现思路，不作契约）

- LibreYOLO 容错解析（markdown fence/截断/schema 回显/别名键/yxyx）：<https://github.com/LibreYOLO/libreyolo/blob/main/libreyolo/models/vlm/parsing.py>
- LibreYOLO Qwen3-VL 适配（`bbox_2d`/1000 的实测注释）：<https://github.com/LibreYOLO/libreyolo/blob/main/libreyolo/models/vlm/qwen3vl.py>
- Gemini 空间理解 cookbook（`box_2d` y 在前，官方示例）：<https://github.com/google-gemini/cookbook/blob/main/quickstarts/Spatial_understanding.ipynb>
- 社区 Gemma 3 目标检测微调（非官方协议）：<https://github.com/ariG23498/gemma3-object-detection>
- Qwen3-VL 量化部署坐标错位 issue：#1030：<https://github.com/QwenLM/Qwen3-VL/issues/1030>
- LLaMA-Factory grounding 困惑 issue：#9279：<https://github.com/hiyouga/LLaMA-Factory/issues/9279>
- LibreYOLO PR 中关于 Molmo2 parser 边界的讨论：<https://github.com/LibreYOLO/libreyolo/pull/341>

### 7.4 本仓库内相关文档（不重复调研）

- `docs/archive/research/vlm-grounding.md`（Qwen 三代坐标、Florence/检测器对比、精度上限与误差来源）
- `docs/archive/research/industry-survey.md`、`docs/archive/research/ui-tracking.md`（业务与 UI 追踪背景）
- `docs/design/localization-design.md`（多框功能的产品/交互设计；P0 设计方案）

---

## 8. 待办与不确定项（交给 Lead 决策）

1. **Qwen3-VL points 的 JSON 字段名**（`point_2d`?）未拿到官方逐字示例 → 探针覆盖即可，不建议写死解析。
2. **Gemma 4 / Step-1o / Llama 3.2 Vision 的 grounding 协议**本次未找到官方原文 → 客户若真要出框，按“通用 JSON + 探针 + 人工复核”处理，并在合同中注明“框为提示框”。
3. **SGLang / LM Studio 的 data URL 支持**未文档化 → 探针的 R1 请求本身即可验证（失败则降级尝试）。
4. **Qwen2.5-VL 在客户具体部署（vLLM/百炼/LM Studio/llama.cpp）下的 resize 参数**未实测 → 建议第一次连接时用标定图同时跑 §5 探针，并把 `min_pixels/max_pixels` 写进端点配置。
5. **是否引入 LibreYOLO 解析代码**：其 parsing.py 是纯函数、无模型依赖，可移植；但其许可证/归属需 Lead 评估（本文件只记录，不引入依赖）。
