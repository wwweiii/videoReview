# 视频智能审核

内网桌面视频审核工具。工作台导入本地视频后，按预设抽帧间隔提取原始分辨率画面，调用多模态模型检测所选物品，在结果列表与帧预览中展示判定与**违禁物位置标记**，供人工复核。

当前版本：0.1.0，支持 Windows x64 与银河麒麟 Linux V10 SP1 x64。技术栈：Electron 38 + electron-vite 4 + React 19 + TypeScript 5.7。

## 功能

- 拖入或选择本地视频，点击“开始分析”运行
- 工作台支持“识别物品”和“识别行为”两条独立任务流程；行为识别按设置页中保存的行为类别采样判定，采样窗口、推进间隔与每秒帧数可在设置页调整（默认 2 秒窗口、每 2 秒推进、4 FPS）
- 原始分辨率 PNG 抽帧，内置 ffmpeg（免安装运行）
- 逐帧、分组两种模型发送方式
- **违禁物清单**：预设手机、矿泉水、工作牌、中性笔、铅笔、保温杯、笔记本、钥匙、夹子、回形针、牙签、订书针、耳机、一次性筷子、不锈钢工具、手表、数据线、空调遥控器 18 项。列表中显示的物品全部启用，点击右侧取消按钮移出列表，输入名称可重新添加；还可添加最多 30 个自定义违禁物。物品提示词直接使用名称。
- **违禁物定位标记（多框）**：对异常/待复核帧单独发起“定位请求”，不限制每帧框数；帧预览默认**不显示**定位框，鼠标悬浮右侧「检测对象」时才显示对应框，点击检测对象可把框固定住（支持同时固定多个，再点取消），避免画面一开始就被框铺满；定位只针对本帧判定确认的对象，与判定对象不一致的框会被过滤
- **模型无关适配**：不绑定具体模型；不同模型（Qwen2.5-VL / Qwen3-VL / InternVL / MiniCPM-V / GLM / Florence / 自微调模型）的坐标空间、轴序、输出方言由「能力探针 + 解析方言链」自动适配
- 任务记录、结果筛选、搜索、帧预览
- 物品帧列表与行为片段列表支持在分页处输入页码，按回车或移开焦点后跳转到指定页；筛选或搜索后自动回到第一页。
- 物品识别记录与行为识别记录分开管理；行为片段支持连续采样画面、原视频片段回放、事件证据与 CSV 导出
- 行为类别不内置预设，需在「设置 → 行为识别 → 识别行为」中自行添加和删除；行为任务会保存创建时的行为名称与采样参数快照
- 失败重试、任务取消、物品识别结果导出为 Excel，附原始帧和标有异常对象位置的图片
- 物品任务详情在出现失败时显示「失败重试」按钮；只重跑判定失败的帧，定位失败的帧只补跑定位，成功帧保留原结果。重试期间隐藏按钮，全部成功后自动隐藏。
- 内置预设加密，配置校验与解密均在主进程完成，渲染进程拿不到明文配置

## 调整配置页初始默认值

配置页的初始默认值统一维护在 `src/shared/defaults.ts`，按「模型配置、物品识别、行为识别」分区，可调整连接参数、高级设置、图片缩放比例、行为列表和采样参数。文件末尾为校验范围和数量限制。

- `DEFAULT_MODEL_MODE` 为 `auto` 时，有内置预设则默认选预设，否则选自定义；设为 `custom` 可默认选自定义。
- `DEFAULT_CUSTOM_MODEL` 配置自定义接口地址、模型名称、初始密钥与超时。`DEFAULT_MODEL_RUNTIME` 配置展开高级设置后生效的参数。`DEFAULT_TRACE_ENABLED` 控制「启用轨迹」的初始状态，默认为关闭。
- 检测物品列表初始为空，由用户在设置中添加。`DEFAULT_BEHAVIOR_ITEMS` 配置初始行为列表，示例格式见代码注释。
- 已保存的配置优先。验证全新启动默认值时，先关闭应用，备份并移走 `data/settings.json`，再重新启动开发应用；发布包需要重新构建。若通过 `VIDEOREVIEW_DATA_DIR` 指定了数据目录，应处理该目录下的 `settings.json`。
- `preset.enc` 中的参数仍可覆盖对应初始值（并发数、物品抽帧间隔、发送方式、每组帧数、置信度阈值、定位开关及两类图片比例）。

