#!/usr/bin/env node
/**
 * 桌面端升级之后的兼容性核对工具。
 *
 * 它会重新解包「当前已安装的 PI-Desktop」的 app.asar，把宿主实现里所有本插件依赖的
 * 事实（API 白名单、主题 CSS 限制、图片资源限制、主题 id 命名空间、界面区域类名、
 * 设计 token、插件事件）逐条与 lib/host-contract.js 里登记的契约比对。
 *
 * 用法：
 *   node scripts/compat-check.mjs                    # 自动找 E:\PI-Desktop
 *   node scripts/compat-check.mjs "D:\Apps\PI-Desktop"
 *   set PI_DESKTOP_DIR=D:\Apps\PI-Desktop && node scripts/compat-check.mjs
 *
 * 退出码：0 = 全部通过（含仅提示项）；1 = 有硬失败，需要按报告修改 lib/host-contract.js。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CONTRACT, SURFACES, themeIdFor } = require("../lib/host-contract.js");
const { buildThemeCss, themeCssProblem } = require("../lib/theme-css.js");

/* --------------------------------------------------------------- asar 读取 */

/** 解析 asar 头（嵌套 pickle，兼容两种布局）并返回可按路径读文件的工具。 */
function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  const head = Buffer.alloc(24);
  fs.readSync(fd, head, 0, 24, 0);
  const headerSize = head.readUInt32LE(4);
  let header = null;
  for (const [lenAt, dataAt] of [
    [12, 16],
    [8, 12],
  ]) {
    const len = head.readUInt32LE(lenAt);
    if (!Number.isFinite(len) || len <= 0 || len > headerSize + 16) continue;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, dataAt);
    try {
      header = JSON.parse(buf.toString("utf8"));
      break;
    } catch {
      /* 试下一种布局 */
    }
  }
  if (!header) throw new Error(`无法解析 asar 头：${asarPath}`);
  const baseOffset = 8 + headerSize;

  const index = new Map();
  (function walk(node, rel) {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = rel ? `${rel}/${name}` : name;
      if (entry.files) walk(entry, p);
      else if (!entry.unpacked) index.set(p, { size: entry.size, offset: Number(entry.offset) });
    }
  })(header, "");

  return {
    paths: [...index.keys()],
    read(p) {
      const entry = index.get(p);
      if (!entry) return null;
      const buf = Buffer.alloc(entry.size);
      fs.readSync(fd, buf, 0, entry.size, baseOffset + entry.offset);
      return buf.toString("utf8");
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

/* --------------------------------------------------------------- 小工具 */

const results = [];
let failures = 0;

function record(level, id, label, detail) {
  if (level === "fail") failures += 1;
  results.push({ level, id, label, detail });
}

const ok = (id, label, detail) => record("ok", id, label, detail);
const fail = (id, label, detail) => record("fail", id, label, detail);
const info = (id, label, detail) => record("info", id, label, detail);

/** 宿主压缩代码里的数字表达式（"256 * 1024" / "4 * 1024 * 1024" / "262144"）。 */
function parseNumberExpr(expr) {
  const parts = String(expr ?? "").split("*").map((part) => Number.parseInt(part.trim(), 10));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * n, 1);
}

/** 从宿主 bundle 里取 `名字 = 表达式;` 的数值。 */
function numberConstant(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*([0-9*\\s]+)[,;]`).exec(source);
  return match ? parseNumberExpr(match[1]) : null;
}

/** 从宿主 bundle 里取字符串数组常量。 */
function stringArrayConstant(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 当前生成的 CSS 是否还满足宿主限制。 */
function generatedCssHealth() {
  const css = buildThemeCss({
    imagePath: "C:/Users/you/Pictures/example.jpg",
    blur: 16,
    dim: 20,
    veil: "ink",
    fit: "cover",
  });
  return { css, problem: themeCssProblem(css), bytes: Buffer.byteLength(css, "utf8") };
}

/* --------------------------------------------------------------- 主流程 */

const explicitDir = process.argv[2] ?? process.env.PI_DESKTOP_DIR ?? "";
const candidates = [
  explicitDir,
  "E:\\PI-Desktop",
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "PI-Desktop"),
  path.join(process.env.PROGRAMFILES ?? "", "PI-Desktop"),
].filter(Boolean);

const asarPath = (() => {
  for (const dir of candidates) {
    const candidate = path.join(dir, "resources", "app.asar");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
})();

console.log("PI-Desktop 壁纸插件 · 兼容性核对");
console.log("=".repeat(64));

if (!asarPath) {
  console.log("找不到 app.asar。请把安装目录作为参数传进来，例如：");
  console.log('  node scripts/compat-check.mjs "D:\\Apps\\PI-Desktop"');
  process.exit(1);
}
console.log(`安装位置：${asarPath}`);

const asar = openAsar(asarPath);
const mainBundle = asar.read("out/main/index.js") ?? "";
const rendererCss =
  asar.paths
    .filter((p) => /^out\/renderer\/assets\/index-.*\.css$/.test(p))
    .map((p) => asar.read(p))
    .join("\n") ?? "";
const rendererHtml = asar.read("out/renderer/index.html") ?? "";
const manifestRaw = asar.read("package.json") ?? "{}";
const hostProcess = asar.read("out/main/plugin-host-process.js") ?? "";
const panelPreload = asar.read("out/preload/plugin-panel.js") ?? "";

if (!mainBundle || !rendererCss) {
  console.log("[FAIL] app.asar 结构变了：读不到 out/main/index.js 或渲染层样式表。");
  console.log("       本插件依赖「运行时主题 + 覆盖宿主底色」的机制，需要人工确认新版本的做法。");
  asar.close();
  process.exit(1);
}

/* 1. 版本 */
const hostVersion = (() => {
  try {
    return JSON.parse(manifestRaw).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();
const versionAtLeast = (actual, minimum) => {
  const parse = (v) => String(v ?? "").split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  const a = parse(actual);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
};
if (versionAtLeast(hostVersion, CONTRACT.minimumHost)) {
  ok("version", `宿主版本 ${hostVersion}`, `核对基准 ${CONTRACT.verifiedAgainst}，要求 ≥ ${CONTRACT.minimumHost}`);
} else {
  fail("version", `宿主版本 ${hostVersion} 低于要求`, `manifest.engines 声明的是 ≥ ${CONTRACT.minimumHost}，请同步更新插件`);
}

/* 2. 插件 API 白名单 */
const allowlist = (() => {
  const start = mainBundle.indexOf("HOST_API_ALLOWLIST");
  if (start < 0) return null;
  const slice = mainBundle.slice(start, start + 6000);
  const end = slice.indexOf("])");
  return end > 0 ? new Set([...slice.slice(0, end).matchAll(/"([^"]+)"/g)].map((m) => m[1])) : null;
})();
if (!allowlist) {
  fail("api.allowlist", "找不到 HOST_API_ALLOWLIST", "宿主可能重命名了插件 API 白名单，需要人工确认");
} else {
  const missingApis = CONTRACT.requireApis.filter((api) => !allowlist.has(api));
  if (missingApis.length) {
    fail("api.allowlist", `宿主不再暴露这些 API：${missingApis.join(", ")}`, "main.js 里对应的功能会失效");
  } else {
    ok("api.allowlist", `插件 API 齐备（${CONTRACT.requireApis.length} 项）`, CONTRACT.requireApis.join(", "));
  }
}

/* 3. 主题 CSS 限制 */
const cssMax = numberConstant(mainBundle, "THEME_CSS_MAX_BYTES");
if (cssMax === CONTRACT.cssMaxBytes) {
  ok("css.limit", `主题 CSS 上限 ${cssMax} 字节`, "与契约一致");
} else {
  fail("css.limit", `主题 CSS 上限变成 ${cssMax}`, `契约里登记的是 ${CONTRACT.cssMaxBytes}`);
}
const forbiddenMissing = CONTRACT.cssForbidden.filter((token) => !mainBundle.includes(token));
if (forbiddenMissing.length) {
  info("css.forbidden", `这些禁用写法在新宿主里已搜不到：${forbiddenMissing.join(", ")}`, "可能放宽了限制，无需改动");
} else {
  ok("css.forbidden", "主题 CSS 禁用写法仍然生效", CONTRACT.cssForbidden.join(" / "));
}

/* 4. 图片资源限制 */
const assetExtensions = stringArrayConstant(mainBundle, "THEME_ASSET_EXTENSIONS");
if (assetExtensions && assetExtensions.join(",") === CONTRACT.assetExtensions.join(",")) {
  ok("asset.ext", `图片扩展名白名单一致（${assetExtensions.join(" / ")}）`, "");
} else {
  fail(
    "asset.ext",
    `图片扩展名白名单变了：${assetExtensions ? assetExtensions.join(" / ") : "未找到"}`,
    `契约里是 ${CONTRACT.assetExtensions.join(" / ")}；同步修改 lib/host-contract.js`
  );
}
const assetMax = numberConstant(mainBundle, "THEME_ASSET_MAX_BYTES");
if (assetMax === CONTRACT.assetMaxBytes) {
  ok("asset.size", `单张图片上限 ${assetMax / 1024 / 1024} MB`, "与契约一致");
} else {
  fail("asset.size", `单张图片上限变成 ${assetMax}`, `契约里是 ${CONTRACT.assetMaxBytes}`);
}
if (mainBundle.includes("externalThemeAsset")) {
  ok("asset.external", "运行时主题支持读取任意绝对路径的图片", "pi.themes.upsert 会走 externalThemeAsset");
} else {
  fail("asset.external", "找不到 externalThemeAsset", "运行时主题可能不再接受磁盘上的绝对路径");
}

/* 5. 主题 id 命名空间 */
if (/plugin:\$\{/.test(mainBundle) || mainBundle.includes("`plugin:${")) {
  ok("theme.id", `主题 id 命名空间仍是 ${CONTRACT.themeIdPrefix}<pluginId>:<themeId>`, "");
} else {
  fail("theme.id", "主题 id 命名空间可能变了", "检查宿主里的 pluginThemeId 实现，同步修改 themeIdFor()");
}

/* 6. 插件事件 */
for (const [id, eventName] of [
  ["event.settings", CONTRACT.settingsChangedEvent],
  ["event.appearance", CONTRACT.appearanceChangedEvent],
]) {
  if (mainBundle.includes(eventName)) ok(id, `事件 ${eventName} 仍在`, "");
  else fail(id, `事件 ${eventName} 消失`, "main.js 里监听它；需要换用新的通知方式");
}

if (panelPreload.includes(CONTRACT.panelChromePaintThroughVersion) && panelPreload.includes("paint-through")) {
  ok(
    "panel.chromeV3",
    `宿主仍支持 chrome ${CONTRACT.panelChromePaintThroughVersion}（paint-through）`,
    "面板靠它避开 Windows 上 v2 那条原生拖拽黑带"
  );
} else {
  fail(
    "panel.chromeV3",
    `宿主不再支持 chrome ${CONTRACT.panelChromePaintThroughVersion}`,
    "顶部拖拽带方案要重选：v2 会有黑带；legacy 需要自己补 body 顶部留白"
  );
}

/* 6.8 我方产物的自洽性：面板声明的 chrome 版本必须和契约一致，且 v3 下要自己画拖拽条 */
try {
  const panelHtml = fs.readFileSync(path.join(import.meta.dirname, "..", "renderer", "index.html"), "utf8");
  const meta = /name="pi-plugin-chrome"\s+content="([^"]+)"/.exec(panelHtml);
  const declared = meta ? meta[1] : "";
  if (declared === CONTRACT.panelChromePaintThroughVersion) {
    ok("self.panelChrome", `renderer/index.html 声明 chrome ${declared}`, "与契约一致");
  } else {
    fail("self.panelChrome", `renderer/index.html 声明的是 ${declared || "(缺失)"}`, `契约要求 ${CONTRACT.panelChromePaintThroughVersion}`);
  }
  if (declared === CONTRACT.panelChromePaintThroughVersion && !/app-region: drag/.test(panelHtml)) {
    fail("self.panelDrag", "v3 面板没有自己标记拖拽区", "窗口会拖不动：顶部那条要自己画并加 -webkit-app-region: drag");
  } else if (declared === CONTRACT.panelChromePaintThroughVersion) {
    ok("self.panelDrag", "v3 面板自己画了拖拽标题栏", "顺带说明：v2 的整条原生拖拽带在 Windows 上会显示成纯黑");
  }
} catch (error) {
  info("self.panelChrome", "读不到 renderer/index.html", String(error?.message ?? error));
}

