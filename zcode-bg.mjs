#!/usr/bin/env node
/**
 * zcode-bg.mjs —— 给 ZCode 桌面版（Electron）换自定义壁纸：静态图片或视频动态壁纸
 *
 * 原理：ZCode 是 Electron 应用。本脚本用 `--remote-debugging-port` 启动它，
 *       再通过 DevTools 协议（CDP）往渲染进程注入：
 *         1) 一段 CSS：html 画背景图（或一个 <video> 壁纸层）+ 让基础面板半透明；
 *         2) 一段界面脚本（ui-inject.js）：在 ZCode 侧栏挂一个「壁纸」入口和一页
 *            原生观感的设置界面，用来换图 / 换视频、调透明度/压暗/模糊/铺排方式。
 *       视频没法像图片那样内嵌，由本脚本内置的本地媒体服务（只监听 127.0.0.1，
 *       支持 Range 拖进度）给页面供流；视频静音循环，切到后台自动暂停省电。
 *       全程不修改 ZCode 的任何安装文件（不改 app.asar），
 *       关掉脚本注入、重启 ZCode 即完全恢复原样。
 *
 * 用法：
 *   node zcode-bg.mjs                     启动 ZCode 并注入背景 + 设置界面（默认）
 *   node zcode-bg.mjs --attach            只注入（ZCode 已带调试端口在跑）
 *   node zcode-bg.mjs --check             检查当前是否已生效后退出
 *   node zcode-bg.mjs --off               移除注入（含设置界面）、结束后台注入器，恢复默认外观
 *   node zcode-bg.mjs --no-ui             只要背景，不要设置界面
 *   node zcode-bg.mjs --dump-css          只打印将要注入的 CSS，不连接 ZCode
 *   node zcode-bg.mjs --screenshot a.png  注入后截一张图（用于确认效果）
 *   node zcode-bg.mjs --port 9333 ...     指定调试端口
 *
 * 依赖：Node.js >= 22（用到全局 fetch / WebSocket），零第三方依赖。
 *
 * 注意：ZCode 有单实例锁，必须“完全退出 ZCode”之后再运行本脚本，
 *       否则带调试端口的新实例会直接退出、端口不会打开。
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, "config.json");
const LOCK_PATH = path.join(SCRIPT_DIR, ".injector.lock");
const STYLE_ID = "__zcode_custom_bg_style__";

/* 设置界面（注入到 ZCode 页面里的浮层）用到的固定名字，ui-inject.js 里必须完全一致 */
const UI_STYLE_ID = "__zcode_bg_ui_style__";
const LAYER_ID = "__zcode_bg_layer";
const BINDING = "__zcodeBgHost";
const UI_SCRIPT_PATH = path.join(SCRIPT_DIR, "ui-inject.js");
const UI_VERSION = 35; // v35：面板支持把图片/视频文件直接拖进来换壁纸（和「选择图片/视频」同一条上传通道、同一套大小上限，ui-inject.js 的 usePickedFile 统一入口）；「壁纸」定位轮询降频——面板开着 0.5s 一轮、关着 2s 一轮，滚动（capture 捕获）和布局变化（MutationObserver）停稳后即时重贴，不再纯靠轮询保响应；v34：画质三件套——① 视频/素材条目带真实码率（bps），低码率假 4K 角标提示（mp4 头 mvhd 时长 ÷ 文件大小，WebM 拿不到就不标）；② 素材静帧抽取按「面积 × 编码质量」挑（PNG/JPG/裸 RGBA 无损 > DXT5 > DXT1，面积接近时宁要无损），DXT 抽出的静帧标「有损纹理」；③ 新增「画面增强（锐化）」滑块（config.sharpen 0~1，默认 0=原画质直出）：视频/网页层直接套 SVG 卷积锐化滤镜（feConvolveMatrix，先建滤镜节点再挂 filter——引用不存在的滤镜 id 会让整层消失），图片壁纸切到 <img> 层（CSS 背景没法单独套 filter；平铺保持 CSS 老路径）；UI_VERSION 升级强制 UI 重建一次；v33：面板标题行「✕ 关闭」键放大一档（zcbg-btn-lg：42px 高 / 15px 字 / 12px 圆角），与 text-2xl/3xl 大标题视觉配平；v32：修「网页壁纸改版后旧 UI 闭包用旧实现覆盖新状态」——UI 的 paintBg 改调主进程每次注入刷新的 window.__zcodeBgApplyWeb 蹦床（旧闭包也调到最新 applyWebState），UI_VERSION 升级强制 UI 重建一次；v31：网页壁纸铺满（cover）+ 超采样——壁纸自带排版是 contain+10% 边距，屏比不合时相机视野滑出背景画面（实测左侧露出 34 世界单位底色带）；srcdoc 里给 spineCamera 包钳制（zoom 不超过「内容刚好铺满画布」、相机位置保证视野窗口完全落在内容包围盒内），任何屏比都铺满；canvas 缓冲再乘 1.5 超采样（约 3842×2093，4K 级渲染下采样）；v30：网页壁纸高清化——壁纸页 canvas 按 CSS 像素建缓冲，缩放屏（本机 150%）上被拉伸发糊；applyWebState 改写壁纸 HTML 里所有「画布=客户区」的赋值与比较为按 devicePixelRatio 物理像素渲染（1719×936 → 2561×1395，2.25 倍像素量）；v29：修网页壁纸「点了没反应」——跨源 http iframe 在 ZCod网页壁纸高清化——壁纸页 canvas 按 CSS 像素建缓冲，缩放屏（本机 150%）上被拉伸发糊；applyWebState 改写壁纸 HTML 里所有「画布=客户区」的赋值与比较为按 devicePixelRatio 物理像素渲染（1719×936 → 2561×1395，2.25 倍像素量）；v29：修网页壁纸「点了没反应」——跨源 http iframe 在 ZCode 里是独立进程（OOPIF），内容渲染正常但合成不到屏幕；applyWebState 改为拉取壁纸 HTML 文本→注入 <base href> 指回媒体服务→贴图补 crossOrigin→以同源 srcdoc 上层（同进程渲染可见），拉取失败退回直连 src；v28：网页壁纸——工坊 web 型（spine/HTML）项目直接以本体上墙：新增媒体路由 /we-web/<ID>/<相对路径>（按 MIME 供流项目目录，路径越界拒绝），条目 kind「网页」rel = we-web://<项目ID>；页面新增 <iframe> 层（applyWebState，幂等不重载），mediaType 新增 "web"（平铺/预览缩略图等按需隐藏，当前壁纸名显示「（网页）」）；小憩时光这类 spine 网页壁纸从此以 4K 图集原生渲染上墙，不再用 192×192 封面当静帧；v27：壁纸库/创意工坊标题行的按键左对齐——「随机换一张/打开文件夹」「从工坊导入/打开文件夹」不再被 space-between 散到宽面板两端，改紧跟标题（.zcbg-row-left + .zcbg-btns）；v26：静帧显示与分辨率——壁纸库条目 /list 带 w/h（cachedMediaDims 缓存），壁纸库卡片加「图片/视频 + 分辨率」角标（和创意工坊同款）；工坊「静帧」卡片缩略图改用静帧本体（高清原图）而不是低清方形封面；v25：修宽屏排版——卡片网格容器一直带 .zcbg-hint 的 max-width:44em 导致面板右侧大片留白，装网格的容器解除限宽、网格铺满面板全宽，卡片最小 150px + 悬浮封面微放大；v24：工坊区块改「仅列出已导入」——Steam 新下载的壁纸不再自动出现（一次性迁移：启动时把当时已列出的项目种进 wePinned，标记 wePinnedSeeded 只跑一次），想装随时走「从工坊导入」选择列表（仍扫全量目录）；weLibraryEntries 只扫 wePinned 里的项目（ID 做合法性校验）；v23：「随时间变化的壁纸」合成——同一工坊项目里能按文件名/分段名认出 ≥2 个时段（清晨/白天/黄昏/夜晚）的视频合并成一个条目（kind「随时间」，rel = we-time://<项目ID>），新增媒体路由 /we-time/<ID>?b=<时段> 按时段供流；注入页 applyVideoState 带 timeUrl/timeBounds 时起 20s 定时器，按系统时间换 <video> 源，壁纸真的随时间变；时段边界 config.json weTimeBounds 可调（默认 5/9/16/19 点）；weDelete 对合并条目清全部分段缓存；v22：「从工坊导入」重做——不弹原生对话框（初始目录不可控），改面板内选择列表：/list 新增 weAll（weProjectCatalog 扫全部工坊项目，含隐藏/低清），点卡片 op:"wePin" → 加 wePinned（低清强制列出，条目 forced 标记）+ 从 weHidden 摘除 → 回传条目面板应用；weDelete 同步摘 wePinned；v21：op:"wePick" 曾是弹文件对话框反查项目装进工坊区块（weProjectDirFromSelection 已删）；v20：op:"wePick" 曾是复制文件进 wallpaper\（已废弃 installWallpaperFile）；v19：工坊区块加「打开文件夹」——op:"weOpenFolder" 打开 Steam 创意工坊目录（WE 新下载壁纸的落点），找不到工坊库时给指引；v18：创意工坊条目加删除点——清理 .we-pkg-cache 抽取产物并把项目记进 config.json 的 weHidden（防止重新抽取），Steam 工坊本体不动；op:"weDelete"；v17：创意工坊条目显示分辨率标签（4K/2K/1080p/W×H），低清封面静帧不再列出、改在区块底部提示数量；v16：新增「Wallpaper Engine 创意工坊」区块——自动发现 Steam 工坊库（可用 config.json 的 weDir 手动指定），视频型直接换用、场景型抽视频素材或用预览图当静帧；v15：易用性巡检——面板加关闭按钮、预设激活态+撤销、扫描「全部恢复」、壁纸库溢出提示、文案去术语、「打开文件夹」op；v14：点扫描结果的选择器名，页面上对应区域描边高亮（收起面板自动撤掉）；v13：修调色闪烁
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const SAMPLE_WALLPAPER = "wallpaper\\sample-gradient.png";

/* 视频动态壁纸：按扩展名识别（解码器 Chromium 不支持的就放不了，见 README） */
const VIDEO_MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".ogv": "video/ogg",
};
const VIDEO_EXTS = new Set(Object.keys(VIDEO_MIME));
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 上传 / 使用的上限：1 GB

/* 本地媒体服务：视频没法内嵌成 data:URL，由注入器在本机起 HTTP 服务给页面供流。
   /w/<token> 按令牌供流（令牌 = sha1(绝对路径) 前 16 位，重启不变），
   /list 列出 wallpaper\ 目录（设置界面的「壁纸库」用），/upload 接收界面上传的文件。 */
const media = { server: null, port: 0, tokens: new Map(), weDir: null };

const DEFAULTS = {
  // ZCode 可执行文件路径。留空 = 自动探测（常见安装位置，见 findZcodeExe）；
  // 自动探测不到时才需要在 config.json 里手动指定。
  zcodeExe: "",
  debugPort: 9222,
  wallpaper: "wallpaper\\sample-gradient.png",
  embedAsDataUrl: true,
  enabled: true,
  showSettingsUI: true,
  panelAlpha: 0.62,
  dim: 0.25,
  dimColor: "#000000",
  imageBlurPx: 0,
  // 画面增强（锐化）0~1：给壁纸层（视频/图片/网页）套一层卷积锐化滤镜。
  // 源是 1080p/1440p 拉到 2K 屏、或 4K 下采样偏软时，观感会明显更「锐」。
  // 0 = 关（原画质直出，默认）；这是显示端的主观增强，不改文件本身。
  sharpen: 0,
  fit: "cover",
  align: "center",
  videoMuted: true,
  videoSpeed: 1,
  videoPauseWhenHidden: true,
  mediaPort: 18765,
  waitSeconds: 90,
  // 从面板删掉的 Wallpaper Engine 工坊项目目录名（纯数字 ID）。删缓存文件解决不了
  // 「下次扫描重新抽取」，所以同时记在这里，扫描时整项目跳过；Wallpaper Engine 本体不受影响。
  weHidden: [],
  // 「从工坊导入」点过名的工坊项目目录名：v24 起「创意工坊」区块**只列这里的项目**——
  // Steam 新下载的壁纸不再自动出现，想装随时走面板「从工坊导入」（选择列表扫全量目录，
  // 不受此限）。✕ 删除会同时从这里摘掉。
  wePinned: [],
  // 一次性迁移标记：v24 从「自动列出全部」切到「只列导入过的」时，把当时已列出的项目
  // 种进 wePinned，用户已装的壁纸不因升级消失。只跑一次。
  wePinnedSeeded: false,
  // 随时间变化的分段壁纸（we-time://）的时段边界（小时，含头不含尾，夜晚跨零点）。
  // 默认和「夜莺Night」系列作者的设定一致：5-9 清晨 / 9-16 白天 / 16-19 黄昏 / 19-5 夜晚。
  weTimeBounds: { morning: 5, day: 9, evening: 16, night: 19 },
  translucentClasses: [
    "bg-background",
    "bg-background-alt",
    "bg-background-win-alt",
    "bg-header",
    "bg-panel",
    "bg-sidebar",
  ],
  // 兜底自愈：上面这些类名一个都没命中时（ZCode 升级换了类名），运行时自动把
  // 大面积实心内容表面半透明化，保证壁纸不会整块被盖住。设 false 可关掉。
  autoTranslucent: true,
  extraCss: "",
  // 精细透明化/调色（吸收自 Zcode-Wallpaper 的 background_overrides，但不用手写 CSS：
  // 面板「🔍 扫描」直接生成）：每项要么是选择器字符串（强制 background:transparent），
  // 要么是 {selector, background}（该区域背景改成任意颜色/半透明色，面板调色器生成）。
  overrides: [],
};

/* ------------------------------- 基础工具 ------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}]`, ...a);
const warn = (...a) => console.warn(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}]`, ...a);

/** 人类可读的文件大小：小于 1 KB 就按字节显示，免得出现“0 KB” */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 进程是否还活着（Windows 上也可能抛 EPERM，那也算活着） */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

/** 正在运行的注入器 PID；没有（或只剩过期的锁文件）就返回 0，顺手清掉过期锁 */
function liveInjectorPid() {
  let pid = 0;
  try {
    pid = parseInt(fs.readFileSync(LOCK_PATH, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
  if (pid === process.pid) return 0;
  if (pidAlive(pid)) return pid;
  try {
    fs.rmSync(LOCK_PATH, { force: true });
  } catch {
    /* 清不掉也无所谓，下次照样按死锁处理 */
  }
  return 0;
}

function writeLock() {
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), "utf8");
  } catch (e) {
    warn(`写锁文件失败（不影响使用）: ${e.message}`);
  }
}

function releaseLock() {
  try {
    // 只在锁确实属于自己时才删，免得把后来者的锁误删
    const pid = parseInt(fs.readFileSync(LOCK_PATH, "utf8").trim(), 10) || 0;
    if (pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 结束正在运行的后台注入器（--off 专用）。
 * 不这么做的话会留一个坑：后台注入器还在跑，但页面上的样式已经被 --off 撤掉了，
 * 而注入器只对“新附上的窗口”注入，于是再点桌面快捷方式（--locked 发现已有注入器 → 什么都不做）
 * 也回不来，只能重启 ZCode。所以 --off 顺手把它收掉，下次点快捷方式就是干净的一次注入。
 */
async function stopLiveInjector() {
  const pid = liveInjectorPid();
  if (!pid) return 0;
  try {
    process.kill(pid);
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 25 && pidAlive(pid); i++) await sleep(100);
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 10 && pidAlive(pid); i++) await sleep(100);
  }
  try {
    fs.rmSync(LOCK_PATH, { force: true });
  } catch {
    /* ignore */
  }
  return pid;
}

function parseArgs(argv) {
  const out = { attach: false, check: false, off: false, dumpCss: false, help: false, screenshot: null, once: false, diagnose: false, noUi: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--attach") out.attach = true;
    else if (a === "--selftest") out.selftest = true;
    else if (a === "--check") { out.check = true; out.once = true; }
    else if (a === "--off") { out.off = true; out.once = true; }
    else if (a === "--diagnose") { out.diagnose = true; out.once = true; }
    else if (a === "--probe") { out.probe = true; out.diagnose = true; out.once = true; }
    else if (a === "--dump-css") out.dumpCss = true;
    else if (a === "--dump-ui") out.dumpUi = true;
    else if (a === "--no-ui") out.noUi = true;
    else if (a === "--locked") out.locked = true;
    else if (a === "--once") out.once = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) out.port = Number(a.slice(7));
    else if (a === "--screenshot") { out.screenshot = argv[++i]; out.once = true; }
    else if (a.startsWith("--screenshot=")) { out.screenshot = a.slice(13); out.once = true; }
    else if (a === "--wait") out.waitSeconds = Number(argv[++i]);
    else if (a.startsWith("--wait=")) out.waitSeconds = Number(a.slice(7));
    else warn(`忽略未知参数: ${a}`);
  }
  return out;
}

function printHelp() {
  console.log(`zcode-bg —— 给 ZCode 换自定义图片背景（不改安装文件）

  node zcode-bg.mjs                     启动 ZCode 并在「设置 → 壁纸」里加一页设置界面
  node zcode-bg.mjs --attach            只注入（ZCode 已带调试端口在跑）
  node zcode-bg.mjs --check             检查是否已生效，打印样式状态后退出
  node zcode-bg.mjs --diagnose          体检：找出还在挡住壁纸的不透明层，并给出要加的类名
  node zcode-bg.mjs --probe             探测：同 --diagnose，再把挡壁纸的元素输出成可直接使用的 CSS 选择器
  node zcode-bg.mjs --off               移除注入（含设置界面）、结束后台注入器，恢复默认外观
  node zcode-bg.mjs --dump-css          只打印将注入的 CSS，不连接 ZCode
  node zcode-bg.mjs --dump-ui           只打印将注入的“壁纸”设置界面脚本（调试用）
  node zcode-bg.mjs --screenshot a.png  注入后截图（确认效果用）
  node zcode-bg.mjs --no-ui             只注入背景，不显示「壁纸」设置界面
  node zcode-bg.mjs --selftest          自检：验证 CSS 生成 / 媒体服务（不连 ZCode）
  node zcode-bg.mjs --locked            问一句“已经有注入器在跑吗”：有则退出码 0，没有则 1
  node zcode-bg.mjs --once ...          注入后立刻退出（不常驻；刷新页面会失效）
  --port <n>   调试端口（默认 9222）      --wait <秒>  等待端口/窗口的超时

  配置见同目录 config.json：背景图路径、面板透明度、压暗、模糊、是否显示设置界面、附加 CSS。
  设置界面的“壁纸”页由 ui-inject.js 提供，跑起来后改的任何值都会写回 config.json。`);
}

/* 自动探测 ZCode.exe：config 里没配或路径失效时，按常见安装位置找一遍（只找，不写回 config）。 */
function findZcodeExe() {
  const cands = [];
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  for (const root of [local, pf, pf86]) {
    if (!root) continue;
    cands.push(path.join(root, "Programs", "ZCode", "ZCode.exe"));
    cands.push(path.join(root, "ZCode", "ZCode.exe"));
  }
  // LOCALAPPDATA\Programs 下一级目录名以 ZCode 开头的都试一遍（大小写/带后缀的变体）
  try {
    const progs = path.join(local, "Programs");
    for (const e of fs.readdirSync(progs, { withFileTypes: true })) {
      if (e.isDirectory() && /^zcode/i.test(e.name)) cands.push(path.join(progs, e.name, "ZCode.exe"));
    }
  } catch {}
  return cands.find((p) => fs.existsSync(p)) || null;
}

function loadConfig() {
  const cfg = { ...DEFAULTS };
  if (fs.existsSync(CONFIG_PATH)) {
    let raw;
    try {
      raw = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
    } catch (e) {
      throw new Error(`读取 config.json 失败: ${e.message}`);
    }
    try {
      Object.assign(cfg, JSON.parse(raw));
    } catch (e) {
      throw new Error(`config.json 不是合法 JSON: ${e.message}\n路径: ${CONFIG_PATH}`);
    }
  } else {
    warn(`未找到 ${CONFIG_PATH}，使用内置默认配置。`);
  }
  return cfg;
}

/* ------------------------------- CSS 生成 ------------------------------- */

