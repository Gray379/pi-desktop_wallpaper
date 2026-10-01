"use strict";
/**
 * PI-Desktop 宿主契约清单 —— 单一事实来源。
 *
 * 这个插件是给「第三方桌面端 PI-Desktop」写的，宿主不开源、会随版本变化，
 * 所以凡是与宿主私有实现耦合的东西（类名、CSS 变量、宿主 API、资源规则）
 * 全部集中在本文件与同目录的 theme-css.js 里，其它地方不再出现魔法字符串。
 *
 * 桌面端升级之后怎么更新：
 *   1. 在插件目录跑  node scripts/compat-check.mjs
 *      它会重新解包当前安装版的 app.asar，对照下面的常量与实际宿主实现逐条核对，
 *      并打印「仍然成立 / 已失效」的清单。
 *   2. 哪一条报红，就只改本文件对应的那一行（外加 theme-css.js 里引用它的地方），
 *      不用去翻 main.js。
 *
 * 最近一次逐条核对：PI-Desktop 0.15.10（见 scripts/compat-check.mjs 的输出）。
 */

/** 宿主相关的常量。 */
const CONTRACT = {
  /** 上次核对通过的桌面端版本。 */
  verifiedAgainst: "0.15.10",
  /** manifest.engines.piDesktop 声明的下限，低于它拒绝加载。 */
  minimumHost: "0.15.0",
  /** 宿主给插件主题的命名空间前缀：plugin:<pluginId>:<localThemeId>。 */
  themeIdPrefix: "plugin:",
  /**
   * 主题钩子：宿主选中插件主题时会把它的 id 写到 <html> 上，
   * 并把主题 CSS 追加成 head 里最后一个 <style>（0.15.10 渲染层实现）。
   * 我方 CSS 全部以 :root[data-plugin-theme="<主题id>"] 开头，所以这两个事实是硬依赖，
   * compat-check 会到渲染层 bundle 里核对（themeHookRuntimeExpression）。
   */
  themeHookAttribute: "data-plugin-theme",
  /** 上面那条钩子在宿主渲染层代码里的写法（用于兼容性核对）。 */
  themeHookRuntimeExpression: "dataset.pluginTheme",
  /** 宿主注入主题 CSS 的方式：新建 <style> 追加到 head 末尾。 */
  themeStyleInjection: 'createElement("style")',
  /**
   * 宿主给插件预留的壁纸挂点（本插件不依赖它，仅用于自检时报告）。
   * 另外宿主 0.15.10 起还有一套「风景主题（scenicThemes）」机制：
   *   contributes.scenicThemes + ui.settings 权限，会在设置里生成卡片与模糊滑杆，
   *   但模糊值被硬编码写进 --nexus-backdrop-blur。本插件不用它（会多要 ui.settings 权限，
   *   而且与「任意本地路径图片」的用法不搭），仅记录备查。
   */
  wallpaperSlotSelector: ".app-scenic-backdrop",

  /** 运行时主题 API（pi.themes.*）本身就是这套方案的核心。 */
  requireApis: [
    "themes.upsert",
    "themes.remove",
    "themes.list",
    "app.setTheme",
    "app.getAppearance",
    "app.getVersion",
    "plugin.setSettings",
  ],

  /** 插件能收到的宿主事件（用 pi.events.on 订阅）。 */
  settingsChangedEvent: "plugin:settingsChanged",
  appearanceChangedEvent: "appearance:changed",

  /** 主题 CSS 的宿主侧限制（sanitizeThemeCss 实现）。 */
  cssMaxBytes: 256 * 1024,
  cssForbidden: ["@import", "<style", "<!--", "javascript:", "expression("],
  /**
   * 面板（renderer/index.html）依赖的宿主机制。
   * 面板里的 pluginBridge.invoke 走宿主主进程 → 插件进程的 "panel.invoke"，
   * 宿主再调用插件 main.js 导出的 onPanelInvoke 回调。
   */
  panelInvocationExport: "onPanelInvoke",
  /** 面板 bridge 与主进程之间的 IPC 通道名（宿主 ipcMain.handle 里注册的）。 */
  panelBridgeChannel: "pi-plugin-panel-invoke",
  /** 面板 chrome 约定的 meta 名（renderer/index.html 里声明版本）。 */
  panelChromeMeta: "pi-plugin-chrome",
  /**
   * 面板 chrome 协议的版本（renderer/index.html 的 meta content）。
   * v2 = safe-area：宿主在顶部铺一条 46px 的「原生拖拽带」—— 这条在 Windows 上不属于
   *      页面合成范围，会显示成一条纯黑（窗口按钮下面那块黑底就是这么来的）。
   * v3 = paint-through：宿主不再铺那条带，顶部由插件自己画并自己标 -webkit-app-region: drag。
   * 本插件用 v3。
   */
  panelChromePaintThroughVersion: "v3",
  panelTitlebarVariable: "--pi-plugin-titlebar-height",
  panelDropPathApi: "getDroppedFilePath",

  /**
   * 两侧栏遮罩强度的默认值（设置项 glass）。0 = 和中间栏一样完全透出壁纸；
   * 每个 glass 区域的最终不透明度 = clamp(glass + 该区域的 offset, 0, 100)。
   * 默认值刻意偏小（宿主自己是 #000 死黑侧栏，用户要的是“只比中间暗一点”）。
   */
  defaultGlass: 22,
  /**
   * 壁纸提亮的默认值（设置项 lift）：在壁纸上再叠一层 `lift%` 的白。
   * 0 = 关闭。对"图片本身某块很暗（比如左边缘）"最有效，因为它对暗部是加法。
   */
  defaultLift: 0,
  /**
   * 主题的明暗基底（设置项 base）：auto / dark / light。
   * 为什么必须有这个设置：宿主在"偏好指向运行时主题、但主题还没注册"的瞬间会把 base 报成系统色，
   * 跟着它走会把界面刷成浅色（浅色系统上白底 + 深色文字压在壁纸上，根本看不清）。详见 main.js 的 currentBase()。
   */
  baseModes: ["auto", "dark", "light"],
  defaultBaseMode: "auto",
  /** auto 且宿主没给出可信内置亮/暗时的兜底：暗色（照片壁纸 + 白字最好读）。 */
  fallbackBase: "dark",
  /** 本插件贡献的设置键。 */
  settingKeys: ["imagePath", "index", "blur", "dim", "lift", "veil", "fit", "glass", "base"],

  /**
   * 本地资源白名单的「宿主真值」（externalThemeAsset / THEME_ASSET_EXTENSIONS）。
   * 注意里面还有 woff2（宿主把它当主题字体用），我们自己只放行图片，见 imageExtensions。
   */
  assetExtensions: ["png", "jpg", "jpeg", "webp", "avif", "svg", "woff2"],
  /** 壁纸允许用的图片格式（assetExtensions 的子集，去掉了字体）。 */
  imageExtensions: ["png", "jpg", "jpeg", "webp", "avif", "svg"],
  assetMaxBytes: 4 * 1024 * 1024,

  /** 本插件在宿主注册的运行时主题。 */
  localThemeId: "photo",
  localThemeLabel: "本地图片壁纸",
};

