# 文档索引

本目录只放「设计文档」与「历史调研归档」两类内容。产品说明、目录结构、开发与验证命令以根 [README.md](../README.md) 为准，命令以 `package.json` 的 `scripts` 为准。

## 设计文档（当前有效）

| 文档 | 说明 |
| --- | --- |
| [design/localization-design.md](design/localization-design.md) | 违禁物定位标记（Bounding Box）设计方案：两段式「判定 / 定位」、模型能力探针 + 解析方言链、坐标空间自适应、分层降级、框的按需显示。**写于 P0 阶段，文中代码路径以当前结构为准**；§9 记录了 P0 及后续轮次的实现与实测修正。 |

## 归档调研（历史参考）

以下文档是定位标记立项前后的调研报告，保留原始证据与 URL 引用，供追溯设计依据。其中提到的文件路径、组件名、行号均为**当时快照**，不作为当前代码结构或接口契约的依据。

| 文档 | 内容 |
| --- | --- |
| [archive/research/vlm-grounding.md](archive/research/vlm-grounding.md) | VLM 定位能力、Qwen 三代坐标口径、Florence / 检测器对比、精度上限与误差来源 |
| [archive/research/model-dialects.md](archive/research/model-dialects.md) | 各模型族 grounding 方言与部署差异（模型无关适配的依据） |
| [archive/research/ui-tracking.md](archive/research/ui-tracking.md) | 帧上多框渲染 / 交互 / 时间轴 / 导出的前端工程方案与踩坑清单 |
| [archive/research/industry-survey.md](archive/research/industry-survey.md) | 竞品、开源与学术调研；增强思路 ROI 与合规证据链 |

## 如何阅读

1. 先读根 [README.md](../README.md)，了解产品功能、目录结构、开发与验证命令。
2. 想知道「定位标记为什么这么设计」→ 读 `design/localization-design.md` 的 §0（结论先行）、§3（推荐方案）、§9（实现记录）。
3. 需要追溯原始证据、核对模型方言或评估替代方案时，再查 `archive/research/`；结论与路径以当前代码和根 README 为准。
4. 新增设计文档放在 `docs/design/`；被取代的调研或设计移入 `docs/archive/` 并在本索引登记，不直接删除。

## 维护约定

- 代码结构、构建或验证命令变化时，同步更新根 `README.md` 与本索引。
- 文档之间互相引用使用相对路径，保证在仓库内可直接跳转。
- 文档是辅助材料，行为细节以 `src/` 与 `scripts/` 的当前实现为准。