function hexToRgba(hex, alpha) {
  let h = String(hex || "#000000").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 6) h += "ff";
  const n = Number.parseInt(h.slice(0, 8), 16) || 0;
  const r = (n >>> 24) & 255;
  const g = (n >>> 16) & 255;
  const b = (n >>> 8) & 255;
  const a = (n & 255) / 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a * alpha)).toFixed(3)})`;
}

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  /* 网页壁纸（/we-web/ 供流工坊项目目录）用到的类型 */
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".atlas": "text/plain; charset=utf-8",
  ".skel": "application/octet-stream",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveWallpaper(cfg) {
  if (!cfg.wallpaper) throw new Error(`config.json 里的 "wallpaper" 为空，请填入图片路径。`);
  // 随时间变化的时间壁纸：we-time://<工坊项目ID> 按当前系统时间解析成对应分段的视频文件
  if (/^we-time:\/\//i.test(String(cfg.wallpaper))) return weTimeResolve(cfg).file;
  const file = path.isAbsolute(cfg.wallpaper) ? cfg.wallpaper : path.join(SCRIPT_DIR, cfg.wallpaper);
  if (!fs.existsSync(file)) {
    throw new Error(`找不到背景图片: ${file}\n请修改 ${CONFIG_PATH} 里的 "wallpaper"（支持绝对路径或相对本脚本的路径）。`);
  }
  return file;
}

/** 把图片变成 CSS 能用的 URL：默认内嵌成 data:URL，避免 file:// 读取被 Electron 拦。 */
function wallpaperUrl(cfg, { placeholder = false } = {}) {
  const file = resolveWallpaper(cfg);
  if (!cfg.embedAsDataUrl) {
    return new URL("file:///" + file.replace(/\\/g, "/")).href;
  }
  if (placeholder) {
    const size = fs.statSync(file).size;
    return `data:${MIME[path.extname(file).toLowerCase()] || "image/png"};base64,<… 已内嵌 ${(size / 1024).toFixed(0)} KB 图片 …>`;
  }
  const mime = MIME[path.extname(file).toLowerCase()] || "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

/* ---------------------- Wallpaper Engine 创意工坊库 ------------------------ */

const WE_APP_ID = "431960"; // Steam 创意工坊里 Wallpaper Engine 的 app id
/* 预览图最短边小于这个值就只是封面缩略图（192~500px 的方图），放全屏必然糊——不列为壁纸 */
const WE_MIN_PREVIEW = 600;

/**
 * 自动发现 Wallpaper Engine 的创意工坊内容目录：
 *   <Steam库>/steamapps/workshop/content/431960/
 * 顺序：config.json 里的 "weDir"（手动指定，自动找不到时用）→ Steam 主目录 →
 * libraryfolders.vdf 里列出的每个库。必须存在 appmanifest_431960.acf（确认装了 WE）
 * 且工坊目录下至少有一个 project.json。找不到返回 null。
 */
function findWallpaperEngineDir(cfg) {
  const cand = [];
  const manual = String(cfg.weDir || "").trim();
  if (manual && path.isAbsolute(manual)) cand.push(manual);
  const steamRoot = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam");
  cand.push(steamRoot);
  try {
    const vdf = fs.readFileSync(path.join(steamRoot, "steamapps", "libraryfolders.vdf"), "utf8");
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) cand.push(m[1].replace(/\\\\/g, "\\"));
  } catch {}
  const out = [];
  for (const lib of cand) {
    const dir = path.join(lib, "steamapps", "workshop", "content", WE_APP_ID);
    const manifest = path.join(lib, "steamapps", `appmanifest_${WE_APP_ID}.acf`);
    let has = false;
    try {
      has = fs.existsSync(manifest) && fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory());
    } catch {}
    if (has && !out.some((p) => p.toLowerCase() === path.resolve(dir).toLowerCase())) {
      out.push(path.resolve(dir));
    }
  }
  return out[0] || null;
}

/**
 * 把一个工坊壁纸目录解析成可用条目。Wallpaper Engine 的 project.json 描述了
 * 标题（title）、类型（type: video/scene/web）、预览图（preview）。
 * 规则：
 *   - 项目里的视频文件（file 字段优先）全部列出，每段一条（时间分段壁纸每段都能单独选）；
 *   - 没有视频时才考虑预览图当静帧，且边长 ≥ WE_MIN_PREVIEW 才列出——工坊封面是
 *     192~1024 的方形缩略图，拉伸到全屏必然糊成一团，宁可不列也不能给用户糊图；
 *   - 被藏起来的低清封面数量记进 weLow，界面会明说「还有 N 个只有低清封面」。
 */

/** MP4/MOV 的 tkhd 宽高（16.16 定点），顺带 mvhd 时长 + stsd 编码（算真实码率用）。
 *  只读 moov 头，不整读大文件。 */
function mp4Dims(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    const hdr = Buffer.alloc(16);
    let pos = 0;
    let moov = null;
    while (pos + 8 <= st.size) {
      if (fs.readSync(fd, hdr, 0, 16, pos) < 8) break;
      let size = hdr.readUInt32BE(0);
      const type = hdr.toString("latin1", 4, 8);
      if (size === 1) size = Number(hdr.readBigUInt64BE(8));
      if (size < 8) break;
      if (type === "moov") {
        moov = { pos: pos + 8, size: Math.min(size - 8, 64 * 1024 * 1024) };
        break;
      }
      pos += size;
    }
    if (!moov) return null;
    const buf = Buffer.alloc(moov.size);
    if (fs.readSync(fd, buf, 0, buf.length, moov.pos) < 8) return null;
    // moov > trak > tkhd：宽高在 tkhd 里，v0 在 +84、v1 在 +96（16.16 定点）。
    // 注意第一个 trak 不一定是视频轨（常见音前视后）——收集所有 tkhd，取第一个宽高非零的。
    const findAll = (s, e, name, out = []) => {
      let p = s;
      while (p + 8 <= Math.min(e, buf.length)) {
        let size = buf.readUInt32BE(p);
        if (size === 1) size = Number(buf.readBigUInt64BE(p + 8));
        if (size < 8) return out;
        const t = buf.toString("latin1", p + 4, p + 8);
        if (t === name) out.push({ pos: p, size });
        else if (["trak", "mdia", "minf", "stbl"].includes(t)) findAll(p + 8, Math.min(p + size, e), name, out);
        p += size;
      }
      return out;
    };
    let dims = null;
    for (const tkhd of findAll(0, buf.length, "tkhd")) {
      const ver = buf[tkhd.pos + 8];
      const wOff = tkhd.pos + (ver === 1 ? 96 : 84);
      if (wOff + 8 > buf.length) continue;
      const w = Math.round(buf.readUInt32BE(wOff) / 65536);
      const h = Math.round(buf.readUInt32BE(wOff + 4) / 65536);
      if (w > 0 && h > 0) {
        dims = { w, h };
        break;
      }
    }
    if (!dims) return null;
    return mp4MetaFromMoov(buf, dims);
  } catch {
    return null;
  } finally {
    try {
      fd.close();
    } catch {}
  }
}

/** 已拿到 moov 内容后的补充元数据：mvhd 时长 + stsd 编码四字符码。
 *  时长用来算真实码率（面板识别「低码率虚标 4K」），拿不到就不填。
 *  stsd 同样有「音轨在前」的问题：只认视频编码的四字符码，音频（mp4a 等）跳过。 */
const MP4_VIDEO_CODECS = new Set(["avc1", "avc3", "hev1", "hvc1", "vp08", "vp09", "av01", "mp4v", "svc1", "mvc1"]);
function mp4MetaFromMoov(buf, out) {
  const findBoxes = (s, e, name, out2 = [], depth = 0) => {
    let p = s;
    while (p + 8 <= Math.min(e, buf.length)) {
      let size = buf.readUInt32BE(p);
      if (size === 1) size = Number(buf.readBigUInt64BE(p + 8));
      if (size < 8) return out2;
      const t = buf.toString("latin1", p + 4, p + 8);
      if (t === name) out2.push({ pos: p, size });
      else if (depth < 4 && ["moov", "trak", "mdia", "minf", "stbl"].includes(t)) findBoxes(p + 8, Math.min(p + size, e), name, out2, depth + 1);
      p += size;
    }
    return out2;
  };
  try {
    const [mvhd] = findBoxes(0, buf.length, "mvhd");
    if (mvhd) {
      const v = buf[mvhd.pos + 8];
      if (v === 1) {
        const ts = buf.readUInt32BE(mvhd.pos + 28);
        const dur = Number(buf.readBigUInt64BE(mvhd.pos + 32));
        if (ts > 0 && dur > 0) out.durS = dur / ts;
      } else {
        const ts = buf.readUInt32BE(mvhd.pos + 20);
        const dur = buf.readUInt32BE(mvhd.pos + 24);
        if (ts > 0 && dur > 0) out.durS = dur / ts;
      }
    }
  } catch {}
  try {
    for (const stsd of findBoxes(0, buf.length, "stsd")) {
      if (stsd.pos + 24 > buf.length) continue;
      const codec = buf.toString("latin1", stsd.pos + 20, stsd.pos + 24);
      if (MP4_VIDEO_CODECS.has(codec)) {
        out.codec = codec;
        break;
      }
    }
  } catch {}
  return out;
}

/** 视频真实码率（Mbps，一位小数）= 文件大小 ÷ 时长。时长拿不到（WebM 常见）返回 0。 */
function bitrateMbpsOf(size, info) {
  const dur = Number(info && info.durS);
  return dur > 0.5 ? Math.round(((Number(size) || 0) * 8) / dur / 1e5) / 10 : 0;
}

/** 低码率判据（按 H.264 的常见经验值；HEVC/AV1 更省码率，宁可不误报也不标错）：
 *  4K <10、2K <6、1080p <3.5、再低 <2 Mbps 放全屏大概率糊。 */
function lowBitrateOf(w, h, bps) {
  if (!bps || !w || !h) return false;
  const lim = h >= 2000 ? 10 : h >= 1300 ? 6 : h >= 1000 ? 3.5 : 2;
  return bps < lim;
}

/** WebM/MKV 的 EBML Tracks → Video.PixelWidth(0xB0)/PixelHeight(0xBA)。
 *  Tracks 紧跟在 Segment 头后面，读前 2MB 就够，不整读大文件。 */
function webmDims(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 2 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const vint = (p, keep) => {
      if (p < 0 || p >= buf.length) return null;
      let len = 0;
      for (let i = 0; i < 8; i++) {
        if (buf[p] & (0x80 >> i)) { len = i + 1; break; }
      }
      if (!len || p + len > buf.length) return null;
      let v;
      if (keep) {
        v = 0n;
        for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(buf[p + i]);
      } else {
        v = BigInt(buf[p] & (0xff >> len));
        for (let i = 1; i < len; i++) v = (v << 8n) | BigInt(buf[p + i]);
      }
      return { v, len, data: p + len };
    };
    // 可再往下钻的母元素：Segment / Tracks / TrackEntry / Video
    const CONT = new Set([0x18538067n, 0x1654ae6bn, 0xaen, 0xe0n]);
    const find = (s, e, want) => {
      let p = s;
      while (p < e) {
        const id = vint(p, true);
        if (!id) return null;
        const sz = vint(p + id.len, false);
        if (!sz) return null;
        // 全 1 的 size 是 unknown-size（流式 Segment），只用已读到的边界兜底
        const unknown = sz.v === (1n << BigInt(7 * sz.len)) - 1n;
        const dEnd = unknown ? e : Math.min(sz.data + Number(sz.v), e);
        if (id.v === want) return { pos: sz.data, end: dEnd };
        if (CONT.has(id.v)) {
          const r = find(sz.data, dEnd, want);
          if (r) return r;
        }
        p = dEnd;
      }
      return null;
    };
    const tracks = find(0, buf.length, 0x1654ae6bn);
    if (!tracks) return null;
    let p = tracks.pos;
    while (p < tracks.end) {
      const id = vint(p, true);
      const sz = id && vint(p + id.len, false);
      if (!id || !sz) break;
      const dEnd = Math.min(sz.data + Number(sz.v), tracks.end);
      if (id.v === 0xaen) {
        const vid = find(sz.data, dEnd, 0xe0n);
        if (vid) {
          const uint = (el, want) => {
            const f = find(el.pos, el.end, want);
            if (!f) return 0;
            let v = 0n;
            for (let i = f.pos; i < Math.min(f.end, f.pos + 8); i++) v = (v << 8n) | BigInt(buf[i]);
            return Number(v);
          };
          const w = uint(vid, 0xb0n); // PixelWidth
          const h = uint(vid, 0xbAn); // PixelHeight
          if (w && h) return { w, h };
        }
      }
      p = dEnd;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

/** 图片尺寸：PNG IHDR / GIF 逻辑屏 / JPEG SOF 段扫描。 */
function imgDims(file) {
  const b = fs.readFileSync(file);
  if (b.length < 11) return null;
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  if (b.length > 24 && b.toString("latin1", 1, 4) === "PNG") return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.toString("latin1", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  return null;
}

/** 统一入口：能拿到就返回 {w,h}，拿不到（WebM/VP9 的容器常不存尺寸）返回 null。 */
function mediaDims(file) {
  const ext = path.extname(String(file)).toLowerCase();
  try {
    if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".gif") return imgDims(file);
    if (ext === ".mp4" || ext === ".m4v" || ext === ".mov") return mp4Dims(file);
    if (ext === ".webm" || ext === ".mkv") return webmDims(file);
  } catch {}
  return null;
}

/** mediaDims 带缓存：面板 /list 每次扫描都要尺寸，图片头不值得反复读 */
const dimsCache = new Map();
function cachedMediaDims(file, st) {
  const key = `${path.resolve(String(file))}|${st.size}|${st.mtimeMs}`;
  if (dimsCache.has(key)) return dimsCache.get(key);
  const d = mediaDims(file);
  dimsCache.set(key, d);
  if (dimsCache.size > 512) dimsCache.clear(); // 简单防膨胀：溢出就整表重算
  return d;
}

/* -------------------- Wallpaper Engine scene.pkg 纹理抽取 --------------------
 * 场景型（scene/web）壁纸的正文打在 scene.pkg 里：不少「夜莺」系列直接内嵌整段
 * 4K MP4（ftyp 盒头），抽出来就是真正的动态壁纸；其余是分层纹理（PNG/JPEG 直存、
 * 裸 RGBA、DXT1/5 压缩、可再套 LZ4），抽最大的一张当高清底图。
 * 格式参照 RePKG：PKGV\d+ 文件表 + TEXV0005/TEXI0001 + TEXB0001-0004 容器。
 * 抽取结果缓存到 .we-pkg-cache\，键 = pkg 路径+大小+mtime。 */

function lz4BlockDecompress(src, dstSize) {
  const dst = Buffer.alloc(dstSize);
  let s = 0, d = 0;
  while (s < src.length && d < dstSize) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    if (lit) {
      src.copy(dst, d, s, s + lit);
      s += lit; d += lit;
      if (s >= src.length) break;
    }
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let ml = (token & 15) + 4;
    if ((token & 15) === 15) { let b; do { b = src[s++]; ml += b; } while (b === 255); }
    let mp = d - off;
    for (let i = 0; i < ml && d < dstSize; i++) dst[d++] = dst[mp++];
  }
  return dst;
}

/** DXT1(fmt7)/DXT5(fmt4) 块解码 → RGBA。 */
function decodeDXT(src, w, h, dxt5) {
  const out = Buffer.alloc(w * h * 4);
  const bw = (w + 3) >> 2, bh = (h + 3) >> 2;
  const bpp = dxt5 ? 16 : 8;
  const rgb565 = (v) => {
    const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
  };
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const base = (by * bw + bx) * bpp;
      let aPal = null, aBits = 0n;
      if (dxt5) {
        const a0 = src[base], a1 = src[base + 1];
        aPal = [a0, a1];
        if (a0 > a1) {
          for (let i = 2; i < 8; i++) aPal[i] = Math.round(((8 - i) * a0 + (i - 1) * a1) / 7);
          aPal[7] = 255;
        } else {
          aPal[2] = Math.round((4 * a0 + a1) / 5);
          aPal[3] = Math.round((3 * a0 + 2 * a1) / 5);
          aPal[4] = Math.round((2 * a0 + 3 * a1) / 5);
          aPal[5] = Math.round((a0 + 4 * a1) / 5);
          aPal[6] = 0;
          aPal[7] = 255;
        }
        aBits = src.readBigUInt64LE(base) >> 16n;
      }
      const c0 = src.readUInt16LE(base + (dxt5 ? 8 : 0));
      const c1 = src.readUInt16LE(base + (dxt5 ? 10 : 2));
      const cbits = src.readUInt32LE(base + (dxt5 ? 12 : 4));
      const p0 = rgb565(c0), p1 = rgb565(c1);
      const transparent = !dxt5 && c0 <= c1;
      const pal = [
        p0, p1,
        transparent ? [0, 0, 0] : [(2 * p0[0] + p1[0]) / 3 | 0, (2 * p0[1] + p1[1]) / 3 | 0, (2 * p0[2] + p1[2]) / 3 | 0],
        transparent ? [0, 0, 0] : [(p0[0] + 2 * p1[0]) / 3 | 0, (p0[1] + 2 * p1[1]) / 3 | 0, (p0[2] + 2 * p1[2]) / 3 | 0],
      ];
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= w || y >= h) continue;
          const pix = (y * w + x) * 4;
          const ci = (cbits >> (2 * (py * 4 + px))) & 3;
          out[pix] = pal[ci][0];
          out[pix + 1] = pal[ci][1];
          out[pix + 2] = pal[ci][2];
          out[pix + 3] = dxt5 ? aPal[Number(aBits >> BigInt(3 * (py * 4 + px))) & 7] : transparent && ci === 3 ? 0 : 255;
        }
      }
    }
  }
  return out;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  let c = -1;
  for (let i = 0; i < td.length; i++) c = PNG_CRC_T[(c ^ td[i]) & 255] ^ (c >>> 8);
  crc.writeUInt32BE((c ^ -1) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? 0 : pb <= pc ? 1 : 2;
}
/** RGBA 像素 → PNG：逐行试 none/sub/up/paeth 取压缩最友好的过滤；全不透明时丢 alpha 省 25%。 */
function rgbaToPng(rgba, w, h) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) { opaque = false; break; }
  }
  const bpp = opaque ? 3 : 4;
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1);
    let bestType = 0, bestSum = Infinity, best = null;
    for (let type = 0; type < 4; type++) {
      const f = Buffer.alloc(stride);
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const comp = opaque ? x % 3 : x % 4;
        const px2 = opaque ? ((x - comp) / 3) | 0 : ((x - comp) / 4) | 0;
        const cur = rgba[(y * w + px2) * 4 + comp];
        const left = px2 > 0 ? rgba[(y * w + px2 - 1) * 4 + comp] : 0;
        const up = y > 0 ? rgba[((y - 1) * w + px2) * 4 + comp] : 0;
        const ul = px2 > 0 && y > 0 ? rgba[((y - 1) * w + px2 - 1) * 4 + comp] : 0;
        const pred = type === 0 ? 0 : type === 1 ? left : type === 2 ? up : paeth(left, up, ul);
        const v = (cur - pred) & 255;
        f[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; bestType = type; best = f; }
    }
    raw[row] = bestType;
    best.copy(raw, row + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** 解析 scene.pkg → 纹理候选（含首 mip 定位）。仅认 PNG/JPEG/GIF 直存、裸 RGBA、DXT1/5 和内嵌 MP4。 */
function pkgTextureCandidates(buf, minArea) {
  let q = 0;
  const u32 = () => { const v = buf.readUInt32LE(q); q += 4; return v; };
  const ml = u32();
  if (!/^PKGV\d+$/.test(buf.toString("latin1", 4, 4 + ml))) return [];
  q += ml;
  const count = u32();
  const texs = [];
  for (let i = 0; i < count; i++) {
    const nl = u32();
    const name = buf.toString("utf8", q, q + nl);
    q += nl;
    const off = u32();
    q += 4; // size 不需要
    if (name.toLowerCase().endsWith(".tex")) texs.push({ name, off });
  }
  const base = q;
  const cands = [];
  for (const t of texs) {
    let p = base + t.off;
    const r32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
    const rStr = () => { const s = p; while (p < buf.length && buf[p] !== 0) p++; const r = buf.toString("utf8", s, p); p++; return r; };
    try {
      if (rStr() !== "TEXV0005" || rStr() !== "TEXI0001") continue;
      const format = r32();
      r32(); // flags
      r32(); r32(); // 纹理宽高（比图像大，对齐 mip 用）
      const iw = r32(), ih = r32();
      r32(); // unk
      const cm = rStr();
      if (cm !== "TEXB0001" && cm !== "TEXB0002" && cm !== "TEXB0003" && cm !== "TEXB0004") continue;
      const imgCount = r32();
      let fif = -1;
      if (cm === "TEXB0003") fif = r32();
      else if (cm === "TEXB0004") { fif = r32(); r32(); } // FIF + isVideoMp4 标志
      if (imgCount < 1) continue;
      r32(); // mipCount
      // 只取首 mip（最大的一张），后面 mip 对做壁纸没用
      const mw = r32(), mh = r32();
      let lz4 = -1, dec = 0;
      if (cm !== "TEXB0001") { lz4 = r32(); dec = r32(); }
      const len = r32();
      const at = p;
      if (at + len > buf.length) continue;
      const isVideo = buf.toString("latin1", at + 4, at + 8) === "ftyp"; // 内嵌 MP4 直接是完整的 mp4 流
      const direct = fif === 13 ? "png" : fif === 2 ? "jpg" : fif === 25 ? "gif" : null;
      const kind = isVideo ? "mp4" : direct || (format === 0 ? "rgba" : format === 4 ? "dxt5" : format === 7 ? "dxt1" : null);
      if (!kind) continue;
      // 不透明度：分层场景里透明图层（人物/装饰）不该当整幅壁纸。jpg 恒不透明；
      // DXT1 无 alpha 通道；PNG 看 IHDR colorType（4/6 带 alpha 位）。
      let opaque = kind === "jpg" || kind === "dxt1" || kind === "gif";
      if (kind === "png" && buf[at] === 0x89 && at + 26 <= buf.length) opaque = (buf[at + 25] & 2) === 0;
      if (iw * ih < (isVideo ? 0 : minArea)) continue; // 视频不设面积门槛（本来就不会小）
      cands.push({ seg: t.name.replace(/^.*[\\/]/, "").replace(/\.tex$/i, ""), iw, ih, format, kind, lz4, dec, len, at, mw, mh, opaque });
    } catch {
      continue;
    }
  }
  return cands;
}

/** 从 pkg 抽一个纹理/视频为 Buffer。失败返回 null。 */
function extractPkgTexture(buf, c) {
  const data = buf.subarray(c.at, c.at + c.len);
  if (c.kind === "mp4") return { ext: "mp4", data };
  if (c.kind === "png" || c.kind === "jpg" || c.kind === "gif") {
    return { ext: c.kind, data: c.lz4 === 1 ? lz4BlockDecompress(data, c.dec) : data };
  }
  const w = c.mw, h = c.mh;
  let rgba;
  if (c.kind === "dxt1" || c.kind === "dxt5") {
    let src = data;
    if (c.lz4 === 1) src = lz4BlockDecompress(data, c.dec || Math.ceil(w / 4) * Math.ceil(h / 4) * (c.kind === "dxt5" ? 16 : 8));
    if (src.length < Math.ceil(w / 4) * Math.ceil(h / 4) * (c.kind === "dxt5" ? 16 : 8)) return null;
    rgba = decodeDXT(src, w, h, c.kind === "dxt5");
  } else {
    rgba = c.lz4 === 1 ? lz4BlockDecompress(data, c.dec || w * h * 4) : data;
    if (rgba.length < w * h * 4) return null;
  }
  // 纹理常比图像大一圈（mip 对齐）——裁掉，只留图像区
  const cw = Math.min(w, c.iw || w), ch = Math.min(h, c.ih || h);
  const crop = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) rgba.copy(crop, y * cw * 4, y * w * 4, y * w * 4 + cw * 4);
  return { ext: "png", data: rgbaToPng(crop, cw, ch) };
}

/** scene.pkg → 抽好的媒体文件列表（带缓存）。返回 [{file,w,h,isVideo,seg}]。 */
function wePkgMedia(pkg) {
  let st;
  try {
    st = fs.statSync(pkg);
  } catch {
    return [];
  }
  const key = crypto.createHash("sha1").update(`${path.resolve(pkg).toLowerCase()}|${st.size}|${Math.floor(st.mtimeMs)}`).digest("hex").slice(0, 8);
  const cacheDir = path.join(SCRIPT_DIR, ".we-pkg-cache");
  const buf = fs.readFileSync(pkg);
  const all = pkgTextureCandidates(buf, 1600 * 900);
  // 内嵌 MP4 全保留（分段靠 seg 名，顺序不能乱）；静帧把不透明的排前面再取 4 张——
  // 分层场景里最大纹理常是透明人物/装饰图层，拿它当整幅壁纸就是一片乱码。
  // 同为不透明时按「面积 × 编码质量」挑：PNG/JPG/裸 RGBA 无损 1.0，DXT5 0.9，DXT1 0.78
  // ——DXT 是有损块压缩，4200 的 DXT 未必比 3840 的无损 PNG 清楚，面积接近时宁可要无损。
  const texScore = (c) => (c.iw * c.ih) * (c.kind === "png" || c.kind === "jpg" || c.kind === "rgba" ? 1 : c.kind === "dxt5" ? 0.9 : 0.78);
  const vids = all.filter((c) => c.kind === "mp4");
  const stills = all
    .filter((c) => c.kind !== "mp4")
    .sort((a, b) => (b.opaque === a.opaque ? texScore(b) - texScore(a) : b.opaque ? 1 : -1));
  const cands = [...vids, ...stills.slice(0, 4)];
  const out = [];
  const taken = new Set();
  for (const c of cands) {
    const ext = c.kind === "mp4" ? "mp4" : c.kind === "rgba" || c.kind.startsWith("dxt") ? "png" : c.kind;
    const f = path.join(cacheDir, `${key}-${c.seg.replace(/[\\/:*?"<>|\s]/g, "_").slice(0, 40)}.${ext}`);
    if (taken.has(f)) continue;
    taken.add(f);
    if (!fs.existsSync(f)) {
      const r = extractPkgTexture(buf, c);
      if (!r || !r.data || !r.data.length) continue;
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(f, r.data);
      } catch {
        continue;
      }
    }
    out.push({
      file: f,
      w: c.iw,
      h: c.ih,
      isVideo: c.kind === "mp4",
      seg: cands.length > 1 ? c.seg : "",
      // 内嵌 MP4 顺手读时长算真实码率（只读 moov 头）；DXT 静帧带上标记给面板提示
      ...(c.kind === "mp4" ? (() => { try { return { bps: bitrateMbpsOf(fs.statSync(f).size, mp4Dims(f)) }; } catch { return {}; } })() : {}),
      ...(c.kind === "dxt1" || c.kind === "dxt5" ? { dxt: true } : {}),
    });
  }
  return out;
}

/** 工坊项目目录里 scene.pkg 的可抽取内容；失败返回空。 */
function tryWePkgMedia(dir) {
  const pkg = path.join(dir, "scene.pkg");
  if (!fs.existsSync(pkg)) return [];
  try {
    return wePkgMedia(pkg);
  } catch {
    return [];
  }
}


function weProjectEntries(dir, pinned = false) {
  let pj;
  try {
    pj = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
  } catch {
    return null;
  }
  const title = String(pj.title || path.basename(dir)).trim() || path.basename(dir);
  const wtype = String(pj.type || "").toLowerCase();
  let preview = typeof pj.preview === "string" ? path.join(dir, pj.preview) : "";
  if (preview && !fs.existsSync(preview)) preview = "";
  const previewUrl = preview ? mediaUrlFor(preview) : "";

  // 视频素材：两级目录里所有 ≥512KB 的视频都算（文件太小的多是装饰贴片）。
  // project.json 的 file 字段排最前；尺寸能读的按像素面积排，读不到的按字节排。
  // 顺手读 mp4 时长算真实码率（bps）——面板靠它识破「低码率的假 4K」。
  const videos = [];
  if (typeof pj.file === "string") {
    const main = path.join(dir, pj.file);
    if (VIDEO_EXTS.has(path.extname(main).toLowerCase()) && fs.existsSync(main)) {
      const dims = mediaDims(main);
      videos.push({
        abs: main,
        size: fs.statSync(main).size,
        w: dims ? dims.w : 0,
        h: dims ? dims.h : 0,
        bps: bitrateMbpsOf(fs.statSync(main).size, dims),
      });
    }
  }
  const walk = (d, depth) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const x of ents) {
      const abs = path.join(d, x.name);
      if (x.isDirectory()) {
        if (depth < 2) walk(abs, depth + 1);
        continue;
      }
      if (!VIDEO_EXTS.has(path.extname(x.name).toLowerCase())) continue;
      if (videos.some((v) => v.abs.toLowerCase() === abs.toLowerCase())) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size < 512 * 1024) continue; // 太小的是贴图/装饰，不是正片
      const dims = mediaDims(abs); // mp4/mov 能拿到；webm 容器常不存 → null
      videos.push({ abs, size: st.size, w: dims ? dims.w : 0, h: dims ? dims.h : 0, bps: bitrateMbpsOf(st.size, dims) });
    }
  };
  walk(dir, 0);
  // scene.pkg 里藏的正文：内嵌 MP4（夜莺系列整段 4K 视频，抽出来就能当视频壁纸放）
  // 和高清纹理（比 254×254 封面实在得多的底图）。
  let pkgMedia = [];
  if (wtype !== "video") {
    try {
      pkgMedia = tryWePkgMedia(dir);
    } catch {}
  }
  for (const m of pkgMedia.filter((m) => m.isVideo)) {
    if (videos.some((v) => v.abs.toLowerCase() === m.file.toLowerCase())) continue;
    let size = 0;
    try {
      size = fs.statSync(m.file).size;
    } catch {}
    videos.push({ abs: m.file, size, w: m.w, h: m.h, seg: m.seg, bps: m.bps || 0 });
  }
  videos.sort((a, b) => (b.w * b.h || b.size) - (a.w * a.h || a.size));

  // 「随时间变化」的分段壁纸（清晨/白天/黄昏/夜晚，文件名或 scene.pkg 分段名带时段词，
  // 同一工坊项目能认出 ≥2 个时段）：不再拆成 4 张卡，合成一个条目——rel 用 we-time://
  // 虚拟地址，选中后面板按系统时间自动换段，不用人工盯着换。
  const inWeCache = (abs) => path.dirname(abs).toLowerCase() === path.join(SCRIPT_DIR, ".we-pkg-cache").toLowerCase();
  const bySeg = new Map();
  for (const v of videos) {
    const s = timeSegOf(v.seg || path.basename(v.abs, path.extname(v.abs)));
    if (s && !bySeg.has(s)) bySeg.set(s, v);
  }
  const timeMerged = bySeg.size >= 2;
  // 只有真合并时才把分段从「普通条目」里摘走：单段项目（认出的时段不足 2 个）
  // 必须照旧按普通视频列出，否则只有一个时段命名的视频会凭空消失
  const rest = timeMerged ? videos.filter((v) => ![...bySeg.values()].includes(v)) : videos;

  const out = [];
  let low = 0;
  const srcId = path.basename(dir); // 工坊项目目录名（纯数字 ID），weHidden 用它记「已删」
  if (timeMerged) {
    const segs = TIME_SEGS.filter((t) => bySeg.has(t.seg)).map((t) => {
      const v = bySeg.get(t.seg);
      return {
        seg: t.seg,
        label: t.label,
        file: v.abs,
        rel: v.abs,
        size: v.size,
        w: v.w,
        h: v.h,
        cache: inWeCache(v.abs),
        ...(v.bps ? { bps: v.bps, lowBps: lowBitrateOf(v.w, v.h, v.bps) } : {}),
      };
    });
    out.push({
      name: title,
      kind: "随时间",
      wtype,
      type: "video",
      time: true,
      rel: `we-time://${srcId}`,
      url: media.port ? `http://127.0.0.1:${media.port}/we-time/${srcId}` : mediaUrlFor(segs[0].file),
      preview: previewUrl,
      size: segs.reduce((a, s) => a + (s.size || 0), 0),
      w: segs.reduce((a, s) => Math.max(a, s.w || 0), 0),
      h: segs.reduce((a, s) => Math.max(a, s.h || 0), 0),
      mtime: 0,
      src: srcId,
      cache: false,
      segments: segs,
      ...(segs.some((s) => s.lowBps) ? { lowBps: true } : {}),
    });
  }
  for (const v of rest.slice(0, 4)) {
    const multi = rest.length > 1;
    const seg = v.seg || path.basename(v.abs, path.extname(v.abs));
    out.push({
      name: multi ? `${title} · ${seg}` : title,
      kind: wtype === "video" ? "视频" : "素材",
      wtype,
      type: "video",
      rel: v.abs,
      url: mediaUrlFor(v.abs),
      preview: previewUrl,
      size: v.size,
      w: v.w,
      h: v.h,
      mtime: 0,
      src: srcId,
      cache: path.dirname(v.abs).toLowerCase() === path.join(SCRIPT_DIR, ".we-pkg-cache").toLowerCase(),
      // 真实码率 + 低码率判定：面板角标据此提示「低码率」，别被 4K 标签骗了
      ...(v.bps ? { bps: v.bps, lowBps: lowBitrateOf(v.w, v.h, v.bps) } : {}),
    });
  }
  if (!out.length) {
    // 没有视频：网页型（spine/HTML 壁纸）直接以项目本体上墙（/we-web/<ID>/ 供流，
    // 页面用 <iframe> 层加载）——spine 动画的 4K 图集/原版渲染都在项目里，
    // 比拿 192×192 的方形封面当静帧强太多；其次才轮到 pkg 纹理/预览图。
    const webFile =
      wtype === "web" && typeof pj.file === "string" && /\.html?$/i.test(pj.file) && fs.existsSync(path.join(dir, pj.file))
        ? path.join(dir, pj.file)
        : "";
    const tex = pkgMedia.find((m) => !m.isVideo) || null;
    const pd = preview ? mediaDims(preview) : null;
    const previewOk = pd ? Math.max(pd.w, pd.h) >= WE_MIN_PREVIEW : false;
    const useTex = tex && (!pd || tex.w * tex.h > pd.w * pd.h) ? tex : null;
    if (webFile) {
      out.push({
        name: title,
        kind: "网页",
        wtype,
        type: "web",
        rel: `we-web://${srcId}`,
        url: media.port ? `http://127.0.0.1:${media.port}/we-web/${srcId}/` : "",
        preview: previewUrl,
        size: 0,
        mtime: 0,
        src: srcId,
        cache: false,
      });
    } else if (useTex) {
      let size = 0;
      try {
        size = fs.statSync(tex.file).size;
      } catch {}
      out.push({
        name: title,
        kind: "静帧",
        wtype,
        type: "image",
        rel: useTex.file,
        url: mediaUrlFor(useTex.file),
        // 缩略图直接用静帧本体（url）：它就是本地高清图，比 254~1024 的方形封面
        // 清楚得多、构图也和点开后的画面一致；preview 留空面板会自动回退到 url。
        preview: "",
        size,
        w: useTex.w,
        h: useTex.h,
        mtime: 0,
        src: srcId,
        cache: true, // pkg 纹理产物都落在 .we-pkg-cache
        // DXT 抽出来的静帧带块压缩痕迹：面板标出来，用户心里有数
        ...(useTex.dxt ? { dxt: true } : {}),
      });
    } else if (previewOk) {
      let size = 0;
      try {
        size = fs.statSync(preview).size;
      } catch {}
      out.push({
        name: title,
        kind: "静帧",
        wtype,
        type: "image",
        rel: preview,
        url: mediaUrlFor(preview),
        preview: "",
        size,
        w: pd.w,
        h: pd.h,
        mtime: 0,
        src: srcId,
        cache: false, // 直用工坊里的预览图，缓存里没有它的产物
      });
    } else if (preview && pinned) {
      // 「从工坊导入」点过名的项目：哪怕只有低清封面也强制列出，
      // 用户明确要装的壁纸不能因为「放上去会糊」永远不出现；不计入 weLow。
      let size = 0;
      try {
        size = fs.statSync(preview).size;
      } catch {}
      out.push({
        name: title,
        kind: "静帧",
        wtype,
        type: "image",
        rel: preview,
        url: mediaUrlFor(preview),
        preview: "",
        size,
        w: pd ? pd.w : 0,
        h: pd ? pd.h : 0,
        mtime: 0,
        src: srcId,
        cache: false, // 直用工坊里的预览图，缓存里没有它的产物
        forced: true, // wePinned 强制列出——面板据此提示「清晰度有限」
      });
    } else {
      low++; // 只有封面缩略图（几百像素的方图），放上去就是糊的——不列
    }
  }
  return out.length ? { entries: out, low } : (low ? { entries: [], low } : null);
}

/** 工坊目录 → 可用条目（按清晰度排序，最多 24 条）+ 被隐藏的低清封面数。
 *  v24 起只扫 wePinned 里「导入过」的项目：新下载的壁纸不再自动出现在区块里，
 *  想装随时走面板「从工坊导入」（选择列表扫的是全量目录，不受此限）。
 *  hidden：面板删过的工坊项目目录名（config.json 的 weHidden），整项目跳过——
 *  光删缓存文件的话下次扫描会重新抽取，必须连扫描入口一起挡掉。
 *  pinned：「从工坊导入」点过名的项目（config.json 的 wePinned），低清封面也强制列出。 */
