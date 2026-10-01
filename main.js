"use strict";
/**
 * 壁纸（本地图片 + 背景虚化）—— PI-Desktop 插件入口。
 *
 * 这个文件只负责「编排」：读设置、生成主题 CSS、向宿主注册运行时主题、
 * 应用/切换/自检。所有与宿主实现耦合的细节都在 lib/host-contract.js。
 *
 * 工作方式：
 *   - 壁纸图片始终是你磁盘上的原文件，插件不复制、不上传，只把绝对路径写进主题 CSS；
 *   - 主题通过 pi.themes.upsert 注册（内存态），所以启动时会重建一次；
 *   - 虚化/压暗等参数改一下设置就实时生效（宿主会发 plugin:settingsChanged）。
 */

const {
  CONTRACT,
  themeIdFor,
  normalizeImagePath,
  isAbsolutePath,
  hasSupportedExtension,
  describeError,
  isPermissionDenied,
} = require("./lib/host-contract.js");
const { buildThemeCss, themeCssProblem } = require("./lib/theme-css.js");

const COMMANDS = {
  openPanel: "local.pi-wallpaper.openPanel",
  apply: "local.pi-wallpaper.apply",
  next: "local.pi-wallpaper.next",
  clear: "local.pi-wallpaper.clear",
  selfCheck: "local.pi-wallpaper.selfCheck",
  reset: "local.pi-wallpaper.reset",
};

const state = {
  settings: {},
  appearance: null,
  hostVersion: "unknown",
  lastError: null,
};

/* ------------------------------------------------------------------ 基础工具 */

function log(...args) {
  // 插件进程的 stdout 会进宿主的插件审计日志（设置 → 插件 → 日志）。
  try {
    console.log("[wallpaper]", ...args);
  } catch {
    /* 忽略 */
  }
}

async function toast(message) {
  try {
    await pi.ui.showToast(String(message));
  } catch (error) {
    log("toast failed:", error?.message ?? error);
  }
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.round(num), min), max);
}

const FITS = ["cover", "contain", "center", "tile"];
const VEILS = ["ink", "slate", "blue", "violet", "warm", "none"];

/** 设置里的图片路径可以一行一个，支持多张轮换。 */
function parseImagePaths(raw) {
  return String(raw ?? "")
    .split(/[\r\n;]+/)
    .map((line) => normalizeImagePath(line))
    .filter((line) => line.length > 0);
}

/** 把设置整理成生成 CSS 需要的样子。 */
function resolveConfig() {
  const paths = parseImagePaths(state.settings?.imagePath);
  const rawIndex = Number(state.settings?.index);
  const index = paths.length ? (((Number.isFinite(rawIndex) ? Math.trunc(rawIndex) : 0) % paths.length) + paths.length) % paths.length : 0;
  const fitValue = String(state.settings?.fit ?? "");
  const veilValue = String(state.settings?.veil ?? "");
  return {
    paths,
    index,
    imagePath: paths[index] ?? "",
    blur: clampNumber(state.settings?.blur, 0, 40, 16),
    dim: clampNumber(state.settings?.dim, 0, 70, 20),
    glass: clampNumber(state.settings?.glass, 0, 100, CONTRACT.defaultGlass),
    lift: clampNumber(state.settings?.lift, 0, 60, CONTRACT.defaultLift),
    fit: FITS.includes(fitValue) ? fitValue : "cover",
    veil: VEILS.includes(veilValue) ? veilValue : "ink",
  };
}

/** 设置项 base 的取值：auto / dark / light。 */
function baseMode() {
  const mode = String(state.settings?.base ?? CONTRACT.defaultBaseMode);
  return CONTRACT.baseModes.includes(mode) ? mode : CONTRACT.defaultBaseMode;
}

/**
 * 主题的明暗基底（决定界面用亮色还是暗色 token）。
 *
 * 这里**不能**无脑跟随 `appearance.base`：宿主在"用户选的是运行时主题、但该主题此刻还没注册"
 * 的那一瞬间（每次启动、每次插件重载都会出现）会把 base 报成系统色。本机系统是浅色，
 * 跟着它注册就会把界面整片刷白、白字变黑字糊在壁纸上 —— 真实踩过。
 * 所以：显式设置优先；auto 只跟随"用户真的选了内置亮/暗"，其余一律暗色。
 */
