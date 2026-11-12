# 视频智能审核

内网桌面视频审核工具。工作台导入本地视频后，按预设抽帧间隔提取原始分辨率画面，调用多模态模型检测所选物品，在结果列表与帧预览中展示判定与**违禁物位置标记**，供人工复核。

当前版本：0.1.0，支持 Windows x64 与银河麒麟 Linux V10 SP1 x64。技术栈：Electron 38 + electron-vite 4 + React 19 + TypeScript 5.7。

## 功能

- 拖入或选择本地视频，点击“开始分析”运行
- 工作台支持“识别物品”和“识别行为”两条独立任务流程；行为识别按设置页中保存的行为类别采样判定，采样窗口、推进间隔与每秒帧数可在设置页调整（默认 2 秒窗口、每 2 秒推进、4 FPS）
- 原始分辨率 PNG 抽帧，内置 ffmpeg（免安装运行）
- 逐帧、分组两种模型发送方式
- **违禁物清单**：内置「笔、水杯、水壶、手机」四项固定检测（不可删除）；可自行添加自定义违禁物，自定义项可勾选/取消、可删除
- **违禁物定位标记（多框）**：对异常/待复核帧单独发起“定位请求”，不限制每帧框数；帧预览默认**不显示**定位框，鼠标悬浮右侧「检测对象」时才显示对应框，点击检测对象可把框固定住（支持同时固定多个，再点取消），避免画面一开始就被框铺满；定位只针对本帧判定确认的对象，与判定对象不一致的框会被过滤
- **模型无关适配**：不绑定具体模型；不同模型（Qwen2.5-VL / Qwen3-VL / InternVL / MiniCPM-V / GLM / Florence / 自微调模型）的坐标空间、轴序、输出方言由「能力探针 + 解析方言链」自动适配
- **只重跑定位**：换模型或补标后，可对已有任务重新定位，无需重跑判定
- 任务记录、结果筛选、搜索、帧预览
- 物品识别记录与行为识别记录分开管理；行为片段支持连续采样画面、原视频片段回放、事件证据与 CSV 导出
- 行为类别不内置预设，需在「设置 → 行为识别 → 识别行为」中自行添加和删除；行为任务会保存创建时的行为名称与采样参数快照
- 失败重试、任务取消、结果导出（CSV 含定位状态与归一化框）
- 内置预设加密，配置校验与解密均在主进程完成，渲染进程拿不到明文配置

## 定位标记的工作方式

1. **判定段（保持原逻辑）**：逐帧/分组请求，只返回是否异常、类别、证据、置信度，不要求坐标；
2. **定位段（新增）**：仅对判定为 `异常/待复核` 的帧逐帧请求，要求模型返回所有可确认的目标框（不限制每帧框数）；提示词会带上“本帧已判定存在 X”的约束，只允许框判定确认的对象；
3. **边判定边定位**：判定出一帧异常就立刻入队定位（并发 2–3 个请求），框不必等全部判定跑完；能力探针也在后台预热，不额外阻塞；
4. **自适应**：首次定位前运行探针（同一张合成标定图发两个尺寸），自动判定坐标空间（0–1 / 0–100 / 0–1000 / 绝对像素）、轴序与解析方言；
5. **优雅降级**：模型不支持定位时，功能自动关闭并提示，不影响判定结果；支持手动指定坐标空间/轴序/方言兜底；
6. **速度取舍**：定位请求会自动把图片长边压到 1120（可在设置里调，0=自动）；外部接口建议把“定位图片格式”设为 JPEG，上传体积约为 PNG 的 1/5～1/10。

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

npm run verify:localization  # 纯逻辑 + 真实 HTTP 到 mock：
                             #   多方言解析、4 坐标空间 × 2 轴序、探针判定、边界模式
npm run smoke:localization   # Electron 端到端冒烟（真实 ffmpeg 抽帧 → 判定 → 定位 → 落盘 → 重定位）
npm run verify               # 依次执行 typecheck + verify:localization + smoke:localization