function weLibraryEntries(weDir, hidden, pinned) {
  const entries = [];
  let low = 0;
  if (!weDir || !fs.existsSync(weDir)) return { entries, low };
  const skip = new Set((Array.isArray(hidden) ? hidden : []).map(String));
  const pin = new Set((Array.isArray(pinned) ? pinned : []).map(String));
  for (const id of pin) {
    // 工坊项目 ID 是纯数字目录名：config.json 手改出奇怪值时宁可跳过也别拼路径
    if (skip.has(id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || id === "." || id === "..") continue;
    const dir = path.join(weDir, id);
    if (!fs.existsSync(dir)) continue; // 项目可能已被 Steam 卸载/删除
    const r = weProjectEntries(dir, true);
    if (r) {
      entries.push(...r.entries);
      low += r.low;
    }
  }
  const area = (e) => (e.w && e.h ? e.w * e.h : e.size || 0);
  entries.sort((a, b) => area(b) - area(a));
  return { entries: entries.slice(0, 24), low };
}

/* ------------------------ 本地媒体服务（视频壁纸用） ------------------------ */

/** 按扩展名判断媒体类型：视频走 <video> 壁纸，其余当图片 */
function mediaTypeOf(file) {
  return VIDEO_EXTS.has(path.extname(String(file || "")).toLowerCase()) ? "video" : "image";
}

function guessMime(file) {
  const e = path.extname(String(file)).toLowerCase();
  return MIME[e] || VIDEO_MIME[e] || "application/octet-stream";
}

/** 稳定令牌：同一文件每次启动都得到同一个 URL，视频不会因为重启而重新缓冲 */
function mediaTokenFor(fileAbs) {
  const key = path.resolve(String(fileAbs)).toLowerCase();
  for (const [t, p] of media.tokens) if (p.toLowerCase() === key) return t;
  const t = crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
  media.tokens.set(t, path.resolve(fileAbs));
  return t;
}

/** 媒体文件的页面侧 URL：媒体服务在跑就走 HTTP（支持 Range），否则退回 file:// 直读 */
function mediaUrlFor(file) {
  const abs = path.resolve(String(file));
  if (media.port) return `http://127.0.0.1:${media.port}/w/${mediaTokenFor(abs)}`;
  return new URL("file:///" + abs.replace(/\\/g, "/")).href;
}

/** Windows 文件名净化：去掉非法字符和开头的一串点，保留扩展名 */
function sanitizeName(name, fallback = "media") {
  let n = path
    .basename(String(name || ""))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 100);
  return n || fallback;
}

/* ------------------- 工坊导入：把工坊项目装进「创意工坊」区块 ------------------- */

/**
 * 工坊根 → 全部项目清单（含被 ✕ 隐藏的和只有低清封面的），面板「从工坊导入」的
 * 选择列表用。只读 project.json 拿标题和预览图，不做纹理抽取（那留给 /list 扫描）。
 */
function weProjectCatalog(weDir) {
  const out = [];
  if (!weDir || !fs.existsSync(weDir)) return out;
  let dirs;
  try {
    dirs = fs.readdirSync(weDir, { withFileTypes: true }).filter((x) => x.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    let pj;
    try {
      pj = JSON.parse(fs.readFileSync(path.join(weDir, d.name, "project.json"), "utf8"));
    } catch {
      continue; // 没有 project.json 的目录不是壁纸项目，跳过
    }
    const title = String(pj.title || d.name).trim() || d.name;
    let preview = typeof pj.preview === "string" ? path.join(weDir, d.name, pj.preview) : "";
    if (preview && !fs.existsSync(preview)) preview = "";
    out.push({ src: d.name, title, preview: preview ? mediaUrlFor(preview) : "" });
  }
  out.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  return out;
}

/* ------------------- 随系统时间变化的分段壁纸（合成一个条目） ------------------- */

/* 时段定义与识别：文件名 / scene.pkg 分段名命中关键词就归到对应时段。
   英文用词边界防误伤（birthday 不能算 day），中文按词匹配——
   「夜莺」只含单字「夜」，不会误判成夜晚；「夜晚/夜间」才算。顺序即检测顺序。 */
const TIME_SEGS = [
  { seg: "morning", label: "清晨", re: /(^|[^a-z])mornings?([^a-z]|$)|dawn|清晨|早晨|凌晨/ },
  { seg: "day", label: "白天", re: /(^|[^a-z])day(time)?([^a-z]|$)|noon|白天|白昼|日间|中午/ },
  { seg: "evening", label: "黄昏", re: /(^|[^a-z])evening([^a-z]|$)|dusk|sunset|黄昏|傍晚|夕阳/ },
  { seg: "night", label: "夜晚", re: /(^|[^a-z])night([^a-z]|$)|夜晚|夜间|晚上|深夜/ },
];

/** 文件名/分段名 → 时段键；识别不出的返回 ""（当普通条目处理，不参与合并） */
function timeSegOf(name) {
  const s = String(name || "").toLowerCase();
  for (const t of TIME_SEGS) if (t.re.test(s)) return t.seg;
  return "";
}

/* 时段边界（小时，含头不含尾）。默认取「夜莺Night」系列作者在 project.json 里写明的
   5-9 清晨 / 9-16 白天 / 16-19 黄昏 / 19-5 夜晚；config.json 的 weTimeBounds 可改。 */
const TIME_BOUNDS_DEFAULT = { morning: 5, day: 9, evening: 16, night: 19 };

function weTimeBoundsOf(cfg) {
  const b = (cfg && typeof cfg.weTimeBounds === "object" && cfg.weTimeBounds) || {};
  const num = (v, d) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : d;
  };
  return {
    morning: num(b.morning, TIME_BOUNDS_DEFAULT.morning),
    day: num(b.day, TIME_BOUNDS_DEFAULT.day),
    evening: num(b.evening, TIME_BOUNDS_DEFAULT.evening),
    night: num(b.night, TIME_BOUNDS_DEFAULT.night),
  };
}

/** 时刻 → 时段键（含头不含尾；夜晚跨零点，兜住 [night,24)∪[0,morning)） */
function weTimePick(bounds, date) {
  const h = (date instanceof Date ? date : new Date()).getHours();
  const b = weTimeBoundsOf({ weTimeBounds: bounds });
  if (h >= b.morning && h < b.day) return "morning";
  if (h >= b.day && h < b.evening) return "day";
  if (h >= b.evening && h < b.night) return "evening";
  return "night";
}

/** 工坊项目 ID + 时段键 → 该时段的视频文件绝对路径；解析不了就抛错（宁可失败别放错段） */
function weTimeFileFor(srcId, seg) {
  const id = String(srcId || "").trim();
  if (!id || id === "." || id === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`随时间壁纸的项目标识不合法：${id}`);
  }
  const proj = media.weDir ? path.join(media.weDir, id) : "";
  if (!proj || !fs.existsSync(path.join(proj, "project.json"))) {
    throw new Error(`随时间壁纸找不到工坊项目 ${id}（工坊库没找到，或项目已被删除）`);
  }
  const r = weProjectEntries(proj, true);
  const merged = r && r.entries.find((e) => e.time);
  if (!merged) throw new Error(`工坊项目 ${id} 里没有可识别的时间分段视频`);
  const hit = merged.segments.find((s) => s.seg === seg) || merged.segments[0];
  if (!hit || !fs.existsSync(hit.file)) throw new Error(`「${merged.name}」缺少「${seg}」分段视频`);
  return hit.file;
}

/** config.wallpaper = "we-web://<工坊项目ID>" → 项目标题（面板「当前壁纸」显示用）。 */
function weProjectTitle(id) {
  if (!media.weDir) return "";
  let t = "";
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(media.weDir, String(id), "project.json"), "utf8"));
    t = String(pj.title || "").trim();
  } catch {}
  return t;
}

/** config.wallpaper = "we-time://<工坊项目ID>" → 当前时刻应播的分段视频。
 *  不是时间壁纸返回 null；解析失败抛错。url 带 ?b=<时段>（页面定时器换段时也用它）。 */
function weTimeResolve(cfg) {
  const m = /^we-time:\/\/(.+)$/i.exec(String((cfg && cfg.wallpaper) || ""));
  if (!m) return null;
  let id = "";
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    id = m[1];
  }
  const proj = media.weDir ? path.join(media.weDir, id) : "";
  if (!id || !media.weDir || !fs.existsSync(path.join(proj, "project.json"))) {
    throw new Error(`随时间变化的壁纸找不到工坊项目 ${id}（工坊库没找到，或项目已被删除）`);
  }
  const r = weProjectEntries(proj, true);
  const merged = r && r.entries.find((e) => e.time);
  if (!merged) throw new Error(`工坊项目 ${id} 里没有可识别的时间分段视频`);
  const bounds = weTimeBoundsOf(cfg);
  const seg = weTimePick(bounds, new Date());
  const hit = merged.segments.find((s) => s.seg === seg) || merged.segments[0];
  if (!hit || !fs.existsSync(hit.file)) throw new Error(`「${merged.name}」的「${seg}」分段视频不见了`);
  const base = media.port ? `http://127.0.0.1:${media.port}/we-time/${encodeURIComponent(id)}` : "";
  return {
    id,
    seg,
    bounds,
    file: hit.file,
    url: base ? `${base}?b=${seg}` : new URL("file:///" + hit.file.replace(/\\/g, "/")).href,
    timeUrl: base,
    label: `${merged.name}（随时间 · 当前${hit.label}）`,
  };
}

async function startMediaServer(cfg, getWeHidden, getWePinned, getTimeBounds) {
  if (media.server) return media.port;
  media.weDir = findWallpaperEngineDir(cfg); // Wallpaper Engine 创意工坊库路径（没有则为 null）
  if (media.weDir) log(`Wallpaper Engine 创意工坊库：${media.weDir}`);
  const wallDir = path.join(SCRIPT_DIR, "wallpaper");
  try {
    fs.mkdirSync(wallDir, { recursive: true });
  } catch {}
  const base = Math.max(1024, Number(cfg.mediaPort ?? DEFAULTS.mediaPort) || DEFAULTS.mediaPort);
  for (let p = base; p < base + 20; p++) {
    const ok = await new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        try {
          handleMediaRequest(req, res, wallDir, getWeHidden, getWePinned, getTimeBounds);
        } catch (e) {
          try {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(String((e && e.message) || e));
          } catch {}
        }
      });
      srv.on("error", () => resolve(null));
      srv.listen(p, "127.0.0.1", () => resolve(srv));
    });
    if (ok) {
      media.server = ok;
      media.port = p;
      process.once("exit", stopMediaServer);
      if (p !== base) warn(`媒体端口 ${base} 被占用，改用 ${p}。`);
      return p;
    }
  }
  warn(`媒体服务没能启动（${base}~${base + 19} 都被占用）——视频壁纸退回 file:// 直读，可能被 Electron 拦截。`);
  return 0;
}

function stopMediaServer() {
  try {
    media.server?.close();
  } catch {
    /* ignore */
  }
  media.server = null;
  media.port = 0;
}

function handleMediaRequest(req, res, wallDir, getWeHidden, getWePinned, getTimeBounds) {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Range" };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === "GET" && u.pathname === "/list") {
    // 传 getter 而不是 cfg 本身：热加载会整个换掉 cfg 对象，捕获旧引用就读不到新 weHidden 了
    handleList(res, wallDir, cors, getWeHidden, getWePinned);
    return;
  }
  if (req.method === "POST" && u.pathname === "/upload") {
    handleUpload(req, res, u, wallDir, cors);
    return;
  }
  const m = /^\/w\/([a-f0-9]{8,64})$/.exec(u.pathname);
  if ((req.method === "GET" || req.method === "HEAD") && m) {
    const file = media.tokens.get(m[1]);
    if (file && fs.existsSync(file)) {
      serveFile(req, res, file, cors);
      return;
    }
  }
  // 随时间壁纸的分段流：/we-time/<工坊项目ID>?b=<时段>。b 合法就按它来（页面定时器换段用），
  // 缺省按当前系统时间（+ config 的 weTimeBounds）算——整台机器一个时钟，两边不会打架。
  const tm = /^\/we-time\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(u.pathname);
  if ((req.method === "GET" || req.method === "HEAD") && tm) {
    try {
      const b = u.searchParams.get("b");
      const seg = TIME_SEGS.some((s) => s.seg === b)
        ? b
        : weTimePick(weTimeBoundsOf(typeof getTimeBounds === "function" ? getTimeBounds() : null), new Date());
      serveFile(req, res, weTimeFileFor(tm[1], seg), cors);
      return;
    } catch {}
  }
  // 网页壁纸：/we-web/<工坊项目ID>/<相对路径>。按 MIME 供流项目目录里的文件，
  // 相对路径在 resolve 后必须仍落在项目目录里（拦掉 ../ 之类越界）；空路径 = index.html。
  const wm = /^\/we-web\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\/(.*))?$/.exec(u.pathname);
  if ((req.method === "GET" || req.method === "HEAD") && wm && media.weDir) {
    const rel = wm[2] ? decodeURIComponent(wm[2]) : "index.html";
    const root = path.join(media.weDir, wm[1]);
    const abs = path.resolve(root, rel);
    // 宁可拒绝：解析结果必须还在项目目录里面，ID 也必须是合法的工坊目录名
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(wm[1]) && wm[1] !== "." && wm[1] !== ".." && abs.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      serveFile(req, res, abs, cors);
      return;
    }
  }
  res.writeHead(404, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function handleList(res, wallDir, cors, getWeHidden, getWePinned) {
  const items = [];
  try {
    for (const e of fs.readdirSync(wallDir, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith(".")) continue;
      const abs = path.join(wallDir, e.name);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      // w/h：面板卡片右上角的分辨率角标（4K/2K/…）靠它；带缓存避免每次 /list 都重读图片头
      const dims = cachedMediaDims(abs, st);
      // mp4 顺手算真实码率（低码率假 4K 的角标提示靠它）；其它容器拿不到就算了
      const bps = mediaTypeOf(e.name) === "video" ? bitrateMbpsOf(st.size, dims) : 0;
      items.push({
        name: e.name,
        size: st.size,
        type: mediaTypeOf(e.name),
        mtime: st.mtimeMs,
        rel: path.join("wallpaper", e.name),
        url: mediaUrlFor(abs),
        ...(dims ? { w: dims.w, h: dims.h } : {}),
        ...(bps ? { bps, lowBps: lowBitrateOf(dims ? dims.w : 0, dims ? dims.h : 0, bps) } : {}),
      });
    }
  } catch {}
  items.sort((a, b) => b.mtime - a.mtime);
  let we = [];
  let weLow = 0;
  let weAll = [];
  const hiddenList = typeof getWeHidden === "function" ? getWeHidden() : [];
  const pinnedList = typeof getWePinned === "function" ? getWePinned() : [];
  if (media.weDir) {
    try {
      const r = weLibraryEntries(media.weDir, hiddenList, pinnedList);
      we = r.entries;
      weLow = r.low;
    } catch (e) {
      warn(`读取 Wallpaper Engine 库失败: ${e.message}`);
    }
    // 全部工坊项目（含被隐藏的），面板「从工坊导入」的选择列表用
    const listed = new Set(we.map((x) => String(x.src || "")));
    const hiddenSet = new Set((Array.isArray(hiddenList) ? hiddenList : []).map(String));
    const pinnedSet = new Set((Array.isArray(pinnedList) ? pinnedList : []).map(String));
    weAll = weProjectCatalog(media.weDir).map((p) => ({
      ...p,
      listed: listed.has(p.src),
      hidden: hiddenSet.has(p.src),
      pinned: pinnedSet.has(p.src),
    }));
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...cors });
  res.end(JSON.stringify({ ok: true, items: items.slice(0, 100), we, weAll, weDir: media.weDir || "", weLow: weLow || 0 }));
}

function handleUpload(req, res, u, wallDir, cors) {
  const name = sanitizeName(u.searchParams.get("name") || "picked");
  const ext = (name.match(/\.[a-z0-9]{1,8}$/i) || [""])[0].toLowerCase();
  const cap = VIDEO_EXTS.has(ext) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  fs.mkdirSync(wallDir, { recursive: true });
  const tmp = path.join(wallDir, `.upload-${process.pid}-${Date.now()}${ext || ".bin"}`);
  const ws = fs.createWriteStream(tmp);
  let n = 0;
  let done = false;
  const fail = (code, msg) => {
    if (done) return;
    done = true;
    try {
      ws.destroy();
      fs.rmSync(tmp, { force: true });
    } catch {}
    if (!res.headersSent) res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...cors });
    try {
      res.end(JSON.stringify({ ok: false, error: msg }));
    } catch {}
  };
  req.on("data", (c) => {
    n += c.length;
    if (n > cap) fail(413, `文件超过 ${(cap / 1024 / 1024).toFixed(0)} MB 上限`);
  });
  req.on("error", () => {
    if (!done) {
      done = true;
      try {
        ws.destroy();
        fs.rmSync(tmp, { force: true });
      } catch {}
    }
  });
  ws.on("error", () => fail(500, "写入磁盘失败"));
  req.pipe(ws);
  ws.on("finish", () => {
    if (done) return;
    try {
      // 同名同大小视为同一文件直接覆盖，否则加序号，避免越攒越多
      let file = path.join(wallDir, name);
      if (fs.existsSync(file) && fs.statSync(file).size !== n) {
        const e = ext0(name);
        const b = name.slice(0, name.length - e.length) || "media";
        for (let i = 2; fs.existsSync(file); i++) file = path.join(wallDir, `${b}-${i}${e}`);
      }
      fs.renameSync(tmp, file);
      done = true;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...cors });
      res.end(JSON.stringify({ ok: true, name: path.basename(file), rel: path.relative(SCRIPT_DIR, file), size: n, type: mediaTypeOf(file), url: mediaUrlFor(file) }));
    } catch (e) {
      fail(500, "保存失败: " + e.message);
    }
  });
}

const ext0 = (name) => {
  const m = String(name || "").match(/\.[a-z0-9]{1,8}$/i);
  return m ? m[0] : "";
};

/* --------------------- 壁纸库：删掉一张（设置界面里点 ✕） -------------------- */

/**
 * 纯函数：校验设置界面报上来的壁纸库文件名，返回安全的基础名，不合法就抛错。
 * 这里刻意「宁可拒绝、不要猜」：带路径分隔符的名字直接拒绝，而不是 path.basename
 * 悄悄取尾段——`sub\a.png` 取尾段后会把 wallpaper\a.png 删掉，删的不是用户点的那个。
 */
function wallpaperChildName(name) {
  const raw = String(name == null ? "" : name).trim();
  if (!raw) throw new Error("没有指定要删的文件名。");
  if (/[\\/:]/.test(raw)) throw new Error("只能删除 wallpaper\\ 目录里的文件，文件名里不能带路径。");
  const base = path.basename(raw);
  if (!base || base === "." || base === ".." || base.startsWith(".")) throw new Error(`文件名不合法：${raw}`);
  if (base.toLowerCase() === path.basename(SAMPLE_WALLPAPER).toLowerCase()) {
    throw new Error("这是脚本自带的示例图（「用内置示例」按钮要用它），不能删。");
  }
  return base;
}

/** 壁纸库文件名 → wallpaper\ 下的真实文件；越界、目录、已消失都抛错 */
function resolveWallpaperChild(name) {
  const wallDir = path.resolve(path.join(SCRIPT_DIR, "wallpaper"));
  const base = wallpaperChildName(name);
  const abs = path.resolve(wallDir, base);
  // 双保险：即使上面的校验以后被改松了，这里也不允许跑到 wallpaper\ 外面去
  if (path.dirname(abs).toLowerCase() !== wallDir.toLowerCase()) {
    throw new Error("只能删除 wallpaper\\ 目录里的文件。");
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`文件已经不在了：${base}（可能你自己在文件夹里删掉了）。`);
  }
  if (!st.isFile()) throw new Error(`${base} 不是普通文件，不能删。`);
  return { abs, base, bytes: st.size };
}

/** 真正把文件删掉，并让媒体服务里这个文件的令牌失效。返回 {abs, base, bytes} */
function deleteWallpaperItem(name) {
  const d = resolveWallpaperChild(name);
  fs.rmSync(d.abs, { force: true });
  if (fs.existsSync(d.abs)) throw new Error(`删不掉 ${d.base}：文件可能被别的程序占用着。`);
  for (const [t, p] of [...media.tokens]) {
    if (String(p).toLowerCase() === d.abs.toLowerCase()) media.tokens.delete(t);
  }
  return d;
}

/** 校验面板报上来的 WE 条目 rel：必须是 .we-pkg-cache 里的直接子文件，
 *  且文件名以 8 位缓存键前缀开头（wePkgMedia 的命名）。返回前缀，不合法抛错。
 *  和 wallpaperChildName 一个思路：宁可拒绝、不要猜，绝不碰缓存目录外的任何文件。 */
function weCacheKeyFromRel(rel) {
  const cacheDir = path.resolve(path.join(SCRIPT_DIR, ".we-pkg-cache"));
  const abs = path.resolve(SCRIPT_DIR, String(rel == null ? "" : rel));
  if (path.dirname(abs).toLowerCase() !== cacheDir.toLowerCase()) {
    throw new Error("只能删除 Wallpaper Engine 的抽取缓存（.we-pkg-cache\\ 里的文件）。");
  }
  const m = /^([0-9a-f]{8})-/.exec(path.basename(abs));
  if (!m) throw new Error(`文件名不是抽取缓存的格式：${path.basename(abs)}`);
  return { key: m[1], cacheDir };
}

/** 面板「✕」删一个工坊项目：把 .we-pkg-cache 里这个项目的全部抽取产物删掉
 *  （一个 scene.pkg 的所有分段/纹理共用同一个键前缀，一起删才无残留），
 *  并让媒体服务里这些文件的令牌失效。绝不碰工坊目录——Wallpaper Engine 本体不受影响。 */
function deleteWeCacheItem(rel) {
  const { key, cacheDir } = weCacheKeyFromRel(rel);
  let count = 0, bytes = 0;
  const removed = [];
  for (const f of fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []) {
    if (!f.startsWith(`${key}-`)) continue;
    const abs = path.join(cacheDir, f);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    fs.rmSync(abs, { force: true });
    if (fs.existsSync(abs)) throw new Error(`删不掉 ${f}：文件可能正在被壁纸层播放着，切走再试。`);
    for (const [t, p] of [...media.tokens]) {
      if (String(p).toLowerCase() === abs.toLowerCase()) media.tokens.delete(t);
    }
    count++;
    bytes += st.size;
    removed.push(f);
  }
  return { key, cacheDir, count, bytes, removed };
}

/** 删掉当前壁纸后挑一张替补：库里最新改动的那个文件，没有就返回 null */function pickReplacementWallpaper() {
  const wallDir = path.join(SCRIPT_DIR, "wallpaper");
  const items = [];
  try {
    for (const e of fs.readdirSync(wallDir, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith(".")) continue;
      const abs = path.join(wallDir, e.name);
      try {
        items.push({ name: e.name, rel: path.join("wallpaper", e.name), mtime: fs.statSync(abs).mtimeMs });
      } catch {}
    }
  } catch {}
  items.sort((a, b) => b.mtime - a.mtime);
  return items.length ? items[0] : null;
}

function serveFile(req, res, file, cors) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    res.writeHead(404, cors);
    res.end();
    return;
  }
  const headOnly = req.method === "HEAD";
  const base = { "Content-Type": guessMime(file), "Accept-Ranges": "bytes", "Cache-Control": "no-store", ...cors };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (m && (m[1] !== "" || m[2] !== "")) {
    // 兼容三种写法：bytes=0-9 / bytes=500- / bytes=-200（最后 200 字节）
    const start = m[1] === "" ? Math.max(0, size - (parseInt(m[2], 10) || 0)) : parseInt(m[1], 10);
    const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
    if (!(start >= 0 && start <= end && start < size)) {
      res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    if (!headOnly) fs.createReadStream(file, { start, end }).pipe(res);
    else res.end();
    return;
  }
  res.writeHead(200, { ...base, "Content-Length": size });
  if (!headOnly) fs.createReadStream(file).pipe(res);
  else res.end();
}

/**
 * 纯函数：状态 → 背景 CSS。
 * 保持“纯”（不读文件、不用 config 对象）是刻意的：这个函数的源码会被
 * .toString() 塞进 ZCode 页面里运行（见 buildUiScript），
 * 这样主进程和设置界面永远共用同一套实现，不会出现两边渲染不一致。
 */