/* 6.6 主题钩子：我方 CSS 全部以 :root[data-plugin-theme="…"] 开头，必须确认宿主还在设这个属性 */
const rendererJs = asar.paths
  .filter((p) => /^out\/renderer\/assets\/index-.*\.js$/.test(p))
  .map((p) => asar.read(p))
  .join("\n");
if (rendererJs.includes(CONTRACT.themeHookRuntimeExpression) && rendererJs.includes(CONTRACT.themeStyleInjection)) {
  ok(
    "theme.hook",
    `宿主仍把主题 id 写到 html 上（${CONTRACT.themeHookRuntimeExpression}）并把主题 CSS 追加成 head 里的 <style>`,
    "主题 CSS 的作用域前缀靠它生效"
  );
} else {
  fail(
    "theme.hook",
    "主题钩子没了：宿主不再设置 data-plugin-theme，或不再追加 <style>",
    "界面会一点壁纸都看不到。先看渲染层现在怎么应用插件主题，再改 lib/theme-css.js 的 themeScope()"
  );
}
if (rendererCss.includes(CONTRACT.themeHookAttribute)) {
  ok("theme.hookCss", `宿主样式表里也在用 ${CONTRACT.themeHookAttribute}`, "说明它还是官方钩子");
} else {
  info("theme.hookCss", `宿主样式表里看不到 ${CONTRACT.themeHookAttribute}`, "仅提示；以 theme.hook 的结论为准");
}

