#!/usr/bin/env node
/**
 * 本地自测：用「桩宿主」把 main.js 的完整流程跑一遍，不需要真的桌面端窗口。
 *
 * 桩宿主严格按 PI-Desktop 0.15.10 的规则做事：
 *   - pi.themes.upsert 会用宿主的 CSS 消毒规则复查（禁 @import/<style/<!--/javascript:/expression(，
 *     体积 ≤256 KB，url() 只允许 data: 或绝对路径的本地文件，扩展名与大小也照宿主校验）；
 *   - pi.app.setTheme 只接受内置 id 或已注册的主题；
 *   - pi.plugin.getSettings/setSettings 会像宿主一样回发 plugin:settingsChanged 事件。
 *
 * 用法：node scripts/selftest.mjs
 * 退出码 0 = 全部通过。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pluginDir = path.join(import.meta.dirname, "..");
const { CONTRACT } = require("../lib/host-contract.js");

/* ----------------------------------------------------------- 桩宿主 */

const EXTENSIONS = CONTRACT.assetExtensions;
const FILES = new Map([
  ["C:/test/wall/aurora.jpg", 2 * 1024 * 1024],
  ["C:/test/wall/too-big.jpg", 9 * 1024 * 1024],
  ["C:/test/wall/vector.svg", 4096],
  ["C:/test/wall/photo.bmp", 1024],
]);

const calls = [];

// 宿主拒绝 ui.theme 时抛的东西（用来验证插件的报错翻译与自检）
let denyTheme = false;
const permissionDenied = () =>
  Object.assign(new Error("missing permission: ui.theme"), { code: "PERMISSION_DENIED" });
const themes = new Map();
const listeners = new Map();
let activeTheme = "system";
// 宿主报出来的 base：平时跟着 activeTheme，测试里可以强行改成 light，
// 用来复现"偏好指向运行时主题但主题还没注册 → 宿主报系统色"那一幕。
let appearanceBase = null;
let settings = { imagePath: "", index: 0, blur: 16, dim: 20, glass: CONTRACT.defaultGlass, lift: CONTRACT.defaultLift, base: CONTRACT.defaultBaseMode, veil: "ink", fit: "cover" };