function cssFromState(s) {
  const st = s || {};
  const url = String(st.url || "");
  const alpha = Math.max(0, Math.min(1, Number(st.panelAlpha ?? 0.62)));
  const dim = Math.max(0, Math.min(1, Number(st.dim ?? 0)));
  const blur = Math.max(0, Number(st.imageBlurPx ?? 0));
  const isVideo = st.type === "video";
  // 铺排方式：图片用 background-size，视频用 object-fit；平铺只对图片有意义
  const FIT_BG = { cover: "cover", contain: "contain", fill: "100% 100%", tile: "auto" };
  const FIT_OBJ = { cover: "cover", contain: "contain", fill: "fill", tile: "cover" };
  const ALIGN = { center: "center center", top: "center top", bottom: "center bottom", left: "left center", right: "right center" };
  const fitCss = FIT_BG[st.fit] || "cover";
  const pos = ALIGN[st.align] || "center center";

  const classes = (Array.isArray(st.translucentClasses) ? st.translucentClasses : [])
    .filter((c) => typeof c === "string" && c.startsWith("bg-"))
    // 短的先写、长的后写：class 同时命中多条时，更精确的长名字规则靠后覆盖，胜出。
    .slice()
    .sort((a, b) => a.length - b.length);

  const panelRules = classes
    .map((c) => {
      const varName = `--color-${c.slice(3)}`;
      return `[class*="${c}"]{background-color:color-mix(in oklab, var(${varName}) ${(alpha * 100).toFixed(1)}%, transparent) !important}`;
    })
    .join("\n");

  const overlay =
    dim > 0 || blur > 0
      ? `body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;background:${hexToRgba(
          st.dimColor,
          dim,
        )};${blur > 0 ? `backdrop-filter:blur(${blur}px);-webkit-backdrop-filter:blur(${blur}px);` : ""}}`
      : "";

  const extra = typeof st.extraCss === "string" ? st.extraCss.trim() : "";

  // 精细透明化/调色（overrides）：数组每项要么是选择器字符串（强制透明），
  // 要么是 {selector, background}（把该区域背景改成任意颜色/半透明色——吸收 Zcode-Wallpaper 的
  // background_overrides，但由面板调色器生成，不用手写）。
  // 必须是自包含的纯函数（会被 .toString() 注入页面），所以消毒器写在函数体内。
  const safeSel = (s) => {
    if (typeof s !== "string") return "";
    const t = s.trim();
    if (!t || t.length > 200) return "";
    // 注意 > 是合法的子代选择器（nav>div），不能拦；没有 {} @ ; \ 和 /* 就注入不了别的规则
    if (/[{}@;\\<]/.test(t) || t.indexOf("/*") >= 0) return "";
    return t;
  };
  // background 值只放行“颜色样”的内容：拦掉规则/资源注入的载体（{}@;\<、/*、url()、expression、自带 !important）
  const safeBg = (v) => {
    if (typeof v !== "string") return "";
    const t = v.trim();
    if (!t || t.length > 120) return "";
    if (/[{}@;\\<]/.test(t) || t.indexOf("/*") >= 0) return "";
    if (/url\s*\(|expression|!important/i.test(t)) return "";
    return t;
  };
  const overrideRules = (Array.isArray(st.overrides) ? st.overrides : [])
    .slice(0, 24)
    .map((o) => {
      if (typeof o === "string") {
        const sel = safeSel(o);
        return sel ? `${sel}{background:transparent !important}` : "";
      }
      if (o && typeof o === "object") {
        const sel = safeSel(o.selector);
        const bg = safeBg(o.background);
        return sel && bg ? `${sel}{background:${bg} !important}` : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  // 视频壁纸：<video> 层铺满窗口（z-index:-2，压暗层 body::before 是 -1，正好盖在它上面）。
  // 网页壁纸同理，用 <iframe> 层加载 /we-web/<ID>/（spine/HTML 壁纸原生渲染）。
  // 图片壁纸默认走 html 的 background-image（老路径）；只有开了锐化（sharpen>0）才切到
  // <img> 层——CSS 背景没法单独套 filter，<img> 层才能只锐化壁纸不动界面。平铺保持老路径。
  const isWeb = st.type === "web";
  const imgLayer = !isVideo && !isWeb && st.fit !== "tile" && Number(st.sharpen) > 0;
  const framed = isVideo || isWeb || st.fit === "contain" || imgLayer;
  const htmlRule = isVideo || isWeb
    ? `html{background-color:var(--color-background,#111111) !important;background-attachment:fixed !important}`
    : `html{background-color:${framed ? "var(--color-background,#111111)" : "transparent"} !important;${imgLayer ? "" : `background-image:url("${url}") !important;`}background-position:${pos} !important;background-size:${fitCss} !important;background-repeat:${st.fit === "tile" ? "repeat" : "no-repeat"} !important;background-attachment:fixed !important}`;
  const videoRule = isVideo
    ? `video#__zcode_bg_video{position:fixed;inset:0;width:100%;height:100%;object-fit:${FIT_OBJ[st.fit] || "cover"};object-position:${pos};z-index:-2;pointer-events:none;opacity:0;transition:opacity .5s ease}`
    : isWeb
      ? `iframe#__zcode_bg_web{position:fixed;inset:0;width:100%;height:100%;border:0;z-index:-2;pointer-events:none;opacity:0;transition:opacity .5s ease}`
      : imgLayer
        ? `img#__zcode_bg_img{position:fixed;inset:0;width:100%;height:100%;object-fit:${FIT_OBJ[st.fit] || "cover"};object-position:${pos};z-index:-2;pointer-events:none;opacity:0;transition:opacity .5s ease}`
        : "";

  return `/* ZCode 自定义背景（${isVideo ? "视频动态壁纸" : isWeb ? "网页壁纸" : "图片"}${imgLayer ? " · 锐化" : ""}）—— 由 zcode-bg.mjs 注入；移除用: node zcode-bg.mjs --off */
${htmlRule}
body{background-color:transparent !important}
body,#root{background:transparent !important}
${videoRule}
${overlay}
/* 基础面板半透明，让壁纸透出来（panelAlpha=${alpha}） */
${panelRules}
${overrideRules}
${extra}
`.replace(/\n{3,}/g, "\n\n");
}

/**
 * 纯函数：视频壁纸状态 → 维护页面里的 <video> 层。
 * 同样会被 .toString() 注入页面（ui-inject.js 和 injectSource 共用这一份实现）。
 * 做成幂等：重复调用只在 src / 参数真的变化时才动 DOM，拖滑块不会让视频从头播。
 */
function applyVideoState(vs) {
  var ID = "__zcode_bg_video";
  var el = document.getElementById(ID);
  if (!vs || vs.type !== "video" || !vs.url) {
    if (el) {
      try {
        el.pause();
      } catch (e) {}
      el.remove();
    }
    window.__zcodeBgVideoCfg = null;
    return false;
  }
  window.__zcodeBgVideoCfg = vs;
  // 随时间变化的分段壁纸（timeUrl = /we-time/<项目ID>）：每 20 秒按系统时间重算时段，
  // 换段了就重设 <video> 的 src（?b=<时段>，服务端按参数回对应分段视频）。
  var timeBucketOf = function (hh, b) {
    var m0 = b && isFinite(b.morning) ? Math.floor(b.morning) : 5;
    var d0 = b && isFinite(b.day) ? Math.floor(b.day) : 9;
    var e0 = b && isFinite(b.evening) ? Math.floor(b.evening) : 16;
    var n0 = b && isFinite(b.night) ? Math.floor(b.night) : 19;
    return hh >= m0 && hh < d0 ? "morning" : hh >= d0 && hh < e0 ? "day" : hh >= e0 && hh < n0 ? "evening" : "night";
  };
  if (vs.timeUrl) {
    if (!window.__zcodeBgTimeTimer) {
      window.__zcodeBgTimeTimer = setInterval(function () {
        var c = window.__zcodeBgVideoCfg || {};
        if (!c || !c.timeUrl) return;
        var hh = new Date().getHours();
        var k = timeBucketOf(hh, c.timeBounds);
        if (window.__zcodeBgTimeBucket === k) return;
        var v2 = document.getElementById("__zcode_bg_video");
        if (!v2) return;
        window.__zcodeBgTimeBucket = k;
        try {
          v2.src = c.timeUrl + (c.timeUrl.indexOf("?") < 0 ? "?" : "&") + "b=" + k;
          v2.load();
        } catch (e) {}
      }, 20000);
    }
  } else if (window.__zcodeBgTimeTimer) {
    clearInterval(window.__zcodeBgTimeTimer);
    window.__zcodeBgTimeTimer = 0;
  }
  if (!el) {
    el = document.createElement("video");
    el.id = ID;
    el.loop = true;
    el.autoplay = true;
    el.muted = vs.muted !== false;
    el.playsInline = true;
    el.setAttribute("playsinline", "");
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("disablepictureinpicture", "");
    el.tabIndex = -1;
    el.style.opacity = "0";
    el.addEventListener(
      "canplay",
      function () {
        el.style.opacity = "1";
      },
      { once: true },
    );
    (document.body || document.documentElement).appendChild(el);
    // 省电：ZCode 最小化 / 被完全遮住时暂停解码，回来接着播
    document.addEventListener("visibilitychange", function () {
      var v = document.getElementById(ID);
      if (!v) return;
      var c = window.__zcodeBgVideoCfg || {};
      if (document.hidden) {
        if (c.pauseWhenHidden !== false) {
          try {
            v.pause();
          } catch (e) {}
        }
      } else {
        try {
          var p = v.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
    });
  }
  try {
    // 时间壁纸：src = timeUrl?b=<当前时段>；普通壁纸就是 vs.url 本身
    var wantSrc = vs.url;
    if (vs.timeUrl) {
      var bk = timeBucketOf(new Date().getHours(), vs.timeBounds);
      window.__zcodeBgTimeBucket = bk;
      wantSrc = vs.timeUrl + (vs.timeUrl.indexOf("?") < 0 ? "?" : "&") + "b=" + bk;
    }
    if (el.getAttribute("src") !== wantSrc) {
      el.style.opacity = "0";
      el.addEventListener(
        "canplay",
        function () {
          el.style.opacity = "1";
        },
        { once: true },
      );
      el.src = wantSrc;
      el.load();
    }
    el.muted = vs.muted !== false;
    el.loop = vs.loop !== false;
    el.playbackRate = Math.max(0.0625, Math.min(16, Number(vs.speed) || 1));
    var FITS = { cover: "cover", contain: "contain", fill: "fill", tile: "cover" };
    var POS = { center: "center center", top: "center top", bottom: "center bottom", left: "left center", right: "right center" };
    el.style.objectFit = FITS[vs.fit] || "cover";
    el.style.objectPosition = POS[vs.align] || "center center";
    el.style.zIndex = "-2";
  } catch (e) {}
  if (el.paused) {
    try {
      var pr = el.play();
      if (pr && pr.catch) pr.catch(function () {});
    } catch (e) {}
  }
  return true;
}

/**
 * 纯函数：网页壁纸状态 → 维护页面里的 <iframe> 层（we-web:// 工坊网页壁纸）。
 * 同样会被 .toString() 注入页面（ui-inject.js 和 injectSource 共用这一份实现）。
 * 幂等：src 没变就不重载（拖滑块/重开面板不会让网页壁纸闪一下）。
 */
function applyWebState(ws) {
  var ID = "__zcode_bg_web";
  var el = document.getElementById(ID);
  if (!ws || ws.type !== "web" || !ws.url) {
    if (el) el.remove();
    window.__zcodeBgWebCfg = null;
    window.__zcodeBgWebSrc = null;
    return false;
  }
  window.__zcodeBgWebCfg = ws;
  if (!el) {
    el = document.createElement("iframe");
    el.id = ID;
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("scrolling", "no");
    el.tabIndex = -1;
    el.style.opacity = "0";
    el.style.transition = "opacity .5s ease";
    (document.body || document.documentElement).appendChild(el);
  }
  try {
    el.style.position = "fixed";
    el.style.inset = "0";
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.border = "0";
    el.style.pointerEvents = "none";
    el.style.zIndex = "-2";
    // 跨源 http iframe 在本应用里是独立进程（OOPIF），内容渲染正常但合成不到屏幕上；
    // 改成同源 srcdoc（继承父页面 origin，同进程渲染）就没有这个问题：
    // 拉壁纸 HTML 文本 → 注入 <base> 指回媒体服务（相对路径的脚本/贴图才找得到）→ 贴图补
    // crossOrigin（WebGL 纹理要求 CORS 模式的图）。拉不到再退回直连 src。
    // 守卫键带改写版本号：以后再改这里的改写逻辑时同步 +1，已上墙的旧 srcdoc 也会自动重打。
    var KEY = ws.url + "@rw5";
    if (window.__zcodeBgWebSrc !== KEY) {
      window.__zcodeBgWebSrc = KEY;
      el.style.opacity = "0";
      var show = function () {
        if (window.__zcodeBgWebSrc === KEY) el.style.opacity = "1";
      };
      fetch(ws.url, { cache: "no-store" })
        .then(function (r) {
          return r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status));
        })
        .then(function (html) {
          if (window.__zcodeBgWebSrc !== KEY) return;
          if (!/<base\s/i.test(html)) {
            html = /<head[^>]*>/i.test(html)
              ? html.replace(/<head([^>]*)>/i, '<head$1><base href="' + ws.url + '">')
              : '<base href="' + ws.url + '">' + html;
          }
          html = html.replace("img.src = t.file;", 'img.crossOrigin = "anonymous"; img.src = t.file;');
          // 高清化：壁纸页 canvas 一律按 CSS 像素建缓冲，在缩放屏（本机 150%）会被
          // 拉到物理分辨率显示而发糊。把「画布尺寸 = 客户区尺寸」整体升到物理像素，
          // 再乘 1.5 做超采样（4K 级渲染下采样到屏，边缘更细腻）。
          html = html.replace(
            /canvas\.width = canvas\.clientWidth; canvas\.height = canvas\.clientHeight;/g,
            "canvas.width = Math.round(canvas.clientWidth * (window.devicePixelRatio || 1) * 1.5); " +
              "canvas.height = Math.round(canvas.clientHeight * (window.devicePixelRatio || 1) * 1.5);",
          );
          html = html.replace(
            "if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight)",
            "if (canvas.width !== Math.round(canvas.clientWidth * (window.devicePixelRatio || 1) * 1.5) || " +
              "canvas.height !== Math.round(canvas.clientHeight * (window.devicePixelRatio || 1) * 1.5))",
          );
          // 关键配套：spineCamera 的视野 = 视口×zoom。画布缓冲升到 CSS×DPR×1.5 后，
          // 相机视口也被 setViewport 成缓冲大小，若仍按 clientWidth 算 zoom，视野会比
          // 设计大 2.2 倍、内容缩成屏中央一小块。排版必须改用缓冲尺寸计算。
          html = html.replace(
            "WallpaperLayout.spineCamera(computeBounds(), canvas.clientWidth, canvas.clientHeight, {",
            "WallpaperLayout.spineCamera(computeBounds(), canvas.width, canvas.height, {",
          );
          // 铺满（cover）：壁纸页自带排版是 contain+10% 边距，屏比不合时相机视野会
          // 滑出背景画面、屏边露出底色（本机实测左侧露出 34 世界单位）。给 spineCamera
          // 包一层钳制：以「面积最大的附件」当背景板，zoom 不超过「背景板刚好铺满画布」
          // 的值（最多收紧 20%，防止对没有背景板的角色皮肤猛裁），相机位置保证视野
          // 窗口完全落在背景板包围盒内。
          var COVER = [
            "<script>(function () {",
            "  var L = window.WallpaperLayout;",
            "  if (!L || typeof L.spineCamera !== 'function' || L.__coverClamped) return;",
            "  var orig = L.spineCamera;",
            "  L.__coverClamped = true;",
            "  function backdrop() {",
            "    try {",
            "      var best = null, bestA = -1;",
            "      for (var li = 0; li < skeletons.length; li++) {",
            "        var sk = skeletons[li].skeleton;",
            "        for (var i = 0; i < sk.slots.length; i++) {",
            "          var slot = sk.slots[i], att = slot.getAttachment();",
            "          if (!att) continue;",
            "          var isRegion = att instanceof spine.RegionAttachment;",
            "          if (!isRegion && !(att instanceof spine.MeshAttachment)) continue;",
            "          var len = isRegion ? 8 : att.worldVerticesLength;",
            "          if (!len) continue;",
            "          var verts = spine.Utils.newFloatArray(len);",
            "          if (isRegion) att.computeWorldVertices(slot.bone, verts, 0, 2);",
            "          else att.computeWorldVertices(slot, 0, len, verts, 0, 2);",
            "          var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };",
            "          for (var k = 0; k < len; k += 2) {",
            "            if (verts[k] < b.minX) b.minX = verts[k];",
            "            if (verts[k] > b.maxX) b.maxX = verts[k];",
            "            if (verts[k + 1] < b.minY) b.minY = verts[k + 1];",
            "            if (verts[k + 1] > b.maxY) b.maxY = verts[k + 1];",
            "          }",
            "          var a = (b.maxX - b.minX) * (b.maxY - b.minY);",
            "          if (a > bestA) { bestA = a; best = b; }",
            "        }",
            "      }",
            "      return best;",
            "    } catch (e) { return null; }",
            "  }",
            "  L.spineCamera = function (bounds, cw, ch, opts) {",
            "    var r = orig(bounds, cw, ch, opts);",
            "    try {",
            "      var bd = backdrop();",
            "      if (bd) {",
            "        var bw = bd.maxX - bd.minX, bh = bd.maxY - bd.minY;",
            "        var coverZoom = Math.min(bw / Math.max(1e-3, cw), bh / Math.max(1e-3, ch));",
            "        if (coverZoom < r.zoom && coverZoom * 1.25 >= r.zoom) r.zoom = coverZoom;",
            "        var vw = cw * r.zoom, vh = ch * r.zoom;",
            "        if (vw <= bw) {",
            "          var lo = bd.minX + vw / 2, hi = bd.maxX - vw / 2;",
            "          if (lo <= hi) r.x = Math.min(hi, Math.max(lo, r.x));",
            "        }",
            "        if (vh <= bh) {",
            "          var lo2 = bd.minY + vh / 2, hi2 = bd.maxY - vh / 2;",
            "          if (lo2 <= hi2) r.y = Math.min(hi2, Math.max(lo2, r.y));",
            "        }",
            "      }",
            "    } catch (e) {}",
            "    return r;",
            "  };",
            "})();</scr" + "ipt>",
          ].join("\n");
          html = /<\/body>/i.test(html)
            ? html.replace(/<\/body>/i, COVER + "</body>")
            : html + COVER;
          el.removeAttribute("src");
          el.removeAttribute("srcdoc");
          el.setAttribute("srcdoc", html);
          el.addEventListener("load", function onLoaded() {
            el.removeEventListener("load", onLoaded);
            show();
          });
        })
        .catch(function () {
          if (window.__zcodeBgWebSrc !== KEY) return;
          el.removeAttribute("srcdoc");
          el.setAttribute("src", ws.url);
          el.addEventListener("load", function onFallback() {
            el.removeEventListener("load", onFallback);
            show();
          });
        });
    } else {
      el.style.opacity = "1";
    }
  } catch (e) {}
  return true;
}

/**
 * 纯函数：图片壁纸的 <img> 层（只在开锐化时启用，平时走 html 的 CSS 背景）。
 * CSS 背景没法单独套 filter，<img> 层才能做到「只锐化壁纸、不动界面」。
 * 和 applyVideoState 一样会被 .toString() 注入页面（ui-inject.js 共用），只能用朴素语法。
 * 幂等：src 没变就不动 DOM，拖锐化滑块不会让图片闪一下。
 */
function applyImageState(is) {
  var ID = "__zcode_bg_img";
  var el = document.getElementById(ID);
  if (!is || is.type !== "image" || !is.url) {
    if (el) el.remove();
    window.__zcodeBgImgCfg = null;
    return false;
  }
  window.__zcodeBgImgCfg = is;
  if (!el) {
    el = document.createElement("img");
    el.id = ID;
    el.alt = "";
    el.draggable = false;
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.style.opacity = "0";
    el.style.transition = "opacity .5s ease";
    el.addEventListener(
      "load",
      function () {
        el.style.opacity = "1";
      },
      { once: true },
    );
    (document.body || document.documentElement).appendChild(el);
  }
  try {
    if (el.getAttribute("src") !== is.url) {
      el.style.opacity = "0";
      el.addEventListener(
        "load",
        function () {
          el.style.opacity = "1";
        },
        { once: true },
      );
      el.src = is.url;
    }
    var FITS = { cover: "cover", contain: "contain", fill: "fill" };
    var POS = { center: "center center", top: "center top", bottom: "center bottom", left: "left center", right: "right center" };
    el.style.position = "fixed";
    el.style.inset = "0";
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.objectFit = FITS[is.fit] || "cover";
    el.style.objectPosition = POS[is.align] || "center center";
    el.style.zIndex = "-2";
    el.style.pointerEvents = "none";
  } catch (e) {}
  return true;
}

/**
 * 纯函数：画面增强（锐化）——给视频/图片/网页壁纸层套一个 SVG 卷积锐化滤镜。
 * 滑块 0~1 → 卷积核中心 1+4a、十字 -a；a=1 就是经典 [0,-1,0;-1,5,-1;0,-1,0]。
 * 注意：filter 引用不存在的滤镜 id 会让整层直接消失，所以必须先把 SVG 节点建好再挂 filter；
 * 关掉（amount=0）时先摘 filter 再删节点。同样会被 .toString() 注入页面，只能用朴素语法。
 */
function applySharpenState(ss) {
  var amount = ss && Number(ss.sharpen) > 0 ? Math.max(0, Math.min(1, Number(ss.sharpen))) : 0;
  var FILT = "url(#__zcbg_sharp)";
  var svg = document.getElementById("__zcbg_sharp_svg");
  if (amount > 0) {
    var NS = "http://www.w3.org/2000/svg";
    if (!svg) {
      svg = document.createElementNS(NS, "svg");
      svg.id = "__zcbg_sharp_svg";
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
      svg.style.position = "absolute";
      svg.style.pointerEvents = "none";
      (document.body || document.documentElement).appendChild(svg);
    }
    var f = svg.firstElementChild;
    if (!f) {
      f = document.createElementNS(NS, "filter");
      f.id = "__zcbg_sharp";
      svg.appendChild(f);
    }
    var c = f.firstElementChild;
    if (!c) {
      c = document.createElementNS(NS, "feConvolveMatrix");
      f.appendChild(c);
    }
    var a = amount;
    f.setAttribute("x", "-2%");
    f.setAttribute("y", "-2%");
    f.setAttribute("width", "104%");
    f.setAttribute("height", "104%");
    c.setAttribute("order", "3");
    c.setAttribute("kernelMatrix", "0 " + -a + " 0 " + -a + " " + (1 + 4 * a) + " " + -a + " 0 " + -a + " 0");
    c.setAttribute("divisor", "1");
    c.setAttribute("edgeMode", "duplicate");
  }
  var targets = ["__zcode_bg_video", "__zcode_bg_web", "__zcode_bg_img"];
  for (var i = 0; i < targets.length; i++) {
    var el = document.getElementById(targets[i]);
    if (!el) continue;
    if (amount > 0) {
      if (el.style.filter !== FILT) el.style.filter = FILT;
    } else if (el.style.filter) {
      el.style.filter = "";
    }
  }
  if (!amount && svg) svg.remove();
  window.__zcodeBgSharpenCfg = ss || null;
  return true;
}

/**
 * 纯函数：兜底自愈 —— 把「面积够大但仍然是实心」的内容表面也改成半透明。
 * 场景：ZCode 升级后把 bg-xxx 类名换了，config.json 里配的 translucentClasses
 * 一条都没命中，结果右侧内容区整块盖住壁纸。这里不要求用户先跑 --diagnose，
 * 而是运行时自己找出这些大块头，按和配置类完全相同的公式（color-mix + --color-*）
 * 补一条规则，保证「壁纸至少是看得见的」。
 * 和 applyVideoState 一样会被 .toString() 注入页面，所以只能用朴素语法。
 * 幂等：规则内容不变就不碰 DOM；壁纸关掉（主样式不在）时自己退场。
 */
function applyTranslucentFallback(st) {
  var ID = "__zcode_bg_fallback_style__";
  var MAIN = "__zcode_custom_bg_style__";
  var LAYER = "__zcode_bg_layer";
  var s = st || {};
  var on = s.autoTranslucent !== false && s.enabled !== false;
  var timer = window.__zcodeBgFallbackTimer || 0;
  var mo = window.__zcodeBgFallbackObserver || null;
  var stop = function () {
    if (timer) {
      clearInterval(timer);
      window.__zcodeBgFallbackTimer = 0;
    }
    if (mo && mo.disconnect) mo.disconnect();
    window.__zcodeBgFallbackObserver = null;
    var t = document.getElementById(ID);
    if (t) t.remove();
    window.__zcodeBgFallbackInfo = { on: false, classes: [], surfaces: 0 };
  };
  if (!on) {
    // 关掉时也要把「当前下发的兜底参数」刷新一遍：否则 __zcodeBgFallbackCfg 会一直留着
    // 上一次的 autoTranslucent=true，排查问题时看着像开关没生效（--diagnose 也读它）。
    window.__zcodeBgFallbackCfg = {
      alpha: Math.max(0, Math.min(1, Number(s.panelAlpha != null ? s.panelAlpha : 0.62))),
      known: {},
      autoTranslucent: false,
    };
    stop();
    return false;
  }
  var known = {};
  (Array.isArray(s.translucentClasses) ? s.translucentClasses : []).forEach(function (c) {
    if (c) known[c] = 1;
  });
  var alpha = Math.max(0, Math.min(1, Number(s.panelAlpha != null ? s.panelAlpha : 0.62)));
  // 注入时的这批默认值放在全局：注入器热加载 config.json（或设置界面改了参数）后，
  // 下面的 scan() 每轮都从这里 + 界面状态重新取一次，不会拿着过期参数一直兜底。
  window.__zcodeBgFallbackCfg = { alpha: alpha, known: known, autoTranslucent: s.autoTranslucent !== false };

  var scan = function () {
    try {
      // 壁纸本身没在注入（关掉了 / 还没注入）→ 兜底也不该留着，否则用户会发现
      // “关掉壁纸之后界面还是半透明的”。
      if (!document.getElementById(MAIN)) {
        stop();
        return;
      }
      if (document.hidden) return;
      var base = window.__zcodeBgFallbackCfg;
      if (base) {
        if (base.autoTranslucent === false) {
          stop();
          return;
        }
        if (base.alpha != null) alpha = base.alpha;
        if (base.known) known = base.known;
      }
      // 设置界面里改了「面板透明度」等参数时，跟着它走（它才是页面侧的真相来源），
      // 这样兜底出来的透明度和配置类完全一致，不用等注入器重新下发。
      var live = window.__zcodeBgUi && window.__zcodeBgUi.state;
      if (live) {
        if (live.autoTranslucent === false) {
          stop();
          return;
        }
        if (live.panelAlpha != null) alpha = Math.max(0, Math.min(1, Number(live.panelAlpha)));
        if (Array.isArray(live.translucentClasses)) {
          known = {};
          live.translucentClasses.forEach(function (c) {
            if (c) known[c] = 1;
          });
        }
      }
      var vw = window.innerWidth, vh = window.innerHeight, varea = vw * vh;
      var found = {}, surfaces = 0;
      var nodes = document.querySelectorAll('[class*="bg-"]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.id === ID || el.id === MAIN) continue;
        if (el.closest && el.closest('#' + LAYER)) continue;
        if (el.offsetWidth < vw * 0.35 || el.offsetHeight < vh * 0.25) continue;
        if (el.offsetWidth * el.offsetHeight < varea * 0.18) continue;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
        if (cs.pointerEvents === 'none') continue;
        var bg = cs.backgroundColor || '';
        var m = bg.match(/rgba?\(([^)]+)\)/);
        if (!m) continue;
        var parts = m[1].split(',');
        var a = parts.length > 3 ? parseFloat(parts[3]) : 1;
        if (!(a >= 0.9)) continue;
        // 弹层/下拉菜单/气泡不碰：固定或绝对定位且层级很高的那些
        var pos = cs.position;
        if ((pos === 'fixed' || pos === 'absolute') && parseInt(cs.zIndex || '0', 10) >= 30) continue;
        var cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/);
        var unknown = [];
        for (var j = 0; j < cls.length; j++) {
          var c = cls[j];
          if (c && c.indexOf('bg-') === 0 && !known[c] && unknown.indexOf(c) < 0) unknown.push(c);
        }
        if (!unknown.length) continue;
        // 优先挑一个能解析出 --color-xxx 的类名，否则 color-mix 会整条失效、白兜底
        var pick = '';
        for (var k = 0; k < unknown.length; k++) {
          var v = (cs.getPropertyValue('--color-' + unknown[k].slice(3)) || '').trim();
          if (v) {
            pick = unknown[k];
            break;
          }
        }
        if (!pick) continue;
        found[pick] = 1;
        surfaces++;
      }
      var out = Object.keys(found).sort();
      var css = out
        .map(function (c) {
          return '[class*="' + c + '"]{background-color:color-mix(in oklab, var(--color-' + c.slice(3) + ') ' + (alpha * 100).toFixed(1) + '%, transparent) !important}';
        })
        .join('\n');
      var tag = document.getElementById(ID);
      if (out.length) {
        if (!tag) {
          tag = document.createElement('style');
          tag.id = ID;
          (document.head || document.documentElement).appendChild(tag);
        }
        if (tag.textContent !== css) tag.textContent = css;
      } else if (tag) {
        // 配置里的类名又命中了（或者升级后类名变回来了）→ 撤掉兜底，别越权
        tag.remove();
      }
      window.__zcodeBgFallbackInfo = { on: true, classes: out, surfaces: surfaces };
    } catch (e) {
      window.__zcodeBgFallbackInfo = { on: true, error: String(e) };
    }
  };
  window.__zcodeBgFallbackScan = scan;
  scan();
  if (!timer) window.__zcodeBgFallbackTimer = setInterval(scan, 4000);
  if (!mo && window.MutationObserver) {
    var pending = 0;
    mo = new MutationObserver(function () {
      clearTimeout(pending);
      pending = setTimeout(scan, 900);
    });
    try {
      mo.observe(document.documentElement, { childList: true, subtree: true });
      window.__zcodeBgFallbackObserver = mo;
    } catch (e) {}
  }
  return true;
}

/** config → 页面侧状态对象（设置界面和 CSS 都用它，只有一个真相来源） */
function uiState(cfg, { placeholder = false } = {}) {
  let url = "";
  let label = "";
  let mediaType = "image";
  let timeUrl = ""; // 随时间壁纸：分段解析端点（不带 ?b=），页面定时器按系统时间换段用
  let timeBounds = null;
  try {
    if (/^we-time:\/\//i.test(String(cfg.wallpaper || ""))) {
      const t = weTimeResolve(cfg);
      mediaType = "video";
      url = t.url;
      timeUrl = t.timeUrl;
      timeBounds = t.bounds;
      label = t.label;
    } else if (/^we-web:\/\//i.test(String(cfg.wallpaper || ""))) {
      // 网页壁纸：页面用 <iframe> 层加载 /we-web/<ID>/，spine/HTML 壁纸原生渲染
      const id = String(cfg.wallpaper).replace(/^we-web:\/\//i, "");
      mediaType = "web";
      url = media.port ? `http://127.0.0.1:${media.port}/we-web/${encodeURIComponent(id)}/` : "";
      label = weProjectTitle(id) || id;
    } else {
      const file = resolveWallpaper(cfg);
      mediaType = mediaTypeOf(file);
      url = mediaType === "video" ? mediaUrlFor(file) : wallpaperUrl(cfg, { placeholder });
      label = path.basename(file);
    }
  } catch (e) {
    label = `（找不到壁纸文件：${cfg.wallpaper || "空"}）`;
  }
  const FITS = ["cover", "contain", "fill", "tile"];
  const ALIGNS = ["center", "top", "bottom", "left", "right"];
  return {
    version: UI_VERSION,
    enabled: cfg.enabled !== false,
    url,
    label,
    mediaType,
    timeUrl,
    timeBounds,
    // cssFromState() 认的是 type，而设置界面认的是 mediaType；两个都给，
    // 否则视频壁纸会被当成图片走 background-image（渲染成破图）。
    type: mediaType,
    fit: FITS.includes(cfg.fit) ? cfg.fit : "cover",
    align: ALIGNS.includes(cfg.align) ? cfg.align : "center",
    panelAlpha: Math.max(0, Math.min(1, Number(cfg.panelAlpha ?? 0.62))),
    dim: Math.max(0, Math.min(1, Number(cfg.dim ?? 0))),
    dimColor: cfg.dimColor || "#000000",
    imageBlurPx: Math.max(0, Number(cfg.imageBlurPx ?? 0)),
    sharpen: Math.max(0, Math.min(1, Number(cfg.sharpen ?? 0) || 0)),
    videoMuted: cfg.videoMuted !== false,
    videoSpeed: Math.max(0.25, Math.min(4, Number(cfg.videoSpeed ?? 1) || 1)),
    videoPauseWhenHidden: cfg.videoPauseWhenHidden !== false,
    mediaBase: media.port ? `http://127.0.0.1:${media.port}` : "",
    translucentClasses: Array.isArray(cfg.translucentClasses) ? cfg.translucentClasses : [],
    overrides: Array.isArray(cfg.overrides)
      ? cfg.overrides
          .slice(0, 24)
          .map((o) => {
            if (typeof o === "string") return o;
            if (o && typeof o === "object" && typeof o.selector === "string" && typeof o.background === "string")
              return { selector: o.selector, background: o.background };
            return null;
          })
          .filter(Boolean)
          .slice(0, 24)
      : [],
    autoTranslucent: cfg.autoTranslucent !== false,
    extraCss: typeof cfg.extraCss === "string" ? cfg.extraCss : "",
  };
}

/** config → 视频层状态（enabled=false 或当前是图片时返回 null，页面侧就会把 <video> 拆掉） */
function videoStateFor(cfg) {
  if (cfg.enabled === false) return null;
  // 网页壁纸走 <iframe> 层（webStateFor），<video> 要拆掉
  if (/^we-web:\/\//i.test(String(cfg.wallpaper || ""))) return null;
  // 随时间壁纸：url 带 ?b=<当前时段>，再给页面 timeUrl/timeBounds 让定时器到点自己换段
  if (/^we-time:\/\//i.test(String(cfg.wallpaper || ""))) {
    try {
      const t = weTimeResolve(cfg);
      const FITS = ["cover", "contain", "fill"];
      const ALIGNS = ["center", "top", "bottom", "left", "right"];
      return {
        type: "video",
        url: t.url,
        timeUrl: t.timeUrl,
        timeBounds: t.bounds,
        muted: cfg.videoMuted !== false,
        loop: true,
        speed: Math.max(0.25, Math.min(4, Number(cfg.videoSpeed ?? 1) || 1)),
        fit: FITS.includes(cfg.fit) ? cfg.fit : "cover",
        align: ALIGNS.includes(cfg.align) ? cfg.align : "center",
        pauseWhenHidden: cfg.videoPauseWhenHidden !== false,
        sharpen: Math.max(0, Math.min(1, Number(cfg.sharpen ?? 0) || 0)),
      };
    } catch {
      return null;
    }
  }
  let file;
  try {
    file = resolveWallpaper(cfg);
  } catch {
    return null;
  }
  if (mediaTypeOf(file) !== "video") return null;
  const FITS = ["cover", "contain", "fill"];
  const ALIGNS = ["center", "top", "bottom", "left", "right"];
  return {
    type: "video",
    url: mediaUrlFor(file),
    muted: cfg.videoMuted !== false,
    loop: true,
    speed: Math.max(0.25, Math.min(4, Number(cfg.videoSpeed ?? 1) || 1)),
    fit: FITS.includes(cfg.fit) ? cfg.fit : "cover",
    align: ALIGNS.includes(cfg.align) ? cfg.align : "center",
    pauseWhenHidden: cfg.videoPauseWhenHidden !== false,
    sharpen: Math.max(0, Math.min(1, Number(cfg.sharpen ?? 0) || 0)),
  };
}

/** config → 网页壁纸层状态（we-web:// 才有，其它情况 null，页面侧就会把 <iframe> 拆掉） */
function webStateFor(cfg) {
  if (cfg.enabled === false) return null;
  if (!/^we-web:\/\//i.test(String(cfg.wallpaper || ""))) return null;
  const s = uiState(cfg);
  if (!s.url) return null;
  return { type: "web", url: s.url, sharpen: s.sharpen };
}

/** config → 图片层状态：只在开锐化时启用 <img> 层（平时走 CSS 背景，锐化 0 不改老路径）。
 *  平铺（tile）没法用 object-fit 表达，保持 CSS 背景、不锐化。 */
function imageStateFor(cfg) {
  if (cfg.enabled === false) return null;
  const sharpen = Math.max(0, Math.min(1, Number(cfg.sharpen ?? 0) || 0));
  if (sharpen <= 0) return null;
  if (/^(we-web|we-time):\/\//i.test(String(cfg.wallpaper || ""))) return null;
  let file;
  try {
    file = resolveWallpaper(cfg);
  } catch {
    return null;
  }
  if (mediaTypeOf(file) !== "image") return null;
  if (cfg.fit === "tile") return null;
  const FITS = ["cover", "contain", "fill"];
  const ALIGNS = ["center", "top", "bottom", "left", "right"];
  return {
    type: "image",
    url: wallpaperUrl(cfg),
    fit: FITS.includes(cfg.fit) ? cfg.fit : "cover",
    align: ALIGNS.includes(cfg.align) ? cfg.align : "center",
    sharpen,
  };
}

/** config → 锐化滤镜层状态：>0 才给视频/图片/网页层套 SVG 卷积锐化 */
function sharpenStateFor(cfg) {
  if (cfg.enabled === false) return null;
  const sharpen = Math.max(0, Math.min(1, Number(cfg.sharpen ?? 0) || 0));
  return sharpen > 0 ? { sharpen } : null;
}

/** config → 页面侧兜底自愈状态（壁纸关掉时给 null，页面侧会自己退场） */
function fallbackStateFor(cfg) {
  if (cfg.enabled === false) return null;
  return {
    enabled: true,
    autoTranslucent: cfg.autoTranslucent !== false,
    panelAlpha: Math.max(0, Math.min(1, Number(cfg.panelAlpha ?? 0.62))),
    translucentClasses: Array.isArray(cfg.translucentClasses) ? cfg.translucentClasses : [],
  };
}

function buildCss(cfg, { placeholder = false } = {}) {
  return cssFromState(uiState(cfg, { placeholder }));
}

/** 读取 ui-inject.js，把两个占位符换成实际内容，得到可注入页面的源码 */
function buildUiScript(cfg, { placeholder = false } = {}) {
  if (cfg.showSettingsUI === false) return "";
  let tpl;
  try {
    tpl = fs.readFileSync(UI_SCRIPT_PATH, "utf8").replace(/^\uFEFF/, "");
  } catch (e) {
    warn(`读不到设置界面脚本 ${UI_SCRIPT_PATH}（${e.message}）—— 本次只注入背景 CSS，不显示“壁纸”设置页。`);
    return "";
  }
  const state = uiState(cfg, { placeholder });
  const helpers = `${hexToRgba.toString()}\n${cssFromState.toString()}\n${applyVideoState.toString()}\n${applyWebState.toString()}\n${applyImageState.toString()}\n${applySharpenState.toString()}`;
  return tpl
    .replace("/*__ZCBG_VERSION__*/ 0", () => String(UI_VERSION))
    .replace("/*__ZCBG_STATE__*/ null", () => JSON.stringify(state))
    .replace("/*__ZCBG_CSS_HELPERS__*/", () => helpers);
}

/* --------------------------- 配置 / 图片的写回 --------------------------- */

const WRITABLE_KEYS = new Set([
  "enabled",
  "wallpaper",
  "panelAlpha",
  "dim",
  "imageBlurPx",
  "sharpen",
  "fit",
  "align",
  "videoMuted",
  "videoSpeed",
  "videoPauseWhenHidden",
  "showSettingsUI",
  "autoTranslucent",
  "extraCss",
  "overrides",
  "weHidden",
  "wePinned",
  "weTimeBounds",
  "wePinnedSeeded",
]);

/** 合并写回 config.json（保留 DEFAULTS 里的其它键和用户自己加的未知键） */
function saveConfig(patch) {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""));
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) cur = {};
  } catch {
    /* 文件不存在或坏掉：直接用默认值重建 */
  }
  const next = { ...DEFAULTS, ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (WRITABLE_KEYS.has(k)) next[k] = v;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

const EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

/** 把设置界面选中的图片（data URL）落盘到 wallpaper\，返回可写进 config 的相对路径 */
function savePickedImage(dataUrl, name) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ""));
  if (!m) throw new Error("图片数据格式不认识（只接受 base64 编码的 data URL）");
  const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!buf.length) throw new Error("图片内容是空的");
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片 ${(buf.length / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 上限`);
  }
  const ext = EXT_BY_MIME[m[1].toLowerCase()] || ".png";
  const base =
    path
      .basename(String(name || "picked"))
      .replace(/\.[^.]*$/, "")
      // 去掉 Windows 文件名非法字符
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[\u0000-\u001f]/g, "")
      .trim()
      .slice(0, 60) || "picked";

  const dir = path.join(SCRIPT_DIR, "wallpaper");
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(file); i++) {
    // 同一张图重复保存就直接覆盖，避免越攒越多
    if (fs.statSync(file).size === buf.length) break;
    file = path.join(dir, `${base}-${i}${ext}`);
  }
  fs.writeFileSync(file, buf);
  return { file, rel: path.relative(SCRIPT_DIR, file), bytes: buf.length };
}

/* --------------------------------- CDP ---------------------------------- */

async function httpJson(port, endpoint, timeoutMs = 2500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function portOpen(port) {
  try {
    await httpJson(port, "/json/version", 1200);
    return true;
  } catch {
    return false;
  }
}

class CdpSession {
  constructor(target) {
    this.target = target;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  /** 监听 CDP 事件（如 Runtime.bindingCalled），返回取消函数 */
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method)?.delete(fn);
  }

  async open() {
    const ws = new WebSocket(this.target.webSocketDebuggerUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket 连接超时")), 8000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("WebSocket 连接失败（若提示 Origin 被拒，启动参数已带 --remote-allow-origins=*）"));
        },
        { once: true },
      );
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message || "CDP 错误"} (${msg.error.code ?? ""})`));
        else resolve(msg.result);
        return;
      }
      // CDP 事件（设置界面就是靠 Runtime.bindingCalled 把用户操作传回来的）
      if (msg.method && this.handlers.has(msg.method)) {
        for (const fn of this.handlers.get(msg.method)) {
          try {
            fn(msg.params || {});
          } catch (e) {
            warn(`事件 ${msg.method} 处理出错: ${e.message}`);
          }
        }
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("CDP 连接已关闭"));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) {
      // exceptionDetails.text 永远只是 "Uncaught"，真正的原因（含栈）在 exception.description 里。
      // 只取前几行并压成一行，既保留定位信息，又不破坏日志一事件一行的格式。
      const d = r.exceptionDetails;
      const raw = (d.exception && (d.exception.description || d.exception.value)) || d.text || "页面执行异常";
      const brief = String(raw)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" ⏎ ");
      throw new Error(brief || "页面执行异常");
    }
    return r && r.result ? r.result.value : undefined;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** 从 /json/list 里挑出 ZCode 主窗口（跳过 devtools、内嵌浏览器等） */