初始密钥会随共享代码打包，正式密钥建议在设置页填写。调整默认值不会修改已有任务的配置快照。

## 定位标记的工作方式

1. **判定段（保持原逻辑）**：逐帧/分组请求，只返回是否异常、类别、证据、置信度，不要求坐标；
2. **定位段（新增）**：仅对判定为 `异常/待复核` 的帧逐帧请求，要求模型返回所有可确认的目标框（不限制每帧框数）；提示词会带上“本帧已判定存在 X”的约束，只允许框判定确认的对象；
3. **边判定边定位**：判定出一帧异常就立刻入队定位（并发 2–3 个请求），框不必等全部判定跑完；能力探针也在后台预热，不额外阻塞；
4. **自适应**：首次定位前运行探针（同一张合成标定图发两个尺寸），自动判定坐标空间（0–1 / 0–100 / 0–1000 / 绝对像素）、轴序与解析方言；
5. **优雅降级**：模型不支持定位时，功能自动关闭并提示，不影响判定结果；支持手动指定坐标空间/轴序/方言兜底；
6. **速度取舍**：物品与行为识别分别配置图片缩放比例，默认 100% 原尺寸。物品判定和定位共用同一比例、保留抽帧图片格式，行为抽帧沿用 JPEG；降低比例可减少像素数量，但应检查小目标和细节是否仍清晰。

更完整的设计推导、坐标证据链与实测记录见 [docs/design/localization-design.md](docs/design/localization-design.md)。

## 目录结构

```text
videoReview/
├─ electron.vite.config.ts        # electron-vite 构建配置（@shared / @renderer 别名）
├─ electron-builder.linux.json    # Linux x64 发布配置（只带 Linux ffmpeg）
├─ tsconfig*.json                 # node / web 两套 TypeScript 类型检查配置
├─ build/                         # 打包用图标资源（icon.ico / icon.png）
├─ resources/                     # 随包分发的运行资源
│  ├─ bin/win32/x64/ffmpeg.exe    # Windows 内置视频处理组件（gitignore，npm run fetch:ffmpeg 下载）
│  ├─ bin/linux/x64/ffmpeg        # Linux 内置视频处理组件（同上）
│  ├─ config/                     # 运行时配置目录（preset.enc 本地生成，见该目录 README）
│  ├─ icon.png
│  ├─ 使用说明-windows.txt         # Windows 发布包说明（打包时写入包内 使用说明.txt）
│  └─ 使用说明-linux.txt           # Linux 发布包说明（同上）
├─ scripts/                       # 工程脚本（无第三方依赖优先）
│  ├─ build 相关：package-win.mjs / package-linux.mjs（打包后整理绿色发布包）
│  ├─ clean.mjs                   # 清理 out/ release/ .tmp/（可选 --data）
│  ├─ mock-model-server.mjs       # OpenAI 兼容的 mock 多模态模型服务
│  ├─ encrypt-preset.mjs          # 生成加密预设 resources/config/preset.enc
│  ├─ verify-localization.mjs     # 定位逻辑 / 方言链 / 探针判定验证
│  └─ smoke/                      # Electron 端到端冒烟（e2e-entry.ts + run-e2e.mjs）
├─ docs/
│  ├─ README.md                   # 文档索引（设计文档 / 归档调研）
│  ├─ design/localization-design.md
│  └─ archive/research/           # 历史调研归档（只读参考）
├─ src/
│  ├─ main/                       # Electron 主进程
│  │  ├─ index.ts                 # 应用入口：单实例、窗口、媒体协议注册
│  │  ├─ ipc.ts                   # IPC 通道注册与参数校验
│  │  ├─ paths.ts                 # 数据 / 资源 / 任务路径解析
│  │  ├─ logger.ts                # 文件日志（data/logs/app.log）
│  │  ├─ app/                     # window（窗口生命周期）、media-protocol（vr-media:// 帧图与缩略图）
│  │  ├─ config/                  # settings、model-config、preset（解密）、profiles（能力缓存）
│  │  ├─ model/                   # client（HTTP 调用）、analysis（判定）、prompts（提示词）
│  │  ├─ localization/            # probe（能力探针）、locator（定位）、probe-image（标定图）
│  │  ├─ task/                    # manager、store、summary、event、analysis、regions、runner、export
│  │  └─ media/ffmpeg             # 视频探测 / 抽帧 / 缩略图
│  ├─ preload/index.ts            # contextBridge 暴露的白名单 API
│  ├─ renderer/                   # React 渲染层
│  │  ├─ index.html
│  │  └─ src/
│  │     ├─ pages/                # 工作台、任务详情等页面
│  │     ├─ components/           # layout / common / task / settings 分组组件
│  │     ├─ hooks/                # 复用状态与副作用
│  │     ├─ lib/                  # 渲染层工具函数
│  │     └─ styles/               # 样式
│  └─ shared/                     # 主进程与渲染层共享的纯逻辑
│     ├─ api.ts types.ts defaults.ts format.ts items.ts task.ts
│     └─ localization/            # 方言解析、探针判定、坐标映射、提示词
├─ data/                          # 运行时生成（gitignore）：设置、任务、日志、Electron 缓存
├─ out/                           # electron-vite 构建产物（gitignore）
├─ release/                       # 打包产物（gitignore）：Windows zip / Linux tar.gz
└─ .tmp/                          # 验证 / 冒烟的临时目录（gitignore）
```