function currentBase() {
  const mode = baseMode();
  if (mode === "light" || mode === "dark") return mode;
  const theme = state.appearance?.theme;
  return theme === "light" || theme === "dark" ? theme : CONTRACT.fallbackBase;
}

async function refreshAppearance() {
  try {
    state.appearance = await pi.app.getAppearance();
  } catch (error) {
    log("getAppearance failed:", error?.message ?? error);
    state.appearance = null;
  }
  return state.appearance;
}

/**
 * 读取最新设置。
 * 命令路径每次都重新读，所以即使宿主某天不再发 plugin:settingsChanged，
 * 手动点「应用壁纸」也一定是按当前设置生效的。
 */
async function refreshSettings() {
  try {
    state.settings = (await pi.plugin.getSettings()) ?? state.settings;
  } catch (error) {
    log("getSettings failed:", error?.message ?? error);
  }
  return state.settings;
}

function ourThemeId() {
  return themeIdFor(CONTRACT.localThemeId);
}

function isOurThemeActive() {
  const id = ourThemeId();
  return state.appearance?.pluginTheme === id || state.appearance?.theme === id;
}

/** 路径的合法性：先自己查，给出比宿主报错更具体的中文提示。 */
function pathProblem(imagePath) {
  if (!imagePath) {
    return "还没设置图片路径。到「设置 → 插件 → 壁纸」把图片的完整路径填进去（一行一张，可多张轮换）。";
  }
  if (!isAbsolutePath(imagePath)) {
    return `需要绝对路径，例如 C:/Users/你/Pictures/bg.jpg；当前填的是：${imagePath}`;
  }
  if (!hasSupportedExtension(imagePath)) {
    return `宿主只接受这些图片格式：${CONTRACT.assetExtensions.join(" / ")}；当前是：${imagePath}`;
  }
  return null;
}

/* ------------------------------------------------------------------ 宿主动作 */

/** 用当前设置（重新）注册运行时主题，返回主题 id。 */
async function upsertWallpaperTheme(config) {
  if (!pi.themes?.upsert) throw new Error("host api not available: themes.upsert");
  const css = buildThemeCss({ ...config, base: currentBase(), themeId: ourThemeId() });
  const problem = themeCssProblem(css);
  if (problem) throw new Error(problem);
  await pi.themes.upsert({
    id: CONTRACT.localThemeId,
    label: CONTRACT.localThemeLabel,
    base: currentBase(),
    css,
  });
  log(
    `theme upserted: ${ourThemeId()} · base=${currentBase()} · image=${config.imagePath} · blur=${config.blur}px · dim=${config.dim}% · lift=${config.lift}% · glass=${config.glass}% · fit=${config.fit} · veil=${config.veil}`,
  );
  return ourThemeId();
}

async function removeWallpaperTheme() {
  if (!pi.themes?.remove) return;
  try {
    await pi.themes.remove(ourThemeId());
  } catch (error) {
    // 本来就不存在就无所谓
    if (!/NOT_FOUND/i.test(String(error?.message ?? ""))) throw error;
  }
}

/**
 * 应用壁纸。
 * @param {{ announce?: boolean, activate?: boolean }} options
 *        activate=false 时只保证主题内容是最新的，不抢占用户当前选的主题。
 */
async function applyWallpaper(options = {}) {
  const { announce = false, activate = true } = options;
  // 每次都按磁盘上的最新设置来，避免依赖宿主事件。
  await refreshSettings();
  await refreshAppearance();
  const config = resolveConfig();
  const problem = pathProblem(config.imagePath);
  if (problem) {
    state.lastError = problem;
    if (announce) await toast(problem);
    return { ok: false, error: problem };
  }
  try {
    const id = await upsertWallpaperTheme(config);
    if (activate) {
      await pi.app.setTheme(id);
      await refreshAppearance();
    }
    if (announce) {
      const name = config.imagePath.split("/").pop();
      const extra = config.paths.length > 1 ? `（第 ${config.index + 1}/${config.paths.length} 张）` : "";
      await toast(`壁纸已应用${extra}：${name}｜模糊 ${config.blur}px｜压暗 ${config.dim}%｜${config.fit}`);
    }
    state.lastError = null;
    return { ok: true, themeId: id, config };
  } catch (error) {
    const friendly = describeError(error);
    state.lastError = friendly;
    log("apply failed:", error?.stack ?? error);
    if (announce) await toast(`壁纸应用失败：${friendly}`);
    return { ok: false, error: friendly };
  }
}