function pickTargets(list) {
  const pages = (Array.isArray(list) ? list : []).filter(
    (t) => t && t.webSocketDebuggerUrl && !String(t.url).startsWith("devtools://"),
  );
  const main = pages.filter((t) => /\/renderer\/index\.html/i.test(t.url) || /(^file:\/\/|\/).*index\.html/i.test(t.url));
  if (main.length) return main;
  return pages.filter((t) => /zcode/i.test(String(t.url)) || /zcode/i.test(String(t.title || "")));
}

const injectSource = (css, videoState, fallbackState, webState, imageState, sharpenState) => `(() => {
  const ID = ${JSON.stringify(STYLE_ID)};
  const CSS = ${JSON.stringify(css)};
  const VIDEO = ${JSON.stringify(videoState || null)};
  const FALLBACK = ${JSON.stringify(fallbackState || null)};
  const WEB = ${JSON.stringify(webState || null)};
  const IMAGE = ${JSON.stringify(imageState || null)};
  const SHARPEN = ${JSON.stringify(sharpenState || null)};
  const paint = () => {
    try {
      let el = document.getElementById(ID);
      if (!CSS) {
        // 壁纸被关掉时 CSS 是空的：这时要顺手把旧样式和视频层拆掉
        if (el) el.remove();
        window.__zcodeBg = { applied: false, bytes: 0 };
        return;
      }
      if (!el) {
        el = document.createElement('style');
        el.id = ID;
        (document.head || document.documentElement).appendChild(el);
      }
      if (el.textContent !== CSS) el.textContent = CSS;
      window.__zcodeBg = { applied: true, bytes: CSS.length };
    } catch (e) {
      window.__zcodeBg = { applied: false, error: String(e) };
    }
  };
  ${applyVideoState.toString()}
  ${applyWebState.toString()}
  ${applyImageState.toString()}
  ${applySharpenState.toString()}
  ${applyTranslucentFallback.toString()}
  // 蹦床：UI 闭包（setState 路径）可能存活多轮注入，它捕获的 applyWebState 是旧实现；
  // UI 侧统一走这个全局引用，保证任何旧闭包都调到本次注入的最新实现。
  window.__zcodeBgApplyWeb = applyWebState;
  window.__zcodeBgApplyImage = applyImageState;
  window.__zcodeBgApplySharpen = applySharpenState;
  paint();
  try { applyVideoState(VIDEO); } catch (e) {}
  try { applyWebState(WEB); } catch (e) {}
  try { applyImageState(IMAGE); } catch (e) {}
  try { applySharpenState(SHARPEN); } catch (e) {}
  try { applyTranslucentFallback(FALLBACK); } catch (e) {}
  if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', paint, { once: true });
  setTimeout(paint, 1000);
  setTimeout(paint, 4000);
  return true;
})()`;

/**
 * 把「背景脚本」和「界面脚本」拼成一段可注入的源码。
 *
 * ⚠ 这里的分号是**必须**的，不是风格问题：
 *   injectSource 生成的是 `(() => { … })()`，而 ui-inject.js 也是以 `(() => {` 开头。
 *   两段只用换行拼接时，JS 的 ASI（自动分号插入）不会补分号——因为下一行的 `(`
 *   可以继续上一个表达式，于是整段被解析成 `(...)()(ui)()` 这条调用链：
 *   第一段返回的 `true` 被当成函数调用，抛 TypeError，**界面脚本一行都不会执行**。
 *   历史症状：刷新页面（Ctrl+R）或窗口重建后，壁纸还在，但「设置 → 壁纸」面板
 *   凭空消失，且没有任何明显报错——因为主样式是在抛错之前就已经写进页面了。
 *   修法就是让两段各自成为独立语句（末尾/开头补分号，前导分号是空语句，安全）。
 */
const composeInjectionSource = (css, videoState, fallbackState, ui, webState, imageState, sharpenState) => {
  const bg = css ? `${injectSource(css, videoState, fallbackState, webState, imageState, sharpenState)};` : "";
  const face = ui ? `\n;${ui}` : "";
  return bg + face;
};

/** 一次性拆掉背景样式 + 设置界面浮层（不依赖 ui-inject.js 是否还在，按固定 id 清理） */
const removeSource = `(() => {
  const out = { style: false, ui: false };
  // 先记录“移除前是否存在”（设置界面的 destroy() 自己也会删样式，必须提前判断）
  out.style = !!document.getElementById(${JSON.stringify(STYLE_ID)});
  out.ui = !!(document.getElementById(${JSON.stringify(UI_STYLE_ID)}) ||
              document.getElementById(${JSON.stringify(LAYER_ID)}) ||
              (window.__zcodeBgUi && typeof window.__zcodeBgUi.destroy === 'function'));
  try {
    if (window.__zcodeBgUi && typeof window.__zcodeBgUi.destroy === 'function') window.__zcodeBgUi.destroy();
  } catch (e) {}
  const vid = document.getElementById('__zcode_bg_video');
  if (vid) {
    try { vid.pause(); } catch (e) {}
    vid.remove();
  }
  const web = document.getElementById('__zcode_bg_web');
  if (web) web.remove();
  const imgLayer = document.getElementById('__zcode_bg_img');
  if (imgLayer) imgLayer.remove();
  const sharpSvg = document.getElementById('__zcbg_sharp_svg');
  if (sharpSvg) sharpSvg.remove();
  try {
    window.__zcodeBgVideoCfg = undefined;
    window.__zcodeBgVideoState = undefined;
    window.__zcodeBgWebCfg = undefined;
    window.__zcodeBgWebSrc = undefined;
    window.__zcodeBgImgCfg = undefined;
    window.__zcodeBgSharpenCfg = undefined;
  } catch (e) {}
  try {
    if (window.__zcodeBgFallbackTimer) { clearInterval(window.__zcodeBgFallbackTimer); window.__zcodeBgFallbackTimer = 0; }
    if (window.__zcodeBgTimeTimer) { clearInterval(window.__zcodeBgTimeTimer); window.__zcodeBgTimeTimer = 0; }
    if (window.__zcodeBgFallbackObserver && window.__zcodeBgFallbackObserver.disconnect) window.__zcodeBgFallbackObserver.disconnect();
    window.__zcodeBgFallbackObserver = null;
    window.__zcodeBgFallbackInfo = undefined;
    window.__zcodeBgFallbackScan = undefined;
    window.__zcodeBgFallbackCfg = undefined;
  } catch (e) {}
  for (const id of [${JSON.stringify(STYLE_ID)}, ${JSON.stringify(UI_STYLE_ID)}, ${JSON.stringify(LAYER_ID)}, '__zcode_bg_video', '__zcode_bg_web', '__zcode_bg_img', '__zcbg_sharp_svg', '__zcode_bg_fallback_style__']) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
  try { window.__zcodeBg = undefined; } catch (e) {}
  return out;
})()`;

const statusSource = `(() => {
  const el = document.getElementById(${JSON.stringify(STYLE_ID)});
  const uiEl = document.getElementById(${JSON.stringify(UI_STYLE_ID)});
  const layer = document.getElementById(${JSON.stringify(LAYER_ID)});
  const cs = getComputedStyle(document.documentElement);
  const api = window.__zcodeBgUi;
  return {
    present: !!el,
    bytes: el ? el.textContent.length : 0,
    uiPresent: !!uiEl || !!layer,
    panelVisible: !!(layer && layer.style.display !== 'none'),
    uiVersion: api ? api.version : 0,
    uiEnabled: api && api.state ? !!api.state.enabled : null,
    video: !!document.getElementById('__zcode_bg_video'),
    web: !!document.getElementById('__zcode_bg_web'),
    htmlBackground: (cs.backgroundImage || '').slice(0, 40),
    themeClass: document.documentElement.className || document.body.className || '',
  };
})()`;

/**
 * 体检：找出“还在挡着壁纸”的大面积不透明层。
 * 原理：壁纸画在 html 画布上，属于最底层；任何压在它上面的不透明大块都会挡住壁纸。
 * 所以从采样点自顶向下找第一个 alpha>=0.9 的元素即可判断该处壁纸是否可见。
 */
const diagnoseSource = `(() => {
  const alphaOf = (c) => {
    if (!c) return 1;
    if (c === 'transparent') return 0;
    if (c.startsWith('rgb')) {
      const parts = c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).split(/[,/]/).map((s) => s.trim());
      return parts.length >= 4 ? parseFloat(parts[3]) : 1;
    }
    if (c.includes('/')) {
      const a = parseFloat(c.slice(c.lastIndexOf('/') + 1).replace(')', ''));
      return Number.isFinite(a) ? a : 1;
    }
    return 1;
  };
  const label = (el) => {
    const cls = (typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '').trim();
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls.split(/\\s+/).slice(0, 4).join('.') : '');
  };
  const vw = innerWidth, vh = innerHeight, varea = vw * vh;
  const blockers = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.5 || r.height < vh * 0.4) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    if (alphaOf(cs.backgroundColor) < 0.9) continue;
    blockers.push({
      area: Math.round((r.width * r.height) / varea * 100),
      bg: cs.backgroundColor,
      el: label(el),
    });
  }
  blockers.sort((a, b) => b.area - a.area);
  const points = [[vw / 2, vh / 2], [vw / 2, 40], [60, vh * 0.45], [vw - 120, vh * 0.7], [vw / 2, vh - 60]];
  const samples = points.map(([x, y]) => {
    const stack = document.elementsFromPoint(x, y) || [];
    const cover = stack.find((el) => alphaOf(getComputedStyle(el).backgroundColor) >= 0.9);
    return {
      at: Math.round(x) + ',' + Math.round(y),
      visible: cover ? '被挡住' : '壁纸可见',
      top: cover ? label(cover) + '  ' + getComputedStyle(cover).backgroundColor : '-',
    };
  });
  const suggests = [...new Set(blockers.flatMap((b) => b.el.match(/bg-[a-z0-9-]+/g) || []))];
  return {
    viewport: vw + 'x' + vh,
    injected: !!document.getElementById(${JSON.stringify(STYLE_ID)}),
    fallback: window.__zcodeBgFallbackInfo || null,
    blockers: blockers.slice(0, 12),
    suggests: suggests.slice(0, 12),
    samples,
  };
})()`;

function printDiagnosis(d) {
  log(`视口 ${d.viewport}　背景样式已注入: ${d.injected ? "是" : "否"}`);
  const fb = d.fallback;
  if (fb && fb.on) {
    if (fb.classes && fb.classes.length)
      log(
        `兜底自愈：配置里的 translucentClasses 有 ${fb.classes.length} 个类名没覆盖到，已自动半透明化 ${fb.surfaces} 个内容表面 → ${JSON.stringify(fb.classes)}`,
      );
    else log("兜底自愈：没有发现需要兜底的大面积实心表面（配置里的类名够用）。");
    if (fb.error) warn(`兜底自愈执行异常：${fb.error}`);
  }
  log("采样点（看壁纸有没有被不透明层挡住）：");
  for (const s of d.samples) log(`  ${String(s.at).padEnd(10)} ${s.visible}　${s.top}`);
  if (d.blockers.length) {
    warn(`发现 ${d.blockers.length} 个大面积不透明层，可能挡住壁纸（按面积占比排序）：`);
    for (const b of d.blockers) warn(`  ${String(b.area + "%").padStart(4)}  ${b.bg.padEnd(22)}  ${b.el}`);
    if (d.suggests.length)
      warn(`→ 可把下面这些类加进 config.json 的 translucentClasses：\n  ${JSON.stringify(d.suggests)}`);
  } else {
    log("没有发现大面积不透明层，壁纸应该能完整透出来。");
  }
}

async function attachTo(target, onBinding) {
  const s = new CdpSession(target);
  await s.open();
  try {
    await s.send("Page.enable", {}, 8000);
  } catch {
    /* Page 域不可用也不影响 Runtime.evaluate */
  }
  // 会话被别的调试客户端抢走时（状态栏守护 / 一次性脚本 / 真打开 DevTools），
  // Chromium 只发 Inspector.detached 事件，WS 不一定关闭——不处理它，注入器就成了
  // “自己不知道已经死了”的僵尸：配置改动不再生效，页面刷新后壁纸也不会回来。
  // 标记 closed 让主循环在下一个 2 秒轮询里自动重附、重新注入。
  s.on("Inspector.detached", (p) => {
    s.closed = true;
    warn(`CDP 会话被接管（原因: ${(p && p.reason) || "未知"}）——将自动重附并重新注入。`);
  });
  if (onBinding) {
    try {
      await s.send("Runtime.enable", {}, 8000);
      await s.send("Runtime.addBinding", { name: BINDING }, 8000);
      s.on("Runtime.bindingCalled", (p) => {
        if (p && p.name === BINDING) onBinding(s, p.payload);
      });
    } catch (e) {
      warn(`设置界面与主进程的通道没建起来（${e.message}）——界面能显示，但改动不会写回 config.json。`);
    }
  }
  return s;
}

/* --------------------------------- 自检 ---------------------------------- */

