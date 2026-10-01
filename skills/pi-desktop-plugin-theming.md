---
name: PI-Desktop 插件：安装/权限/验证 + 壁纸主题改造避坑
description: 用户要安装、更新、排查 PI-Desktop（第三方桌面端）插件（权限被拒、重载不生效、日志/设置在哪），或要给 PI-Desktop 写改壁纸与主题类插件（顶部或侧栏发黑、界面变白、文字看不清）时加载。
---

# 路径与基本约定

- 插件数据：`%USERPROFILE%\.pi-desktop\plugins\data\<pluginId>\settings.json`
- 插件注册表：`%USERPROFILE%\.pi-desktop\plugins\registry.json`（装/更新时写入，含 capabilities 与 manifest 快照）
- 日志：`%USERPROFILE%\.pi-desktop\logs\app\plugin.log`（插件进程的 stdout 也进这里）、`host\permission.log`
- 应用设置与主题偏好：`%USERPROFILE%\.pi-desktop\pi.sqlite` → `kv` 表（`ns='app', key='app'`，`value_json.theme` 就是当前主题偏好）
  **读它必须把 `pi.sqlite` 连同 `-wal` / `-shm` 一起复制到别处再读**，否则拿到的是 WAL 之前的旧值（会误判"主题没生效"）。
- 宿主安装目录（示例 `E:\PI-Desktop`）：`resources\app.asar` 里有 `out/main/index.js`、`out/renderer/assets/index-*.css|js`、
  `out/preload/plugin-panel.js`。要查"某个界面元素的底色是谁画的"，就把这些解包出来按类名或 `background:var(--ds-…)` 反查。

# 安装 / 重载 / 权限（最容易浪费时间的一条）

- **改了 `permissions` 必须重新走授权**：扩展页 → 该插件「卸载」→「加载本地插件」选目录 → 在权限复核里勾同意。
  「禁用 / 启用」不会重新询问，重启应用也不会。只改代码或设置不需要重走。
- 报错 `missing permission: <权限名>`（`error.code === "PERMISSION_DENIED"`）就是它：声明里有、但当初授权时没勾。
  实际可用权限 = **已授权集合 ∩ 当前 manifest 声明**。
- 开发目录里的插件会被宿主**热重载**：`plugin.log` 出现 `development.plugin.reloaded` 说明它读到了新代码；
  语法错误会显示成 `plugin.reload.error: …`，同时运行时主题被卸载 → 界面掉回内置主题，看上去像"插件坏了"。
- 打包/校验顺序：`PluginCheck`（manifest / 入口 / 面板 / 技能 / 权限 / 体积）→ `PluginPack`。
  `.piplug` 必须是 **store-only zip**，不要用系统 `zip` / `tar` 生成。
- 资源限制：图片 ≤4 MB、扩展名白名单 `png/jpg/jpeg/webp/avif/svg`（宿主还允许 woff2 当字体）；
  主题 CSS ≤256 KB，且禁 `@import`、`<style`、`<!--`、`javascript:`、`expression(`。

# 主题类插件必须知道的六条（每条都真实踩过）

1. **用主题钩子做作用域**。宿主把插件主题 CSS 追加成 head 里最后一个 `<style>`，并把命名空间 id 写到
   `document.documentElement.dataset.pluginTheme = plugin:<pluginId>:<themeId>`。
   规则都写成 `:root[data-plugin-theme="plugin:<id>:<theme>"] .目标类 { … }`：它比宿主自己的类规则
   （(0,1,0)）特异性高、不受以后懒加载的分块样式影响，也不会在主题未选中时漏出来。
   `html` 那条例外：直接写 `:root[...]`；壁纸层写 `:root[...]::before` / `::after`。
2. **运行时主题是内存态**：每次启动/重载都要重新 `themes.upsert`。卸载时清掉注册，但**绝对不要动用户选的主题**
   （别在卸载时 `app.setTheme` 改回亮/暗），否则开发热重载、桌面端升级、开关插件都会让壁纸凭空消失，下次启动也恢复不回来。
3. **不要跟随 `appearance.base`**：当偏好指向运行时主题、而该主题此刻还没注册时（每次启动/重载都会有一瞬间），
   宿主报的是**系统色**。浅色系统上跟着它注册就会把界面整片刷白、白字变深色糊在照片上、侧栏变一层白雾。
   用显式设置（auto/dark/light；auto 只跟随"用户真的选过内置亮/暗"，其余按 dark）。
4. **深色 token 的关键值**：`--ds-bg-under: #000`（侧栏死黑）、`--ds-bg-primary: #181818`（中间栏）、
   `--ds-bg-secondary` / `--ds-bg-dock: #212121`、`--ds-bg-dock-raised: transparent`（**浅色下是 #fff**）。
   想"只比中间暗一点"就用 `--ds-bg-primary` 当遮罩色，别用 `--ds-bg-under`。
5. **要清的面一个都不能漏**（漏一个就是一条黑条，宿主给它们写的是不透明 `--ds-bg-primary`）：
   `html/body/#root`、`.app-shell`、`.main-pane`、**`.main-titlebar` / `.conversation-topbar`（会话标题栏）**、
   **`.window-controls`（右上角三键所在的 120px 条带）**、`.window-chrome-row`、`.work-panel-header`、
   `.work-browser-chrome`、`.file-viewer-header`、设置页那一圈（`.settings-shell*` / `.settings-content*` / `.settings-titlebar`）。
   关键面直接加 `!important`，压住宿主自己的同特异性规则（例如 `.app-shell:has(.work-panel)>.window-controls`）。
6. **插件自己的面板窗口用 chrome v3**：`<meta name="pi-plugin-chrome" content="v3">` + 自己画 46px 可拖拽标题栏
   （`-webkit-app-region: drag`，交互元素标 `no-drag`）。v2（safe-area）那条原生拖拽带在 Windows 上会显示成纯黑。

# 不靠肉眼的验证手法

- 桩宿主自测：`node scripts/selftest.mjs` —— 模拟宿主行为（upsert / setTheme / 权限被拒 / 面板通道 / 设置夹取），不需要开桌面端。
- 解包核对：`node scripts/compat-check.mjs` —— 读本机 `app.asar`，逐条核对 API 白名单、CSS 限制、资源限制、类名、设计 token。
- CSS 作用域与特异性：做一张"仿制宿主页"——先放宿主风格样式，再把插件**真实生成**的 CSS 追加进 head，
  **最后再插一段同特异性的"竞品规则"**，用 Chromium 读 `getComputedStyle`。这样能提前发现被盖掉的情况。
- 生成物断言：把"必须出现的规则"（如标题栏清理、窗口三键清理）写成断言，防止某次编辑悄悄删掉一整组区域。

# 已知边界

- 面板里的 `pluginBridge.invoke` 只能走白名单宿主 API，或转发给插件导出的 `onPanelInvoke`，没有自定义 RPC。
- 插件主题 CSS 只覆盖 `background-color` 最安全；动 `background` / `background-image` 要自己承担被宿主改动的风险。
- 宿主还有一套 `contributes.scenicThemes`（风景主题卡片 + 固定写 `--nexus-backdrop-blur`），与"用运行时主题自绘壁纸"是两条路，别混用。
- macOS 上宿主自己会走 `--ds-sidebar-glass-*`（仅 `[data-platform=darwin]`），Windows 上没有这组 token，侧栏的半透明要自己出。