function sanitizeThemeCss(rawCss) {
  const bytes = Buffer.byteLength(rawCss, "utf8");
  if (bytes > CONTRACT.cssMaxBytes) return { ok: false, error: `theme css exceeds ${CONTRACT.cssMaxBytes} bytes (${bytes})` };
  if (!rawCss.trim()) return { ok: false, error: "theme css is empty" };
  for (const token of CONTRACT.cssForbidden) {
    if (rawCss.toLowerCase().includes(token.toLowerCase())) return { ok: false, error: `theme css must not use ${token}` };
  }
  // 宿主：url() 只允许 data: 或「已声明资源」（运行时=存在的本地绝对路径）
  for (const match of rawCss.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const target = match[2].trim();
    if (/^data:/i.test(target)) continue;
    if (!(target.startsWith("/") || /^[a-zA-Z]:\//.test(target))) {
      return { ok: false, error: `theme css may only reference data: urls or declared assets (found "${target}")` };
    }
    if (!new RegExp(`\\.(${EXTENSIONS.join("|")})$`, "i").test(target)) {
      return { ok: false, error: `theme css may only reference data: urls or declared assets (found "${target}")` };
    }
    const size = FILES.get(target.replace(/\\/g, "/"));
    if (size === undefined || size > CONTRACT.assetMaxBytes) {
      return { ok: false, error: `theme css may only reference data: urls or declared assets (found "${target}")` };
    }
  }
  return { ok: true, css: rawCss.trim() };
}

const pi = {
  plugin: {
    getId: () => "local.pi-wallpaper",
    getSettings: async () => ({ ...settings }),
    setSettings: async (partial) => {
      settings = { ...settings, ...partial };
      calls.push(["plugin.setSettings", partial]);
      for (const handler of listeners.get(CONTRACT.settingsChangedEvent) ?? []) handler({ ...settings });
    },
  },
  themes: {
    // 打开 denyTheme 就模拟「授权里没有 ui.theme」
    upsert: async (input) => {
      if (denyTheme) throw permissionDenied();
      calls.push(["themes.upsert", input.id, input.base, input.css]);
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(String(input.id))) throw new Error(`theme id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}: ${input.id}`);
      const sanitized = sanitizeThemeCss(String(input.css ?? ""));
      if (!sanitized.ok) throw new Error(sanitized.error);
      themes.set(`${CONTRACT.themeIdPrefix}local.pi-wallpaper:${input.id}`, {
        id: `${CONTRACT.themeIdPrefix}local.pi-wallpaper:${input.id}`,
        label: input.label,
        base: input.base,
        css: sanitized.css,
      });
    },
    remove: async (themeId) => {
      if (denyTheme) throw permissionDenied();
      calls.push(["themes.remove", themeId]);
      if (!themes.delete(themeId)) throw new Error(`NOT_FOUND: theme not found: ${themeId}`);
    },
    list: async () => {
      if (denyTheme) throw permissionDenied();
      return [...themes.values()].map(({ id, label, base }) => ({ id, label, base }));
    },
  },
  app: {
    getVersion: async () => "0.15.10",
    getAppearance: async () => ({
      theme: activeTheme,
      base: appearanceBase ?? (activeTheme === "light" ? "light" : "dark"),
      locale: "zh-CN",
      pluginTheme: activeTheme.startsWith("plugin:") ? activeTheme : null,
    }),
    setTheme: async (themeId) => {
      calls.push(["app.setTheme", themeId]);
      const builtin = ["system", "light", "dark"];
      if (!builtin.includes(themeId) && !themes.has(themeId)) throw new Error(`INVALID_ARGUMENT: unknown theme id: ${themeId}`);
      activeTheme = themeId;
    },
  },
  commands: {
    registered: new Map(),
    register: async (command) => {
      pi.commands.registered.set(command.id, command);
    },
    unregister: async (id) => {
      pi.commands.registered.delete(id);
    },
  },
  ui: {
    toasts: [],
    showToast: async (message) => {
      pi.ui.toasts.push(String(message));
    },
    openPanel: async (options) => {
      calls.push(["ui.openPanel", options?.title ?? ""]);
    },
  },
  events: {
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
  },
};