/** node zcode-bg.mjs --selftest：不连 ZCode，验证 CSS 生成和媒体服务本身。 */
async function selftest() {
  let ok = true;
  const eq = (name, cond) => {
    if (cond) log(`  ✔ ${name}`);
    else {
      ok = false;
      console.error(`  ✖ ${name}`);
    }
  };
  log("自检：");

  const imgCss = cssFromState({
    url: "data:image/png;base64,x",
    type: "image",
    fit: "tile",
    panelAlpha: 0.5,
    dim: 0,
    dimColor: "#000000",
    imageBlurPx: 0,
    translucentClasses: ["bg-background"],
  });
  eq("图片平铺 CSS（tile）", imgCss.includes("background-repeat:repeat") && imgCss.includes("background-size:auto"));

  const vidCss = cssFromState({
    url: "http://127.0.0.1:1/w/abc",
    type: "video",
    fit: "contain",
    align: "top",
    panelAlpha: 0.5,
    dim: 0.2,
    dimColor: "#000000",
    imageBlurPx: 0,
    translucentClasses: [],
  });
  eq(
    "视频壁纸 CSS（contain/顶部留边）",
    vidCss.includes("video#__zcode_bg_video") &&
      vidCss.includes("object-fit:contain") &&
      vidCss.includes("object-position:center top") &&
      !vidCss.includes("background-image:url"),
  );

  try {
    const f = new Function(
      "var document={getElementById:function(){return null}};var window={};(" +
        applyVideoState.toString() +
        ")(null);return window.__zcodeBgVideoCfg === null;",
    );
    eq("applyVideoState 空参数会拆层", f() === true);
  } catch (e) {
    ok = false;
    console.error(`  ✖ applyVideoState: ${e.message}`);
  }
  try {
    const f = new Function(
      "var document={getElementById:function(){return null},createElement:function(){return {style:{},addEventListener:function(){},setAttribute:function(){}}},body:{appendChild:function(){}}};var window={};(" +
        applyWebState.toString() +
        ")(null);return window.__zcodeBgWebCfg === null;",
    );
    eq("applyWebState 空参数会拆层", f() === true);
  } catch (e) {
    ok = false;
    console.error(`  ✖ applyWebState: ${e.message}`);
  }

  // 兜底自愈：升级换了类名时不该“静默失效”。用一个极小的假 DOM 验证它真的
  // 挑出了「大面积 + 实心 + 类名没配过」的那一个，并且绕开弹层和已配置的类名。
  try {
    const mk = (cls, bg, w, h, vars) => {
      const cs = {
        display: "block",
        visibility: "visible",
        opacity: "1",
        pointerEvents: "auto",
        backgroundColor: bg,
        position: "static",
        zIndex: "0",
        getPropertyValue: (n) => (vars && vars[n]) || "",
      };
      return { id: "", className: cls, offsetWidth: w, offsetHeight: h, closest: () => null, _cs: cs };
    };
    const big = mk("bg-surface flex-1", "rgb(20, 20, 20)", 900, 600, { "--color-surface": "#141414" });
    const tiny = mk("bg-chip", "rgb(20, 20, 20)", 40, 20, { "--color-chip": "#141414" });
    const float = mk("bg-popover", "rgb(20, 20, 20)", 900, 600, { "--color-popover": "#141414" });
    float._cs.position = "fixed";
    float._cs.zIndex = "50";
    const configured = mk("bg-background", "rgb(20, 20, 20)", 900, 600, { "--color-background": "#141414" });
    const nodes = [big, tiny, float, configured];
    const run = (state) => {
      const created = [];
      const fakeDoc = {
        hidden: false,
        head: { appendChild: () => {} },
        documentElement: { appendChild: () => {} },
        getElementById: (id) =>
          id === "__zcode_custom_bg_style__" ? { id } : created.find((t) => t.id === id) || null,
        createElement: () => {
          const t = {
            id: "",
            textContent: "",
            remove: () => {
              const i = created.indexOf(t);
              if (i >= 0) created.splice(i, 1);
            },
          };
          created.push(t);
          return t;
        },
        querySelectorAll: () => nodes,
      };
      const fakeWin = {
        innerWidth: 1000,
        innerHeight: 700,
        getComputedStyle: (e) => e._cs,
        MutationObserver: null,
      };
      const fn = new Function(
        "document",
        "window",
        "setInterval",
        `${applyTranslucentFallback.toString()}\nreturn applyTranslucentFallback(${JSON.stringify(state)});`,
      );
      const flag = fn(fakeDoc, fakeWin, () => 0);
      return { flag, info: fakeWin.__zcodeBgFallbackInfo, created };
    };
    const r = run({ enabled: true, panelAlpha: 0.5, translucentClasses: ["bg-background"] });
    eq(
      "兜底自愈挑出未配置的大面积实心表面",
      r.flag === true &&
        r.info.on === true &&
        r.info.surfaces === 1 &&
        JSON.stringify(r.info.classes) === JSON.stringify(["bg-surface"]) &&
        r.created.some((t) => /\[class\*="bg-surface"\]/.test(t.textContent) && /50\.0%, transparent/.test(t.textContent)),
    );
    const off = run({ enabled: true, autoTranslucent: false, panelAlpha: 0.5, translucentClasses: [] });
    eq("兜底自愈可被 autoTranslucent=false 关掉", off.flag === false && off.info.on === false && off.created.length === 0);
  } catch (e) {
    ok = false;
    console.error(`  ✖ 兜底自愈: ${e.message}`);
  }

  // overrides（精细透明化）：面板「🔍 扫描」产出的选择器走 cssFromState 时，
  // 要变成强制透明的规则；能注入任意 CSS 的危险选择器必须被消毒掉。
  try {
    const css = cssFromState({
      enabled: true,
      type: "image",
      url: "http://127.0.0.1:18765/w/x",
      label: "t",
      panelAlpha: 0.5,
      dim: 0,
      dimColor: "#000000",
      imageBlurPx: 0,
      fit: "cover",
      align: "center",
      translucentClasses: [],
      overrides: [".bg-card", "body{color:red}", "a;b", "  ", "nav>div.list"],
      extraCss: "",
    });
    eq(
      "overrides 生成透明化规则并消毒危险选择器",
      css.includes(".bg-card{background:transparent !important}") &&
        css.includes("nav>div.list{background:transparent !important}") &&
        !css.includes("{color:red") &&
        !css.includes("a;b"),
    );
    const many = cssFromState({
      enabled: true,
      type: "image",
      panelAlpha: 0.5,
      translucentClasses: [],
      overrides: Array.from({ length: 30 }, (_, i) => `.bg-x${i}`),
      extraCss: "",
    });
    eq("overrides 最多下发 24 条", (many.match(/\.bg-x\d+\{background:transparent/g) || []).length === 24);

    // v11：overrides 对象形式 —— 每块区域自定义半透明颜色（吸收 Zcode-Wallpaper 的 background_overrides）
    const mixed = cssFromState({
      enabled: true,
      type: "image",
      panelAlpha: 0.5,
      translucentClasses: [],
      overrides: [
        ".bg-card",
        { selector: "div.panel", background: "rgba(0, 0, 0, 0.35)" },
        { selector: "aside", background: "url(//evil.example/x.png)" },
        { selector: "nav", background: "rgba(0,0,0,.4); } body{display:none" },
        { selector: "header", background: "transparent !important" },
        { selector: "", background: "#fff" },
        { selector: ".ok", background: 42 },
      ],
      extraCss: "",
    });
    eq(
      "overrides 对象形式生成调色规则并消毒危险背景值",
      mixed.includes(".bg-card{background:transparent !important}") &&
        mixed.includes("div.panel{background:rgba(0, 0, 0, 0.35) !important}") &&
        !mixed.includes("evil.example") &&
        !mixed.includes("body{display:none") &&
        !mixed.includes("header{") &&
        !mixed.includes(".ok{"),
    );
  } catch (e) {
    ok = false;
    console.error(`  ✖ overrides: ${e.message}`);
  }

  // 回归：背景脚本和界面脚本是两段独立的 IIFE，拼接时必须保住语句边界。
  // 历史 bug（07:1x 真机发现）：只用一个换行拼接，ASI 不插分号，两段被解析成
  // `(...)()(ui)()` 调用链 → 界面整段没执行。症状是「刷新后壁纸在、面板不见了」。
  // 这里用一个金丝雀 IIFE 冒充界面脚本：它跑到了，就说明拼接是安全的。
  try {
    const created = [];
    const fakeDoc = {
      hidden: false,
      readyState: "complete",
      head: { appendChild: () => {} },
      documentElement: { appendChild: () => {} },
      getElementById: () => null,
      createElement: () => {
        const t = { id: "", textContent: "" };
        created.push(t);
        return t;
      },
      addEventListener: () => {},
    };
    globalThis.__zcbgUiSpy = 0;
    const spy = "(() => { globalThis.__zcbgUiSpy = (globalThis.__zcbgUiSpy || 0) + 1; })()";
    const fn = new Function("document", "window", "setTimeout", composeInjectionSource("html{background:#000}", null, null, spy));
    fn(fakeDoc, {}, () => 0);
    eq(
      "背景脚本 + 界面脚本拼接后两段都会执行（ASI 回归）",
      globalThis.__zcbgUiSpy === 1 && created.length === 1,
    );
    delete globalThis.__zcbgUiSpy;
  } catch (e) {
    ok = false;
    console.error(`  ✖ 注入源码拼接: ${e.message}`);
  }

  // 回归：「设置 → 壁纸」面板存盘时发上来的每一个键，主进程的白名单都必须放行。
  // 历史 bug（07:19 真机发现）：面板把 autoTranslucent 发上来了，但 handleUiMessage
  // 里 msg.op === "config" 那段白名单没有这一项 → 配置根本没写进去 → 紧接着的
  // applyToWindowForAll() 又把配置里的旧值推回页面 → 开关点一下、一两秒后自己弹回去。
  // 这里直接拿两份源码对账，以后再加开关忘了放行就会在这里红。
  try {
    const uiSrc = fs.readFileSync(UI_SCRIPT_PATH, "utf8").replace(/^\uFEFF/, "");
    const selfSrc = fs.readFileSync(path.join(SCRIPT_DIR, "zcode-bg.mjs"), "utf8");
    const patchBlock = /patch:\s*\{([^}]*)\}/.exec(uiSrc);
    const uiKeys = patchBlock ? [...patchBlock[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]) : [];
    // 这段自检代码自己也含 "if (msg.op === \"config\")" 字面量，所以用 lastIndexOf 定位真正的那个
    const from = selfSrc.lastIndexOf('if (msg.op === "config")');
    const to = selfSrc.indexOf('if (msg.op === "image")', from);
    const cfgBlock = from >= 0 && to > from ? selfSrc.slice(from, to) : "";
    const blocked = uiKeys.filter((k) => !new RegExp(`p\\.${k}\\b`).test(cfgBlock));
    if (blocked.length) console.error(`      面板发来但主进程没放行：${blocked.join(", ")}`);
    eq(`面板保存的键主进程全部放行（${uiKeys.length} 个）`, uiKeys.length >= 9 && blocked.length === 0);
  } catch (e) {
    ok = false;
    console.error(`  ✖ 面板/主进程键对齐: ${e.message}`);
  }

  // 回归：界面上发得出去的每一种 op，主进程都必须有对应分支——
  // 否则点了没反应，而且很难查（历史上 autoTranslucent 就是栽在「配置发了没人接」上）。
  try {
    const uiSrc = fs.readFileSync(UI_SCRIPT_PATH, "utf8").replace(/^\uFEFF/, "");
    const selfSrc = fs.readFileSync(path.join(SCRIPT_DIR, "zcode-bg.mjs"), "utf8");
    const ops = [...new Set([...uiSrc.matchAll(/send\(\{\s*op:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]))];
    const missing = ops.filter((o) => !selfSrc.includes(`msg.op === "${o}"`));
    if (missing.length) console.error(`      界面发得出去但主进程没接：${missing.join(", ")}`);
    eq(`界面发出的操作主进程都有分支（${ops.length} 种：${ops.join("/")}）`, ops.length >= 5 && missing.length === 0);
  } catch (e) {
    ok = false;
    console.error(`  ✖ 界面 op / 主进程分支对齐: ${e.message}`);
  }

  // 回归：Wallpaper Engine 工坊条目解析 —— 多视频分段、低清封面隐藏、分辨率解析、
  // 缺 project.json 的目录跳过。用临时假工坊目录验证。
  try {
    const tmp = path.join(SCRIPT_DIR, `.selftest-we-${process.pid}`);
    const png = (w, h) => {
      // 最小 PNG 头：签名 + IHDR（宽高在固定偏移），imgDims 只读头，不校验 CRC
      const b = Buffer.alloc(33);
      b.write("89504e470d0a1a0a", 0, "hex");
      b.writeUInt32BE(13, 8);
      b.write("IHDR", 12, "latin1");
      b.writeUInt32BE(800, 16);
      b.writeUInt32BE(450, 20);
      return b;
    };
    const gif = (w, h) => {
      const b = Buffer.alloc(14);
      b.write("GIF89a", 0, "latin1");
      b.writeUInt16LE(w, 6);
      b.writeUInt16LE(h, 8);
      return b;
    };
    const mk = (id, pj, files) => {
      const d = path.join(tmp, id);
      fs.mkdirSync(d, { recursive: true });
      if (pj) fs.writeFileSync(path.join(d, "project.json"), JSON.stringify(pj));
      for (const [n, data] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true });
        fs.writeFileSync(path.join(d, n), typeof data === "number" ? Buffer.alloc(data) : data);
      }
      return d;
    };
    const B = (kb) => 600 * 1024 + Number(kb); // 一定超过 512KB 的贴图门槛
    mk("111", { title: "视频壁纸", type: "video", file: "main.mp4", preview: "preview.jpg" }, { "main.mp4": B(1), "preview.jpg": 10 });
    // 222 的分段名带时段词（morning/day）→ 合并成一个「随时间」条目
    mk("222", { title: "分段场景", type: "scene", preview: "preview.gif" }, { "videos/day.mp4": B(2), "videos/morning.mp4": B(0), "small.mp4": 100, "preview.gif": gif(254, 254) });
    mk("333", { title: "低清封面", type: "scene", preview: "preview.gif" }, { "preview.gif": gif(254, 254) });
    mk("444", { title: "高清静帧", type: "scene", preview: "poster.png" }, { "poster.png": png(800, 450) });
    mk("555", { title: "多段无时段", type: "video", file: "part1.mp4" }, { "part1.mp4": B(3), "part2.mp4": B(1) });
    fs.mkdirSync(path.join(tmp, "666"), { recursive: true }); // 没有 project.json 的目录
    const pinnedAll = ["111", "222", "333", "444", "555"];
    try {
      const r = weLibraryEntries(tmp, [], pinnedAll);
      eq("WE 工坊：条目解析（1 时间合并 + 2 无时段分段 + 1 可用静帧 + 1 导入后强列的低清封面）", r.entries.length === 6 && r.entries.some((e) => e.forced === true && e.name === "低清封面"));
      eq("WE 工坊：video 项目取 file 字段的视频", r.entries.some((e) => e.kind === "视频" && e.name === "视频壁纸" && path.basename(e.rel) === "main.mp4" && e.type === "video"));
      const tm = r.entries.find((e) => e.time);
      eq(
        "WE 工坊：时段分段合并成一个「随时间」条目",
        !!tm && tm.name === "分段场景" && tm.kind === "随时间" && tm.rel === "we-time://222" && tm.segments.length === 2 && tm.segments.map((s) => s.seg).join(",") === "morning,day",
      );
      const segs = r.entries.filter((e) => e.name.startsWith("多段无时段 · "));
      eq("WE 工坊：多视频场景分段列出且大的在前", segs.length === 2 && path.basename(segs[0].rel) === "part1.mp4" && path.basename(segs[1].rel) === "part2.mp4");
      const still = r.entries.find((e) => e.kind === "静帧");
      eq("WE 工坊：够大的预览图（≥600px）列为静帧", !!still && still.type === "image" && still.w === 800 && still.h === 450);
      eq("WE 工坊：导入的项目低清封面强制列出（不再计入 weLow）", r.low === 0);
      eq("WE 工坊：不存在的工坊目录返回空", weLibraryEntries(path.join(tmp, "不存在"), [], pinnedAll).entries.length === 0);
      eq("WE 工坊：PNG/GIF 尺寸解析", JSON.stringify(imgDims(path.join(tmp, "444", "poster.png"))) === '{"w":800,"h":450}' && JSON.stringify(imgDims(path.join(tmp, "222", "preview.gif"))) === '{"w":254,"h":254}');
      // v24：区块只列「导入过」的项目——不在 wePinned 里的项目连扫都不扫
      const rImp = weLibraryEntries(tmp, [], ["111", "222", "444", "555"]);
      eq("WE 工坊：未导入的项目不自动出现（新下载不自动读取）", rImp.entries.length === 5 && rImp.low === 0);
      eq("WE 工坊：不传导入清单 = 区块为空", weLibraryEntries(tmp, [], []).entries.length === 0);
      eq("WE 工坊：weHidden 优先（hidden 的项目即使在 wePinned 里也跳过）", weLibraryEntries(tmp, ["111"], pinnedAll).entries.every((e) => e.name !== "视频壁纸"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    ok = false;
    console.error(`  ✖ WE 工坊解析: ${e.message}`);
  }

  // 回归：scene.pkg 抽取 —— 内嵌 MP4 当视频分段、纹理升级低清静帧、裸 RGBA 编码 PNG。
  // 手工构造最小 PKGV0001 包（结构见 pkgTextureCandidates）。
  try {
    const tmp = path.join(SCRIPT_DIR, `.selftest-we-pkg-${process.pid}`);
    const cacheDir = path.join(SCRIPT_DIR, ".we-pkg-cache");
    const before = new Set(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []);
    const u32 = (v) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(v >>> 0);
      return b;
    };
    const mkTex = ({ format = 0, fif = -1, iw, ih, mw, mh, lz4 = 0, dec = 0, data }) => {
      const parts = [Buffer.from("TEXV0005\0TEXI0001\0", "latin1"), u32(format), u32(0), u32(mw), u32(mh), u32(iw), u32(ih), u32(0), Buffer.from("TEXB0003\0", "latin1"), u32(1), u32(fif >>> 0)];
      parts.push(u32(1), u32(mw), u32(mh), u32(lz4), u32(dec), u32(data.length), data);
      return Buffer.concat(parts);
    };
    const mkPkg = (texs) => {
      const chunks = [u32(8), Buffer.from("PKGV0001", "latin1"), u32(texs.length)];
      let off = 0;
      texs.forEach((t) => {
        const nb = Buffer.from("materials/" + t.seg + ".tex", "utf8");
        chunks.push(u32(nb.length), nb, u32(off), u32(t.buf.length));
        off += t.buf.length;
      });
      texs.forEach((t) => chunks.push(t.buf));
      return Buffer.concat(chunks);
    };
    const gifLow = (() => {
      const b = Buffer.alloc(14);
      b.write("GIF89a", 0, "latin1");
      b.writeUInt16LE(254, 6);
      b.writeUInt16LE(254, 8);
      return b;
    })();
    // imgDims 只读 IHDR，假的 PNG 头就够；IW/IH 用 tex 头里声明的 1600×900
    const fakePng = (() => {
      const b = Buffer.alloc(33);
      b.write("89504e470d0a1a0a", 0, "hex");
      b.writeUInt32BE(13, 8);
      b.write("IHDR", 12, "latin1");
      b.writeUInt32BE(1600, 16);
      b.writeUInt32BE(900, 20);
      return b;
    })();
    const RW = 1608, RH = 904; // 裸 RGBA：带 mip 对齐边，裁到 1600×900
    // v28 回归夹具：分层场景里最大的纹理是透明人物图层，更小的 bg 是完整画面——静帧必须选 bg
    const fakeJpg = Buffer.from("ffd8ffe000104a46494600", "hex");
    const transPng = rgbaToPng(Buffer.alloc(2000 * 1000 * 4, 0), 2000, 1000); // 全透明 → ct6
    const mk = (id, pj, files) => {
      const d = path.join(tmp, id);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "project.json"), JSON.stringify(pj));
      for (const [n, data] of Object.entries(files)) fs.writeFileSync(path.join(d, n), data);
      return d;
    };
    const mp4Head = Buffer.alloc(600 * 1024);
    Buffer.from("ftypisom", "latin1").copy(mp4Head, 4);
    mk("a1", { title: "内嵌视频场景", type: "scene", preview: "preview.gif" }, { "preview.gif": gifLow, "scene.pkg": mkPkg([{ seg: "横屏", buf: mkTex({ fif: -1, iw: 3840, ih: 2160, mw: 3840, mh: 2160, data: mp4Head }) }]) });
    mk("a2", { title: "纹理静帧", type: "scene", preview: "preview.gif" }, { "preview.gif": gifLow, "scene.pkg": mkPkg([{ seg: "bg", buf: mkTex({ fif: 13, iw: 1600, ih: 900, mw: 1600, mh: 900, data: fakePng }) }]) });
    mk("a3", { title: "裸纹理解码", type: "scene", preview: "preview.gif" }, { "preview.gif": gifLow, "scene.pkg": mkPkg([{ seg: "bg", buf: mkTex({ fif: -1, iw: 1600, ih: 900, mw: RW, mh: RH, data: Buffer.alloc(RW * RH * 4, 0x40) }) }]) });
    mk("a4", { title: "分层场景", type: "scene", preview: "preview.gif" }, { "preview.gif": gifLow, "scene.pkg": mkPkg([{ seg: "人物图层", buf: mkTex({ fif: 13, iw: 2000, ih: 1000, mw: 2000, mh: 1000, data: transPng }) }, { seg: "bg", buf: mkTex({ fif: 2, iw: 1600, ih: 900, mw: 1600, mh: 900, data: fakeJpg }) }]) });
    try {
      const r = weLibraryEntries(tmp, [], ["a1", "a2", "a3", "a4"]);
      const vid = r.entries.find((e) => e.name === "内嵌视频场景");
      eq("WE scene.pkg：内嵌 MP4 抽成视频条目（尺寸取 tex 头）", !!vid && vid.type === "video" && vid.w === 3840 && vid.h === 2160 && vid.kind === "素材");
      const stills = r.entries.filter((e) => e.type === "image");
      eq("WE scene.pkg：纹理当高清静帧，尺寸来自 tex 头", stills.length === 3 && stills.every((s) => s.kind === "静帧"));
      eq("WE scene.pkg：裸 RGBA 编码出的 PNG 可解析出裁剪后尺寸", stills.some((s) => JSON.stringify(imgDims(s.rel)) === '{"w":1600,"h":900}'));
      // v28：分层场景的静帧选图——大图常是透明人物/装饰图层，拿它当整幅壁纸就是乱码；
      // 候选带 opaque 标记（jpg/DXT1/无 alpha PNG），不透明的排前面
      const lay = r.entries.find((e) => e.name === "分层场景");
      eq("WE scene.pkg：静帧优先选不透明纹理（透明大图层让位给小的完整 bg）", !!lay && lay.type === "image" && /\.jpg$/i.test(lay.rel) && lay.w === 1600 && lay.h === 900);
      eq("WE scene.pkg：裸 RGBA 编码出的 PNG 可解析出裁剪后尺寸", stills.some((s) => JSON.stringify(imgDims(s.rel)) === '{"w":1600,"h":900}'));
      // 完整解码校验：chunk 链闭合、CRC 正确、IDAT 解压长度精确等于 (stride+1)*h。
      // 之前 pngChunk 把 data 拼了两遍，imgDims 只读头发现不了，浏览器直接 onerror。
      // a2 的直存 PNG 也会进缓存（33 字节假头），所以按 wePkgMedia 的缓存键精确锁定 a3 的产物。
      const pkgPath = path.join(tmp, "a3", "scene.pkg");
      const pst = fs.statSync(pkgPath);
      const key = crypto.createHash("sha1").update(`${path.resolve(pkgPath).toLowerCase()}|${pst.size}|${Math.floor(pst.mtimeMs)}`).digest("hex").slice(0, 8);
      const encPath = path.join(cacheDir, `${key}-bg.png`);
      if (fs.existsSync(encPath)) {
        const b = fs.readFileSync(encPath);
        let p = 8, idat = [], crcOk = true, ended = false;
        const crc32 = (td) => {
          let c = -1;
          for (const x of td) c = PNG_CRC_T[(c ^ x) & 255] ^ (c >>> 8);
          return (c ^ -1) >>> 0;
        };
        while (p + 12 <= b.length) {
          const len = b.readUInt32BE(p), type = b.toString("latin1", p + 4, p + 8);
          if (p + 12 + len > b.length) { crcOk = false; break; }
          if (crc32(b.subarray(p + 4, p + 8 + len)) !== b.readUInt32BE(p + 8 + len)) crcOk = false;
          if (type === "IDAT") idat.push(b.subarray(p + 8, p + 8 + len));
          p += 12 + len;
          if (type === "IEND") { ended = true; break; }
        }
        let rows = -1;
        try { rows = zlib.inflateSync(Buffer.concat(idat)).length; } catch {}
        // a3 测试像素 alpha=0x40 → 编码器走 ct6/4 字节路径
        eq("WE scene.pkg：编码 PNG 的 chunk 链/CRC/IDAT 解压长度全部正确", crcOk && ended && p === b.length && rows === (1600 * 4 + 1) * 900);
      } else eq("WE scene.pkg：按缓存键找到 a3 编码产物", false);
      if (fs.existsSync(cacheDir)) {
        for (const f of fs.readdirSync(cacheDir)) if (!before.has(f)) fs.rmSync(path.join(cacheDir, f), { force: true });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    ok = false;
    console.error(`  ✖ WE scene.pkg 抽取: ${e.message}`);
  }

  // 回归：画质三件套（v34）—— mp4 真实码率、低码率判据、无损优先抽取、DXT 标记、
  // sharpen 配置链路（uiState/videoStateFor/imageStateFor/sharpenStateFor/cssFromState）。
  try {
    // 最小 mp4：ftyp + moov{ mvhd(v0) + trak{tkhd(v0) + mdia{minf{stbl{stsd(avc1)}}}} }
    const u32be = (v) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(v >>> 0);
      return b;
    };
    const box = (type, ...payload) => {
      const b = Buffer.concat([Buffer.alloc(8), ...payload]);
      b.writeUInt32BE(b.length, 0);
      b.write(type, 4, "latin1");
      return b;
    };
    const mkMp4 = ({ w, h, durS, codec = "avc1" }) => {
      // tkhd v0：box 头 8 + ver/flags 4 + 72 字节字段 = 84，宽高（16.16 定点）在 box+84/+88
      const tkhdPayload = Buffer.alloc(84);
      tkhdPayload.writeUInt32BE(Math.round(w * 65536), 76);
      tkhdPayload.writeUInt32BE(Math.round(h * 65536), 80);
      const tk = box("tkhd", tkhdPayload);
      const stsd = box("stsd", Buffer.alloc(4), u32be(1), box(codec, Buffer.alloc(8)));
      const trak = box("trak", tk, box("mdia", box("minf", box("stbl", stsd))));
      // mvhd v0：timescale 在 box+20、duration 在 box+24（parser 是从 box 头算的偏移）
      const mvhdPayload = Buffer.alloc(92);
      mvhdPayload.writeUInt32BE(1000, 12);
      mvhdPayload.writeUInt32BE(Math.round(durS * 1000), 16);
      const mv = box("mvhd", mvhdPayload);
      return Buffer.concat([box("ftyp", Buffer.from("isom", "latin1")), box("moov", mv, trak)]);
    };
    const mp4Path = path.join(SCRIPT_DIR, `.selftest-quality-${process.pid}.mp4`);
    fs.writeFileSync(mp4Path, mkMp4({ w: 3840, h: 2160, durS: 4 }));
    const info = mp4Dims(mp4Path);
    eq("画质：mp4 头解析出宽高 + 时长 + 编码", !!info && info.w === 3840 && info.h === 2160 && Math.abs(info.durS - 4) < 0.01 && info.codec === "avc1");
    eq("画质：码率 = 大小÷时长（6MB/4s = 12 Mbps）", bitrateMbpsOf(6e6, info) === 12);
    eq("画质：低码率判据（4K<10 / 1080p<3.5 档位）", lowBitrateOf(3840, 2160, 9) === true && lowBitrateOf(3840, 2160, 12) === false && lowBitrateOf(1920, 1080, 3) === true && lowBitrateOf(1920, 1080, 4) === false && lowBitrateOf(0, 0, 1) === false);

    // sharpen 配置链路：uiState → videoStateFor/imageStateFor/sharpenStateFor → CSS
    const imgFile = path.join(SCRIPT_DIR, `.selftest-quality-${process.pid}.png`);
    fs.writeFileSync(imgFile, Buffer.from("89504e470d0a1a0a", "hex"));
    const cfgSharpen = { wallpaper: imgFile, enabled: true, embedAsDataUrl: false, sharpen: 0.5 };
    eq("画质：uiState 透传 sharpen、videoStateFor 带上锐化", uiState(cfgSharpen).sharpen === 0.5 && videoStateFor({ wallpaper: mp4Path, enabled: true, sharpen: 0.4 }).sharpen === 0.4);
    const imgState = imageStateFor(cfgSharpen);
    eq("画质：开锐化时图片走 <img> 层（有 url/fit），关锐化或平铺回到 CSS 老路径", !!imgState && imgState.type === "image" && !!imgState.url && imageStateFor({ wallpaper: imgFile, enabled: true, sharpen: 0 }) === null && imageStateFor({ wallpaper: imgFile, enabled: true, sharpen: 0.5, fit: "tile" }) === null);
    eq("画质：sharpenStateFor（0→null，>0→{sharpen}，关壁纸→null）", sharpenStateFor({ wallpaper: imgFile, enabled: true, sharpen: 0 }) === null && JSON.stringify(sharpenStateFor({ wallpaper: imgFile, enabled: true, sharpen: 0.5 })) === '{"sharpen":0.5}' && sharpenStateFor({ wallpaper: imgFile, enabled: false, sharpen: 0.5 }) === null);
    const cssOn = buildCss({ wallpaper: imgFile, enabled: true, embedAsDataUrl: false, sharpen: 0.5 });
    const cssOff = buildCss({ wallpaper: imgFile, enabled: true, embedAsDataUrl: false, sharpen: 0 });
    eq("画质：锐化 CSS——图片切 <img> 层且 html 不再带背景图；关掉恢复背景图写法", cssOn.includes("img#__zcode_bg_img{") && !cssOn.includes("background-image:url(") && cssOff.includes("background-image:url(") && !cssOff.includes("img#__zcode_bg_img{"));
    fs.rmSync(imgFile, { force: true });
    fs.rmSync(mp4Path, { force: true });

    // 无损优先抽取：DXT1 大纹理（有损）让位给面积略小的直存 PNG（无损）；只有 DXT 时条目带 dxt 标记
    const u32 = (v) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(v >>> 0);
      return b;
    };
    const mkTex = ({ format = 0, fif = -1, iw, ih, mw, mh, data }) => {
      const parts = [Buffer.from("TEXV0005\0TEXI0001\0", "latin1"), u32(format), u32(0), u32(mw), u32(mh), u32(iw), u32(ih), u32(0), Buffer.from("TEXB0003\0", "latin1"), u32(1), u32(fif >>> 0)];
      parts.push(u32(1), u32(mw), u32(mh), u32(0), u32(0), u32(data.length), data);
      return Buffer.concat(parts);
    };
    const mkPkg = (texs) => {
      const chunks = [u32(8), Buffer.from("PKGV0001", "latin1"), u32(texs.length)];
      let off = 0;
      texs.forEach((t) => {
        const nb = Buffer.from("materials/" + t.seg + ".tex", "utf8");
        chunks.push(u32(nb.length), nb, u32(off), u32(t.buf.length));
        off += t.buf.length;
      });
      texs.forEach((t) => chunks.push(t.buf));
      return Buffer.concat(chunks);
    };
    const fakePng = (w, h) => {
      const b = Buffer.alloc(33);
      b.write("89504e470d0a1a0a", 0, "hex");
      b.writeUInt32BE(13, 8);
      b.write("IHDR", 12, "latin1");
      b.writeUInt32BE(w, 16);
      b.writeUInt32BE(h, 20);
      return b;
    };
    const tmpQ = path.join(SCRIPT_DIR, `.selftest-we-quality-${process.pid}`);
    const mkQ = (id, files) => {
      const d = path.join(tmpQ, id);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "project.json"), JSON.stringify({ title: id, type: "scene", preview: "preview.gif" }));
      fs.writeFileSync(path.join(d, "preview.gif"), "GIF89a");
      for (const [n, data] of Object.entries(files)) fs.writeFileSync(path.join(d, n), data);
      return d;
    };
    // DXT1 1800×1000（面积大但 0.78 折算）vs 直存 PNG 1750×950（无损 1.0）——PNG 赢
    const dxtData = Buffer.alloc(Math.ceil(1800 / 4) * Math.ceil(1000 / 4) * 8, 0x11);
    mkQ("q1", { "scene.pkg": mkPkg([{ seg: "dxt大图", buf: mkTex({ format: 7, iw: 1800, ih: 1000, mw: 1800, mh: 1000, data: dxtData }) }, { seg: "png无损", buf: mkTex({ fif: 13, iw: 1750, ih: 950, mw: 1750, mh: 950, data: fakePng(1750, 950) }) }]) });
    mkQ("q2", { "scene.pkg": mkPkg([{ seg: "只有dxt", buf: mkTex({ format: 7, iw: 1800, ih: 1000, mw: 1800, mh: 1000, data: dxtData }) }]) });
    const cacheBefore = new Set(fs.existsSync(path.join(SCRIPT_DIR, ".we-pkg-cache")) ? fs.readdirSync(path.join(SCRIPT_DIR, ".we-pkg-cache")) : []);
    try {
      const r = weLibraryEntries(tmpQ, [], ["q1", "q2"]);
      const still1 = r.entries.find((e) => e.name === "q1" && e.type === "image");
      eq("画质：静帧无损优先——面积接近时选直存 PNG 而不是更大的 DXT1", !!still1 && still1.rel.includes("png无损") && still1.w === 1750 && still1.h === 950 && !still1.dxt);
      const still2 = r.entries.find((e) => e.name === "q2" && e.type === "image");
      eq("画质：只有 DXT 纹理时照常列出，并带「有损纹理」标记", !!still2 && still2.rel.includes("只有dxt") && still2.dxt === true && still2.w === 1800 && still2.h === 1000);
    } finally {
      const cacheDir = path.join(SCRIPT_DIR, ".we-pkg-cache");
      if (fs.existsSync(cacheDir)) for (const f of fs.readdirSync(cacheDir)) if (!cacheBefore.has(f)) fs.rmSync(path.join(cacheDir, f), { force: true });
      fs.rmSync(tmpQ, { recursive: true, force: true });
    }
  } catch (e) {
    ok = false;
    console.error(`  ✖ 画质三件套: ${e.message}`);
  }

  // 回归：「壁纸库 ✕ 删除」只能删 wallpaper\ 下的直接子文件。
  // 这里真建一个文件删掉；再用各种越界/目录/示例图名字去撞，必须全被拒。
  try {
    const wallDir = path.join(SCRIPT_DIR, "wallpaper");
    fs.mkdirSync(wallDir, { recursive: true });
    const probe = path.join(wallDir, `selftest-del-${process.pid}.png`);
    try {
      fs.writeFileSync(probe, Buffer.from("delete-me"));
      const d = deleteWallpaperItem(path.basename(probe));
      eq("壁纸库删除：能删掉 wallpaper\\ 下的文件", d.base === path.basename(probe) && !fs.existsSync(probe));
      const bad = ["../config.json", "..\\config.json", "wallpaper/config.json", "C:\\Windows\\win.ini", "", "   ", ".hidden", "sample-gradient.png"];
      const leaked = [];
      for (const n of bad) {
        try {
          leaked.push(`${JSON.stringify(n)} → ${wallpaperChildName(n)}`);
        } catch {
          /* 预期就是抛错 */
        }
      }
      if (leaked.length) console.error(`      这些名字本该被拒绝：${leaked.join(" | ")}`);
      eq(`壁纸库删除：拒绝越界 / 目录 / 示例图 / 空名（${bad.length} 个）`, leaked.length === 0);
      eq("壁纸库删除：正常文件名的首尾空格会被去掉", wallpaperChildName("  生活照.png  ") === "生活照.png");
      let msg = "";
      try {
        resolveWallpaperChild("绝对不存在的文件.png");
      } catch (e) {
        msg = e.message;
      }
      eq("壁纸库删除：文件不存在时给中文提示", /不在了/.test(msg));
    } finally {
      try {
        fs.rmSync(probe, { force: true });
      } catch {}
    }
  } catch (e) {
    ok = false;
    console.error(`  ✖ 壁纸库删除: ${e.message}`);
  }

  // 回归：壁纸库 /list 条目要带 w/h（面板卡片的分辨率角标靠它）。
  // 之前 items 里没有尺寸，壁纸库卡片永远不显示 4K/2K 角标，和创意工坊区块不一致。
  try {
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcbg-dims-"));
    try {
      const px = Buffer.alloc(8 * 8 * 4, 0x80);
      fs.writeFileSync(path.join(tmp, "pic.png"), rgbaToPng(px, 8, 8));
      fs.writeFileSync(path.join(tmp, "note.txt"), "not media");
      let captured = null;
      const fakeRes = {
        writeHead: () => {},
        end: (payload) => {
          captured = payload;
        },
      };
      const savedWeDir = media.weDir;
      media.weDir = ""; // 只测本机库区块，不碰真工坊
      try {
        handleList({ writeHead: () => {}, end: (p) => { captured = p; } }, tmp, {}, () => [], () => []);
      } finally {
        media.weDir = savedWeDir;
      }
      const parsed = JSON.parse(captured);
      const pic = parsed.items.find((x) => x.name === "pic.png");
      const txt = parsed.items.find((x) => x.name === "note.txt");
      eq("壁纸库 /list：图片条目带 w/h（8×8）", !!pic && pic.w === 8 && pic.h === 8);
      eq("壁纸库 /list：非媒体文件不给 w/h 也不报错", !!txt && txt.w === undefined && txt.h === undefined);
      // 缓存命中：同文件再取一次必须一致（mtime/size 相同）
      const st = fs.statSync(path.join(tmp, "pic.png"));
      eq("壁纸库 /list：cachedMediaDims 同文件二次读取一致", JSON.stringify(cachedMediaDims(path.join(tmp, "pic.png"), st)) === '{"w":8,"h":8}');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    ok = false;
    console.error(`  ✖ 壁纸库 /list 尺寸: ${e.message}`);
  }

  // 回归：工坊导入——选中文件反查项目目录、wePinned 把低清封面项目强制列进区块。
  // （这里不能直接用 os：本模块顶部没导入它，自检块 2900 行附近才有个局部 const os，提前用会 TDZ）
  try {
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcbg-imp-"));
    try {
      const weDir = path.join(tmp, "431960");
      const proj = path.join(weDir, "1111111111");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "project.json"), JSON.stringify({ title: "导入测试", type: "scene", preview: "preview.png" }));
      // 8×8 的 PNG（低于 WE_MIN_PREVIEW=600）：rgbaToPng 产合法 PNG，imgDims 按扩展名走 PNG 解析可读尺寸
      const px = Buffer.alloc(8 * 8 * 4, 0x80);
      fs.writeFileSync(path.join(proj, "preview.png"), rgbaToPng(px, 8, 8));
      // 反查：项目里任意深度的文件都能定位回项目根；工坊外的文件拒绝
      // 反查：项目里任意深度的文件都能定位回项目根；工坊外的文件拒绝
      // （注意 v.mp4 要 <512KB：≥512KB 会被当正片视频列出，项目就不走「低清封面」分支了）
      const deep = path.join(proj, "sub", "v.mp4");
      fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
      fs.writeFileSync(deep, Buffer.alloc(64, 1));
      eq("工坊导入：目录清单含全部项目（隐藏/可见都列出）", weProjectCatalog(weDir).length === 1 && weProjectCatalog(weDir)[0].title === "导入测试" && !!weProjectCatalog(weDir)[0].preview);
      eq("工坊导入：非项目目录被跳过", (() => {
        fs.mkdirSync(path.join(weDir, "not-a-project"), { recursive: true });
        return weProjectCatalog(weDir).every((p) => p.src !== "not-a-project");
      })());
      // 只有 8×8 低清封面：默认不扫（未导入的项目根本不出现）；pin 了强制列出（forced 标记）
      const plain = weLibraryEntries(weDir, [], []);
      const pinned = weLibraryEntries(weDir, [], ["1111111111"]);
      eq(
        "工坊导入：未导入不出现、导入后强制列出",
        plain.entries.length === 0 && plain.low === 0 && pinned.entries.length === 1 && pinned.entries[0].name === "导入测试" && pinned.entries[0].forced === true && pinned.low === 0,
      );
      // weHidden + wePinned 并存时 weHidden 优先（✕ 删除优先于导入），但 wePick 会先摘 weHidden
      const both = weLibraryEntries(tmp, ["1111111111"], ["1111111111"]);
      eq("工坊导入：weHidden 优先于 wePinned（✕ 删除说了算）", both.entries.length === 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    ok = false;
    console.error(`  ✖ 工坊导入: ${e.message}`);
  }

  // 回归：WE 工坊条目的「✕」——只删 .we-pkg-cache 里同键前缀的抽取产物，越界/乱名拒绝，
  // weHidden 里的工坊项目整个从 /list 消失（否则下次扫描把缓存原样抽回来）。
  try {
    const cacheDir = path.join(SCRIPT_DIR, ".we-pkg-cache");
    const mk = (key, name) => {
      const f = path.join(cacheDir, `${key}-${name}`);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(f, Buffer.from("cache-" + key));
      return f;
    };
    const delFile = mk("deadbeef", "背景.png");
    const keepFile = mk("feedface", "别的项目.png");
    const bad = [
      "wallpaper\\逃逸.png", // 缓存目录外
      "C:\\Windows\\win.ini",
      ".we-pkg-cache\\没有键前缀.png",
      "..\\config.json",
      "",
    ];
    const leaked = [];
    for (const r of bad) {
      try {
        leaked.push(`${JSON.stringify(r)} → 键 ${weCacheKeyFromRel(r).key}`);
      } catch {
        /* 预期就是抛错 */
      }
    }
    if (leaked.length) console.error(`      这些 rel 本该被拒绝：${leaked.join(" | ")}`);
    eq("WE 缓存删除：拒绝越界 / 无键前缀 / 空名（5 个）", leaked.length === 0);
    const d = deleteWeCacheItem(delFile);
    eq("WE 缓存删除：按键前缀删干净（同项目全部分段一起删）", !fs.existsSync(delFile) && fs.existsSync(keepFile) && d.count === 1 && d.removed[0] === path.basename(delFile));
    fs.rmSync(keepFile, { force: true });
    // 隐藏清单：weLibraryEntries 跳过 weHidden 里的工坊目录（多项目合成时视频分段也要藏）
    const fakeWe = path.join(SCRIPT_DIR, `.selftest-we-hidden-${process.pid}`);
    const mkProject = (id) => {
      const d2 = path.join(fakeWe, id);
      fs.mkdirSync(d2, { recursive: true });
      fs.writeFileSync(path.join(d2, "project.json"), JSON.stringify({ title: "P" + id, type: "video", file: "v.mp4" }));
      fs.writeFileSync(path.join(d2, "v.mp4"), Buffer.alloc(600 * 1024, 1));
      return d2;
    };
    mkProject("111111");
    mkProject("222222");
    // v24：只扫 wePinned 里的项目；weHidden 优先于 wePinned
    const withHide = weLibraryEntries(fakeWe, ["111111"], ["111111", "222222"]);
    const noHide = weLibraryEntries(fakeWe, [], ["111111", "222222"]);
    const notPinned = weLibraryEntries(fakeWe, [], []);
    eq(
      "WE 隐藏清单：hidden 的项目即使已导入也跳过，未导入的不出现",
      noHide.entries.length === 2 && withHide.entries.length === 1 && withHide.entries[0].name.startsWith("P222222") && notPinned.entries.length === 0,
    );
    fs.rmSync(fakeWe, { recursive: true, force: true });
  } catch (e) {
    ok = false;
    console.error(`  ✖ WE 缓存删除: ${e.message}`);
  }

  // 回归：随时间变化的分段壁纸——时段识别/边界、多段合成一个条目、we-time:// 解析、路由按时段供流。
  try {
    const osT = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(osT.tmpdir(), "zcbg-time-"));
    try {
      eq(
        "时段识别：中英关键词 + 词边界（birthday 不算 day，夜莺 不算夜晚）",
        timeSegOf("morning.webm") === "morning" &&
          timeSegOf("videos/day.webm") === "day" &&
          timeSegOf("风居住的街道白天") === "day" &&
          timeSegOf("风居住的街道黄昏") === "evening" &&
          timeSegOf("风居住的街道夜晚") === "night" &&
          timeSegOf("夜莺") === "" &&
          timeSegOf("birthday.mp4") === "",
      );
      eq(
        "时段边界：默认 5/9/16/19，夜晚跨零点",
        weTimePick(null, new Date(2026, 0, 1, 4, 59)) === "night" &&
          weTimePick(null, new Date(2026, 0, 1, 5, 0)) === "morning" &&
          weTimePick(null, new Date(2026, 0, 1, 9, 0)) === "day" &&
          weTimePick(null, new Date(2026, 0, 1, 16, 0)) === "evening" &&
          weTimePick(null, new Date(2026, 0, 1, 19, 0)) === "night" &&
          weTimePick({ morning: 7, day: 12, evening: 18, night: 22 }, new Date(2026, 0, 1, 8, 0)) === "morning" &&
          weTimePick({ morning: 7, day: 12, evening: 18, night: 22 }, new Date(2026, 0, 1, 23, 0)) === "night",
      );
      // 合成：同一项目认出 ≥2 个时段就合并成一个「随时间」条目（rel = we-time://<项目ID>）
      const weDir = path.join(tmp, "431960");
      const proj = path.join(weDir, "555000111");
      fs.mkdirSync(path.join(proj, "videos"), { recursive: true });
      fs.writeFileSync(path.join(proj, "project.json"), JSON.stringify({ title: "时段合成测试", type: "web", file: "index.html" }));
      fs.writeFileSync(path.join(proj, "videos", "morning.webm"), Buffer.alloc(600 * 1024, 1));
      fs.writeFileSync(path.join(proj, "videos", "day.webm"), Buffer.alloc(600 * 1024, 2));
      fs.writeFileSync(path.join(proj, "videos", "night.webm"), Buffer.alloc(600 * 1024, 3));
      const rT = weProjectEntries(proj, true);
      const merged = rT && rT.entries.find((e) => e.time);
      eq(
        "时间壁纸合成：多段并成一个「随时间」条目",
        !!merged && merged.rel === "we-time://555000111" && merged.kind === "随时间" && merged.segments.length === 3 && merged.segments[0].seg === "morning" && merged.segments.map((s) => s.seg).join(",") === "morning,day,night" && rT.entries.length === 1,
      );
      // 单段项目（文件名碰巧带时段词也不够两个时段）不合并，照旧单独列出
      const one = path.join(weDir, "555000222");
      fs.mkdirSync(one, { recursive: true });
      fs.writeFileSync(path.join(one, "project.json"), JSON.stringify({ title: "单段项目", type: "video", file: "night.mp4" }));
      fs.writeFileSync(path.join(one, "night.mp4"), Buffer.alloc(600 * 1024, 4));
      const rOne = weProjectEntries(one, false);
      eq(
        "时间壁纸合成：单段项目不合并",
        rT && rT.entries.length === 1 && rT.entries[0].time === true && !!rOne && rOne.entries.length === 1 && rOne.entries[0].time === undefined && rOne.entries[0].name === "单段项目",
      );
      // weTimeFileFor：按段取文件；非法 ID / 未知项目抛错，未知段回退到第一段（路由侧已先验段名）
      const realWeDir = media.weDir;
      media.weDir = weDir;
      try {
        eq(
          "weTimeFileFor：按段解析到对应视频",
          path.resolve(weTimeFileFor("555000111", "day")).toLowerCase() === path.resolve(path.join(proj, "videos", "day.webm")).toLowerCase(),
        );
        let rejects = 0;
        for (const badId of ["../逃逸", "404404404"]) {
          try {
            weTimeFileFor(badId, "day");
          } catch {
            rejects++;
          }
        }
        eq("weTimeFileFor：非法 ID / 未知项目都拒绝（2 个）", rejects === 2);
        eq(
          "weTimeFileFor：未知段回退到第一个分段（morning）",
          path.resolve(weTimeFileFor("555000111", "noon")).toLowerCase() === path.resolve(path.join(proj, "videos", "morning.webm")).toLowerCase(),
        );
      } finally {
        media.weDir = realWeDir;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    ok = false;
    console.error(`  ✖ 时间壁纸: ${e.message}`);
  }

  const os = await import("node:os");
  const tmp = path.join(os.tmpdir(), `zcbg-selftest-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(tmp, Buffer.from("0123456789".repeat(10)));
  const port = await startMediaServer({ mediaPort: 19700 });
  if (!port) {
    ok = false;
    console.error("  ✖ 媒体服务启动失败");
  } else {
    const url = mediaUrlFor(tmp);
    const g = await fetch(url);
    const buf = Buffer.from(await g.arrayBuffer());
    eq("GET 整文件（200）", g.status === 200 && buf.length === 100 && buf.toString() === "0123456789".repeat(10));
    const r = await fetch(url, { headers: { Range: "bytes=2-11" } });
    const part = Buffer.from(await r.arrayBuffer());
    eq("Range 请求（206）", r.status === 206 && part.length === 10 && part.toString() === "2345678901");
    const up = await fetch(`http://127.0.0.1:${port}/upload?name=${encodeURIComponent("selftest-probe.png")}`, {
      method: "POST",
      body: Buffer.from("hello-upload"),
    });
    const j = await up.json().catch(() => null);
    eq(
      "上传接口（POST /upload）",
      up.status === 200 && j && j.ok && typeof j.rel === "string" && fs.existsSync(path.join(SCRIPT_DIR, j.rel)),
    );
    if (j && j.rel) {
      try {
        fs.rmSync(path.join(SCRIPT_DIR, j.rel), { force: true });
      } catch {}
    }
    // 随时间壁纸的分段端点：?b=<时段> 精确命中；缺省按当前时间；不存在的项目 404
    const tWe = path.join(SCRIPT_DIR, `.selftest-we-time-${process.pid}`);
    try {
      const tProj = path.join(tWe, "777000222");
      fs.mkdirSync(tProj, { recursive: true });
      fs.writeFileSync(path.join(tProj, "project.json"), JSON.stringify({ title: "时段路由自检", type: "web" }));
      fs.writeFileSync(path.join(tProj, "morning.webm"), Buffer.alloc(600 * 1024, 1));
      fs.writeFileSync(path.join(tProj, "day.webm"), Buffer.alloc(600 * 1024, 2));
      const savedWeDir2 = media.weDir;
      media.weDir = tWe;
      try {
        const gDay = await fetch(`http://127.0.0.1:${port}/we-time/777000222?b=day`);
        const bDay = Buffer.from(await gDay.arrayBuffer());
        eq("WE 时间路由：?b=day 命中白天分段", gDay.status === 200 && bDay.length === 600 * 1024 && bDay[0] === 2);
        const hNight = await fetch(`http://127.0.0.1:${port}/we-time/777000222?b=night`, { method: "HEAD" });
        eq("WE 时间路由：HEAD 也可用", hNight.status === 200 && (await hNight.arrayBuffer()).byteLength === 0);
        const gAny = await fetch(`http://127.0.0.1:${port}/we-time/777000222`);
        const bAny = Buffer.from(await gAny.arrayBuffer());
        eq("WE 时间路由：缺省按时钟回某一段", gAny.status === 200 && (bAny[0] === 1 || bAny[0] === 2));
        const g404 = await fetch(`http://127.0.0.1:${port}/we-time/000000000`);
        eq("WE 时间路由：未知项目 404", g404.status === 404);
      } finally {
        media.weDir = savedWeDir2;
        fs.rmSync(tWe, { recursive: true, force: true });
      }
    } catch (e) {
      ok = false;
      console.error(`  ✖ WE 时间路由: ${e.message}`);
    }
    // 网页壁纸：/we-web/<ID>/ 回 index.html（text/html），子路径按 MIME 回文件，
    // ../ 越界和未知项目都 404；weProjectEntries 对 web 型项目给「网页」条目
    const wWe = path.join(SCRIPT_DIR, `.selftest-we-web-${process.pid}`);
    try {
      const wProj = path.join(wWe, "888000333");
      fs.mkdirSync(wProj, { recursive: true });
      fs.writeFileSync(path.join(wProj, "project.json"), JSON.stringify({ title: "网页壁纸自检", type: "web", file: "index.html", preview: "preview.gif" }));
      fs.writeFileSync(path.join(wProj, "index.html"), "<html><body>web wallpaper</body></html>");
      fs.writeFileSync(path.join(wProj, "hero.png"), rgbaToPng(Buffer.alloc(32 * 16 * 4, 0x80), 32, 16));
      fs.writeFileSync(path.join(wProj, "preview.gif"), Buffer.from("GIF89a-not-really"));
      const savedWeDir3 = media.weDir;
      media.weDir = wWe;
      try {
        const ents = weProjectEntries(wProj, true);
        const webEntry = ents && ents.entries.find((x) => x.type === "web");
        eq("WE 网页壁纸：web 型项目列「网页」条目", !!webEntry && webEntry.kind === "网页" && webEntry.rel === "we-web://888000333" && /\/we-web\/888000333\/$/.test(String(webEntry.url)));
        const gi = await fetch(`http://127.0.0.1:${port}/we-web/888000333/`);
        eq("WE 网页路由：根路径回 index.html（text/html）", gi.status === 200 && (gi.headers.get("content-type") || "").includes("text/html") && (await gi.text()).includes("web wallpaper"));
        const gp = await fetch(`http://127.0.0.1:${port}/we-web/888000333/hero.png`);
        eq("WE 网页路由：子路径按 MIME 供流", gp.status === 200 && (gp.headers.get("content-type") || "").startsWith("image/png"));
        const gUp = await fetch(`http://127.0.0.1:${port}/we-web/888000333/..%2f..%2fconfig.json`);
        const gAbs = await fetch(`http://127.0.0.1:${port}/we-web/999999999/`);
        eq("WE 网页路由：越界路径 / 未知项目 404", gUp.status === 404 && gAbs.status === 404);
        eq("WE 网页壁纸：uiState 给 web 类型 + /we-web/ 端点", (() => {
          const s = uiState({ wallpaper: "we-web://888000333", enabled: true });
          return s.mediaType === "web" && s.url.endsWith("/we-web/888000333/") && s.label === "网页壁纸自检";
        })());
        eq("WE 网页壁纸：videoStateFor 为 null、webStateFor 给层状态（v34 起带 sharpen）", videoStateFor({ wallpaper: "we-web://888000333", enabled: true }) === null && JSON.stringify(webStateFor({ wallpaper: "we-web://888000333", enabled: true })) === `{"type":"web","url":"http://127.0.0.1:${port}/we-web/888000333/","sharpen":0}`);
      } finally {
        media.weDir = savedWeDir3;
        fs.rmSync(wWe, { recursive: true, force: true });
      }
    } catch (e) {
      ok = false;
      console.error(`  ✖ WE 网页壁纸: ${e.message}`);
    }
    stopMediaServer();
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {}
  log(ok ? "自检全部通过。" : "自检有失败项！");
  process.exit(ok ? 0 : 1);
}