> 目录为重构后的目标分层；个别文件仍可能随开发调整，具体以 `src/` 当前代码为准。

## 开发与构建

开发环境要求：Windows x64 或 Linux x64，Node.js `^20.19.0` 或 `>=22.12.0`（electron-vite 4 的要求，推荐 22 LTS），npm。当前发布脚本在银河麒麟 V10 SP1 x86_64 上验证。

首次拉取代码后先下载内置 ffmpeg（单文件约 80 MB，不随 Git 提交）：

```bash
npm run fetch:ffmpeg            # 下载当前平台的 ffmpeg 到 resources/bin/
npm run fetch:ffmpeg -- --all   # Windows + Linux 两个平台都下载
npm run fetch:ffmpeg -- --force # 已存在时强制重新下载
```

- 下载源：[ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1)（GPL-3.0），许可证文本已随仓库提交。
- 脚本会校验文件头（Windows 为 `MZ`、Linux 为 `ELF`），Linux 下自动加执行权限；已存在的文件默认跳过。
- 内网或代理环境可用环境变量 `FFMPEG_STATIC_BASE` 指向镜像地址，例如 `FFMPEG_STATIC_BASE=https://mirror.example.com/ffmpeg-static npm run fetch:ffmpeg`。

```bash
npm install        # 或 npm ci（已有 package-lock.json）

npm run dev        # 开发模式（electron-vite dev，主进程 + 渲染层热更新）
npm run build      # 仅构建到 out/（不打包安装包）
npm run preview    # 预览已构建产物（electron-vite preview）
npm run build:win  # 构建 + 打包 Windows x64 发布包（release/videoReview-win-x86.zip + 同名目录）
npm run build:linux # 构建 + 打包麒麟 Linux x64 便携包（release/videoReview-linux-x64.tar.gz + 同名目录）
```

构建 Windows 时，`scripts/package-win.mjs` 会把 electron-builder 的 `win-unpacked/` 整理成「启动器 + 运行组件子目录」的绿色包。构建 Linux 时，`scripts/package-linux.mjs` 会把 `linux-unpacked/` 整理为同样的数据目录布局并生成 tar.gz。两个脚本都会清理对应的旧中间产物。