/* 6.5 面板机制：面板 bridge → 宿主 → 插件 main.js 的 onPanelInvoke */
if (hostProcess.includes(CONTRACT.panelInvocationExport) && hostProcess.includes("panel.invoke")) {
  ok("panel.invoke", `宿主仍会把面板调用转发给插件的 ${CONTRACT.panelInvocationExport}`, "renderer/index.html 用的就是这条通路");
} else {
  fail(
    "panel.invoke",
    `找不到面板调用转发（${CONTRACT.panelInvocationExport} / panel.invoke）`,
    "面板通道会失效：需要按新宿主的机制改写 main.js 的 onPanelInvoke 与面板里的 bridge 调用"
  );
}
if (panelPreload.includes(CONTRACT.panelDropPathApi)) {
  ok("panel.dropPath", `面板 preload 仍提供 ${CONTRACT.panelDropPathApi}`, "拖拽/选文件后能拿到绝对路径");
} else {
  fail("panel.dropPath", `面板 preload 不再提供 ${CONTRACT.panelDropPathApi}`, "拖图取路径会失效，要改用别的取路径方式");
}
if (panelPreload.includes(CONTRACT.panelTitlebarVariable)) {
  ok("panel.titlebar", `面板仍通过 ${CONTRACT.panelTitlebarVariable} 告诉插件顶部拖拽带高度`, "");
} else {
  fail("panel.titlebar", `找不到 ${CONTRACT.panelTitlebarVariable}`, "面板顶部留白会不对（内容可能被窗口按钮胶囊压住）");
}
if (mainBundle.includes(CONTRACT.panelBridgeChannel)) {
  ok("panel.bridgeChannel", `面板 bridge 通道 ${CONTRACT.panelBridgeChannel} 仍在`, "");
} else {
  fail("panel.bridgeChannel", `找不到 ${CONTRACT.panelBridgeChannel}`, "面板无法调用插件与宿主 API");
}
if (mainBundle.includes(CONTRACT.panelChromeMeta)) {
  ok("panel.chrome", `面板 chrome 约定 ${CONTRACT.panelChromeMeta} 仍在`, `renderer/index.html 里声明的是 ${CONTRACT.panelChromePaintThroughVersion}`);
} else {
  fail("panel.chrome", `找不到 ${CONTRACT.panelChromeMeta}`, "面板标题栏协议可能变了，检查 renderer/index.html 的 meta");
}
if (mainBundle.includes("manifest.ui?.panel") || mainBundle.includes("manifest.ui")) {
  ok("panel.declaration", "宿主仍从实时 manifest 解析 ui.panel", "所以删掉面板文件会让入口失效（本插件已备好 renderer/index.html）");
} else {
  fail("panel.declaration", "宿主不再从 manifest.ui 解析面板", "面板入口的实现方式变了");
}