/* ----------------------------------------------------------- 断言工具 */

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`[ OK ] ${label}`);
  } else {
    failures += 1;
    console.log(`[FAIL] ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const lastCall = (name) => [...calls].reverse().find((call) => call[0] === name);
const toastText = () => pi.ui.toasts.join(" | ");

/* ----------------------------------------------------------- 跑流程 */

globalThis.pi = pi;
const entry = require(path.join(pluginDir, "main.js"));
if (typeof entry.onLoad !== "function") throw new Error("main.js 没有导出 onLoad");

console.log("PI-Desktop 壁纸插件 · 本地自测（桩宿主模拟 0.15.10）");
console.log("=".repeat(64));

await entry.onLoad();
await tick();
check("onLoad 注册了 6 条命令", pi.commands.registered.size === 6, [...pi.commands.registered.keys()].join(", "));
check("未配置图片时不注册主题", themes.size === 0);

// 1) 没填路径就应用 → 应该给出中文提示，而不是抛错
await pi.commands.registered.get("local.pi-wallpaper.apply").run();
check("未设置路径时给出中文提示", toastText().includes("还没设置图片路径"), toastText());
check("未设置路径时不注册主题", themes.size === 0);

// 2) 填一个非法路径（相对路径）
pi.ui.toasts.length = 0;
settings = { ...settings, imagePath: "D:\\wall\\photo.bmp" };
await pi.commands.registered.get("local.pi-wallpaper.apply").run();
check(
  "拒绝不支持的扩展名（bmp）",
  toastText().includes("宿主只接受这些图片格式") && themes.size === 0,
  toastText()
);

// 3) 正式应用一张合法图片
pi.ui.toasts.length = 0;
settings = { ...settings, imagePath: "C:\\test\\wall\\aurora.jpg", blur: 18, dim: 24, veil: "slate", fit: "cover" };
await pi.commands.registered.get("local.pi-wallpaper.apply").run();
const upsert = lastCall("themes.upsert");
check("注册主题成功", Boolean(upsert) && themes.size === 1, toastText());
check("主题 id 命名空间正确", upsert?.[1] === "photo" && [...themes.keys()][0] === "plugin:local.pi-wallpaper:photo");
check("生成 CSS 里是绝对路径且已转成正斜杠", Boolean(upsert?.[3]?.includes('url("C:/test/wall/aurora.jpg")')), upsert?.[3]?.slice(0, 120));
check("模糊值写进 CSS", Boolean(upsert?.[3]?.includes("filter: blur(18px)")), "");
check("压暗层按颜色与百分比生成", Boolean(upsert?.[3]?.includes("rgba(10, 14, 22, 0.24)")), "");
check("激活了主题", activeTheme === "plugin:local.pi-wallpaper:photo", activeTheme);
check("base 跟随当前外观（dark）", upsert?.[2] === "dark", String(upsert?.[2]));

// 4) 改了设置（宿主会回发事件）→ 主题应自动重建
calls.length = 0;
settings = { ...settings, blur: 4, dim: 0, veil: "none" };
for (const handler of listeners.get(CONTRACT.settingsChangedEvent) ?? []) handler({ ...settings });
await tick();
const rebuilt = lastCall("themes.upsert");
check("设置变化后自动重建主题", Boolean(rebuilt), "没有收到重建调用");
check("压暗为 0 时不生成压暗层", Boolean(rebuilt?.[3] && !rebuilt[3].includes("html::after")), "");
check("模糊改为 4px", Boolean(rebuilt?.[3]?.includes("filter: blur(4px)")), "");

// 5) 超大文件 → 宿主拒绝，插件要翻译成中文原因
pi.ui.toasts.length = 0;
settings = { ...settings, imagePath: "C:/test/wall/too-big.jpg", blur: 8, dim: 10, veil: "ink" };
await pi.commands.registered.get("local.pi-wallpaper.apply").run();
check("超大文件被拒绝并给出中文原因", toastText().includes("宿主读不了"), toastText());

// 6) 多张轮换
pi.ui.toasts.length = 0;
settings = { ...settings, imagePath: "C:/test/wall/aurora.jpg\nC:/test/wall/vector.svg", index: 0, blur: 6, dim: 12, veil: "blue", fit: "contain" };
await pi.commands.registered.get("local.pi-wallpaper.apply").run();
await pi.commands.registered.get("local.pi-wallpaper.next").run();
await tick();
check("下一张写在设置里", settings.index === 1, String(settings.index));
check("切换后用的是第二张图", Boolean(lastCall("themes.upsert")?.[3]?.includes('url("C:/test/wall/vector.svg")')), "");
check("适配方式生效（contain）", Boolean(lastCall("themes.upsert")?.[3]?.includes("background-size: contain")), "");

// 7) 自检
pi.ui.toasts.length = 0;
await pi.commands.registered.get("local.pi-wallpaper.selfCheck").run();
check("自检报告通过", toastText().includes("自检通过"), toastText());

// 8) 清除
pi.ui.toasts.length = 0;
await pi.commands.registered.get("local.pi-wallpaper.clear").run();
await tick();
check("清除后主题被移除", themes.size === 0);
check("清除后回到内置主题", activeTheme === "dark", activeTheme);
check("清除后设置里的路径被清空", settings.imagePath === "" && settings.index === 0, JSON.stringify(settings));

// 9) 面板通道：宿主把面板的 pluginBridge.invoke 转发给 main.js 的 onPanelInvoke
check("导出了 onPanelInvoke", typeof entry.onPanelInvoke === "function");
check("面板命令已注册", typeof pi.commands.registered.get("local.pi-wallpaper.openPanel")?.run === "function");
await pi.commands.registered.get("local.pi-wallpaper.openPanel").run();
check("面板命令调用了 ui.openPanel", lastCall("ui.openPanel")?.[1] === "壁纸 · 背景虚化", String(lastCall("ui.openPanel")?.[1]));

const panelState = await entry.onPanelInvoke("wallpaper.state", {});
check(
  "面板读到状态",
  typeof panelState?.blur === "number" && panelState.imagePath === "" && panelState.active === false,
  JSON.stringify({ blur: panelState?.blur, imagePath: panelState?.imagePath, active: panelState?.active })
);
check(
  "面板状态带回宿主上限",
  Array.isArray(panelState?.limits?.extensions) && panelState.limits.maxBytes === 4194304,
  JSON.stringify(panelState?.limits)
);
check(
  "面板状态带回已注册标记",
  panelState?.registered === false && panelState?.themeId === "plugin:local.pi-wallpaper:photo",
  JSON.stringify({ registered: panelState?.registered, themeId: panelState?.themeId })
);

calls.length = 0;
const panelSaved = await entry.onPanelInvoke("wallpaper.save", {
  imagePath: "C:\\test\\wall\\aurora.jpg",
  blur: 9,
  dim: 30,
  veil: "blue",
  fit: "contain",
});
const panelUpsert = lastCall("themes.upsert");
check("面板保存后主题已注册并激活", panelSaved?.active === true && themes.size === 1, JSON.stringify({ active: panelSaved?.active, themes: themes.size }));
check(
  "面板参数写进了主题 CSS",
  Boolean(panelUpsert?.[3]?.includes("filter: blur(9px)")) &&
    Boolean(panelUpsert?.[3]?.includes("background-size: contain")) &&
    Boolean(panelUpsert?.[3]?.includes("rgba(6, 14, 34, 0.30)")),
  String(panelUpsert?.[3]?.slice(0, 200))
);
check(
  "面板改动写回了设置",
  settings.blur === 9 && settings.fit === "contain" && String(settings.imagePath).endsWith("aurora.jpg"),
  JSON.stringify({ blur: settings.blur, fit: settings.fit, imagePath: settings.imagePath })
);
check(
  "面板拿到缩略图 URL",
  String(panelSaved?.previewUrl ?? "").startsWith("plugin-asset://local.pi-wallpaper/"),
  String(panelSaved?.previewUrl)
);
// 11) 两侧栏遮罩强度：默认 22%，可调到 0（= 和中间一样完全透出壁纸）
check(
  "默认遮罩强度写进了 CSS（侧栏 22%，刻意用中间栏的底色 --ds-bg-primary 当遮罩）",
  Boolean(panelUpsert?.[3]?.includes("var(--ds-bg-primary) 22%, transparent")),
  String(panelUpsert?.[3]?.split("\n").filter((l) => l.includes("sidebar-surface")).join(" ").slice(0, 200))
);
check(
  "输入栏按偏移更实一点（22+26=48%）",
  Boolean(panelUpsert?.[3]?.includes("var(--ds-bg-primary) 48%, transparent")),
  ""
);
const scope = ':root[data-plugin-theme="plugin:local.pi-wallpaper:photo"]';
check(
  "所有规则都挂在宿主主题钩子上（壁纸层 + 区域覆盖），只在壁纸主题被选中时生效",
  Boolean(
    panelUpsert?.[3]?.includes(`${scope} .sidebar-surface`) &&
      panelUpsert?.[3]?.includes(`${scope}::before`) &&
      panelUpsert?.[3]?.includes(`${scope} #root { background-color: transparent; }`)
  ),
  String(panelUpsert?.[3]?.split("\n").slice(0, 10).join(" | ").slice(0, 240))
);
await entry.onPanelInvoke("wallpaper.save", { glass: 0 });
const glassCss = lastCall("themes.upsert")?.[3];
check(
  "遮罩可调到 0，和中间栏一样",
  Boolean(glassCss?.includes("var(--ds-bg-primary) 0%, transparent")) && settings.glass === 0,
  "glass=" + settings.glass
);
await entry.onPanelInvoke("wallpaper.save", { glass: 200 });
check(
  "遮罩值被夹到 0–100",
  lastCall("themes.upsert")?.[3]?.includes("var(--ds-bg-primary) 100%, transparent"),
  "glass=" + settings.glass
);
await entry.onPanelInvoke("wallpaper.save", { glass: "abc" });
check(
  "非法遮罩值回落到默认值",
  lastCall("themes.upsert")?.[3]?.includes("var(--ds-bg-primary) 22%, transparent"),
  "glass=" + settings.glass
);
const unscoped = String(panelUpsert?.[3] ?? "")
  .split("\n")
  .filter((line) => line.includes("{") && !line.trimStart().startsWith("/*") && !line.startsWith("@supports") && !line.startsWith("  "))
  .filter((line) => !line.startsWith(scope));