/** 设置变化时：主题内容跟着更新；只有当壁纸本来就在用，才保持激活。 */
async function syncThemeToSettings() {
  await refreshSettings();
  const wasActive = isOurThemeActive();
  const config = resolveConfig();
  if (!config.paths.length) {
    await removeWallpaperTheme();
    return;
  }
  const result = await applyWallpaper({ announce: false, activate: wasActive });
  if (!result.ok) log("settings sync failed:", result.error);
}

/* ------------------------------------------------------------------ 自检 */

function apiPresence() {
  const missing = [];
  for (const path of CONTRACT.requireApis) {
    const [group, method] = path.split(".");
    if (typeof pi?.[group]?.[method] !== "function") missing.push(path);
  }
  return missing;
}

function versionAtLeast(actual, minimum) {
  const parse = (value) => String(value ?? "").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(actual);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

async function selfCheck(options = {}) {
  const { announce = true } = options;
  await refreshAppearance();
  await refreshSettings();
  state.hostVersion = await pi.app.getVersion().catch(() => "unknown");
  const missing = apiPresence();
  // 权限被拒时 pi.themes.* 会抛 "missing permission: ui.theme"，自检必须把它单独报出来。
  let registered = [];
  let themePermission = "可用";
  try {
    registered = await pi.themes.list();
  } catch (error) {
    themePermission = isPermissionDenied(error) ? "被拒绝（缺少 ui.theme）" : `读取失败：${describeError(error)}`;
  }
  const mine = registered.filter((theme) => theme.id === ourThemeId());
  const config = resolveConfig();
  const lines = [
    `宿主版本：${state.hostVersion}（插件核对基准 ${CONTRACT.verifiedAgainst}，要求 ≥ ${CONTRACT.minimumHost}）`,
    `版本是否满足下限：${versionAtLeast(state.hostVersion, CONTRACT.minimumHost) ? "是" : "否 —— 请更新插件或桌面端"}`,
    `运行时主题 API：${missing.length ? `缺少 ${missing.join(", ")}` : "齐备"}`,
    `当前激活的主题：${state.appearance?.theme ?? "未知"}${state.appearance?.pluginTheme ? `（插件主题：${state.appearance.pluginTheme}）` : ""}`,
    `主题权限 ui.theme：${themePermission}`,
    `壁纸图片：${config.paths.length ? `${config.index + 1}/${config.paths.length} · ${config.imagePath}` : "未设置"}`,
    `路径校验：${pathProblem(config.imagePath) ?? "通过"}`,
    `参数：模糊 ${config.blur}px · 压暗 ${config.dim}% · 提亮 ${config.lift}% · 两侧栏遮罩 ${config.glass}% · 适配 ${config.fit} · 压暗色 ${config.veil}`,
    `明暗基底：${currentBase()}（设置 ${baseMode()}；auto 只跟随用户真正选的内置亮/暗，其余按暗色处理）`,
    `主题 CSS 体积：${themeCssProblem(buildThemeCss({ ...config, themeId: ourThemeId() })) ?? "在宿主上限内"}`,
    state.lastError ? `最近一次错误：${state.lastError}` : "最近一次错误：无",
  ];
  for (const line of lines) log(line);
  const ok =
    missing.length === 0 &&
    versionAtLeast(state.hostVersion, CONTRACT.minimumHost) &&
    !themePermission.startsWith("被拒绝") &&
    !themePermission.startsWith("读取失败");
  await toastResult(ok, mine.length, missing, announce);
  return { ok, lines };
}

/** 自检结论：命令要弹 toast，面板只要文字，用这个分开处理。 */
async function toastResult(ok, themeCount, missing, announce) {
  if (!announce) return;
  await toast(
    ok
      ? `自检通过：宿主 ${state.hostVersion}，主题 API 齐备${themeCount ? "" : "（尚未配置图片）"}。详情见插件日志。`
      : `自检发现问题：${missing.length ? `缺少 ${missing.join(", ")}` : `宿主版本 ${state.hostVersion} 低于要求的 ${CONTRACT.minimumHost}`}。详情见插件日志。`
  );
}


/* ------------------------------------------------------------------ 面板（renderer/index.html） */

/**
 * 面板通道的回调：宿主在收到面板的 pluginBridge.invoke(非白名单通道) 时调用它。
 *
 * 只有四个通道：读状态、保存（图片/参数）、移除、自检。
 * 所有校验/写设置/注册主题都走 main.js 里已经自测过的那套函数，
 * 面板本身只是视图（它拿到的是一个绝对路径，不做任何文件读写）。
 */
async function onPanelInvoke(channel, payload) {
  switch (String(channel ?? "")) {
    case "wallpaper.state":
      return statePayload();
    case "wallpaper.save":
      return enqueue(() => panelSave(payload));
    case "wallpaper.clear":
      return enqueue(() => panelClear());
    case "wallpaper.check":
      return enqueue(() => panelCheck());
    case "wallpaper.reset": {
      const problem = await enqueue(() => applyRecommendedAppearance());
      return statePayload(problem ? { error: problem } : { check: ["已恢复正常外观。"], checkOk: true });
    }
    default:
      throw new Error(`unsupported panel channel: ${channel}`);
  }
}

/** 串行执行：面板操作和 plugin:settingsChanged 回调不会交错。 */
let queue = Promise.resolve();
function enqueue(task) {
  const next = queue.catch(() => {}).then(task);
  queue = next.catch(() => {});
  return next;
}

/** 面板要显示的全部状态。 */
async function statePayload(extra = {}) {
  await refreshAppearance();
  const config = resolveConfig();
  let registered = false;
  try {
    registered = (await pi.themes.list()).some((theme) => theme.id === ourThemeId());
  } catch {
    registered = false;
  }
  return {
    hostVersion: state.hostVersion,
    imagePath: config.imagePath,
    pathCount: config.paths.length,
    index: config.index,
    blur: config.blur,
    dim: config.dim,
    glass: config.glass,
    lift: config.lift,
    veil: config.veil,
    fit: config.fit,
    themeId: ourThemeId(),
    registered,
    active: isOurThemeActive(),
    activeTheme: state.appearance?.theme ?? null,
    base: currentBase(),
    baseMode: baseMode(),
    lastError: state.lastError,
    // 面板缩略图走宿主的资源 scheme：主题注册后这张图已登记进本插件的资源表。
    previewUrl: config.imagePath
      ? `plugin-asset://${pi.plugin.getId()}/${encodeURIComponent(config.imagePath)}`
      : null,
    limits: {
      extensions: CONTRACT.imageExtensions,
      maxBytes: CONTRACT.assetMaxBytes,
      blurRange: [0, 40],
      dimRange: [0, 70],
      glassRange: [0, 100],
      liftRange: [0, 60],
    },
    ...extra,
  };
}

/** 面板送来的补丁：只接受认识的键，数值一律夹到合法范围。 */
function normalizePanelPatch(payload) {
  const patch = {};
  if (!payload || typeof payload !== "object") return patch;
  if (typeof payload.imagePath === "string") patch.imagePath = payload.imagePath;
  if (payload.blur !== undefined) patch.blur = clampNumber(payload.blur, 0, 40, 16);
  if (payload.dim !== undefined) patch.dim = clampNumber(payload.dim, 0, 70, 20);
  if (payload.glass !== undefined) patch.glass = clampNumber(payload.glass, 0, 100, CONTRACT.defaultGlass);
  if (payload.lift !== undefined) patch.lift = clampNumber(payload.lift, 0, 60, CONTRACT.defaultLift);
  if (typeof payload.base === "string" && CONTRACT.baseModes.includes(payload.base)) patch.base = payload.base;
  if (payload.index !== undefined) {
    const index = Number(payload.index);
    if (Number.isFinite(index)) patch.index = Math.trunc(index);
  }
  if (typeof payload.veil === "string" && VEILS.includes(payload.veil)) patch.veil = payload.veil;
  if (typeof payload.fit === "string" && FITS.includes(payload.fit)) patch.fit = payload.fit;
  return patch;
}

/** 面板：拖图/调参 → 写设置 → 立即注册并激活。 */
async function panelSave(payload) {
  const patch = normalizePanelPatch(payload);
  if (Object.keys(patch).length) {
    try {
      await pi.plugin.setSettings(patch);
    } catch (error) {
      state.lastError = `保存设置失败：${describeError(error)}`;
      log("panel setSettings failed:", error?.message ?? error);
    }
    await refreshSettings();
  }
  const result = await applyWallpaper({ announce: false, activate: true });
  return statePayload(result.ok ? {} : { error: result.error });
}

/** 面板：移除壁纸。 */
async function panelClear() {
  await refreshAppearance();
  if (isOurThemeActive()) await pi.app.setTheme(currentBase()).catch(() => {});
  await removeWallpaperTheme().catch(() => {});
  try {
    await pi.plugin.setSettings({ imagePath: "", index: 0 });
  } catch (error) {
    log("panel reset settings failed:", error?.message ?? error);
  }
  await refreshSettings();
  state.lastError = null;
  return statePayload();
}


/** 面板：把自检结果直接显示在面板里（不再依赖日志）。 */
async function panelCheck() {
  const report = await selfCheck({ announce: false });
  return statePayload({ check: report.lines, checkOk: report.ok });
}

/**
 * 「恢复正常外观」：一键把参数写回推荐值并立刻重新应用。
 * 之所以需要它：用户自己（或我给出的建议）把压暗/提亮调过头之后，界面会白成一片、字看不清，
 * 这条命令/按钮是确定能回到"看得清"状态的退路。命令与面板按钮共用这一个实现。
 */
const RECOMMENDED_APPEARANCE = { dim: 20, lift: 0, glass: 22, veil: "ink", fit: "cover", base: "auto" };

async function applyRecommendedAppearance() {
  try {
    await pi.plugin.setSettings(RECOMMENDED_APPEARANCE);
  } catch (error) {
    log("reset appearance failed:", error?.message ?? error);
    return `写入推荐参数失败：${describeError(error)}`;
  }
  await refreshSettings();
  const result = await applyWallpaper({ announce: false, activate: true });
  return result.ok ? null : result.error;
}
/* ------------------------------------------------------------------ 指令 */

async function registerCommands() {
  await pi.commands.register({
    id: COMMANDS.openPanel,
    title: "壁纸：打开面板（拖图即用）",
    keywords: ["壁纸", "wallpaper", "面板", "panel", "背景", "模糊"],
    run: async () => {
      await pi.ui.openPanel({ title: "壁纸 · 背景虚化" });
    },
  });

  await pi.commands.register({
    id: COMMANDS.apply,
    title: "壁纸：应用本地图片（按设置的路径）",
    keywords: ["壁纸", "wallpaper", "背景", "模糊", "blur"],

    run: async () => {
      await applyWallpaper({ announce: true, activate: true });
    },
  });

  await pi.commands.register({
    id: COMMANDS.next,
    title: "壁纸：下一张（多张图片轮换）",
    keywords: ["壁纸", "wallpaper", "下一张", "轮换"],
    run: async () => {
      await refreshSettings();
      const config = resolveConfig();
      if (config.paths.length < 2) {
        await toast("只配置了一张图片，先在设置里一行一张填多张，再用这个命令轮换。");
        return;
      }
      const next = (config.index + 1) % config.paths.length;
      // 写回设置；紧接着 applyWallpaper 会重新读一次设置，所以用的是新下标。
      await pi.plugin.setSettings({ index: next });
      await applyWallpaper({ announce: true, activate: true });
    },
  });

  await pi.commands.register({
    id: COMMANDS.clear,
    title: "壁纸：移除壁纸（恢复桌面端默认底色）",
    keywords: ["壁纸", "wallpaper", "清除", "恢复"],
    run: async () => {
      await refreshAppearance();
      const wasActive = isOurThemeActive();
      if (wasActive) await pi.app.setTheme(currentBase());
      await removeWallpaperTheme();
      try {
        await pi.plugin.setSettings({ imagePath: "", index: 0 });
      } catch (error) {
        log("reset settings failed:", error?.message ?? error);
      }
      await refreshAppearance();
      await toast(wasActive ? "壁纸已移除，主题回到桌面端默认。" : "壁纸主题已移除。");
    },
  });

  await pi.commands.register({
    id: COMMANDS.reset,
    title: "壁纸：恢复正常外观（回退到推荐参数）",
    keywords: ["壁纸", "wallpaper", "重置", "回退", "默认", "恢复", "看不清"],
    run: async () => {
      const problem = await applyRecommendedAppearance();
      await toast(
        problem
          ? `恢复参数失败：${problem}`
          : "已恢复正常外观：压暗 20%、提亮 0%、两侧栏遮罩 22%、基底 auto。",
      );
    },
  });

  await pi.commands.register({
    id: COMMANDS.selfCheck,
    title: "壁纸：兼容性自检（桌面端升级后先跑这个）",
    keywords: ["壁纸", "wallpaper", "自检", "兼容", "版本"],
    run: async () => {
      await selfCheck();
    },
  });
}

async function unregisterCommands() {
  for (const id of Object.values(COMMANDS)) {
    try {
      await pi.commands.unregister(id);
    } catch {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ 生命周期 */

async function onLoad() {
  state.hostVersion = await pi.app.getVersion().catch(() => "unknown");
  await refreshAppearance();
  state.settings = await pi.plugin.getSettings().catch(() => ({}));

  const missing = apiPresence();
  if (missing.length) {
    log(`缺少宿主 API：${missing.join(", ")}（桌面端可能升级改动了接口，请跑兼容性自检）`);
  }
  if (!versionAtLeast(state.hostVersion, CONTRACT.minimumHost)) {
    log(`宿主版本 ${state.hostVersion} 低于核对基准 ${CONTRACT.minimumHost}`);
  }

  await registerCommands();

  // 事件：设置改了要跟着重建主题；外观（亮/暗、语言）变了要让 base 跟上。
  pi.events?.on?.("plugin:settingsChanged", (next) => {
    state.settings = next ?? state.settings;
    void enqueue(() => syncThemeToSettings());
  });
  pi.events?.on?.("appearance:changed", (appearance) => {
    state.appearance = appearance ?? state.appearance;
    const config = resolveConfig();
    if (!config.paths.length) return;
    void applyWallpaper({ announce: false, activate: isOurThemeActive() });
  });

  // 运行时主题是内存态：每次启动重建一次；如果上次就是在用壁纸，重新激活。
  const config = resolveConfig();
  if (config.paths.length) {
    const wasActive = isOurThemeActive();
    const result = await applyWallpaper({ announce: false, activate: wasActive });
    log(result.ok ? `启动时已重建壁纸主题（重新激活：${wasActive ? "是" : "否"}）` : `启动重建失败：${result.error}`);
  } else {
    log("启动完成：尚未配置壁纸图片");
  }
}

async function onUnload() {
  await unregisterCommands();
  // 只清掉运行时主题，故意**不动**用户选的主题。
  // 宿主对插件主题的"选择"是持久化偏好（appearance.theme = plugin:<插件id>:<主题id>），
  // 在这里改回 dark 的话，插件每次重载（开发热重载、桌面端升级、扩展页开关插件）都会把壁纸弄丢，
  // 而且下次启动也恢复不回来（判断"上次在用壁纸"看的正是这个偏好）。
  await removeWallpaperTheme().catch(() => {});
  log("已卸载：运行时主题已清理（用户选的主题保持不动）");
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  __internals: { buildThemeCss, resolveConfig, parseImagePaths, normalizePanelPatch, describeError, isPermissionDenied },
};
