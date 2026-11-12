# resources/config

打包时该目录会作为 `extraResources` 复制到应用的 `resources/config/`（见根 `package.json` 的 `build.extraResources`），运行期由主进程读取。

## 放什么

- `preset.enc`：**加密后的内置预设**，由 `npm run encrypt-preset`（`scripts/encrypt-preset.mjs`）在本地生成。用于预置模型接口地址、模型名称、密钥与默认分析参数；只有主进程解密，渲染进程拿不到明文。

该目录默认不存放真实密钥或生产环境预设，分发时在打包机本地生成 `preset.enc` 后再执行 `npm run build:win`。

## 生成方式

```powershell
$env:PRESET_BASE_URL = "http://10.0.0.10:8000/v1"
$env:PRESET_MODEL = "qwen2.5-vl-32b-instruct"
$env:PRESET_API_KEY = "your-key"
npm run encrypt-preset
```

生成结果：`resources/config/preset.enc`。可选的默认分析参数（如 `PRESET_ITEMS`、`PRESET_INTERVAL_SEC`、`PRESET_LOCALIZE` 等）见根 [README.md](../../README.md) 的「加密预设」一节，以及 `scripts/encrypt-preset.mjs` 顶部打印的用法。

## 注意

- 预设加密用于避免界面 / 普通查看者直接读到配置，**不是服务端级密钥保护**：密钥随客户端分发、可在本地解密，严格保密需结合内网访问控制或独立密钥分发。
- 更换密钥需同步修改 `scripts/encrypt-preset.mjs` 与主进程解密代码（当前为 `src/main/config/preset.ts`，以代码为准）。
- 请不要把含生产密钥的 `preset.enc` 提交到仓库：`.gitignore` 已忽略 `resources/config/preset.enc`，打包时也只把该文件（如存在）复制进安装包。
