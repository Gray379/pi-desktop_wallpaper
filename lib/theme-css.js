"use strict";
/**
 * 主题 CSS 生成器 —— 这套方案的全部视觉效果都在这里。
 *
 * 设计要点（为什么这么做）：
 *   1. 壁纸不依赖宿主自己的壁纸挂点（.app-scenic-backdrop），而是挂在根元素的
 *      ::before 上、用 z-index:-1 沉到所有内容之下。宿主若改了内部 DOM 结构，
 *      只要 html/body/#root 还是那块画布，壁纸就仍然工作。
 *   2. 虚化只作用于壁纸本身（filter: blur），界面文字保持清晰；
 *      面板改成半透明后，透过面板看到的是已虚化的壁纸，等效毛玻璃。
 *   3. 只覆盖「不透明底色」这一个属性（background-color / background），并且优先沿用
 *      宿主自己的 CSS 变量；色值全部走 var(--ds-*)，所以宿主换配色时自动跟随。
 *   4. 半透明走 @supports (color-mix(...))，老引擎自动退回不透明底色，
 *      不会出现「面板全透明、文字糊在图上」的最坏情况。
 *   5. 所有规则都挂在宿主的主题钩子上：宿主选中插件主题时会做
 *          <style> 追加到 head 末尾 + document.documentElement.dataset.pluginTheme = <主题id>
 *      两件事（0.15.10 的渲染层实现）。加上 `:root[data-plugin-theme="…"]` 前缀有三个好处：
 *        - 特异性比宿主自己的 `.sidebar-surface { … }` 高，不依赖样式表先后顺序
 *          （宿主以后把某页样式改成分块懒加载也不会把我方规则盖掉）；
 *        - 壁纸层只在这套主题真的被选中时生效，不会在其它主题下漏出来；
 *        - 主题被取消时宿主会移除 <style> 元素，规则自然全部消失。
 *      代价是依赖 data-plugin-theme 这个钩子 —— 它由 scripts/compat-check.mjs 硬核对。
 *
 * 上一条不变的底线：两侧栏不要死黑。宿主的深色配色里 --ds-bg-under:#000 是左侧栏
 * 底色，我方的遮罩刻意用 --ds-bg-primary（中间栏底色），并且强度可调（设置 glass）：
 * 0 = 和中间栏一样完全透出壁纸，越大越实。
 */

const { CONTRACT, FITS, VEILS, SURFACES, themeIdFor } = require("./host-contract.js");

/** CSS 字符串字面量（路径里的反斜杠与引号要转义）。 */
function cssString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 把数字夹到闭区间。 */
function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

/**
 * 主题钩子选择器：`:root[data-plugin-theme="plugin:<插件id>:<主题id>"]`。
 * @param {string} [themeId] 宿主的命名空间主题 id
 */
function themeScope(themeId) {
  return `:root[${CONTRACT.themeHookAttribute}="${String(themeId || themeIdFor(CONTRACT.localThemeId))}"]`;
}

/**
 * 壁纸层的 background-image 值。
 * lift > 0 时在最上面叠一层半透明白 —— 它是"加法"（白色按比例混合），
 * 所以对偏暗的角落/暗图效果最明显；0 时就是纯图片，不做任何额外处理。
 */
function liftBackgroundImage(imagePath, lift) {
  const image = `url(${cssString(imagePath)})`;
  if (!(lift > 0)) return image;
  const white = `rgba(255, 255, 255, ${(lift / 100).toFixed(2)})`;
  return `linear-gradient(${white}, ${white}), ${image}`;
}

/**
 * 生成运行时主题 CSS。
 * @param {{ imagePath: string, blur?: number, dim?: number, glass?: number, lift?: number, veil?: string, fit?: string, themeId?: string }} config
 * @returns {string}
 */