/* --------------------------------- 主流程 -------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  // 单实例询问：给启动器用——“已经有注入器在跑吗？”有 = 0，没有 = 1
  if (args.locked) {
    const pid = liveInjectorPid();
    if (pid) {
      log(`已有注入器在运行（PID ${pid}），不重复启动。`);
      process.exit(0);
    }
    process.exit(1);
  }

  // 自检：不连 ZCode，验证纯函数和媒体服务本身（改完代码先跑这个最省事）
  if (args.selftest) return selftest();

  if (typeof WebSocket !== "function" || typeof fetch !== "function") {
    console.error(`需要 Node.js >= 22（当前 ${process.version}）。`);
    process.exit(2);
  }

  // 用 let：config.json 被改动时可以在常驻循环里热加载，不必重开注入器
  let cfg = loadConfig();
  if (args.noUi) cfg.showSettingsUI = false;
  // 一次性迁移：v24 前工坊区块自动列出全部项目，改「只列导入过的」之前，把当前已
  // 列出的（非 hidden、能扫出条目的）项目种进 wePinned——升级不丢已装的壁纸，
  // 之后再新下载的就静默待在工坊里，等用户从「从工坊导入」点名。
  if (!cfg.wePinnedSeeded) {
    try {
      const weDir = findWallpaperEngineDir(cfg);
      if (weDir) {
        const hidden = new Set((Array.isArray(cfg.weHidden) ? cfg.weHidden : []).map(String));
        const pinned = new Set((Array.isArray(cfg.wePinned) ? cfg.wePinned : []).map(String));
        for (const d of fs.readdirSync(weDir, { withFileTypes: true })) {
          if (!d.isDirectory() || hidden.has(d.name) || pinned.has(d.name)) continue;
          if (!fs.existsSync(path.join(weDir, d.name, "project.json"))) continue;
          const r = weProjectEntries(path.join(weDir, d.name), false);
          if (r && r.entries.length) pinned.add(d.name); // 当时能列出来的才算「已装」
        }
        cfg.wePinned = [...pinned];
        log(`工坊库切换为「仅列出已导入」：已把现有 ${pinned.size} 个项目种进 wePinned。`);
      }
      cfg.wePinnedSeeded = true;
      saveConfig({ wePinned: cfg.wePinned, wePinnedSeeded: true });
    } catch (e) {
      warn(`工坊库迁移失败（下下次启动会重试）: ${e.message}`);
    }
  }
  const port = Number(args.port ?? cfg.debugPort ?? DEFAULTS.debugPort);
  const waitSeconds = Number(args.waitSeconds ?? cfg.waitSeconds ?? DEFAULTS.waitSeconds);

  // 本地媒体服务：视频壁纸没法内嵌成 data:URL，页面要从这里拿流。
  // 图片不依赖它（仍走 data:URL），所以服务起不来只影响视频。
  // 只看一眼/只撤掉的模式（--check / --off / --dump-*）不占端口，也不把日志混进输出。
  if (!args.dumpCss && !args.dumpUi && !args.off && !args.check) {
    const mediaPort = await startMediaServer(cfg, () => cfg.weHidden, () => cfg.wePinned, () => cfg.weTimeBounds);
    if (mediaPort) log(`本地媒体服务已就绪：127.0.0.1:${mediaPort}（视频壁纸供流用）`);
  }

  let css;
  try {
    // enabled=false：不注入背景，但仍然注入设置界面，这样还能从「设置 → 壁纸」里再打开
    css = cfg.enabled === false ? "" : buildCss(cfg, { placeholder: args.dumpCss });
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(2);
  }

  if (args.dumpCss) {
    if (!css) {
      console.log("/* config.json 里 enabled=false，当前不注入背景 CSS。 */");
      // 媒体服务（HTTP server）会挂住事件循环，这类“看一眼就退出”的命令必须显式退出
      process.exit(0);
    }
    console.log(`/* 背景图: ${resolveWallpaper(cfg)} */`);
    console.log(css);
    process.exit(0);
  }

  if (args.dumpUi) {
    // 调试用：打印最终会注入页面的界面脚本（已替换占位符），方便 node --check 验证
    const ui = buildUiScript(cfg);
    console.log(ui || "/* showSettingsUI=false，或读不到 ui-inject.js：没有界面脚本可打印。 */");
    process.exit(0);
  }

  const attached = new Map();

  /** 注入/更新指定窗口：注册“新文档自动注入”的脚本，并对当前文档立即生效 */
  const applyToWindow = async (rec) => {
    const windowCss = cfg.enabled === false ? "" : buildCss(cfg);
    const ui = buildUiScript(cfg);
    const video = cfg.enabled === false ? null : videoStateFor(cfg);
    const web = cfg.enabled === false ? null : webStateFor(cfg);
    const image = cfg.enabled === false ? null : imageStateFor(cfg);
    const sharpen = cfg.enabled === false ? null : sharpenStateFor(cfg);
    const fallback = fallbackStateFor(cfg);
    const src = composeInjectionSource(windowCss, video, fallback, ui, web, image, sharpen);
    if (rec.scriptId) {
      try {
        await rec.session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: rec.scriptId }, 8000);
      } catch {
        /* 旧脚本可能已经随页面一起没了 */
      }
      rec.scriptId = "";
    }
    if (src.trim()) {
      try {
        const r = await rec.session.send("Page.addScriptToEvaluateOnNewDocument", { source: src }, 20000);
        rec.scriptId = (r && r.identifier) || "";
      } catch (e) {
        warn(`注册“刷新后自动注入”失败（${rec.title}）: ${e.message}`);
      }
    }
    if (windowCss) await rec.session.eval(injectSource(windowCss, video, fallback, web));
    // 壁纸关掉时 windowCss 是空的，但也要走一遍：让页面把旧的视频层/网页层/样式拆干净
    else await rec.session.eval(injectSource("", null, null, null));
    if (ui) await rec.session.eval(ui);
    else if (rec.hasUi) {
      // showSettingsUI 被改成了 false（或界面脚本读不到了）：把已经挂上的浮层收掉，
      // 否则它会一直留在侧栏，用户以为“设置里关不掉”。
      try {
        await rec.session.eval(
          "(()=>{try{if(window.__zcodeBgUi&&window.__zcodeBgUi.destroy)window.__zcodeBgUi.destroy();}catch(e){}return true})()",
        );
      } catch {
        /* 页面可能已经关了 */
      }
    }
    rec.hasUi = !!ui;
    return rec;
  };

  /** 把状态变化推给所有已连接窗口（页面侧自己先改过了，这里只是让别的窗口跟上） */
  const pushState = async (patch) => {
    const expr = `window.__zcodeBgUi ? window.__zcodeBgUi.setState(${JSON.stringify(patch)}) : false`;
    for (const rec of attached.values()) {
      try {
        await rec.session.eval(expr);
      } catch {
        /* ignore */
      }
    }
  };

  const reply = async (session, obj) => {
    try {
      await session.eval(`window.__zcodeBgUi ? window.__zcodeBgUi.hostReply(${JSON.stringify(obj)}) : false`);
    } catch {
      /* ignore */
    }
  };

  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

  /** 设置界面发回来的操作（页面 → 主进程） */
  const handleUiMessage = async (session, payload) => {
    let msg;
    try {
      msg = JSON.parse(String(payload));
    } catch {
      return;
    }
    if (!msg || typeof msg.op !== "string") return;
    try {
      if (msg.op === "config") {
        const p = msg.patch || {};
        const patch = {};
        if (p.enabled !== undefined) patch.enabled = !!p.enabled;
        if (p.panelAlpha !== undefined) patch.panelAlpha = clamp01(p.panelAlpha);
        if (p.dim !== undefined) patch.dim = clamp01(p.dim);
        if (p.imageBlurPx !== undefined) patch.imageBlurPx = Math.max(0, Math.min(48, Number(p.imageBlurPx) || 0));
        if (p.sharpen !== undefined) patch.sharpen = clamp01(p.sharpen);
        if (typeof p.fit === "string" && ["cover", "contain", "fill", "tile"].includes(p.fit)) patch.fit = p.fit;
        if (typeof p.align === "string" && ["center", "top", "bottom", "left", "right"].includes(p.align)) patch.align = p.align;
        if (p.videoMuted !== undefined) patch.videoMuted = !!p.videoMuted;
        if (p.videoSpeed !== undefined) patch.videoSpeed = Math.max(0.25, Math.min(4, Number(p.videoSpeed) || 1));
        if (p.videoPauseWhenHidden !== undefined) patch.videoPauseWhenHidden = !!p.videoPauseWhenHidden;
        // 「自动兜底透明化」开关：漏掉这一行的话，页面点一下会先把本地 state 改掉（看着像成功），
        // 但主进程白名单过滤掉这个键 → 配置没变 → 紧接着的 applyToWindowForAll() 又把
        // 配置里的旧值推回页面，开关一秒后自己弹回去。必须在这里放行。
        if (p.autoTranslucent !== undefined) patch.autoTranslucent = !!p.autoTranslucent;
        // 精细透明化/调色：面板「🔍 扫描」发上来的数组，每项要么是选择器字符串（强制透明），
        // 要么是 {selector, background}（该区域背景改成任意颜色/半透明色，面板调色器生成）。
        // 与 cssFromState 同一规则消毒，坏条目静默丢弃；这里不放行的话，扫描开关会像当年的
        // autoTranslucent 一样一秒弹回去。
        if (p.overrides !== undefined) {
          patch.overrides = (Array.isArray(p.overrides) ? p.overrides : [])
            .slice(0, 24)
            .map((o) => {
              if (typeof o === "string") {
                const s = o.trim();
                return s && s.length <= 200 && !/[{}@;\\<]/.test(s) && !s.includes("/*") ? s : "";
              }
              if (o && typeof o === "object") {
                const sel = typeof o.selector === "string" ? o.selector.trim() : "";
                const bg = typeof o.background === "string" ? o.background.trim() : "";
                const okSel = sel && sel.length <= 200 && !/[{}@;\\<]/.test(sel) && !sel.includes("/*");
                const okBg =
                  bg &&
                  bg.length <= 120 &&
                  !/[{}@;\\<]/.test(bg) &&
                  !bg.includes("/*") &&
                  !/url\s*\(|expression|!important/i.test(bg);
                return okSel && okBg ? { selector: sel, background: bg } : "";
              }
              return "";
            })
            .filter(Boolean)
            .slice(0, 24);
        }
        if (typeof p.extraCss === "string") patch.extraCss = p.extraCss.slice(0, 20000);
        if (typeof p.wallpaper === "string" && p.wallpaper.trim()) patch.wallpaper = p.wallpaper.trim();
        if (!Object.keys(patch).length) return;
        // 换了壁纸就顺手把开关打开（用户刚选了一个新文件，显然是想立刻看到）
        if (patch.wallpaper !== undefined) patch.enabled = true;
        saveConfig(patch);
        Object.assign(cfg, patch);
        await applyToWindowForAll();
        log(`设置界面改了配置：${JSON.stringify(patch)}`);
        await reply(session, { message: `✔ 已写入 config.json：${JSON.stringify(patch)}` });
        return;
      }

      if (msg.op === "image") {
        const saved = savePickedImage(msg.dataUrl, msg.name);
        cfg.wallpaper = saved.rel;
        cfg.enabled = true;
        saveConfig({ wallpaper: saved.rel, enabled: true });
        await pushState({ url: msg.dataUrl, label: path.basename(saved.file), mediaType: "image", enabled: true });
        await applyToWindowForAll();
        log(`设置界面存了新壁纸：${saved.file}（${fmtSize(saved.bytes)}）`);
        await reply(session, {
          label: path.basename(saved.file),
          message: `✔ 已存为 ${saved.rel}（${fmtSize(saved.bytes)}）并写进 config.json，下次启动自动生效。`,
        });
        return;
      }

      if (msg.op === "delete") {
        const wasCurrent = !!cfg.wallpaper && path.resolve(SCRIPT_DIR, cfg.wallpaper).toLowerCase() === path.resolve(SCRIPT_DIR, "wallpaper", String(msg.name || "").trim()).toLowerCase();
        const d = deleteWallpaperItem(msg.name);
        let extra = "";
        if (wasCurrent) {
          // 删掉的正好是墙上那张：不能让它指向一个不存在的文件，自动换一张
          const next = pickReplacementWallpaper();
          if (next) {
            cfg.wallpaper = next.rel;
            saveConfig({ wallpaper: next.rel, enabled: true });
            const st = uiState(cfg);
            await pushState({ url: st.url, label: st.label, mediaType: st.mediaType, timeUrl: st.timeUrl, timeBounds: st.timeBounds, enabled: true });
            extra = `删掉的正是当前壁纸，已自动换成「${next.name}」。`;
          } else {
            cfg.enabled = false;
            saveConfig({ enabled: false });
            await pushState({ enabled: false, label: "" });
            extra = "删掉的正是当前壁纸，壁纸库已经空了，先把壁纸关掉了——放一张图进 wallpaper\\ 再打开即可。";
          }
          await applyToWindowForAll();
        }
        log(`设置界面删了壁纸库文件：${d.base}（${fmtSize(d.bytes)}）`);
        await reply(session, {
          message: `✔ 已删除 ${d.base}（释放 ${fmtSize(d.bytes)}）。${extra}`.trim(),
          reloadLibrary: true,
        });
        return;
      }

      // 面板「Wallpaper Engine 创意工坊」卡片的 ✕：只删 .we-pkg-cache 里该项目的抽取产物，
      // 并把工坊目录名记进 config.json 的 weHidden（否则下次扫描会把缓存原样抽回来）。
      // 工坊目录本身一个字节都不动，Wallpaper Engine 随时能照常播放。
      if (msg.op === "weDelete") {
        const name = String(msg.name || "该壁纸").trim();
        let extra = "";
        let d = null;
        const relRaw = String(msg.rel || "");
        const mTime = /^we-time:\/\/(.+)$/i.exec(relRaw);
        try {
          if (mTime) {
            // 合并的时间分段条目：把项目各分段在 .we-pkg-cache 里的产物逐个清掉
            let total = 0;
            let tbytes = 0;
            const removedAll = [];
            const projDir = media.weDir ? path.join(media.weDir, decodeURIComponent(mTime[1])) : "";
            if (projDir && fs.existsSync(path.join(projDir, "project.json"))) {
              const r = weProjectEntries(projDir, true);
              const merged = r && r.entries.find((x) => x.time);
              if (merged) {
                for (const s of merged.segments) {
                  if (!s.cache) continue;
                  const one = deleteWeCacheItem(s.rel);
                  total += one.count;
                  tbytes += one.bytes;
                  removedAll.push(...one.removed);
                }
              }
            }
            d = { key: mTime[1], cacheDir: path.join(SCRIPT_DIR, ".we-pkg-cache"), count: total, bytes: tbytes, removed: removedAll };
          } else {
            d = deleteWeCacheItem(msg.rel);
          }
          log(`设置界面删了工坊抽取缓存：键 ${d.key}，${d.count} 个文件（${fmtSize(d.bytes)}）`);
        } catch (e) {
          // rel 不是缓存文件（直用预览图/工坊视频的条目）：没有产物可删，只做隐藏
          if (!/只能删除|不是抽取缓存/.test(e.message)) throw e;
        }
        // 记进隐藏清单（去重），扫描时整个项目跳过；同时从 wePinned 摘掉——
        // 否则「从工坊导入」加过的项目删掉后下次扫描又强制列回来。
        const src = String(msg.src || "").trim();
        if (!src || /[\\/:]/.test(src) || src === "." || src === "..") throw new Error(`工坊项目标识不合法：${src}`);
        const hidden = new Set(Array.isArray(cfg.weHidden) ? cfg.weHidden.map(String) : []);
        hidden.add(src);
        cfg.weHidden = [...hidden];
        const pinned = new Set(Array.isArray(cfg.wePinned) ? cfg.wePinned.map(String) : []);
        if (pinned.delete(src)) {
          cfg.wePinned = [...pinned];
        }
        saveConfig({ weHidden: cfg.weHidden, wePinned: cfg.wePinned });
        // 删掉的正好是墙上那张：跟壁纸库删除一样兜底换一张/关掉
        // （时间壁纸的 config.wallpaper 是 we-time:// 虚拟地址，直接跟删除的 rel 比）
        const curRel = cfg.wallpaper ? String(cfg.wallpaper) : "";
        const cur = curRel ? path.resolve(SCRIPT_DIR, curRel).toLowerCase() : "";
        const isTimeCur = !!mTime && /^we-time:\/\//i.test(curRel) && curRel.toLowerCase() === relRaw.toLowerCase();
        if ((isTimeCur || (d && cur && !isTimeCur && d.removed.some((f) => path.resolve(path.join(d.cacheDir, f)).toLowerCase() === cur)))) {
          const next = pickReplacementWallpaper();
          if (next) {
            cfg.wallpaper = next.rel;
            saveConfig({ wallpaper: next.rel, enabled: true });
            const st = uiState(cfg);
            await pushState({ url: st.url, label: st.label, mediaType: st.mediaType, timeUrl: st.timeUrl, timeBounds: st.timeBounds, enabled: true });
            extra = `删掉的正是当前壁纸，已自动换成「${next.name}」。`;
          } else {
            cfg.enabled = false;
            saveConfig({ enabled: false });
            await pushState({ enabled: false, label: "" });
            extra = "删掉的正是当前壁纸，壁纸库已经空了，先把壁纸关掉了。";
          }
          await applyToWindowForAll();
        }
        const delMsg = d
          ? `已删除「${name}」的抽取缓存（${d.count} 个文件，释放 ${fmtSize(d.bytes)}）`
          : `已从面板移除「${name}」（它在工坊里是原样播放的，没有可清理的抽取缓存）`;
        await reply(session, {
          message: `✔ ${delMsg}。Wallpaper Engine 本体不受影响。${extra}`.trim(),
          reloadLibrary: true,
        });
        return;
      }

      // 面板「打开文件夹」按钮：在资源管理器里打开 wallpaper\（没有就先建出来）。
      // detached + unref：资源管理器窗口的生命周期不归注入器管。
      if (msg.op === "openFolder") {
        const wallDir = path.join(SCRIPT_DIR, "wallpaper");
        fs.mkdirSync(wallDir, { recursive: true });
        spawn("explorer.exe", [wallDir], { detached: true, stdio: "ignore" }).unref();
        log("设置界面请求打开壁纸文件夹。");
        await reply(session, { message: "✔ 已打开壁纸文件夹（wallpaper\\）。放进去的图片/视频会出现在「壁纸库」里。" });
        return;
      }

      // 面板工坊区块「打开文件夹」按钮：在资源管理器里打开 WE 创意工坊目录
      // （Steam 下载新壁纸的落点）。media.weDir 没找到时给提示，不开空窗口。
      if (msg.op === "weOpenFolder") {
        const dir = media.weDir;
        if (!dir || !fs.existsSync(dir)) {
          log("设置界面请求打开工坊目录，但没找到 Wallpaper Engine 创意工坊库。");
          await reply(session, {
            message: "✖ 没找到 Wallpaper Engine 的创意工坊库——装了 Steam 版 Wallpaper Engine 并下载过壁纸后再试，或在 config.json 里加 \"weDir\" 手动指定。",
            error: true,
          });
          return;
        }
        spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref();
        log(`设置界面请求打开 Wallpaper Engine 工坊目录：${dir}`);
        await reply(session, { message: "✔ 已打开创意工坊文件夹。Wallpaper Engine 新下载的壁纸会出现在这里，面板会自动读取，无需手动导入。" });
        return;
      }

      // 面板「从工坊导入」：面板自己的选择列表（/list 的 weAll，带标题和封面）里点一个
      // 工坊项目 → 加入 wePinned（低清封面也强制列出）+ 从 weHidden 摘除 → 重新扫出
      // 条目回传，面板应用第一个。不再弹原生文件对话框——初始目录不可控，用户还嫌
      // 全是数字 ID 文件夹没法用。
      if (msg.op === "wePin") {
        const dir = media.weDir;
        if (!dir || !fs.existsSync(dir)) {
          await reply(session, {
            message: "✖ 没找到 Wallpaper Engine 的创意工坊库——装了 Steam 版 Wallpaper Engine 并下载过壁纸后再试，或在 config.json 里加 \"weDir\" 手动指定。",
            error: true,
          });
          return;
        }
        const src = String(msg.src || "").trim();
        const proj = path.join(dir, src);
        if (!src || /[\\/:]/.test(src) || src === "." || src === ".." || !fs.existsSync(path.join(proj, "project.json"))) {
          await reply(session, { message: "✖ 工坊项目标识不合法，刷新面板后重试。", error: true });
          return;
        }
        const hidden = new Set(Array.isArray(cfg.weHidden) ? cfg.weHidden.map(String) : []);
        const pinned = new Set(Array.isArray(cfg.wePinned) ? cfg.wePinned.map(String) : []);
        const wasHidden = hidden.delete(src);
        pinned.add(src);
        cfg.weHidden = [...hidden];
        cfg.wePinned = [...pinned];
        saveConfig({ weHidden: cfg.weHidden, wePinned: cfg.wePinned });
        const r = weProjectEntries(proj, true);
        const items = r && r.entries.length ? [r.entries[0]] : [];
        log(`工坊导入：${src} 加入创意工坊区块${wasHidden ? "（从隐藏清单恢复）" : ""}`);
        await reply(session, {
          message: items.length
            ? `✔ 已把「${items[0].name}」加入「创意工坊」并应用。`
            : "✔ 已把该壁纸加入「创意工坊」——但它没有可显示的视频或图片。",
          picked: items,
          reloadLibrary: true,
        });
        return;
      }

      if (msg.op === "sample") {
        if (!fs.existsSync(path.resolve(SCRIPT_DIR, SAMPLE_WALLPAPER))) {
          await reply(session, { message: `✖ 内置示例图不见了：${SAMPLE_WALLPAPER}（重新跑一次安装脚本可以恢复）。`, error: true });
          return;
        }
        cfg.wallpaper = SAMPLE_WALLPAPER;
        cfg.enabled = true;
        saveConfig({ wallpaper: SAMPLE_WALLPAPER, enabled: true });
        const st = uiState(cfg);
        await pushState({ url: st.url, label: st.label, mediaType: st.mediaType, timeUrl: st.timeUrl, timeBounds: st.timeBounds, fit: st.fit, align: st.align, videoMuted: st.videoMuted, videoSpeed: st.videoSpeed, videoPauseWhenHidden: st.videoPauseWhenHidden, enabled: true });
        await applyToWindowForAll();
        log("设置界面切回了内置示例图。");
        await reply(session, { label: st.label, message: "✔ 已切回内置示例图。" });
        return;
      }

      if (msg.op === "reset") {
        cfg.enabled = false;
        saveConfig({ enabled: false });
        await applyToWindowForAll();
        log("设置界面关闭了壁纸（enabled=false）。");
        await reply(session, { message: "✔ 壁纸已关闭，配置和图片都保留着，随时可以在这一页重新打开。" });
        return;
      }
    } catch (e) {
      warn(`设置界面操作失败: ${e.message}`);
      await reply(session, { message: `✖ ${e.message}`, error: true });
    }
  };

  const applyToWindowForAll = async () => {
    for (const rec of attached.values()) {
      try {
        await applyToWindow(rec);
      } catch (e) {
        warn(`更新窗口失败（${rec.title}）: ${e.message}`);
      }
    }
  };

  const removeAll = async () => {
    const jobs = [...attached.values()].map(async ({ session }) => {
      try {
        await session.eval(removeSource);
      } catch {
        /* ignore */
      }
      session.close();
    });
    await Promise.all(jobs);
  };

  if (args.off || args.check) {
    if (!(await portOpen(port))) {
      if (args.off) {
        // 没有调试端口 = ZCode 不是本脚本启动的，本来就没有任何注入，没什么要恢复的。
        log(`端口 ${port} 没有在监听：ZCode 不是用本脚本启动的（或已经退出），本来就没有注入。`);
        const stopped = await stopLiveInjector();
        if (stopped) log(`已顺带结束后台注入器（PID ${stopped}）。`);
        log("恢复完成。想再打开壁纸：双击桌面的 ZCode 快捷方式即可。");
        process.exit(0);
      }
      console.error(`✖ 端口 ${port} 没有在监听：ZCode 不是用本脚本启动的（或已经退出）。`);
      process.exit(1);
    }
    const targets = pickTargets(await httpJson(port, "/json/list"));
    if (!targets.length) {
      console.error("✖ 没有找到 ZCode 主窗口页面。");
      process.exit(1);
    }
    let checkOk = true;
    for (const t of targets) {
      const session = await attachTo(t);
      if (args.off) {
        const removed = await session.eval(removeSource);
        const what = [removed?.style ? "背景样式" : null, removed?.ui ? "设置界面" : null].filter(Boolean);
        log(`${what.length ? `已移除 ${what.join(" + ")}` : "本来就没有注入"} → ${t.title || t.url}`);
      } else {
        const st = await session.eval(statusSource);
        log(`窗口: ${t.title || t.url}`);
        log(`  背景样式: ${st.present ? `存在（${(st.bytes / 1024).toFixed(1)} KB）` : "不存在"}`);
        log(
          `  设置界面: ${
            st.uiPresent ? `已注入（v${st.uiVersion || "?"}）` + (st.uiEnabled === false ? "，当前壁纸是关闭状态" : "") : "未注入（用了 --no-ui 或旧版本脚本）"
          }`,
        );
        log(`  视频壁纸层: ${st.video ? "存在" : "无"}`);
        log(`  网页壁纸层: ${st.web ? "存在" : "无"}`);
        log(`  html 主题类: ${st.themeClass || "(空)"}`);
        log(`  html 背景: ${st.htmlBackground || "(无)"}`);
        if (!st.present) {
          checkOk = false;
          if (st.uiPresent) log("  → 背景未生效，但设置界面在：打开 ZCode 的「设置 → 壁纸」把开关打开就行。");
          else warn("  → 背景未生效。请用本脚本启动 ZCode，或检查是否被其它主题插件覆盖。");
        }
      }
      session.close();
    }
    if (args.off) {
      const stopped = await stopLiveInjector();
      if (stopped) log(`已结束后台注入器（PID ${stopped}），不会再注入回来。`);
      else log("没有后台注入器在运行。");
      log("恢复完成。想再打开壁纸：双击桌面的 ZCode 快捷方式即可。");
      process.exit(0);
    }
    // --check 到此结束：同样要显式退出，否则媒体服务会让进程一直挂着不返回。
    // 退出码：0 = 背景样式已生效；1 = 端口在听但样式没生效 —— 给脚本/CI 当体检信号用。
    process.exit(checkOk ? 0 : 1);
  }

  // 到这一步就真的要注入了：先占住锁，免得启动器重复拉起第二个注入器。
  // 必须放在 --off / --check 之后：那两个只是“看一眼 / 撤一下”，
  // 如果提前占了锁，它们退出时 releaseLock() 会把正在运行的注入器的锁一起删掉
  // （于是下次 --locked 误判成“没在跑”，又拉起第二个注入器）。
  // --once（含 --diagnose / --probe / --screenshot）同理：只是“看一眼 / 截一张”，
  // 绝不能占锁——否则会把常驻注入器的锁覆盖成自己的 PID，退出时一删，
  // 常驻注入器就成了“黑户”：--off 找不到它、--locked 误判成没在跑。
  if (!args.once) {
    writeLock();
    process.on("exit", releaseLock);
  }

  // 1) 需要时先启动 ZCode（带调试端口）
  let childExited = false;
  if (!args.attach && !(await portOpen(port))) {
    if (!fs.existsSync(cfg.zcodeExe)) {
      const found = findZcodeExe();
      if (found) {
        log(`config 里的 zcodeExe 未配置或已失效，自动探测到: ${found}`);
        cfg.zcodeExe = found;
      } else {
        console.error(
          `✖ 没找到 ZCode 可执行文件（自动探测了 %LOCALAPPDATA%\\Programs、Program Files 等常见位置）。\n` +
            `  请在 ${CONFIG_PATH} 里手动指定，例如："zcodeExe": "C:\\Users\\你\\AppData\\Local\\Programs\\ZCode\\ZCode.exe"。`,
        );
        process.exit(2);
      }
    }
    log(`启动 ZCode: ${cfg.zcodeExe}  (--remote-debugging-port=${port})`);
    const child = spawn(cfg.zcodeExe, [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (e) => console.error(`✖ 启动失败: ${e.message}`));
    // 关键线索：ZCode 已经在运行时，新实例会因单实例锁立刻退出（端口也不会打开）。
    child.once("exit", () => {
      childExited = true;
    });
    child.unref();
  } else if (!args.attach) {
    log(`端口 ${port} 已在监听，直接注入。`);
  }

  // 2) 等调试端口就绪
  const deadline = Date.now() + waitSeconds * 1000;
  let up = false;
  while (Date.now() < deadline) {
    if (await portOpen(port)) {
      up = true;
      break;
    }
    if (childExited) {
      // 给它 3 秒缓冲，避免误判“启动器退出但主进程在别处存活”的情况
      await sleep(3000);
      if (!(await portOpen(port))) {
        console.error(
          `✖ ZCode 刚启动就退出了，调试端口 ${port} 没打开。\n` +
            `  最常见原因：ZCode 已经在运行——它有单实例锁，带端口的新实例会立刻退出。\n` +
            `  请在托盘图标上右键退出 ZCode（任务管理器里确认没有 ZCode.exe），再运行本脚本。\n` +
            `  排除这条之后，还可能是 ZCode 路径不对或启动被拦截。`,
        );
        process.exit(1);
      }
      up = true;
      break;
    }
    await sleep(600);
  }
  if (!up) {
    console.error(
      `✖ 等了 ${waitSeconds} 秒，调试端口 ${port} 仍未打开。\n` +
        `  请先在托盘/任务管理器里完全退出 ZCode，再运行本脚本；\n` +
        `  或者改用 “ZCode 已在带端口运行” 的场景加 --attach。`,
    );
    process.exit(1);
  }
  log(`调试端口 ${port} 已就绪，等待主窗口…`);

  process.on("SIGINT", async () => {
    log("收到退出信号，正在移除注入的样式…");
    await removeAll();
    process.exit(0);
  });

  // 3) 轮询并保持注入
  let misses = 0;
  let firstAttachLogged = false;
  let diagnosed = false;
  // config.json 是用户和其它工具共同的“真相来源”（手工编辑、设置界面写回、别的助手改），
  // 所以每轮看一眼 mtime：变了就热加载并重新注入，不用重开注入器。
  const cfgMtime = () => {
    try {
      return fs.statSync(CONFIG_PATH).mtimeMs;
    } catch {
      return 0;
    }
  };
  let lastCfgMtime = cfgMtime();
  const reloadConfigIfChanged = async () => {
    const m = cfgMtime();
    if (!m || m === lastCfgMtime) return;
    lastCfgMtime = m;
    let next;
    try {
      next = loadConfig();
    } catch (e) {
      warn(`config.json 读取失败，继续用旧配置：${e.message}`);
      return;
    }
    cfg = next;
    if (args.noUi) cfg.showSettingsUI = false;
    const label = `${cfg.wallpaper || "(空)"}　panelAlpha=${cfg.panelAlpha}　dim=${cfg.dim}　fit=${cfg.fit}/${cfg.align}`;
    log(`检测到 config.json 变化，已热加载并重新注入：${label}`);
    for (const rec of attached.values()) {
      try {
        await applyToWindow(rec);
      } catch (e) {
        warn(`热加载后重新注入失败（${rec.title}）: ${e.message}`);
      }
    }
  };
  // 主循环心跳看门狗：真机上出过一次“注入器活着但主循环再也没跑过”的僵死
  // （ZCode 退出瞬间挂在了循环里的某个 await 上，日志无痕；进程被媒体服务拽着不死，
  // 结果启动器看锁以为它还在岗，不再拉新的——ZCode 重启后壁纸就回不来了）。
  // 不管卡在哪一步，90 秒没走完一轮就自杀退出：锁随进程释放，启动器会拉起新注入器重新附着。
  let lastBeat = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - lastBeat > 90000) {
      log("主循环超过 90 秒没完成任何一轮，疑似卡死——退出让位给新注入器。");
      process.exit(2);
    }
  }, 15000);
  for (;;) {
    await reloadConfigIfChanged();
    let list;
    try {
      list = await httpJson(port, "/json/list");
      misses = 0;
    } catch {
      misses++;
      if (attached.size && misses >= 3) {
        log("ZCode 已退出，注入器结束。");
        break;
      }
      if (!attached.size && Date.now() > deadline + 15000) {
        console.error("✖ 一直没能连上 ZCode 的渲染进程，退出。");
        process.exit(1);
      }
      await sleep(1000);
      continue;
    }

    for (const t of pickTargets(list)) {
      if (attached.has(t.id)) continue;
      try {
        const session = await attachTo(t, (s, payload) => {
          handleUiMessage(s, payload).catch((e) => warn(`处理设置界面消息失败: ${e.message}`));
        });
        const rec = { session, title: t.title || t.url, scriptId: "", hasUi: false };
        await applyToWindow(rec);
        attached.set(t.id, rec);
        firstAttachLogged = true;
        log(
          `✔ 已注入${css ? "自定义背景" : "设置界面（壁纸当前是关闭状态）"}` +
            `${rec.hasUi ? "＋「设置 → 壁纸」设置界面" : ""} → ${t.title || t.url}`,
        );
        if (rec.hasUi) log("   打开 ZCode 的「设置 → 外观」附近就能看到新的「壁纸」入口。");
      } catch (e) {
        warn(`注入失败（${t.title || t.url}）: ${e.message}`);
      }
    }

    for (const [id, s] of attached) {
      if (s.session.closed) {
        attached.delete(id);
        log(`窗口已关闭/断开: ${s.title}`);
      }
    }

    if (args.diagnose && !diagnosed && attached.size) {
      diagnosed = true;
      const session = attached.values().next().value;
      try {
        await sleep(400);
        const d = await session.session.eval(diagnoseSource);
        printDiagnosis(d);
        if (args.probe && Array.isArray(d.blockers) && d.blockers.length) {
          // 对标 Zcode-Wallpaper 的 --probe：给的不是「建议你研究一下」，而是
          // 拿来就能用的选择器 —— 贴进 config.json 的 overrides 数组就生效。
          log("");
          log("--probe 可直接使用的选择器（放进 config.json 的 overrides 数组，或在面板「实心区域透明化」里逐条开）：");
          for (const sel of [...new Set(d.blockers.map((b) => b.el))]) log("  " + sel);
        }
      } catch (e) {
        warn(`体检失败: ${e.message}`);
      }
    }

    if (args.screenshot) {
      const session = attached.values().next().value;
      if (session) {
        try {
          const shot = await session.session.send("Page.captureScreenshot", { format: "png" }, 30000);
          const out = path.isAbsolute(args.screenshot) ? args.screenshot : path.join(process.cwd(), args.screenshot);
          fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
          log(`已截图: ${out}`);
        } catch (e) {
          warn(`截图失败: ${e.message}`);
        }
      } else {
        warn("还没有注入成功的窗口，稍后重试截图（可加 --wait 更多秒）。");
      }
    }

    if (args.once) {
      if (attached.size)
        log(
          "完成（一次性模式）：当前窗口已经生效。\n" +
            "  注意：本进程一退出，页面一旦刷新/重载就会恢复原样（新文档的自动注入随连接一起失效）。\n" +
            "  想长期保持，请用常驻模式（不加 --once），ZCode 关闭时脚本会自己结束。"
        );
      else console.error("✖ 没有注入任何窗口。");
      if (videoStateFor(cfg)) {
        warn("⚠ 视频壁纸 + --once：本进程退出后媒体服务关闭，视频会停在第一帧。视频请用常驻模式（去掉 --once）。");
      }
      await Promise.all([...attached.values()].map((s) => Promise.resolve(s.session.close())));
      // 一次性模式必须显式退出：媒体服务（HTTP server）会挂住事件循环，不退出命令就永远不返回
      stopMediaServer();
      process.exit(attached.size ? 0 : 1);
    }

    if (firstAttachLogged) {
      firstAttachLogged = false;
      log(
        "保持运行中：请让本窗口一直开着（最小化可以）。\n" +
          "  关掉本窗口或按 Ctrl+C → 立即移除背景和设置界面、恢复原样；ZCode 自己退出后本脚本也会自动结束。",
      );
    }
    lastBeat = Date.now();
    // 空闲（还没附着任何窗口）时轮询快一点：ZCode 窗口一出来壁纸马上跟上，不用等满 2 秒；
    // 已附着后恢复 2 秒节拍（config 热加载的感知延迟就是这 2 秒，保持文档承诺）。
    await sleep(attached.size ? 2000 : 500);
  }

  // 走到这里只有一种情况：上面的 break（ZCode 已退出）。
  // 媒体服务（HTTP server）会挂住事件循环，不显式退出的话，
  // 进程就成了“媒体端口还在听、主循环已经没了”的僵尸——热加载、重附全部失效。
  stopMediaServer();
  process.exit(0);
}

main().catch((e) => {
  console.error(`✖ ${e && e.message ? e.message : e}`);
  process.exit(1);
});