两个平台使用各自的使用说明：Windows 读取 `resources/使用说明-windows.txt`，Linux 读取 `resources/使用说明-linux.txt`，打包时分别复制为包内的 `使用说明.txt`。

解压后根目录为 exe + 使用说明 + 运行组件子目录，双击 exe 即可运行（直接启动，没有单文件便携版那种解压等待）：

```text
videoReview-win-x86/
├─ 视频智能审核.exe      # 启动器，双击运行（几十 KB）
├─ 使用说明.txt          # Windows 版使用说明
└─ app/                  # Electron 运行时（真实 exe 为 app/videoReview.exe，请勿拆分/移动）
```

启动器会以 `app/videoReview.exe` 启动应用，并把数据目录指向包根目录的 `data/`（首次运行自动创建；目录不可写时回退到系统用户数据目录）。内置 ffmpeg、图标、加密预设等资源都在 `app/` 内。

Linux x64（银河麒麟 V10 SP1）包解压后结构如下：

```text
videoReview-linux-x64/
├─ 视频智能审核         # 启动脚本，需从此文件启动
├─ 使用说明.txt         # Linux 版使用说明
├─ data/                # 首次启动自动写入设置、任务和日志
└─ app/                 # Electron 运行时与内置 ffmpeg，请勿拆分/移动
```

Linux 包不需要安装 Node.js 或联网。解压后执行 `./视频智能审核`（文件管理器中双击也可以）；请把整个目录放在当前用户有写权限的位置。启动脚本会将数据目录设为包根目录的 `data/`，也支持在启动前设置绝对路径环境变量 `VIDEOREVIEW_DATA_DIR` 覆盖该位置。当前 Linux 构建目标为 x86_64，与银河麒麟 V10 SP1 x86_64 虚拟机验证环境一致。

## 测试与验证

```bash
npm run typecheck            # 类型检查：tsc --noEmit（node + web 两套 tsconfig）
npm run verify:reliability   # 可靠性、全局调度、存储/事件回归及合成负载对比

npm run verify:localization  # 纯逻辑 + 真实 HTTP 到 mock：
                             #   多方言解析、4 坐标空间 × 2 轴序、探针判定、边界模式
npm run smoke:localization   # 构建 + Electron 冒烟（抽帧、判定、定位、落盘、设置界面）
npm run verify               # 依次执行类型检查、可靠性回归、定位验证和端到端冒烟

npm run clean                # 清理 out/、release/、.tmp/
npm run clean -- --dry-run   # 只预览将清理的内容
npm run clean -- --data      # 额外清理 data/electron、data/logs 缓存（保留设置/能力缓存/任务）
```

说明：

- `verify:localization` 不依赖 Electron，脚本会把 `src/shared/localization` 打成 ESM 后在 Node 中运行，并自动拉起 `scripts/mock-model-server.mjs`。
- `verify:reliability` 使用真实业务模块及隔离临时目录，通过可控网络、抽帧边界和磁盘故障注入验证异常路径；同时检查公平排队、取消、图片缓存预算、诊断去重、旧数据兼容和批量事件。输出的 `PERFORMANCE` 行对比原全量统计/内嵌轨迹方案与新实现，属于合成负载数据，不代表真实视频识别速度。
- `smoke:localization` 会先构建应用，再把 `scripts/smoke/e2e-entry.ts` 打包成 CJS，用 Electron 真实执行。隐藏窗口验证设置自动保存、高级设置生效、切页、关闭请求、启动任务及调用轨迹开关和按需读取。还验证真实图片转换、多任务请求上限及 FFmpeg 取消。数据目录隔离在 `.tmp/smoke-data`，不会污染 `data/`。运行前需先执行 `npm run fetch:ffmpeg`。
- 两者都会使用 `.tmp/`，**不要并行执行**；冒烟结束后会自行清理其数据目录。
- `clean` 只删除可再生构建/测试产物，不碰 `src/`、`data/` 业务数据；`--data` 也只清明确列出的缓存子目录。

## 用 Mock 模型联调