function buildThemeCss(config) {
  const imagePath = String(config?.imagePath ?? "");
  const blur = clamp(config?.blur, 0, 40, 16);
  const dim = clamp(config?.dim, 0, 70, 20);
  // 两侧栏遮罩强度：0 = 和中间栏一样完全透出壁纸；越大越实。
  const glass = clamp(config?.glass, 0, 100, CONTRACT.defaultGlass);
  // 壁纸提亮：给整张图叠一层白，对暗部是"加法"（比压低压暗更能救回偏黑的角落）。
  const lift = clamp(config?.lift, 0, 60, CONTRACT.defaultLift);
  const fitKey = Object.prototype.hasOwnProperty.call(FITS, config?.fit) ? config.fit : "cover";
  const fit = FITS[fitKey];
  const veilRgb = config?.veil === "none" ? null : VEILS[config?.veil] ?? VEILS.ink;
  // 模糊会让边缘出现透明衰减，按模糊强度放大一点点把边缘推到画布外。
  const zoom = blur > 0 ? Math.min(1 + blur / 200, 1.15) : 1;
  const scope = themeScope(config?.themeId);

  const lines = [
    "/* local.pi-wallpaper · 本地图片壁纸（插件生成，勿手改） */",
    `/* 作用域：只有 ${scope} 命中时（= 这套主题被选中）下面的规则才生效 */`,
    "",
    "/* 壁纸层：固定在视口，z-index:-1 让它落在所有内容之下 */",
    `${scope}::before {`,
    '  content: "";',
    "  position: fixed;",
    "  inset: 0;",
    "  z-index: -1;",
    "  pointer-events: none;",
    `  background-image: ${liftBackgroundImage(imagePath, lift)};`,
    "  background-position: center;",
    `  background-size: ${fit.size};`,
    `  background-repeat: ${fit.repeat};`,
  ];
  if (blur > 0) {
    lines.push(`  filter: blur(${blur}px);`);
    lines.push(`  transform: scale(${zoom.toFixed(3)});`);
  }
  lines.push("}");

  if (veilRgb && dim > 0) {
    lines.push(
      "",
      "/* 压暗层：保证白字在亮图上也能读 */",
      `${scope}::after {`,
      '  content: "";',
      "  position: fixed;",
      "  inset: 0;",
      "  z-index: -1;",
      "  pointer-events: none;",
      `  background-color: rgba(${veilRgb}, ${(dim / 100).toFixed(2)});`,
      "}"
    );
  }

  lines.push(
    "",
    `/* 让宿主的不透明底色给壁纸让位（只动 background-color）；两侧栏遮罩强度 = ${glass}% */`
  );
  for (const surface of SURFACES) {
    // html 自己就是 :root，不能再写成后代选择器，直接用 scope 本身。
    const selector = surface.selectors.map((sel) => (sel === "html" ? scope : `${scope} ${sel}`)).join(", ");
    const bang = surface.important ? " !important" : "";
    if (surface.mode === "clear") {
      lines.push(`${selector} { background-color: transparent${bang}; }`);
      continue;
    }
    const tint = surface.tint ?? surface.token;
    const alpha = clamp(glass + (surface.offset ?? 0), 0, 100);
    // 不支持 color-mix 的引擎退回实色（宁可实一点，也不要透到看不清）
    lines.push(`/* ${surface.note}：遮罩 ${alpha}% */`);
    lines.push(`${selector} { background-color: var(${tint})${bang}; }`);
    lines.push("@supports (background-color: color-mix(in oklab, red, transparent)) {");
    lines.push(`  ${selector} { background-color: color-mix(in oklab, var(${tint}) ${alpha}%, transparent)${bang}; }`);
    lines.push("}");
  }

  return lines.join("\n") + "\n";
}

/**
 * 生成前先按宿主自己的规则自检，避免把注定被拒的 CSS 发过去。
 * 返回错误说明；通过则返回 null。
 */
function themeCssProblem(css) {
  const bytes =
    typeof Buffer !== "undefined"
      ? Buffer.byteLength(css, "utf8")
      : new TextEncoder().encode(css).length;
  if (bytes > CONTRACT.cssMaxBytes) {
    return `生成的 CSS 有 ${bytes} 字节，超过宿主上限 ${CONTRACT.cssMaxBytes} 字节。`;
  }
  const lowered = String(css).toLowerCase();
  for (const token of CONTRACT.cssForbidden) {
    if (lowered.includes(token.toLowerCase())) return `生成的 CSS 含宿主禁止的写法：${token}`;
  }
  return null;
}

module.exports = { buildThemeCss, themeCssProblem, themeScope };