/** 壁纸图片的适配方式：值 → 生成的 background-* 声明。 */
const FITS = {
  cover: { size: "cover", repeat: "no-repeat" },
  contain: { size: "contain", repeat: "no-repeat" },
  center: { size: "auto", repeat: "no-repeat" },
  tile: { size: "auto", repeat: "repeat" },
};

/** 压暗层颜色：值 → rgba 三元组。 */
const VEILS = {
  ink: "0, 0, 0",
  slate: "10, 14, 22",
  blue: "6, 14, 34",
  violet: "20, 10, 36",
  warm: "32, 18, 10",
};

/**
 * 需要"让位"给壁纸的宿主界面区域。
 *
 * mode = "clear"  宿主那层不透明底色直接改透明（壁纸透出来，和中间栏一样）
 * mode = "glass"  改成半透明遮罩（毛玻璃），透明度由「两侧栏遮罩强度」这个设置决定：
 *                 alpha = clamp(glass + offset, 0, 100)，0 = 和中间一样完全透出壁纸
 *
 * token  宿主自己的 CSS 变量（升级后大概率还在，compat-check 会逐个确认）
 * tint   实际用作遮罩的颜色。刻意用 --ds-bg-primary（就是中间栏的底色），
 *        这样侧栏只会"比中间暗一点"，而不是像宿主默认的 --ds-bg-under(#000) 那样死黑。
 * offset 相对滑块值的偏移：输入栏/设置卡片要更实一点，保证文字可读。
 *
 * 注意：下面的选择器都会被生成器加上 `:root[data-plugin-theme="<主题id>"]` 前缀
 * （html 那条例外，直接写成 :root[...]），所以这里只写宿主原样的类名即可。
 */