```bash
# 默认：0–1000 相对坐标 + JSON 方言
node scripts/mock-model-server.mjs

# 模拟其他方言 / 坐标空间
MOCK_DIALECT=box_tokens MOCK_SPACE=absolute node scripts/mock-model-server.mjs
```

设置页填写：接口地址 `http://127.0.0.1:8899/v1`，模型名称 `mock-vl`。

- `MOCK_DIALECT`：`json`（默认）/ `bbox_2d` / `box_tokens` / `plain` / `single` / `none`
- `MOCK_SPACE`：`normalized_1000`（默认）/ `normalized_100` / `normalized_01` / `absolute`
- 其他：`MOCK_PORT`（默认 8899）、`MOCK_DELAY_MS`（默认 300）、`MOCK_ABNORMAL_EVERY`（默认每 3 帧出现 1 个异常）

## 设置

点击侧边栏「设置」默认进入「物品识别」子页；设置页左侧二级菜单分三个子页：

- **物品识别**可设置抽帧间隔、发送方式（选择“分组”时每组帧数内联显示）、检测物品和**标记违禁物位置**。检测物品可用「、」或「，」隔开后一次添加，例如「充电宝、相机，水杯」。标记开关右侧的**图片缩放比例**（1%–100%，默认 100%）同时控制判定和定位。100% 直接使用原始抽帧数据，较小比例按原宽高缩放并保留图片格式。原始抽帧始终保留供复核。图片配置随新建任务固定，判定、定位及失败重试都沿用该任务快照。
- **行为识别**：识别行为（自行添加/删除）；采样参数——**窗口**（默认 2 秒）、**推进**（默认 2 秒）、**每秒帧数**（默认 4 FPS）；每秒帧数右侧为独立的**图片缩放比例**（1%–100%，默认 100%）
  - 窗口：每个片段覆盖的时长；
  - 推进：相邻片段起点的间隔，小于窗口时相邻片段重叠，大于窗口时片段之间留有空隙；
  - 每秒帧数：每秒采样画面数。
  - 三项采样参数与图片缩放比例在创建行为任务时写入任务快照，修改只影响新任务，不影响已有任务。
- **模型配置**：**请求上限**（1–8）、模型接口、模型名称、密钥。点击测试连接下方的**高级设置**箭头，展开并启用自定义模型的额外请求体、坐标空间和轴序。收起后，实际运行使用空额外请求体与自动坐标、轴序和解析方言。再次展开时恢复已保存的高级参数。

在「设置 → 模型配置」展开**高级设置**并打开**启用轨迹**后，应用开始记录调用，开关右侧显示**调用轨迹**按钮。抽屉按时间倒序列出物品判定、行为判定、定位、能力探针和连接测试的调用，包含失败记录。每页加载 30 条摘要，可刷新或加载更多。点击一条记录可按需查看请求、响应、耗时和 token 信息，关闭详情会返回原列表位置。首次打开自动导入已有任务轨迹并去重，图片仅保存摘要。收起高级设置或关闭轨迹开关都会停止记录和读取，历史记录会保留。收起高级设置会记住轨迹开关的状态。

提示词固定使用中文。应用不发送 `max_tokens`、`max_completion_tokens` 或 `max_output_tokens`，输出上限由模型服务端的默认配置决定；旧设置、旧预设及额外请求体中的输出上限不会继续生效。服务端返回截断结果时，判定与定位仍按失败处理。

两页的“图片缩放比例”均支持 1%–100%，100% 保留原尺寸，50% 表示宽、高各减半（像素数量约为原来的四分之一，不代表文件大小或 JPEG 质量）。物品判定和定位保留原 PNG/JPEG 格式，100% 直接复用原文件数据；行为画面按原视频尺寸抽帧，沿用 JPEG 编码，不再有 1120 像素上限。物品与行为比例分别自动保存，使用预设模型时也可独立调整。