/* 7. 界面区域选择器 */
const missingSurfaces = [];
for (const surface of SURFACES) {
  for (const selector of surface.selectors) {
    const probe = selector
      .split(/\s+/)
      .pop()
      .replace(/::?[a-z-]+/g, "")
      .replace(/:not\([^)]*\)/g, "");
    const name = probe.includes(".") ? probe.slice(probe.lastIndexOf(".")) : probe;
    const hit = rendererCss.includes(name) || (name.startsWith(".") && rendererCss.includes(`${name} `)) || rendererCss.includes(`${name}{`) || rendererCss.includes(`${name},`);
    if (!hit) missingSurfaces.push(`${surface.id} → ${selector}（${surface.note}）`);
  }
}
if (missingSurfaces.length) {
  fail("surface.selectors", `${missingSurfaces.length} 个界面区域选择器在新版样式表里找不到`, missingSurfaces.join("\n        "));
} else {
  ok("surface.selectors", `全部 ${SURFACES.length} 组界面区域选择器仍然存在`, SURFACES.map((s) => s.id).join(", "));
}

/* 8. 毛玻璃用的设计 token */
const glassTokens = [
  ...new Set(SURFACES.filter((s) => s.mode === "glass").flatMap((s) => [s.token, s.tint].filter(Boolean))),
];
const missingTokens = glassTokens.filter((token) => !new RegExp(`${token}\\s*:`).test(rendererCss));
if (missingTokens.length) {
  fail("surface.tokens", `这些设计 token 找不到了：${missingTokens.join(", ")}`, "半透明的区域会退回不透明底色");
} else {
  ok("surface.tokens", `${glassTokens.length} 个设计 token 仍在定义`, glassTokens.join(", "));
}