check("没有漏掉作用域前缀的规则", unscoped.length === 0, unscoped.join(" | ").slice(0, 200));
// 这一组是"不许再悄悄弄丢"的守卫：曾经在合并重复行时误删了 titlebars，
// 结果会话标题栏一直黑着（真事）。所以既断言清单里有这些组，也断言生成的 CSS 里有对应规则。
const REQUIRED_SURFACE_IDS = [
  "window-root",
  "app-shell",
  "titlebars",
  "window-controls",
  "main-pane",
  "sidebar",
  "work-panel",
  "composer",
];
const { SURFACES } = require("../lib/host-contract.js");
const missingSurfaces = REQUIRED_SURFACE_IDS.filter((id) => !SURFACES.some((s) => s.id === id));
check("界面区域清单没有被弄丢（含 titlebars）", missingSurfaces.length === 0, `缺少：${missingSurfaces.join(", ")}`);
check(
  "生成的 CSS 里清了会话标题栏（.main-titlebar / .conversation-topbar）",
  Boolean(
    panelUpsert?.[3]?.includes(`${scope} .main-titlebar`) &&
      panelUpsert?.[3]?.includes(`${scope} .conversation-topbar { background-color: transparent !important; }`)
  ),
  String(panelUpsert?.[3]?.split("\n").filter((l) => l.includes("conversation-topbar")).join(" | ").slice(0, 200))
);
check(
  "右上角三个窗口按钮那条底色被清掉（宿主用的是不透明的 --ds-bg-primary）",
  Boolean(panelUpsert?.[3]?.includes(`${scope} .window-controls { background-color: transparent !important; }`)),
  String(panelUpsert?.[3]?.split("\n").filter((l) => l.includes("window-controls")).join(" | ").slice(0, 160))
);
check(
  "顶部一圈 chrome 条带（拖拽行/面板头/浏览器条/文件头）底色也清掉了",
  Boolean(
    panelUpsert?.[3]?.includes(`${scope} .window-chrome-row`) &&
      panelUpsert?.[3]?.includes(`${scope} .work-panel-header`) &&
      panelUpsert?.[3]?.includes(`${scope} .work-browser-chrome`) &&
      panelUpsert?.[3]?.includes(`${scope} .file-viewer-header`)
  ),
  String(panelUpsert?.[3]?.split("\n").filter((l) => l.includes("chrome-row")).join(" | ").slice(0, 200))
);
// 壁纸提亮：0 = 纯图片（不叠白），>0 时在图片上层加一层半透明白；超范围要夹住。
check(
  "提亮关闭时不加任何多余图层",
  Boolean(panelUpsert?.[3]?.includes('background-image: url("C:/test/wall/aurora.jpg")')) &&
    !panelUpsert?.[3]?.includes("linear-gradient"),
  String(panelUpsert?.[3]?.split("\n").filter((l) => l.includes("background-image")).join(" | ").slice(0, 200))
);
await entry.onPanelInvoke("wallpaper.save", { lift: 30 });
check(
  "提亮 30% 时叠上一层白（对暗部是加法）",
  Boolean(lastCall("themes.upsert")?.[3]?.includes("linear-gradient(rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0.30)), url(\"C:/test/wall/aurora.jpg\")")) &&
    settings.lift === 30,
  "lift=" + settings.lift
);
await entry.onPanelInvoke("wallpaper.save", { lift: 999 });
check(
  "提亮值被夹到 0–60",
  lastCall("themes.upsert")?.[3]?.includes("rgba(255, 255, 255, 0.60)"),
  "lift=" + settings.lift
);