const SURFACES = [
  { id: "window-root", selectors: ["html", "body", "#root"], mode: "clear", note: "窗口根底色" },
  { id: "app-shell", selectors: [".app-shell"], mode: "clear", note: "应用外壳" },
  { id: "titlebars", selectors: [".main-titlebar", ".conversation-topbar"], mode: "clear", important: true, note: "会话标题栏（右侧面板打开/收起两种布局都用它）" },
  {
    id: "window-controls",
    selectors: [".window-controls"],
    mode: "clear",
    important: true,
    note: "右上角三个窗口按钮（最小化/最大化/关闭）所在的 120px 条带",
  },
  {
    id: "chrome-rows",
    selectors: [".window-chrome-row", ".work-panel-header", ".work-browser-chrome", ".file-viewer-header"],
    mode: "clear",
    important: true,
    note: "顶部/工作面板的 chrome 条带（拖拽行、面板头、浏览器条、文件查看器头）",
  },
  { id: "app-shell-settings", selectors: [".app-shell.settings-mode"], mode: "clear", note: "外壳（设置页）" },
  { id: "main-pane", selectors: [".main-pane"], mode: "clear", note: "中间会话栏（壁纸原样透出，作为只暗一点的基准）" },
  { id: "settings-shell", selectors: [".settings-shell", ".settings-shell-full"], mode: "clear", note: "设置页外壳" },
  {
    id: "settings-content",
    selectors: [".settings-content", ".settings-content-inner"],
    mode: "clear",
    important: true,
    note: "设置页内容区（宿主同款写法用 !important）",
  },
  { id: "settings-titlebar", selectors: [".settings-titlebar"], mode: "clear", important: true, note: "设置页标题栏" },
  {
    id: "sidebar",
    selectors: [".sidebar-surface", ".sidebar-rail"],
    mode: "glass",
    token: "--ds-bg-sidebar",
    tint: "--ds-bg-primary",
    offset: 0,
    note: "左侧会话栏",
  },
  {
    id: "work-panel",
    selectors: [".work-panel"],
    mode: "glass",
    token: "--ds-bg-dock",
    tint: "--ds-bg-primary",
    offset: 4,
    note: "右侧工作面板",
  },
  {
    id: "composer",
    selectors: [".composer-shell"],
    mode: "glass",
    token: "--ds-bg-composer",
    tint: "--ds-bg-primary",
    offset: 26,
    note: "输入栏（偏实一点，保证输入文字可读）",
  },
  {
    id: "settings-panel",
    selectors: [".settings-panel"],
    mode: "glass",
    token: "--ds-bg-elevated",
    tint: "--ds-bg-elevated",
    offset: 34,
    note: "设置卡片",
  },
];

/** 宿主命名空间里的主题 id。 */
function themeIdFor(localThemeId) {
  return `${CONTRACT.themeIdPrefix}${"local.pi-wallpaper"}:${localThemeId}`;
}