npm run clean                # 清理 out/、release/、.tmp/
npm run clean -- --dry-run   # 只预览将清理的内容
npm run clean -- --data      # 额外清理 data/electron、data/logs 缓存（保留设置/能力缓存/任务）
```

说明：

- `verify:localization` 不依赖 Electron，脚本会把 `src/shared/localization` 打成 ESM 后在 Node 中运行，并自动拉起 `scripts/mock-model-server.mjs`。
- `smoke:localization` 会把 `scripts/smoke/e2e-entry.ts` 打包成 CJS，用 Electron 真实执行；数据目录隔离在 `.tmp/smoke-data`，不会污染 `data/`。运行前需先执行 `npm run fetch:ffmpeg`。
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

- **物品识别**：抽帧间隔、发送方式（选择“分组”时每组帧数内联显示）、检测物品（内置四项固定 + 自定义）、**标记违禁物位置**
- **行为识别**：识别行为（自行添加/删除）；采样参数——**窗口**（默认 2 秒）、**推进**（默认 2 秒）、**每秒帧数**（默认 4 FPS）
  - 窗口：每个片段覆盖的时长；
  - 推进：相邻片段起点的间隔，小于窗口时相邻片段重叠，大于窗口时片段之间留有空隙；
  - 每秒帧数：每秒采样画面数。
  - 三项参数在创建行为任务时写入任务快照，修改只影响新任务，不影响已有任务。
- **模型配置**：模型接口、模型名称、密钥；模型高级配置（额外请求体、max tokens、**定位图片长边**、**定位图片格式**、提示词语言、坐标空间/轴序覆盖）；测试连接

三个子页共用页面顶部的「保存」按钮，一次保存全部设置。

生产分发时可通过加密预设省略模型配置，用户打开工作台直接上传即可。

## 加密预设

```powershell
# 最小配置（PowerShell 示例）
$env:PRESET_BASE_URL = "http://10.0.0.10:8000/v1"
$env:PRESET_MODEL = "qwen2.5-vl-32b-instruct"
$env:PRESET_API_KEY = "your-key"
npm run encrypt-preset
```

生成 `resources/config/preset.enc` 后重新打包。预设只由主进程解密，页面不会读取接口地址、模型名称或密钥。该目录的约定见 [resources/config/README.md](resources/config/README.md)。

可在预设中同时写入默认分析参数（`PRESET_ITEMS` 为内置物品 id，逗号分隔）：

```powershell
$env:PRESET_INTERVAL_SEC = "2"
$env:PRESET_ITEMS = "pen,cup,kettle,phone"
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
├─ tasks/<task-id>/frames/*.png  # 抽帧画面（原始分辨率）
├─ tasks/<task-id>/thumbs/*.jpg  # 预览缩略图（按需生成）
├─ electron/                     # Electron userData / session 缓存
└─ logs/app.log                  # 运行日志
```

- 数据目录优先级：环境变量 `VIDEOREVIEW_DATA_DIR`（必须是绝对路径；发行包启动器会把它指向解压目录下的 `data/`）> 打包后 exe 同级 `data/`（可写时）> Electron 默认 userData。
- 开发模式下默认使用仓库根的 `data/`；冒烟脚本通过 `VIDEOREVIEW_DATA_DIR` 指向 `.tmp/smoke-data` 隔离目录，`verify:localization` 只用 `.tmp/` 存放临时 bundle 与 mock 进程。
- 删除任务会同时删除对应画面与分析结果。

## 文档

- 文档索引：[docs/README.md](docs/README.md)
- 定位标记设计（当前有效）：[docs/design/localization-design.md](docs/design/localization-design.md)
- 历史调研归档：[docs/archive/research/](docs/archive/research/)

## 当前边界

- 只支持本地视频，不支持网络流、直播和无时长视频。
- 同一时间只处理一个任务。
- 原始分辨率 PNG 请求体可能较大；定位请求会按“发送图片长边”配置缩放。
- 定位框是**辅助复核线索**，不是精确标注；VLM 定位在遮挡/小目标/反光场景会明显变差，仍需人工复核。
- 已从内置清单移除的旧物品 ID 仅保留历史任务显示兼容，新任务不再提供；内置清单固定为笔、水杯、水壶、手机。