check("未知面板通道会报错", await entry.onPanelInvoke("nope", {}).then(() => false, () => true));

const panelCheck = await entry.onPanelInvoke("wallpaper.check", {});
check("面板自检返回可显示的文字", Array.isArray(panelCheck?.check) && panelCheck.check.length >= 8, JSON.stringify(panelCheck?.check?.slice(0, 2)));

const panelCleared = await entry.onPanelInvoke("wallpaper.clear", {});
check(
  "面板移除后主题与设置都清空",
  panelCleared?.active === false && themes.size === 0 && settings.imagePath === "",
  JSON.stringify({ active: panelCleared?.active, themes: themes.size, imagePath: settings.imagePath })
);

// 10) 权限被拒（本机真实踩过的坑：授权里没有 ui.theme）
const internals = entry.__internals;
const denied = Object.assign(new Error("missing permission: ui.theme"), { code: "PERMISSION_DENIED" });
check("能识别宿主抛的权限错误", internals.isPermissionDenied(denied) === true);
check("只有消息也能识别", internals.isPermissionDenied(new Error("missing permission: ui.theme")) === true);
const hint = internals.describeError(denied);
check(
  "权限错误被翻译成可照做的中文",
  hint.includes("缺少权限 ui.theme") && hint.includes("加载本地插件"),
  String(hint).split("\n")[0]
);