/* 9. 根元素结构 */
if (/#root/.test(rendererHtml) || rendererCss.includes("#root")) {
  ok("dom.root", "根元素 #root 仍在", "壁纸挂在根元素 ::before 上，靠 data-plugin-theme 作用域限定");
} else {
  fail("dom.root", "找不到 #root", "宿主的根元素结构变了，需要确认壁纸层的挂载方式");
}

/* 10. 仅供参考：宿主自己的壁纸挂点与主题属性 */
if (rendererCss.includes(CONTRACT.wallpaperSlotSelector) || mainBundle.includes(CONTRACT.wallpaperSlotSelector)) {
  info("info.slot", `宿主仍保留壁纸挂点 ${CONTRACT.wallpaperSlotSelector}`, "本插件刻意不依赖它，仅作参考");
} else {
  info("info.slot", `宿主已没有 ${CONTRACT.wallpaperSlotSelector}`, "本插件不依赖它，无需处理");
}
if (rendererCss.includes(CONTRACT.themeHookAttribute)) {
  info("info.hook", `宿主仍在用 ${CONTRACT.themeHookAttribute} 标记插件主题`, "它是官方钩子；硬依赖见上面的 theme.hook");
} else {
  info("info.hook", `宿主样式表里看不到 ${CONTRACT.themeHookAttribute}`, "以 theme.hook 的结论为准");
}

/* 11. 我们自己的产物 */
const health = generatedCssHealth();
if (health.problem) {
  fail("self.css", "插件生成的 CSS 不满足当前宿主限制", health.problem);
} else {
  ok("self.css", `插件生成的 CSS 自检通过（约 ${health.bytes} 字节）`, `上限 ${cssMax ?? CONTRACT.cssMaxBytes} 字节`);
}
const themeScopePrefix = `:root[${CONTRACT.themeHookAttribute}="${themeIdFor(CONTRACT.localThemeId)}"]`;
if (health.css.includes(`${themeScopePrefix} .sidebar-surface`) && health.css.includes(`${themeScopePrefix}::before`)) {
  ok("self.themeScope", "生成的 CSS 用宿主主题钩子做了作用域", themeScopePrefix);
} else {
  fail("self.themeScope", "生成的 CSS 没有作用域前缀", `期望包含 ${themeScopePrefix} .sidebar-surface 与 ${themeScopePrefix}::before`);
}
const manifestPath = path.join(import.meta.dirname, "..", "manifest.json");
try {
  const pluginManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const engine = pluginManifest?.engines?.piDesktop ?? "";
  const expected = `>=${CONTRACT.minimumHost}`;
  if (engine === expected) ok("self.manifest", `manifest.engines.piDesktop = ${engine}`, "与契约一致");
  else info("self.manifest", `manifest.engines.piDesktop = ${engine}`, `契约要求 ${expected}`);
} catch (error) {
  info("self.manifest", "读不到 manifest.json", String(error?.message ?? error));
}

asar.close();

/* --------------------------------------------------------------- 报告 */

console.log("");
const label = { ok: "[ OK ]", fail: "[FAIL]", info: "[INFO]" };
for (const item of results) {
  console.log(`${label[item.level]} ${item.label}`);
  if (item.detail) console.log(`       ${item.detail}`);
}
console.log("");
console.log("=".repeat(64));
if (failures === 0) {
  console.log(`结论：全部关键契约仍然成立（宿主 ${hostVersion}），这个插件不需要改动。`);
} else {
  console.log(`结论：${failures} 项需要处理。改 lib/host-contract.js 里对应的常量/选择器即可，`);
  console.log("      main.js 不需要动；改完再跑一次本脚本确认。");
}
console.log(`提示：核对通过后，把 lib/host-contract.js 顶部的 verifiedAgainst 改成 ${hostVersion}。`);

process.exit(failures === 0 ? 0 : 1);