旧 `imageMaxEdge` 像素上限与定位 `imageFormat` 配置不再使用；旧像素值无法准确换算为统一百分比，升级后默认 100%。已有物品判定比例保留，定位改为共用该比例；旧模型中的共用百分比迁入行为设置，之后不再随模型配置变化。新预设分别使用 `PRESET_ITEM_IMAGE_SCALE_PERCENT` 与 `PRESET_BEHAVIOR_IMAGE_SCALE_PERCENT`；旧 `PRESET_IMAGE_SCALE_PERCENT` 仅作为行为比例的兼容默认值。修改比例只影响新任务，已有行为片段重试复用原抽帧。旧判定图片设置迁移为 100%，不再对新任务单独转换 PNG/JPEG 或设置 JPEG 质量；已经创建的旧任务判定重试仍按其快照中的原长边、格式和质量处理。

坐标空间和轴序默认自动探测，手动选项供模型适配排障。探测档案按接口地址、模型名、提示词及生效的额外请求体和坐标覆盖配置复用；同地址、同模型名的服务端升级不会自动触发重新探测，升级后应重新验证定位。

修改设置后立即显示加载图标和「保存中」，并延迟 300 毫秒自动保存。「已保存」显示 2 秒，切换页面时立即消失。保存失败时可点击「重试保存」。连续编辑会按顺序保存最新值，切换页面保留草稿和保存队列。物品、行为、模型配置和轨迹开关独立保存，模型草稿不合法不会阻止其他分区保存。

启动、重试任务以及关闭窗口前会等待尚未保存的设置提交；保存失败时会提示原因并保留当前页面，不会使用未保存的配置启动任务。

生产分发时可通过加密预设省略模型配置。开始物品识别前，请先在设置中添加检测物品。

## 加密预设

```powershell
# 最小配置（PowerShell 示例）
$env:PRESET_BASE_URL = "http://10.0.0.10:8000/v1"
$env:PRESET_MODEL = "qwen2.5-vl-32b-instruct"
$env:PRESET_API_KEY = "your-key"
npm run encrypt-preset
```

生成 `resources/config/preset.enc` 后重新打包。预设只由主进程解密，页面不会读取接口地址、模型名称或密钥。该目录的约定见 [resources/config/README.md](resources/config/README.md)。

可在预设中同时写入以下默认分析参数。

```powershell
$env:PRESET_INTERVAL_SEC = "2"
$env:PRESET_MODE = "single"          # single / group
$env:PRESET_GROUP_SIZE = "4"
$env:PRESET_THRESHOLD = "0.6"
$env:PRESET_LOCALIZE = "true"
$env:PRESET_BASE_URL = "http://10.0.0.10:8000/v1"
$env:PRESET_MODEL = "qwen2.5-vl-32b-instruct"
npm run encrypt-preset
```

预设加密用于防止界面和普通查看者获取配置，不是服务端级密钥保护。需要严格保密时，应结合内网访问控制或独立密钥分发。

## 数据目录

```text
data/
├─ settings.json                 # 设置
├─ model-profiles.json           # 模型能力探测结论（换模型/改提示词会自动失效）
├─ tasks/<task-id>/task.json     # 判定 + 定位结果（框为归一化坐标）
├─ tasks/<task-id>/summary.json  # 列表摘要，失效时自动重建
├─ tasks/<task-id>/details/      # 原始响应与调用记录引用，按内容摘要去重
├─ model-calls/                # 启用轨迹后保存的统一调用轨迹与分页摘要
├─ tasks/<task-id>/calls/        # 独立调用轨迹，图片只保留类型/大小/SHA-256
├─ tasks/<task-id>/frames/*.png  # 抽帧画面（原始分辨率）
├─ tasks/<task-id>/prepared/     # 判定/定位图片转换副本，重试可复用
├─ tasks/<task-id>/thumbs/*.jpg  # 预览缩略图（按需生成）
├─ electron/                     # Electron userData / session 缓存
└─ logs/app.log                  # 运行日志
```