denyTheme = true;
calls.length = 0;
const deniedSave = await entry.onPanelInvoke("wallpaper.save", { imagePath: "C:/test/wall/aurora.jpg", blur: 12 });
check(
  "权限被拒时面板保存不崩溃、返回中文原因",
  deniedSave?.error?.includes("缺少权限 ui.theme") && themes.size === 0,
  JSON.stringify({ error: deniedSave?.error?.split("\n")[0], themes: themes.size })
);
const deniedCheck = await entry.onPanelInvoke("wallpaper.check", {});
check(
  "自检把权限被拒单独报出来并判为不通过",
  deniedCheck?.checkOk === false && (deniedCheck?.check ?? []).some((line) => line.includes("主题权限 ui.theme：被拒绝")),
  JSON.stringify((deniedCheck?.check ?? []).filter((l) => l.includes("权限")))
);
denyTheme = false;

// 12) 面板 ⇄ 主进程的契约自检：面板要用的键、调用的通道、引用的元素 id 都得对得上。
//     这一组专门拦「加了控件但状态没带回来」这类只有点开面板才会发现的错。
const panelHtml = fs.readFileSync(path.join(pluginDir, "renderer", "index.html"), "utf8");
const mainSource = fs.readFileSync(path.join(pluginDir, "main.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));

const elementIds = new Set([...panelHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const missingIds = [...new Set([...panelHtml.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))].filter((id) => !elementIds.has(id));
check("面板里引用的元素 id 都存在", missingIds.length === 0, missingIds.join(", "));

const handledChannels = new Set([...mainSource.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
const panelChannels = [...new Set([...panelHtml.matchAll(/call\(\s*"([^"]+)"/g)].map((m) => m[1]))];
const unhandled = panelChannels.filter((channel) => !handledChannels.has(channel) && !channel.includes("."));
check(
  `面板调用的通道都有处理（${panelChannels.join(", ")}）`,
  unhandled.length === 0,
  `没有处理：${unhandled.join(", ")}`
);

const panelKeys = ["imagePath", "index", "blur", "dim", "lift", "glass", "veil", "fit", "base"];
const declaredKeys = new Set((manifest.contributes?.settings ?? []).map((setting) => setting.key));
check(
  "面板用到的每个设置键都在 manifest 里声明、也在契约清单里",
  panelKeys.every((key) => declaredKeys.has(key) && CONTRACT.settingKeys.includes(key)),
  panelKeys.filter((key) => !declaredKeys.has(key)).join(", ")
);
const stateBody = mainSource.slice(mainSource.indexOf("async function statePayload"), mainSource.indexOf("/** 面板送来的补丁"));
const missingState = panelKeys.filter((key) => !new RegExp(`\\b${key}:`).test(stateBody));
check("面板状态带回了面板要用的每个值（含 glass、lift）", missingState.length === 0, missingState.join(", "));
const patchBody = mainSource.slice(mainSource.indexOf("function normalizePanelPatch"), mainSource.indexOf("async function panelSave"));
const missingPatch = panelKeys.filter((key) => !new RegExp(`payload\\.${key}\\b`).test(patchBody));
check("面板送来的每个键都经过 normalizePanelPatch 校验/夹取", missingPatch.length === 0, missingPatch.join(", "));
const glassSetting = (manifest.contributes?.settings ?? []).find((setting) => setting.key === "glass");
check(
  "manifest 里 glass 的默认值和契约一致",
  glassSetting?.default === CONTRACT.defaultGlass,
  `manifest=${glassSetting?.default} 契约=${CONTRACT.defaultGlass}`
);
check(
  "面板滑块的范围和契约一致（0–100）",
  /id="glass"[^>]*min="0"[^>]*max="100"/.test(panelHtml),
  ""
);
check(
  "面板有「壁纸提亮」滑块，范围和契约一致（0–60）",
  /id="lift"[^>]*min="0"[^>]*max="60"/.test(panelHtml) && panelHtml.includes('id="lift-val"'),
  ""
);
// 技能（contributes.skills）：宿主只索引带 name/description front matter 的文件，
// 且必须有 agent.prompt.inject 权限，否则文件会被静默忽略。这里把这套契约钉住。
const skillPaths = manifest.contributes?.skills ?? [];
check(
  "manifest 贡献了技能且声明了 agent.prompt.inject",
  skillPaths.length > 0 && (manifest.permissions ?? []).includes("agent.prompt.inject"),
  `skills=${skillPaths.join(", ")} permissions=${(manifest.permissions ?? []).join(", ")}`
);
for (const rel of skillPaths) {
  const skillFile = path.join(pluginDir, ...String(rel).split("/"));
  let text = "";
  try {
    text = fs.readFileSync(skillFile, "utf8");
  } catch (error) {
    check(`技能文件存在：${rel}`, false, String(error?.message ?? error));
    continue;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const name = /^name:\s*(.+)$/m.exec(fm?.[1] ?? "")?.[1]?.trim() ?? "";
  const description = /^description:\s*(.+)$/m.exec(fm?.[1] ?? "")?.[1]?.trim() ?? "";
  const bytes = Buffer.byteLength(text, "utf8");
  check(
    `技能 ${rel} 的 front matter / 体积合规`,
    Boolean(fm) && name.length > 0 && description.length > 0 && description.length <= 240 && bytes <= 128 * 1024,
    `name=${name} 描述 ${description.length} 字符 体积 ${bytes} 字节`
  );
}
// 9) 卸载
await entry.onUnload();
check("卸载时注销全部命令", pi.commands.registered.size === 0);
check("卸载后没有残留主题", themes.size === 0);

// 13) 重载/升级不丢壁纸：用户正用着壁纸时，插件卸载不能改掉主题偏好，重新加载要自动恢复。
//     这一条对应真实踩过的坑：卸载时把主题切回 dark，于是每次开发热重载 / 桌面端升级都把壁纸弄丢。
await entry.onLoad();
await entry.onPanelInvoke("wallpaper.save", { imagePath: "C:/test/wall/aurora.jpg", index: 0 });
const activeBeforeReload = activeTheme;
check("应用后主题是壁纸主题", activeBeforeReload === "plugin:local.pi-wallpaper:photo", activeBeforeReload);
await entry.onUnload();
check(
  "卸载时不动用户选的主题（否则重载就丢壁纸）",
  activeTheme === activeBeforeReload,
  `卸载前=${activeBeforeReload} 卸载后=${activeTheme}`
);
await entry.onLoad();
await tick();
check(
  "重载后自动把壁纸主题恢复回来",
  activeTheme === "plugin:local.pi-wallpaper:photo" && themes.size === 1,
  `theme=${activeTheme} 已注册=${themes.size}`
);

// 14) 明暗基底：这一组盯的是真实踩过的大坑 ——
//     宿主在"偏好指向运行时主题、但该主题此刻还没注册"时会报系统色；本机系统是浅色，
//     跟着它注册就把界面整片刷白、白字变深色糊在壁纸上（侧栏还会变成一层白雾）。
appearanceBase = "light";
await entry.onPanelInvoke("wallpaper.save", { imagePath: "C:/test/wall/aurora.jpg", base: "auto" });
check(
  "宿主报浅色时不跟着变成亮色主题（auto 兜底为暗色）",
  lastCall("themes.upsert")?.[2] === "dark",
  `注册的 base=${lastCall("themes.upsert")?.[2]}`
);
await entry.onPanelInvoke("wallpaper.save", { base: "light" });
check(
  "显式选亮色才用亮色",
  lastCall("themes.upsert")?.[2] === "light",
  `注册的 base=${lastCall("themes.upsert")?.[2]}`
);
await entry.onPanelInvoke("wallpaper.save", { base: "auto" });
check(
  "改回 auto 又回到暗色",
  lastCall("themes.upsert")?.[2] === "dark",
  `注册的 base=${lastCall("themes.upsert")?.[2]}`
);
// 先把队列里剩下的旧回调（上一组 save 触发的 settingsChanged → 重新应用 → app.setTheme）
// 跑完，否则它们会把 stub 的 activeTheme 又改回壁纸主题，让这一步测不准。
await tick();
await tick();
appearanceBase = null;
activeTheme = "light";
await entry.onPanelInvoke("wallpaper.save", {});
await tick();
check(
  "用户真的把桌面端切成内置亮色时，auto 跟随为亮色",
  lastCall("themes.upsert")?.[2] === "light",
  `注册的 base=${lastCall("themes.upsert")?.[2]}；stub 的 activeTheme=${activeTheme}；最近 3 次注册=${JSON.stringify(calls.filter((c) => c[0] === "themes.upsert").slice(-3).map((c) => c[2]))}`
);
activeTheme = "plugin:local.pi-wallpaper:photo";

// 15) 一键恢复正常外观（命令与面板按钮共用同一实现）
settings = { ...settings, dim: 0, lift: 45, glass: 0, base: "light" };
await entry.onPanelInvoke("wallpaper.reset", {});
check(
  "面板「恢复正常外观」把参数写回推荐值",
  settings.dim === 20 && settings.lift === 0 && settings.glass === 22 && settings.base === "auto" && settings.veil === "ink",
  JSON.stringify({ dim: settings.dim, lift: settings.lift, glass: settings.glass, base: settings.base })
);
check(
  "恢复正常外观后主题被重新注册为暗色基底",
  lastCall("themes.upsert")?.[2] === "dark" && themes.size === 1,
  `base=${lastCall("themes.upsert")?.[2]} 已注册=${themes.size}`
);
check(
  "命令表里也有「恢复正常外观」",
  typeof pi.commands.registered.get("local.pi-wallpaper.reset")?.run === "function",
  [...pi.commands.registered.keys()].join(", ")
);

console.log("=".repeat(64));
console.log(failures === 0 ? "结论：本地自测全部通过。" : `结论：${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