/**
 * 把用户给的路径整理成宿主认的绝对路径形式。
 * 宿主只接受绝对路径（X:/… 或 /…），而且会把 file:/// 与反斜杠规范化。
 */
function normalizeImagePath(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return "";
  // 资源管理器「复制文件地址」会带引号
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (/^file:/i.test(value)) {
    value = value.replace(/^file:\/\//i, "").replace(/^file:/i, "");
    try {
      value = decodeURIComponent(value);
    } catch {
      /* 保持原样，交给下面的检查报错 */
    }
    if (/^\/[a-zA-Z]:\//.test(value)) value = value.slice(1);
  }
  return value.replace(/\\/g, "/");
}

/** 是否形如宿主认可的绝对路径。 */
function isAbsolutePath(value) {
  return value.startsWith("/") || /^[a-zA-Z]:\//.test(value);
}

/** 是否受支持的图片扩展名。 */
function hasSupportedExtension(value) {
  return new RegExp(`\\.(${CONTRACT.imageExtensions.join("|")})$`, "i").test(value);
}

/** 单文件大小上限（字节）。 */
function assetMaxBytes() {
  return CONTRACT.assetMaxBytes;
}

/** 把宿主抛出的英文错误翻译成能照着做的中文提示。 */
function describeError(error) {
  const message = String(error?.message ?? error ?? "");
  if (/may only reference data: urls or declared assets/i.test(message)) {
    return [
      "这张图片宿主读不了，常见原因：",
      "1) 路径不是绝对路径（要 X:/… 形式）；",
      `2) 扩展名不在允许列表（${CONTRACT.imageExtensions.join(" / ")}）；`,
      `3) 文件超过 ${Math.round(CONTRACT.assetMaxBytes / 1024 / 1024)} MB（宿主只支持 data: 或已声明资源）；`,
      "4) 文件其实不存在或没有读取权限。",
    ].join("\n");
  }
  if (/theme css exceeds/i.test(message)) return "生成的 CSS 超过宿主上限 256 KB，请减少壁纸条目。";
  if (/theme id must match/i.test(message)) return "主题 id 不合法（这是插件自身的问题，请反馈）。";
  if (isPermissionDenied(error)) return permissionHint(message);
  if (/not available/i.test(message)) return "此桌面端版本没有提供运行时主题 API，请在 设置 → 关于 里确认版本，并跑一次兼容性自检。";
  return message || "未知错误";
}

/**
 * 宿主拒绝权限时抛的是 `code: "PERMISSION_DENIED"` + 消息 `missing permission: <权限名>`。
 * 只匹配消息会漏掉（消息里没有 PERMISSION_DENIED 字样），所以两个都看。
 */
function isPermissionDenied(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? error ?? "");
  return code === "PERMISSION_DENIED" || /PERMISSION_DENIED/i.test(message) || /missing permission:/i.test(message);
}

/** 权限被拒时要说清楚缺哪个、以及怎么补回来。 */
function permissionHint(message) {
  const match = /missing permission:\s*([a-zA-Z.]+)/i.exec(message);
  const permission = match ? match[1] : "所需权限";
  return [
    `缺少权限 ${permission}，桌面端拒绝了这次操作。`,
    "怎么补回来（开发加载的插件改过权限声明后，禁用/启用不会重新询问）：",
    "1) 扩展页 → 壁纸 · 背景虚化 →「卸载」；",
    "2) 再点「加载本地插件」，重新选中插件目录；",
    "3) 在弹出的权限复核里同意 ui.theme（现在还需要 ui.panel）。",
    "如果你是从 .piplug 安装的，直接卸载后重新安装同一个包即可。",
  ].join("\n");
}

module.exports = {
  CONTRACT,
  FITS,
  VEILS,
  SURFACES,
  themeIdFor,
  normalizeImagePath,
  isAbsolutePath,
  hasSupportedExtension,
  assetMaxBytes,
  describeError,
  isPermissionDenied,
};