- 数据目录优先级：环境变量 `VIDEOREVIEW_DATA_DIR`（必须是绝对路径；发行包启动器会把它指向解压目录下的 `data/`）> 打包后 exe 同级 `data/`（可写时）> Electron 默认 userData。
- 开发模式下默认使用仓库根的 `data/`；冒烟脚本通过 `VIDEOREVIEW_DATA_DIR` 指向 `.tmp/smoke-data` 隔离目录，`verify:localization` 只用 `.tmp/` 存放临时 bundle 与 mock 进程。
- 删除任务会同时删除对应画面与分析结果。
- 新保存的任务使用 `schemaVersion: 2`：诊断文件先写入，任务清单最后替换。旧任务可直接读取，首次需要保存时迁移；复制或备份任务时需要保留整个任务目录。历史列表优先读取摘要，摘要缺失或与任务文件不一致时重建。

## 资源与性能

- 判定、定位、探针、测试连接和重试共用全局模型请求预算，按任务轮转排队。排队取消不会发送请求；物品判定和行为请求取得名额后才读取图片。重试退避释放名额，网络超时从实际请求开始计算。降低上限时不强制中断已执行的请求，待其结束后遵循新上限。
- 抽帧最多同时运行 1 个；判定图片转换最多同时运行 2 个，并在独立 FFmpeg 进程完成；定位缩放也复用该处理与缓存。物品与行为图片异步读取，图片内容内存缓存最多 24 MiB，转换副本存于任务目录。
- 已结束任务详情最多缓存 8 个，并以序列化体积 32 MiB 为淘汰预算；运行中或尚未保存的任务保留。原始响应和调用轨迹按需读取，普通任务查询和进度事件不传输这些正文。
- 帧统计增量更新；同一任务在 150 毫秒内的帧变更合并发送，终态立即刷新。页面按一批变更更新结果数组，避免每帧重复复制及筛选全部结果。

## 判定、保存与取消

- 正常和异常结果均检查置信度；低于阈值或为 null 时转为「待复核」。物品判定的置信度或复核标记缺失、无效时也转为待复核；行为响应缺失必要字段或类型错误则按解析失败处理。未配置的类别、正常结论与非空类别矛盾、异常结论缺少类别或证据，均不自动采信。
- 物品按规范名称及显式别名匹配，行为按配置名称匹配，避免短名称误匹配到较长名称。分组结果支持对象或数组，按编号还原顺序；重复编号、缺失结果不会自动猜测归属。模型输出被截断或定位响应损坏时按失败处理，合法空定位结果仍可接受。
- 任务保存按任务串行写入临时文件后替换原文件。普通更新合并 700 毫秒；持续更新最长等待 2 秒就安排保存（不包含磁盘排队及写入耗时）。完成状态落盘成功后才对外发布；保存错误会显示在任务详情，可恢复磁盘后重试。
- 取消会终止请求和抽帧进程，等待工作结束后保存取消状态；未完成的判定与定位会转为失败，可后续重试。抽帧阶段取消、没有任何结果的任务也支持重新抽帧。
- 关闭应用会先提交设置，再取消运行任务并等待保存。保存失败或收尾超时时保持应用打开并提示；异常退出后，下次启动会将遗留任务标为中断，并修复未结束的判定和定位状态。

## 文档

- 文档索引：[docs/README.md](docs/README.md)
- 定位标记设计（当前有效）：[docs/design/localization-design.md](docs/design/localization-design.md)
- 历史调研归档：[docs/archive/research/](docs/archive/research/)

## 当前边界

- 只支持本地视频，不支持网络流、直播和无时长视频。
- 可同时提交多个任务；模型请求共用全局上限，抽帧排队执行。
- 原尺寸 PNG 请求体可能较大，可单独调整判定与定位/行为的缩放比例；缩放对小目标的影响需要用业务样本验证。
- 定位框是**辅助复核线索**，不是精确标注；VLM 定位在遮挡/小目标/反光场景会明显变差，仍需人工复核。
- 已从预设清单移除的旧物品 ID 仅保留历史任务显示兼容，新任务按设置页当前显示的物品清单检测；清单为空时需先添加物品。
