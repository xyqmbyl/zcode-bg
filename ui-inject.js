/* ============================================================================
 * ZCode 壁纸设置界面（注入到 ZCode 渲染进程运行，不是 Node 脚本）
 *
 * 这个文件由 zcode-bg.mjs 读取、替换两个占位符后注入到 ZCode 里：
 *   /*__ZCBG_STATE__* /        → 当前配置（JSON）
 *   /*__ZCBG_CSS_HELPERS__* /  → hexToRgba / cssFromState 两个纯函数源码
 *
 * 做法：不往 React 的 DOM 树里插东西（会被重渲染吃掉），而是在 body 末尾挂一个
 * 自己的浮层，按 ZCode 原生控件的坐标“贴”上去，并用 ZCode 自己的 class 名套样式，
 * 所以观感是原生的；React 怎么重渲染都不影响它。
 * v5：支持视频动态壁纸（<video> 层 + 画面铺排/位置 + 静音/速度/后台暂停 + 壁纸库）。
 * v6：壁纸库加「🎲 随机换一张」；换库逻辑统一进 useLibraryItem，顺带修了 applyPicked 不带 mediaType 的小毛病。
 * v7：壁纸库每张卡片加「✕」直接删除（两步确认，走主进程 op:"delete"），不用再去 wallpaper\ 文件夹里删。
 * v8：「🔍 扫描实心区域」—— 扫出挡住壁纸的大块实心表面，逐个开关透明化（overrides，写回 config.json）；
 *      新增 extraCss 快捷预设（毛玻璃 / 彻底透明 / 清空）；设置入口兼容英文界面（Settings）。
 * v9：快捷预设加「轻磨砂」折中档（所有 bg-* 透明 + 6px 轻模糊），并给按钮加了悬浮说明。
 * v10：轻磨砂滤镜链加 brightness(.85)——透进来的壁纸亮度压 15%，解决「有点亮」。
 * v11：每块扫描区域除了强制透明，还能 🎨 调成任意半透明颜色（色板 + 5%~95% 不透明度，
 *      写成 rgba 存进 overrides 的 {selector, background} 对象形式）；color/alpha 拖动实时预览。
 * v12：扫描第一档没扫到实心区域时，退第二档列出「已经半透明的大块面板」——🎨 调色总有用武之地。
 * v13：修调色闪烁——cssForState 漏传 overrides，拖动时页面本地 CSS（无规则）和主进程 CSS（有规则）
 *      来回打架，色块一闪一闪；现在两边生成完全一致的 CSS，守卫挡掉多余重写。
 * v14：点扫描结果的选择器名，页面上对应区域紫色虚线描边 + 淡淡紫罩（再点取消；收起面板自动撤掉），
 *      调色前先确认「改的到底是哪块」。
 * v16：新增「Wallpaper Engine 创意工坊」区块——自动发现 Steam 工坊里下载的壁纸
 *      （video 型直接换用；scene/Web 型抽自带的视频素材，没有素材就用预览图当
 *      静帧），缩略图卡片 + 类型角标，点击换用；「随机换一张」的池子也把它算上。
 *      主进程 /list 增加 we 数组；config.json 可用 "weDir" 手动指定工坊路径。
 * v28：新增「网页壁纸」——工坊 web 型（spine/HTML）项目直接以项目本体上墙：
 *      主进程 /we-web/<ID>/ 按类型供流项目目录，页面挂 <iframe> 层（applyWebState）加载，
 *      spine 动画原生渲染（4K 图集、原版动画效果，不再是低清封面静帧）；卡片角标「网页」，
 *      面板「当前：…（网页）」，铺排选项里的「平铺」对网页壁纸不出现。
 * v29：修网页壁纸「点了没反应」——跨源 http iframe 在 ZCode 里是独立进程，内容渲染
 *      正常但合成不到屏幕；applyWebState 改为拉取 HTML 注入 <base> 后以同源 srcdoc 上层。
 * v30：网页壁纸高清化——壁纸页 canvas 按 CSS 像素建缓冲，150% 缩放屏上被拉伸发糊；
 *      改写为按 devicePixelRatio 物理像素渲染。
 * v31：铺满（cover）+ 超采样——spineCamera 视野钳进背景板包围盒（修屏边露底色），
 *      画布缓冲 ×1.5 超采样，排版改用缓冲尺寸计算（否则内容缩成屏中央一小块）。
 * v32：paintBg 的 applyWebState 改走全局蹦床 window.__zcodeBgApplyWeb（主进程每次注入刷新），
 *      防止跨版本存活的旧 UI 闭包用旧实现覆盖新壁纸状态。
 * v33：面板标题行的「✕ 关闭」键放大一档（zcbg-btn-lg：42px 高 / 15px 字），与大标题配平。
 * v35：拖拽换壁纸——把图片/视频文件直接拖进打开的面板就应用（与「选择图片/视频」同一条
 *      上传通道和大小上限，统一入口 usePickedFile）；「壁纸」定位轮询降频——面板开着
 *      0.5s 一轮、关着 2s 一轮，滚动（capture 捕获任意元素滚动）和布局变化
 *      （MutationObserver，停稳 400ms）即时重贴位置，不再纯靠轮询保响应。
 * v34：画质三件套——「画面增强（锐化）」滑块（sharpen 0~1，默认 0=原画质；视频/网页层套
 *      SVG 卷积锐化，图片切 <img> 层套 filter，平铺不支持）；卡片角标加「低码率」（假 4K
 *      提示，主进程按 mvhd 时长算真实码率）和「有损纹理」（DXT 抽帧）橙色标记；
 *      applyImageState/applySharpenState 与主进程共用实现，paintBg 走全局蹦床。
 * v25：修宽屏排版——卡片网格的容器（libEl/weEl）一直挂着 .zcbg-hint 的 max-width:44em，
 *      面板右侧大片留白；现在装网格的容器解除限宽（纯文字提示仍限宽），网格铺满面板全宽，
 *      卡片最小 150px（原 118px）+ 悬浮时封面轻微放大，更好看、更好点。
 * v26：静帧显示与分辨率——壁纸库卡片加左上角「图片/视频 + 分辨率」角标（和创意工坊同款，
 *      /list 的本机条目主进程现在带 w/h）；工坊「静帧」卡片缩略图改用静帧本体高清原图，
 *      不再是 254~1024 的方形封面（构图和点开后的画面一致，也不再糊）。
 * v24：工坊区块改「仅列出已导入」——Steam 新下载的壁纸不再自动出现在「创意工坊」里
 *      （避免新东西自己冒出来），想装随时点「从工坊导入」，选择列表仍扫工坊全量目录，
 *      新下载的马上就能选；展开选择列表前会先重拉一次清单，保证看得到刚下载的；
 *      工坊区块空了会提示去导入而不是说「没找到工坊库」。
 * v23：「随时间变化的壁纸」合成——同一工坊项目里能认出 ≥2 个时段（清晨/白天/黄昏/夜晚）
 *      的视频不再拆成 4 张卡，合一个「随时间」条目；选中后面板按系统时间自动换段
 *      （主进程 applyVideoState 里的 20s 定时器换 <video> 源，时段边界主进程下发），
 *      工坊区块里带「随时间」角标，当前壁纸名会显示现在播的是哪一段。
 * v22：「从工坊导入」重做——不再弹原生文件对话框（初始目录不可控，用户实测位置不对；
 *      全数字 ID 文件夹也没法用），改为面板内选择列表：/list 新增 weAll（weProjectCatalog
 *      扫全部工坊项目，含隐藏/低清，带标题和封面），点卡片发 op:"wePin" → 主进程把该项目
 *      加进 wePinned（低清封面强制列出，条目带 forced 标记）+ 从 weHidden 摘除 → 回传
 *      重扫条目，面板应用第一个并收起列表；再点一次「从工坊导入」收起。
 * v21：工坊「从工坊导入」不再复制文件进壁纸库——目标改成把工坊项目装进「创意工坊」区块。
 * v19：工坊区块标题旁加「打开文件夹」按钮（新增主进程 op:"weOpenFolder"，打开 Steam
 *      创意工坊目录）——在 Wallpaper Engine 里下载新壁纸后直达落点；面板本来就自动
 *      扫描该目录，下载完即出现在下面，无需导入。找不到工坊库时点它给指引。
 * v18：创意工坊条目也带「✕」删除点（两步确认，走主进程 op:"weDelete"）——清掉
 *      .we-pkg-cache 里该项目的抽取产物（整个 scene.pkg 的分段/纹理一起清），并把
 *      工坊目录记进 config.json 的 weHidden 防止下次扫描重新抽取；Steam 工坊本体不动。
 * v15（第一次使用者视角的易用性巡检）：
 *      - 面板标题行加了「✕ 关闭」：以前只能点空白处或 Esc 收起，新用户找不到出口；
 *      - 快捷预设按钮有了激活态（当前 extraCss 正好是某个预设时高亮），并加「撤销」——
 *        套错预设一步回退，不用记住之前填了什么；
 *      - 「🔍 扫描」旁边加「全部恢复」：放弃所有透明化/调色不再需要逐个关开关，
 *        overrides 攒满 24 条也不再让用户去手改 config.json；
 *      - 壁纸库超过 24 个时明说「还有 N 个没显示」，不再静默截断；
 *      - 报错文案去掉「注入器 / 主进程 / mediaBase」这类内部词，统一给人话指引；
 *      - 「清空自定义」改名「清除自定义 CSS」；「打开文件夹」按钮直达 wallpaper\ 目录
 *        （新增主进程 op:"openFolder"，zcode-bg.mjs 有对应分支和 op 对账自检）。
 * ==========================================================================*/
(() => {
  "use strict";

  const STYLE_ID = "__zcode_custom_bg_style__";
  const UI_STYLE_ID = "__zcode_bg_ui_style__";
  const LAYER_ID = "__zcode_bg_layer";
  const BINDING = "__zcodeBgHost";
  const VERSION = /*__ZCBG_VERSION__*/ 0;
  const S0 = /*__ZCBG_STATE__*/ null;

  /*__ZCBG_CSS_HELPERS__*/

  const host = window;
  if (!S0) return false;

  // 已经注入过同一版本：只更新状态，避免界面闪一下
  const prev = host.__zcodeBgUi;
  if (prev && prev.version === VERSION) {
    try {
      prev.setState(S0);
      return true;
    } catch (e) {
      /* 出错就走重建 */
    }
  }
  if (prev && typeof prev.destroy === "function") {
    try {
      prev.destroy();
    } catch (e) {
      /* ignore */
    }
  }

  /* --------------------------------- 状态 --------------------------------- */

  const state = {
    enabled: S0.enabled !== false,
    url: String(S0.url || ""),
    label: String(S0.label || ""),
    mediaType: S0.mediaType === "video" ? "video" : S0.mediaType === "web" ? "web" : "image",
    fit: ["cover", "contain", "fill", "tile"].indexOf(S0.fit) >= 0 ? S0.fit : "cover",
    align: ["center", "top", "bottom", "left", "right"].indexOf(S0.align) >= 0 ? S0.align : "center",
    panelAlpha: Number(S0.panelAlpha ?? 0.62),
    dim: Number(S0.dim ?? 0),
    dimColor: String(S0.dimColor || "#000000"),
    imageBlurPx: Number(S0.imageBlurPx ?? 0),
    sharpen: Math.max(0, Math.min(1, Number(S0.sharpen ?? 0) || 0)),
    videoMuted: S0.videoMuted !== false,
    videoSpeed: Math.max(0.25, Math.min(4, Number(S0.videoSpeed ?? 1) || 1)),
    videoPauseWhenHidden: S0.videoPauseWhenHidden !== false,
    // 随时间变化的分段壁纸（we-time://）：换段端点 + 时段边界；普通壁纸两项为空
    timeUrl: String(S0.timeUrl || ""),
    timeBounds: S0.timeBounds && typeof S0.timeBounds === "object" ? S0.timeBounds : null,
    autoTranslucent: S0.autoTranslucent !== false,
    mediaBase: String(S0.mediaBase || ""),
    translucentClasses: S0.translucentClasses || [],
    overrides: Array.isArray(S0.overrides) ? S0.overrides.filter(ovOk) : [],
    extraCss: String(S0.extraCss || ""),
  };

  // ZCode 原生导航项的两套 class（直接抄的）：未选中 / 选中
  const NAV_BASE =
    "shrink-0 flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground";
  const NAV_ACTIVE =
    "shrink-0 flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0 bg-surface-hover text-foreground";

  const ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image size-4 text-foreground" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';

  const h = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

  const FIT_OPTIONS = [
    { v: "cover", label: "铺满" },
    { v: "contain", label: "完整显示" },
    { v: "fill", label: "拉伸" },
    { v: "tile", label: "平铺", imageOnly: true },
  ];
  const FIT_VALUES = FIT_OPTIONS.map((o) => o.v);
  const ALIGN_VALUES = ["center", "top", "bottom", "left", "right"];
  const fmtBytes = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  };

  /* ------------------------------ 背景样式表 ------------------------------ */

  function cssForState() {
    return cssFromState({
      url: state.url,
      type: state.mediaType,
      fit: state.fit,
      align: state.align,
      panelAlpha: state.panelAlpha,
      dim: state.dim,
      dimColor: state.dimColor,
      imageBlurPx: state.imageBlurPx,
      sharpen: state.sharpen,
      translucentClasses: state.translucentClasses,
      // 必须带上 overrides：漏掉的话拖动调色时页面本地先写一版「没有调色规则」的 CSS
      // （色块瞬间还原），400ms 后主进程 applyToWindowForAll 又推回带规则的版本 —— 一闪一闪。
      overrides: state.overrides,
      extraCss: state.extraCss,
    });
  }

  /** 当前应该播放的视频层状态；非视频 / 未启用时为 null */
  function videoStateNow() {
    if (!state.enabled || state.mediaType !== "video" || !state.url) return null;
    return {
      type: "video",
      url: state.url,
      timeUrl: state.timeUrl || "",
      timeBounds: state.timeBounds || null,
      muted: state.videoMuted !== false,
      loop: true,
      speed: state.videoSpeed,
      fit: FIT_VALUES.indexOf(state.fit) >= 0 ? state.fit : "cover",
      align: ALIGN_VALUES.indexOf(state.align) >= 0 ? state.align : "center",
      pauseWhenHidden: state.videoPauseWhenHidden !== false,
      sharpen: state.sharpen,
    };
  }

  /** 当前应该挂的网页壁纸层状态；非 we-web 壁纸 / 未启用时为 null */
  function webStateNow() {
    if (!state.enabled || state.mediaType !== "web" || !state.url) return null;
    return { type: "web", url: state.url, sharpen: state.sharpen };
  }

  /** 图片的 <img> 层状态：只在开锐化时启用（平时走 CSS 背景，锐化 0 不改老路径） */
  function imageStateNow() {
    if (!state.enabled || state.mediaType !== "image" || !state.url) return null;
    if (state.sharpen <= 0 || state.fit === "tile") return null;
    return {
      type: "image",
      url: state.url,
      fit: FIT_VALUES.indexOf(state.fit) >= 0 ? state.fit : "cover",
      align: ALIGN_VALUES.indexOf(state.align) >= 0 ? state.align : "center",
      sharpen: state.sharpen,
    };
  }

  function paintBg() {
    try {
      // applyWebState/applyImageState/applySharpenState 走全局蹦床：UI 闭包可能跨多轮注入
      // 存活，它捕获的实现是旧的；主进程每次注入都会刷新这些全局引用，调到的始终是最新版。
      const applyWeb = typeof host.__zcodeBgApplyWeb === "function" ? host.__zcodeBgApplyWeb : applyWebState;
      const applyImage = typeof host.__zcodeBgApplyImage === "function" ? host.__zcodeBgApplyImage : applyImageState;
      const applySharpen = typeof host.__zcodeBgApplySharpen === "function" ? host.__zcodeBgApplySharpen : applySharpenState;
      if (!state.enabled || !state.url) {
        const el = document.getElementById(STYLE_ID);
        if (el) el.remove();
        applyVideoState(null);
        applyWeb(null);
        applyImage(null);
        applySharpen(null);
        host.__zcodeBg = { applied: false, reason: state.enabled ? "没有壁纸" : "已在设置里关闭" };
        return;
      }
      let el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
        (document.head || document.documentElement).appendChild(el);
      }
      const css = cssForState();
      if (el.textContent !== css) el.textContent = css;
      applyVideoState(videoStateNow());
      applyWeb(webStateNow());
      applyImage(imageStateNow());
      applySharpen(state.sharpen > 0 ? { sharpen: state.sharpen } : null);
      host.__zcodeBg = { applied: true, bytes: css.length };
    } catch (e) {
      host.__zcodeBg = { applied: false, error: String(e) };
    }
  }

  const UI_CSS = `
#${LAYER_ID}{position:fixed;inset:0;z-index:900;pointer-events:none;display:none}
#${LAYER_ID} .zcbg-nav{position:fixed;pointer-events:auto;margin:0;cursor:pointer;font:inherit;background:transparent;border:0;color:inherit}
#${LAYER_ID} .zcbg-panel{position:fixed;pointer-events:auto;display:none;overflow:hidden}
#${LAYER_ID} .zcbg-sec{margin-top:32px}
#${LAYER_ID} .zcbg-sec:first-of-type{margin-top:24px}
#${LAYER_ID} .zcbg-row{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-top:18px}
/* 区块标题行的按键不跟随 space-between 散到面板两端，左对齐紧跟标题 */
#${LAYER_ID} .zcbg-row-left{justify-content:flex-start;align-items:center}
#${LAYER_ID} .zcbg-btns{display:flex;flex:0 0 auto;align-items:center;gap:10px}
#${LAYER_ID} .zcbg-hint{margin-top:3px;max-width:44em;font-size:13px;line-height:1.55;color:var(--color-foreground-subtle, color-mix(in oklab, var(--color-foreground) 62%, transparent))}
/* 装卡片网格的容器解除 44em 文本限宽：面板多宽网格就铺多宽，右边不再留白 */
#${LAYER_ID} .zcbg-hint:has(>.zcbg-lib){max-width:none}
#${LAYER_ID} .zcbg-ctl{display:flex;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:10px;min-width:250px;padding-top:1px}
#${LAYER_ID} .zcbg-range{-webkit-appearance:none;appearance:none;width:150px;height:4px;border-radius:999px;outline:none;background:var(--color-surface-hover, color-mix(in oklab, var(--color-foreground) 14%, transparent))}
#${LAYER_ID} .zcbg-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border:0;border-radius:50%;cursor:pointer;background:var(--color-foreground, #e5e5e5)}
#${LAYER_ID} .zcbg-val{min-width:54px;text-align:right;font-size:13px;font-variant-numeric:tabular-nums;color:var(--color-foreground-subtle, color-mix(in oklab, var(--color-foreground) 62%, transparent))}
#${LAYER_ID} .zcbg-switch{position:relative;width:36px;height:20px;flex:0 0 auto;padding:0;border:0;border-radius:999px;cursor:pointer;background:var(--color-surface-hover, color-mix(in oklab, var(--color-foreground) 18%, transparent));transition:background .15s}
#${LAYER_ID} .zcbg-switch[aria-checked="true"]{background:var(--color-foreground, #e5e5e5)}
#${LAYER_ID} .zcbg-switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--color-background, #1a1a1a);transition:left .15s}
#${LAYER_ID} .zcbg-switch[aria-checked="true"] i{left:18px}
#${LAYER_ID} .zcbg-btn{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--color-border, rgba(128,128,128,.3));border-radius:10px;background:transparent;color:var(--color-foreground, #e5e5e5);font:inherit;font-size:13px;cursor:pointer;transition:background .15s,border-color .15s}
#${LAYER_ID} .zcbg-btn:hover{background:var(--color-surface-hover, color-mix(in oklab, var(--color-foreground) 12%, transparent));border-color:var(--color-border-hover, rgba(160,160,160,.5))}
#${LAYER_ID} .zcbg-btn[data-on="1"]{background:color-mix(in oklab, var(--color-background, #111) 60%, transparent);border-color:#a78bfa;color:#a78bfa}
#${LAYER_ID} .zcbg-btn:disabled{opacity:.4;cursor:default}
#${LAYER_ID} .zcbg-btn-lg{height:42px;padding:0 18px;font-size:15px;border-radius:12px;gap:8px}
#${LAYER_ID} .zcbg-thumb{width:210px;height:118px;flex:0 0 auto;border:1px solid var(--color-border, rgba(128,128,128,.3));border-radius:10px;object-fit:cover;background:var(--color-surface-hover, rgba(128,128,128,.15))}
#${LAYER_ID} .zcbg-status{margin-top:20px;padding-top:16px;border-top:1px solid var(--color-border, rgba(128,128,128,.2));font-size:12.5px;line-height:1.6;color:var(--color-foreground-subtle, color-mix(in oklab, var(--color-foreground) 58%, transparent))}
#${LAYER_ID} .zcbg-status[data-bad="1"]{color:var(--color-destructive, #e5484d)}
#${LAYER_ID} .zcbg-badge{display:inline-block;margin-left:6px;padding:1px 6px;border:1px solid var(--color-border, rgba(128,128,128,.3));border-radius:6px;font-size:11.5px;color:var(--color-foreground-subtle, #999)}
#${LAYER_ID} .zcbg-seg{display:inline-flex;overflow:hidden;border:1px solid var(--color-border, rgba(128,128,128,.3));border-radius:10px}
#${LAYER_ID} .zcbg-seg button{height:28px;padding:0 12px;border:0;background:transparent;color:var(--color-foreground-subtle, #999);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
#${LAYER_ID} .zcbg-seg button + button{border-left:1px solid var(--color-border, rgba(128,128,128,.3))}
#${LAYER_ID} .zcbg-seg button[data-on="1"]{background:var(--color-surface-hover, color-mix(in oklab, var(--color-foreground) 14%, transparent));color:var(--color-foreground, #e5e5e5)}
#${LAYER_ID} .zcbg-select{height:32px;padding:0 8px;border:1px solid var(--color-border, rgba(128,128,128,.3));border-radius:10px;background:transparent;color:var(--color-foreground, #e5e5e5);font:inherit;font-size:13px;cursor:pointer}
#${LAYER_ID} .zcbg-lib{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:10px}
#${LAYER_ID} .zcbg-lib-item{position:relative;width:100%;aspect-ratio:16/9;padding:0;border:1px solid var(--color-border, rgba(128,128,128,.3));border-radius:10px;background:transparent;cursor:pointer;overflow:hidden}
#${LAYER_ID} .zcbg-lib-item:hover{border-color:var(--color-border-hover, rgba(160,160,160,.5))}
#${LAYER_ID} .zcbg-lib-item[data-cur="1"]{border-color:var(--color-foreground, #e5e5e5);box-shadow:0 0 0 1px var(--color-foreground, #e5e5e5)}
#${LAYER_ID} .zcbg-lib-item img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .15s ease}
#${LAYER_ID} .zcbg-lib-item:hover img{transform:scale(1.04)}
#${LAYER_ID} .zcbg-lib-v{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;color:var(--color-foreground-subtle, #999);background:var(--color-surface-hover, rgba(128,128,128,.15))}
#${LAYER_ID} .zcbg-lib-name{position:absolute;left:0;right:0;bottom:0;padding:2px 6px;font-size:11px;line-height:1.4;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--color-foreground, #eee);background:color-mix(in oklab, var(--color-background, #111) 72%, transparent)}
#${LAYER_ID} .zcbg-lib-del{position:absolute;top:5px;right:5px;display:flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 5px;border:1px solid var(--color-border, rgba(128,128,128,.4));border-radius:7px;background:color-mix(in oklab, var(--color-background, #111) 80%, transparent);color:var(--color-foreground, #eee);font-size:12px;line-height:1;cursor:pointer;opacity:.55;transition:opacity .15s,background .15s,border-color .15s}
#${LAYER_ID} .zcbg-lib-item:hover .zcbg-lib-del{opacity:1}
#${LAYER_ID} .zcbg-lib-del:hover{background:color-mix(in oklab, #ef4444 60%, transparent);border-color:#ef4444;opacity:1}
#${LAYER_ID} .zcbg-lib-del[data-arm="1"]{background:#ef4444;border-color:#ef4444;color:#fff;opacity:1}
#${LAYER_ID} .zcbg-lib-del[data-busy="1"]{opacity:.4;cursor:default}
#${LAYER_ID} .zcbg-lib-item[data-busy="1"]{opacity:.45;pointer-events:none}
#${LAYER_ID} .zcbg-lib-kind{position:absolute;top:5px;left:5px;z-index:1;padding:1px 6px;border-radius:6px;font-size:10.5px;line-height:1.5;color:#fff;background:color-mix(in oklab, #6d5ce8 80%, transparent)}
/* 画质提示（低码率/有损纹理）：橙色，一眼和普通角标区分开 */
#${LAYER_ID} .zcbg-lib-kind[data-warn="1"]{background:color-mix(in oklab, #c77b21 88%, transparent)}
#${LAYER_ID} .zcbg-scan{display:flex;flex-direction:column;gap:2px;margin:-6px 0 4px;padding:8px 10px;border:1px dashed var(--color-border, rgba(128,128,128,.4));border-radius:10px}
#${LAYER_ID} .zcbg-scan-row{display:flex;align-items:center;gap:8px;min-height:26px;font-size:12px}
#${LAYER_ID} .zcbg-scan-sel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--color-foreground,#eee);cursor:pointer}
#${LAYER_ID} .zcbg-scan-sel:hover{color:#a78bfa}
#${LAYER_ID} .zcbg-scan-sel[data-hl="1"]{color:#a78bfa}
body .zcbg-scan-hl{outline:2px dashed #a78bfa !important;outline-offset:-2px;box-shadow:inset 0 0 0 99999px rgba(167,139,250,.07) !important}
#${LAYER_ID} .zcbg-scan-meta{flex:0 0 auto;color:var(--color-foreground-subtle,#999)}
#${LAYER_ID} .zcbg-scan-color{display:flex;align-items:center;gap:8px;padding:2px 0 2px 28px;min-height:24px;font-size:12px}
#${LAYER_ID} .zcbg-mini{padding:2px 8px;font-size:12px;line-height:1.4;border-radius:6px;border:1px solid var(--color-border,rgba(128,128,128,.4));background:transparent;color:var(--color-foreground,#eee);cursor:pointer}
#${LAYER_ID} .zcbg-mini[aria-pressed="true"]{background:color-mix(in oklab, var(--color-background,#111) 60%, transparent);border-color:#a78bfa}
#${LAYER_ID} .zcbg-scan-chip{width:34px;height:16px;border-radius:4px;border:1px solid var(--color-border,rgba(128,128,128,.4));flex:none}
#${LAYER_ID} .zcbg-scan-color input[type="color"]{width:30px;height:20px;padding:0;border:1px solid var(--color-border,rgba(128,128,128,.4));border-radius:4px;background:transparent;cursor:pointer;flex:none}
#${LAYER_ID} .zcbg-scan-color input[type="range"]{width:90px;flex:none}
#${LAYER_ID} .zcbg-scan-alpha{font-size:11px;color:var(--color-foreground-subtle,#999);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
/* 拖拽反馈：文件拖进面板时整面板虚线描边，提示「松开即应用」 */
#${LAYER_ID} .zcbg-panel[data-drop="1"]::after{content:"松开鼠标，把这份文件设为壁纸";position:absolute;inset:8px;z-index:5;display:flex;align-items:center;justify-content:center;border:2px dashed #a78bfa;border-radius:14px;background:color-mix(in oklab,#a78bfa 10%,transparent);font-size:16px;font-weight:500;color:#a78bfa;pointer-events:none}
`;

  /* ------------------------------- 界面构建 ------------------------------- */

  let layer = null;
  let navEl = null;
  let navLabel = null;
  let panelEl = null;
  let thumbImg = null;
  let thumbVideo = null;
  let switchEls = {};
  let rangeEls = {};
  let valEls = {};
  let statusEl = null;
  let labelEl = null;
  let fileEl = null;
  let fileVideo = null;
  let segEl = null;
  let alignSel = null;
  let alignRow = null;
  let videoSec = null;
  let libEl = null;
  let libItems = [];
  let weEl = null;
  let weItems = [];
  let weAllItems = []; // 工坊里全部项目（含隐藏/低清），「从工坊导入」的选择列表用
  let wePickMode = false; // 「从工坊导入」的选择列表是否展开
  let weLow = 0; // 工坊里只有低清封面图、被藏起来的场景型壁纸数量
  let uiActive = false;
  let hiddenMain = null;
  let saveTimer = 0;
  let downPos = null;

  function setStatus(text, bad) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.setAttribute("data-bad", bad ? "1" : "0");
  }

  function send(msg) {
    const fn = host[BINDING];
    if (typeof fn !== "function") {
      setStatus("⚠ 壁纸后台程序没在运行——现在的改动只在本次有效，重新打开 ZCode 后即可恢复自动保存。", true);
      return false;
    }
    try {
      fn(JSON.stringify(msg));
      return true;
    } catch (e) {
      setStatus("⚠ 保存改动失败：" + e, true);
      return false;
    }
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (
        send({
          op: "config",
          patch: {
            enabled: state.enabled,
            panelAlpha: state.panelAlpha,
            dim: state.dim,
            imageBlurPx: state.imageBlurPx,
            sharpen: state.sharpen,
            fit: state.fit,
            align: state.align,
            videoMuted: state.videoMuted,
            videoSpeed: state.videoSpeed,
            videoPauseWhenHidden: state.videoPauseWhenHidden,
            autoTranslucent: state.autoTranslucent,
            overrides: state.overrides,
            extraCss: state.extraCss,
          },
        })
      ) {
        setStatus("✔ 已保存，重新打开 ZCode 后依然生效。");
      }
    }, 400);
  }

  function makeSwitch(key) {
    const b = h("button", "zcbg-switch");
    b.type = "button";
    b.setAttribute("role", "switch");
    b.appendChild(h("i"));
    b.addEventListener("click", () => {
      state[key] = !state[key];
      syncUi();
      paintBg();
      queueSave();
    });
    switchEls[key] = b;
    return b;
  }

  function makeRange(key, min, max, step, fmt) {
    const wrap = h("span", "zcbg-ctl");
    const r = h("input", "zcbg-range");
    r.type = "range";
    r.min = String(min);
    r.max = String(max);
    r.step = String(step);
    r.value = String(state[key]);
    const v = h("span", "zcbg-val", fmt(state[key]));
    r.addEventListener("input", () => {
      state[key] = Number(r.value);
      v.textContent = fmt(state[key]);
      paintBg();
    });
    r.addEventListener("change", queueSave);
    rangeEls[key] = r;
    valEls[key] = { el: v, fmt };
    wrap.append(r, v);
    return wrap;
  }

  function makeRow(title, hint, control) {
    const row = h("div", "zcbg-row");
    const left = h("div");
    left.appendChild(h("div", "text-ui-base font-medium text-foreground", title));
    if (hint) left.appendChild(h("div", "zcbg-hint", hint));
    row.append(left, control);
    return row;
  }

  function makeButton(text, onClick, title) {
    const b = h("button", "zcbg-btn", text);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  /* —— 🔍 实心区域扫描：找出挡住壁纸的大块实心表面，逐个开关透明化（overrides） —— */

  /** overrides 条目合法性（字符串=强制透明；对象=该区域调成任意半透明颜色），坏条目直接丢。 */
  function ovOk(x) {
    if (typeof x === "string") return x.trim().length > 0 && x.trim().length <= 200;
    return !!(x && typeof x === "object" && typeof x.selector === "string" && x.selector.trim() && typeof x.background === "string");
  }

  /** 在 overrides 里找某选择器的当前状态：off（没配置）/ transparent（强制透明）/ custom（自定义颜色）。 */
  function ovFind(sel) {
    for (let i = 0; i < state.overrides.length; i++) {
      const o = state.overrides[i];
      if (o === sel) return { idx: i, mode: "transparent" };
      if (o && typeof o === "object" && o.selector === sel) return { idx: i, mode: "custom", bg: o.background };
    }
    return { idx: -1, mode: "off" };
  }

  /** 从 overrides 里移除某选择器的任意形式条目；返回是否真的删了。 */
  function ovRemove(sel) {
    const i = state.overrides.findIndex((x) => x === sel || (x && typeof x === "object" && x.selector === sel));
    if (i >= 0) state.overrides.splice(i, 1);
    return i >= 0;
  }

  /** 把我们生成的 rgba(r,g,b,a) 拆成编辑器用的 {hex, a}；拆不动的返回默认黑 35%。 */
  function bgToPicker(v) {
    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/.exec((v || "").trim());
    if (m) {
      const hex =
        "#" + [1, 3, 5].map((k) => parseInt(m[k], 10).toString(16).padStart(2, "0")).join("");
      return { hex, a: m[4] === undefined ? 1 : Math.max(0.05, Math.min(0.95, parseFloat(m[4]))) };
    }
    return { hex: "#000000", a: 0.35 };
  }

  /** 计算背景色的不透明度。Chromium 可能给 rgb()/rgba()/color(srgb …)/color-mix(…) 各式各样，统一抠出 alpha。 */
  function bgAlpha(c) {
    if (!c || c === "transparent") return 0;
    const rgb = /rgba?\(([^)]+)\)/.exec(c);
    if (rgb) {
      const p = rgb[1].split(/[,/]/).map((s) => parseFloat(s));
      return p.length >= 4 ? p[3] : 1;
    }
    const modern = /\/\s*([\d.]+)\s*\)/.exec(c); // color(srgb … / a)、oklab(… / a) 这类新写法
    return modern ? Math.min(1, parseFloat(modern[1])) : 1;
  }

  /** 扫描按钮：跑一次扫描并渲染结果列表；已配置的 overrides 会预亮开关。 */
  function runScan() {
    if (state.enabled === false) {
      setStatus("壁纸当前是关着的——先打开开关，扫描出来才有意义。", true);
      return;
    }
    scanResults = scanOpaqueSurfaces();
    let tinted = false;
    if (!scanResults.length) {
      // 没有实心区域（界面本来就很透）时，退而列出半透明的大块面板——🎨 调色照样有用武之地
      scanResults = scanTintedPanels();
      tinted = scanResults.length > 0;
    }
    scanEl.style.display = "";
    renderScanResults();
    setStatus(
      tinted
        ? "扫到 " + scanResults.length + " 块半透明面板（不挡壁纸）——点 🎨 可给它换成任意颜色。"
        : scanResults.length
          ? "扫到 " + scanResults.length + " 类实心区域，打开右侧开关即可单独透明化。"
          : "扫描完成：没有可调的大块区域。",
    );
  }

  /* —— extraCss 快捷预设：常用效果一键填入，不用自己写 CSS —— */

  const PRESET_FROST =
    ".bg-background,.bg-background-alt,.bg-background-win-alt,.bg-header,.bg-panel,.bg-sidebar{backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2)}";
  const PRESET_MAX = '[class*="bg-"]{background-color:transparent !important}';
  // 折中档：覆盖面和「彻底透明」一样广，但保留 6px 轻模糊 + 15% 压暗——壁纸透进来、不刺眼
  const PRESET_SOFT =
    '[class*="bg-"]{background-color:transparent !important;backdrop-filter:blur(6px) brightness(.85) saturate(1.1);-webkit-backdrop-filter:blur(6px) brightness(.85) saturate(1.1)}';

  function applyExtraCss(css, note) {
    if (state.extraCss !== css) undoCss = state.extraCss;
    state.extraCss = css;
    paintBg();
    queueSave();
    syncUi();
    setStatus(note);
  }

  /** 撤销：把「最近一次套预设之前」的 extraCss 还回去；再点一下会切回来，可反复对照。 */
  function undoExtraCss() {
    const prev = undoCss;
    undoCss = null;
    applyExtraCss(prev === null ? "" : prev, prev ? "✔ 已撤销，恢复到套用预设前的自定义 CSS。" : "✔ 已撤销——套用前没有自定义 CSS，现在是干净状态。");
  }

  /** 一键放弃所有扫描透明化/调色（overrides 清空并自动保存），不用去 config.json 里手删。 */
  function restoreAllOverrides() {
    if (!state.overrides.length) {
      setStatus("还没有透明化/调色过任何区域，不用恢复。");
      return;
    }
    const n = state.overrides.length;
    state.overrides = [];
    renderScanResults();
    paintBg();
    queueSave();
    setStatus("✔ 已把 " + n + " 个区域恢复成原始背景，并自动保存。");
  }

  /** 让主进程打开 wallpaper\ 文件夹（op:"openFolder"，主进程有对应分支）。 */
  function openWallpaperFolder() {
    if (!send({ op: "openFolder" })) return;
    setStatus("正在打开壁纸文件夹…放进去的图片/视频会出现在「壁纸库」里。");
  }

  /** 让主进程打开 Wallpaper Engine 创意工坊文件夹（op:"weOpenFolder"，主进程有对应分支）。 */
  function openWeFolder() {
    if (!send({ op: "weOpenFolder" })) return;
    setStatus("正在打开 Wallpaper Engine 创意工坊文件夹…新下载的壁纸随时点「从工坊导入」装进来。");
  }

  /** 「从工坊导入」开关：展开/收起工坊项目选择列表；点卡片发 op:"wePin"（主进程钉住该项目并回传条目）。
   *  展开时先重拉一次清单——工坊区块只列导入过的项目，新下载的要在这里能马上看到。 */
  function importFromWe() {
    wePickMode = !wePickMode;
    if (wePickMode) {
      refreshLibrary();
      setStatus("在下面的列表里点一个要装的壁纸（工坊里全部项目都在，新下载的也随时能选）——装好会自动应用；再点一次「从工坊导入」收起列表。");
    } else {
      renderWe();
      setStatus("已收起工坊选择列表。");
    }
  }

  /** 元素 → 一个「够稳、够短」的 CSS 选择器：tag + id + 前 3 个 class，和 --diagnose 的 label 同一套习惯。 */
  function selectorOf(el) {
    const tag = (el.tagName || "div").toLowerCase();
    const id = el.id && /^[A-Za-z][\w-]*$/.test(el.id) ? "#" + el.id : "";
    const cls =
      typeof el.className === "string"
        ? el.className
            .trim()
            .split(/\s+/)
            .filter((x) => x && x.length <= 40)
            .slice(0, 3)
            .map((x) => "." + (window.CSS && CSS.escape ? CSS.escape(x) : x))
            .join("")
        : "";
    return tag + id + cls;
  }

  /** 扫出「面积够大 + 背景 alpha 在 [minA, maxA)」的表面，按选择器归组，面积大的排前面。
   *  第一档（实心）：minA=0.9——挡壁纸的；第二档（半透明）：没有实心区域时兜底，供 🎨 重新调色。 */
  function scanSurfaces(minA, tint) {
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const varea = vw * vh;
    const groups = new Map();
    for (const el of document.querySelectorAll("body *")) {
      if (el.id && String(el.id).indexOf("__zcode_bg") === 0) continue;
      if (el.closest && el.closest("#" + LAYER_ID)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.35 || r.height < vh * 0.25) continue;
      if (r.width * r.height < varea * 0.18) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
      const a = bgAlpha(cs.backgroundColor);
      if (a < minA || a >= 1) continue;
      const sel = selectorOf(el);
      if (!sel) continue;
      const g = groups.get(sel) || { sel, count: 0, area: 0, tint: !!tint };
      g.count += 1;
      g.area = Math.max(g.area, Math.round(((r.width * r.height) / varea) * 100));
      groups.set(sel, g);
    }
    return [...groups.values()].sort((a, b) => b.area - a.area).slice(0, 12);
  }

  function scanOpaqueSurfaces() {
    return scanSurfaces(0.9, false);
  }

  /** 没有实心区域时的第二档：列出「已经半透明」的大块面板——它们不挡壁纸，但可以用 🎨 换成任意颜色。 */
  function scanTintedPanels() {
    return scanSurfaces(0.02, true);
  }

  let scanEl = null;
  let scanResults = [];
  /* 快捷预设的按钮引用 + 撤销栈（只记一步：套预设前的 extraCss）。 */
  let presetBtns = [];
  let undoBtn = null;
  let undoCss = null;

  /* —— 高亮：点扫描结果的选择器名，页面上对应的区域描边显示 —— */
  let hlSel = "";
  let hlEls = [];

  function applyHl() {
    for (const el of hlEls) el.classList.remove("zcbg-scan-hl");
    hlEls = [];
    if (!hlSel) return;
    try {
      hlEls = [...document.querySelectorAll(hlSel)].slice(0, 60);
    } catch {
      hlEls = [];
      hlSel = "";
    }
    for (const el of hlEls) el.classList.add("zcbg-scan-hl");
  }

  function clearHl() {
    hlSel = "";
    applyHl();
  }

  function renderScanResults() {
    if (!scanEl) return;
    scanEl.textContent = "";
    if (!scanResults.length) {
      scanEl.appendChild(h("div", "zcbg-hint", "没扫到挡住壁纸的大块实心区域——当前界面已经透得不错了。"));
      return;
    }
    if (scanResults[0].tint) {
      scanEl.appendChild(h("div", "zcbg-hint", "没有实心区域了；下面是已经透明的大块面板，用 🎨 可给它们换任意颜色，点名字可在页面上高亮位置："));
    }
    for (const g of scanResults) {
      const row = h("div", "zcbg-scan-row");
      const label = h("span", "zcbg-scan-sel", g.sel);
      label.title = g.sel + "（×" + g.count + "）—— 点击在页面上高亮这块区域";
      if (hlSel === g.sel) label.setAttribute("data-hl", "1");
      label.addEventListener("click", () => {
        hlSel = hlSel === g.sel ? "" : g.sel;
        applyHl();
        renderScanResults();
      });
      const meta = h("span", "zcbg-scan-meta", (g.tint ? "半透明 · " : "") + "×" + g.count + " · 占" + g.area + "%");
      const sw = h("button", "zcbg-switch");
      sw.type = "button";
      sw.setAttribute("role", "switch");
      sw.appendChild(h("i"));
      // 调色子行的控件（不管当前是什么模式都先建好，用 display 切换显隐，避免每次拖动都重建 DOM）
      const paintWrap = h("div", "zcbg-scan-color");
      const chip = h("span", "zcbg-scan-chip");
      const colorEl = h("input");
      colorEl.type = "color";
      colorEl.value = "#000000";
      const alphaEl = h("input");
      alphaEl.type = "range";
      alphaEl.min = "5";
      alphaEl.max = "95";
      alphaEl.step = "1";
      alphaEl.value = "35";
      const alphaTxt = h("span", "zcbg-scan-alpha");
      const toRgba = (hex, a) =>
        "rgba(" +
        parseInt(hex.slice(1, 3), 16) + ", " + parseInt(hex.slice(3, 5), 16) + ", " +
        parseInt(hex.slice(5, 7), 16) + ", " + a.toFixed(2) + ")";
      /** 按当前 colorEl/alphaEl 值生成 rgba 背景串。 */
      const pickBg = () => toRgba(colorEl.value, parseInt(alphaEl.value, 10) / 100);
      const syncEditor = () => {
        const cur = ovFind(g.sel);
        const pv = bgToPicker(cur.mode === "custom" ? cur.bg : "");
        colorEl.value = pv.hex;
        alphaEl.value = String(Math.round(pv.a * 100));
        const shown = cur.mode === "custom" ? cur.bg : pickBg();
        chip.style.background = shown;
        alphaTxt.textContent = shown;
      };
      const paint = h("button", "zcbg-mini", "🎨");
      paint.type = "button";
      paint.title = "把这块区域调成任意半透明颜色（不只透明）";
      paint.setAttribute("aria-pressed", ovFind(g.sel).mode === "custom" ? "true" : "false");
      sw.addEventListener("click", () => {
        const cur = ovFind(g.sel);
        if (cur.mode !== "off") {
          state.overrides.splice(cur.idx, 1);
          setStatus("已恢复「" + g.sel + "」的原始背景。");
        } else {
          if (state.overrides.length >= 24) {
            setStatus("自定义透明化的区域最多 24 个，已经满了——点上面的「全部恢复」清掉一些再试。", true);
            return;
          }
          state.overrides.push(g.sel);
          setStatus("✔ 已把「" + g.sel + "」透明化并自动保存，重新打开 ZCode 后依然生效。");
        }
        renderScanResults();
        paintBg();
        queueSave();
      });
      paint.addEventListener("click", () => {
        const cur = ovFind(g.sel);
        if (cur.mode === "custom") {
          state.overrides.splice(cur.idx, 1);
          setStatus("已恢复「" + g.sel + "」的原始背景。");
        } else {
          if (cur.mode === "off" && state.overrides.length >= 24) {
            setStatus("自定义透明化的区域最多 24 个，已经满了——点上面的「全部恢复」清掉一些再试。", true);
            return;
          }
          if (cur.mode === "transparent") state.overrides.splice(cur.idx, 1);
          state.overrides.push({ selector: g.sel, background: pickBg() });
          setStatus("✔ 已给「" + g.sel + "」设置半透明颜色，可在下方色板里继续调。");
        }
        renderScanResults();
        paintBg();
        queueSave();
      });
      paintWrap.append(chip, colorEl, alphaEl, alphaTxt);
      syncEditor();
      colorEl.addEventListener("input", () => {
        const i = state.overrides.findIndex((x) => x && typeof x === "object" && x.selector === g.sel);
        if (i >= 0) {
          state.overrides[i] = { selector: g.sel, background: pickBg() };
          chip.style.background = state.overrides[i].background;
          alphaTxt.textContent = state.overrides[i].background;
          paintBg();
          queueSave();
        }
      });
      alphaEl.addEventListener("input", () => {
        const i = state.overrides.findIndex((x) => x && typeof x === "object" && x.selector === g.sel);
        if (i >= 0) {
          state.overrides[i] = { selector: g.sel, background: pickBg() };
          paintBg();
          queueSave();
          chip.style.background = state.overrides[i].background;
          alphaTxt.textContent = state.overrides[i].background;
        }
      });
      paintWrap.style.display = ovFind(g.sel).mode === "custom" ? "flex" : "none";
      sw.setAttribute("aria-checked", ovFind(g.sel).mode !== "off" ? "true" : "false");
      row.append(label, meta, paint, sw);
      scanEl.appendChild(row);
      scanEl.appendChild(paintWrap);
    }
  }

  function buildPanel() {
    const panel = h(
      "div",
      "zcbg-panel relative flex flex-col min-h-0 h-full rounded-xl border border-border bg-background",
    );
    panel.id = LAYER_ID + "_panel";

    const scroll = h("main", "min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]");
    // v25：原本抄 ZCode 设置页的 max-w-4xl（896px）在宽屏上右边留一大块空白，
    // 卡片网格根本铺不开——放宽到 1600px（超宽屏也不至于摊得太开），壁纸库/工坊的
    // 卡片网格就吃满面板宽度了；说明文字仍有 .zcbg-hint 的 44em 限宽兜着可读性。
    const wrap = h(
      "div",
      "mx-auto w-full max-w-[1600px] px-4 pb-8 pt-6 lg:px-8 lg:pb-10 flex flex-col gap-8",
    );

    /* 标题行右侧放一个显眼的关闭按钮：点空白处 / Esc 也行，但第一次用的人会找「✕」。
       v33：标题是 text-2xl/3xl 大字，32px 小按钮在旁边显得瘪——关闭键放大一档（zcbg-btn-lg）配平。 */
    const headRow = h("div", "flex items-center justify-between gap-4");
    headRow.appendChild(h("h1", "text-2xl font-semibold tracking-tight text-foreground lg:text-3xl", "壁纸"));
    const closeBtn = makeButton("✕ 关闭", () => setPanel(false), "关闭壁纸设置（点空白处或按 Esc 也可以）");
    closeBtn.classList.add("zcbg-btn-lg");
    headRow.appendChild(closeBtn);
    wrap.appendChild(headRow);

    /* —— 背景壁纸 —— */
    const sec1 = h("section", "zcbg-sec");
    sec1.appendChild(h("h2", "text-ui-lg font-semibold text-foreground", "背景壁纸"));
    sec1.appendChild(
      h("p", "mt-1 text-ui-base leading-6 text-foreground-subtle", "选一张图片当 ZCode 的背景，面板会变半透明，图片从后面透出来。"),
    );

    sec1.appendChild(
      makeRow("启用壁纸", "关掉就恢复 ZCode 默认外观（等同 --off）。", makeSwitch("enabled")),
    );

    const pickRow = h("div", "zcbg-ctl");
    fileEl = h("input");
    fileEl.type = "file";
    fileEl.accept = "image/*";
    fileEl.style.display = "none";
    fileEl.addEventListener("change", onPickImage);
    fileVideo = h("input");
    fileVideo.type = "file";
    fileVideo.accept = "video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.m4v,.webm,.mov,.mkv";
    fileVideo.style.display = "none";
    fileVideo.addEventListener("change", onPickVideo);
    pickRow.append(
      fileEl,
      fileVideo,
      makeButton("选择图片…", () => fileEl.click()),
      makeButton("选择视频…", () => fileVideo.click()),
      makeButton("用内置示例", onUseSample),
    );
    sec1.appendChild(
      makeRow("壁纸文件", "图片（≤15MB）和视频（≤1GB）都支持。选完立即生效并自动保存，重新打开 ZCode 后依然生效。", pickRow),
    );

    const previewRow = h("div", "zcbg-ctl");
    thumbImg = h("img", "zcbg-thumb");
    thumbImg.alt = "当前壁纸预览";
    thumbVideo = h("video", "zcbg-thumb");
    thumbVideo.muted = true;
    thumbVideo.loop = true;
    thumbVideo.autoplay = true;
    thumbVideo.setAttribute("playsinline", "");
    previewRow.append(thumbImg, thumbVideo);
    labelEl = h("div", "zcbg-hint");
    const previewLeft = h("div");
    previewLeft.appendChild(labelEl);
    const preview = h("div", "zcbg-row");
    preview.append(previewLeft, previewRow);
    sec1.appendChild(preview);

    /* —— 壁纸库 —— */
    const libHead = h("div", "zcbg-row zcbg-row-left");
    libHead.appendChild(h("p", "text-ui-base font-medium text-foreground", "壁纸库"));
    const libBtns = h("div", "zcbg-btns");
    libBtns.appendChild(makeButton("🎲 随机换一张", pickRandomWallpaper));
    libBtns.appendChild(
      makeButton("打开文件夹", openWallpaperFolder, "打开壁纸文件夹——放进去的图片/视频会出现在下面的壁纸库里"),
    );
    libHead.appendChild(libBtns);
    sec1.appendChild(libHead);
    sec1.appendChild(
      h("p", "mt-1 text-ui-base leading-6 text-foreground-subtle", "壁纸文件夹里的图片和视频都会列在这里，点一下直接换用；卡片右上角的 ✕ 可以直接删掉它，不用再去文件夹里删。"),
    );
    libEl = h("div", "zcbg-hint", "正在读取…");
    sec1.appendChild(libEl);

    /* —— Wallpaper Engine 创意工坊 —— */
    const weHead = h("div", "zcbg-row zcbg-row-left");
    weHead.appendChild(h("p", "text-ui-base font-medium text-foreground", "Wallpaper Engine 创意工坊"));
    const weBtns = h("div", "zcbg-btns");
    weBtns.appendChild(
      makeButton("从工坊导入", importFromWe, "展开工坊全部项目的选择列表（含被隐藏和只有低清封面的）——点一张卡片就装进「创意工坊」并自动应用"),
    );
    weBtns.appendChild(
      makeButton("打开文件夹", openWeFolder, "打开 Wallpaper Engine 的创意工坊文件夹——在 Wallpaper Engine 里新下载的壁纸都落在这里，随时点「从工坊导入」装进来"),
    );
    weHead.appendChild(weBtns);
    sec1.appendChild(weHead);
    sec1.appendChild(
      h("p", "mt-1 text-ui-base leading-6 text-foreground-subtle", "只显示你从「从工坊导入」装进来的项目（Steam 新下载的不会自动冒出来）：视频型直接换用；场景型抽它自带的视频素材，没有素材就用预览图当静帧（完整的交互场景没法在 ZCode 里播放）。"),
    );
    weEl = h("div", "zcbg-hint", "正在读取…");
    sec1.appendChild(weEl);

    /* —— 显示效果 —— */
    const sec2 = h("section", "zcbg-sec");
    sec2.appendChild(h("h2", "text-ui-lg font-semibold text-foreground", "显示效果"));
    sec2.appendChild(
      h("p", "mt-1 text-ui-base leading-6 text-foreground-subtle", "调整面板透明度和图片的压暗、模糊。改完立即生效。"),
    );
    sec2.appendChild(
      makeRow("面板不透明度", "越低壁纸越清楚，但文字对比度也会下降。", makeRange("panelAlpha", 0, 1, 0.01, (v) => Math.round(v * 100) + "%")),
    );
    sec2.appendChild(
      makeRow("背景压暗", "给壁纸盖一层暗色，亮图也能看清前景文字。", makeRange("dim", 0, 0.85, 0.01, (v) => Math.round(v * 100) + "%")),
    );
    sec2.appendChild(
      makeRow("背景模糊", "让壁纸虚化，进一步降低对阅读的干扰。", makeRange("imageBlurPx", 0, 24, 1, (v) => Math.round(v) + " px")),
    );
    sec2.appendChild(
      makeRow(
        "画面增强（锐化）",
        "给壁纸加一点锐化，1080p/1440p 拉上 2K 屏、或 4K 下采样发软时会明显更「锐」。默认 0% = 原画质直出；图片壁纸开锐化后按铺排方式显示（平铺不支持）。",
        makeRange("sharpen", 0, 1, 0.05, (v) => Math.round(v * 100) + "%"),
      ),
    );
    sec2.appendChild(
      makeRow("自动兜底透明化", "ZCode 升级换了内部类名、还有实心色块挡住壁纸时，自动把大面积实心表面改成半透明；关掉可完全手动控制。", makeSwitch("autoTranslucent")),
    );

    /* —— 🔍 实心区域扫描 —— */
    scanEl = h("div", "zcbg-scan");
    scanEl.style.display = "none";
    const scanCtl = h("span", "zcbg-ctl");
    scanCtl.appendChild(makeButton("🔍 扫描", runScan));
    scanCtl.appendChild(makeButton("全部恢复", restoreAllOverrides, "把扫描时打开的所有透明化/调色一次性还原成原始背景"));
    sec2.appendChild(
      makeRow(
        "实心区域透明化",
        "哪块界面还挡着壁纸？点「🔍 扫描」列出大块实心区域，逐个打开开关单独透明化（自动保存，重启后仍生效）；后悔了点「全部恢复」。",
        scanCtl,
      ),
    );
    sec2.appendChild(scanEl);

    const presetWrap = h("span", "zcbg-seg");
    presetBtns = [];
    const addPreset = (label, css, note, title) => {
      const b = makeButton(label, () => applyExtraCss(css, note), title);
      presetWrap.appendChild(b);
      presetBtns.push({ el: b, css: css });
    };
    addPreset("毛玻璃", PRESET_FROST, "✔ 已套用「毛玻璃」预设：半透明表面加了磨砂质感。");
    addPreset(
      "轻磨砂",
      PRESET_SOFT,
      "✔ 已套用「轻磨砂」（折中）：所有 bg-* 透明 + 6px 轻模糊 + 15% 压暗，比毛玻璃透、比彻底透明暗一点护眼。",
      "折中档：所有 bg-* 表面透明，加 6px 轻模糊和 15% 压暗——壁纸透进来，亮度不刺眼",
    );
    addPreset("彻底透明", PRESET_MAX, "✔ 已套用「彻底透明」：所有 bg-* 表面完全透明；觉得太透就点「撤销」或「清除自定义 CSS」。");
    addPreset("清除自定义 CSS", "", "✔ 已清除自定义 CSS（extraCss），界面恢复 ZCode 默认的不透明配色。");
    undoBtn = makeButton("撤销", undoExtraCss, "恢复到套用这个预设之前的样子（再点一下会切回来）");
    undoBtn.disabled = true;
    presetWrap.appendChild(undoBtn);
    sec2.appendChild(
      makeRow("快捷预设", "一键套用常用的界面透明效果（互相覆盖，当前生效的会高亮；套错了点「撤销」；想手写更细的见 config.json 里的 extraCss）。", presetWrap),
    );

    segEl = h("span", "zcbg-seg");
    sec2.appendChild(
      makeRow("画面铺排", "铺满：裁掉多余部分填满窗口；完整显示：完整呈现、不足处留边；拉伸：变形铺满；平铺：重复贴图（仅图片）。", segEl),
    );

    alignSel = h("select", "zcbg-select");
    for (const pair of [["center", "居中"], ["top", "顶部"], ["bottom", "底部"], ["left", "左侧"], ["right", "右侧"]]) {
      const o = h("option", null, pair[1]);
      o.value = pair[0];
      alignSel.appendChild(o);
    }
    alignSel.addEventListener("change", () => {
      state.align = ALIGN_VALUES.indexOf(alignSel.value) >= 0 ? alignSel.value : "center";
      paintBg();
      queueSave();
    });
    alignRow = makeRow("画面位置", "「完整显示」时画面贴向哪一边；其余铺排方式画面已填满窗口，无需调整。", alignSel);
    sec2.appendChild(alignRow);

    /* —— 动态壁纸（视频） —— */
    videoSec = h("section", "zcbg-sec");
    videoSec.appendChild(h("h2", "text-ui-lg font-semibold text-foreground", "动态壁纸（视频）"));
    videoSec.appendChild(
      h("p", "mt-1 text-ui-base leading-6 text-foreground-subtle", "视频会自动循环播放；切走窗口时自动暂停省电，回到 ZCode 接着播。"),
    );
    videoSec.appendChild(
      makeRow("静音播放", "浏览器不允许带声自动播放；关掉静音后，点一下 ZCode 窗口即可带声播放。", makeSwitch("videoMuted")),
    );
    videoSec.appendChild(
      makeRow("播放速度", "0.25×～4×，慢放或快放循环。", makeRange("videoSpeed", 0.25, 4, 0.25, (v) => "×" + Math.round(v * 100) / 100)),
    );
    videoSec.appendChild(
      makeRow("后台时暂停", "ZCode 最小化或被完全遮住时暂停解码，回来接着播；关掉则一直播放。", makeSwitch("videoPauseWhenHidden")),
    );

    /* —— 收尾 —— */
    const sec3 = h("section", "zcbg-sec");
    sec3.appendChild(h("h2", "text-ui-lg font-semibold text-foreground", "恢复"));
    const resetRow = h("div", "zcbg-ctl");
    resetRow.append(
      makeButton("恢复默认外观", () => {
        state.enabled = false;
        syncUi();
        paintBg();
        send({ op: "reset" });
        setStatus("已关闭壁纸并恢复默认外观。");
      }),
    );
    sec3.appendChild(makeRow("移除壁纸", "只关掉背景，配置文件和图片都留着。", resetRow));

    statusEl = h("div", "zcbg-status");
    setStatus(
      typeof host[BINDING] === "function"
        ? "改动立即生效并自动保存。"
        : "⚠ 壁纸后台程序没在运行，改动不会被保存——重新打开 ZCode 后会自动恢复。",
    );
    sec3.appendChild(statusEl);

    wrap.append(sec1, sec2, videoSec, sec3);
    scroll.appendChild(wrap);
    panel.appendChild(scroll);

    /* 拖拽换壁纸：文件拖进面板松手即应用（和「选择图片/视频」同一条上传通道）。
       dragover 里按 types 是否含 Files 决定要不要 preventDefault——别把 ZCode 自己的拖拽也拦了。 */
    panel.addEventListener("dragover", (e) => {
      if (!uiActive) return;
      if (!e.dataTransfer || [...(e.dataTransfer.types || [])].indexOf("Files") < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      panel.setAttribute("data-drop", "1");
    });
    panel.addEventListener("dragleave", () => panel.removeAttribute("data-drop"));
    panel.addEventListener("drop", (e) => {
      panel.removeAttribute("data-drop");
      if (!uiActive) return;
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      e.preventDefault();
      setStatus("收到拖入的「" + (f.name || "文件") + "」，正在应用…");
      usePickedFile(f);
    });
    return panel;
  }

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;

    layer = h("div");
    layer.id = LAYER_ID;

    navEl = h("button", "zcbg-nav " + NAV_BASE);
    navEl.type = "button";
    navEl.innerHTML =
      '<span class="flex size-4 shrink-0 items-center justify-center text-current">' +
      ICON +
      '</span><span class="min-w-0 flex-1 max-lg:sr-only"><span class="truncate text-ui-base">壁纸</span></span>';
    navLabel = navEl.querySelector(".truncate");
    navEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPanel(!uiActive);
    });

    panelEl = buildPanel();

    layer.append(navEl, panelEl);
    document.body.appendChild(layer);

    let st = document.getElementById(UI_STYLE_ID);
    if (!st) {
      st = document.createElement("style");
      st.id = UI_STYLE_ID;
      (document.head || document.documentElement).appendChild(st);
    }
    st.textContent = UI_CSS;
    return layer;
  }

  /* ------------------------------- 原生定位 ------------------------------- */

  let overlayRef = null;
  let navRef = null;

  /** 设置页特征：铺满窗口，且同时含“返回工作区”和“基础设置” */
  function looksLikeOverlay(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 200) return false;
    const t = el.textContent || "";
    return t.indexOf("返回工作区") >= 0 && t.indexOf("基础设置") >= 0;
  }

  function findOverlay() {
    if (overlayRef && overlayRef.isConnected && looksLikeOverlay(overlayRef)) return overlayRef;
    overlayRef = null;
    // 注意：#root 的第一个子节点可能是空的浮层容器，所以整棵子树都要扫，不能只看第一个子节点
    const root = document.getElementById("root");
    if (root) {
      for (const c of root.querySelectorAll('div[class*="absolute"][class*="inset-0"]')) {
        if (looksLikeOverlay(c)) {
          overlayRef = c;
          return c;
        }
      }
    }
    // 兜底：从「外观」导航项往上找最近的设置页容器
    for (const b of document.querySelectorAll("button")) {
      if ((b.textContent || "").trim() !== "外观") continue;
      let el = b.parentElement;
      while (el && el !== document.body) {
        if (looksLikeOverlay(el)) {
          overlayRef = el;
          return el;
        }
        el = el.parentElement;
      }
    }
    return null;
  }

  /** 常驻锚点：侧栏底部的「设置」按钮（不管设置页有没有打开都存在；英文界面叫 Settings） */
  function findSettingsButton() {
    for (const b of document.querySelectorAll("button")) {
      const lb = b.getAttribute("aria-label") || (b.textContent || "").trim();
      if (lb !== "设置" && lb !== "Settings") continue;
      const r = b.getBoundingClientRect();
      if (r.width > 16 && r.height > 16) return b;
    }
    return null;
  }

  /** 左侧栏矩形：从「设置」按钮往上找那个占满高度的容器 */
  function findSidebarRect() {
    const b = findSettingsButton();
    if (!b) return null;
    let el = b;
    const vh = window.innerHeight || 800;
    while (el && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (r.height > vh * 0.6 && r.width >= 120 && r.left < 40) return r;
      el = el.parentElement;
    }
    return null;
  }

  /** 主内容区：优先 main，取不到就按「窗口减去侧栏」推算 */
  function mainAreaRect() {
    for (const m of document.querySelectorAll("main")) {
      const r = m.getBoundingClientRect();
      if (r.width > 400 && r.height > 200) return r;
    }
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const sb = findSidebarRect();
    const left = sb ? Math.round(sb.right) : 264;
    return { left: left, top: 48, width: Math.max(320, vw - left), height: Math.max(240, vh - 48) };
  }

  /** 设置页没打开时：把「壁纸」钉在侧栏底部按钮上方，让它一直可点 */
  function pinNavToSidebar() {
    const b = findSettingsButton();
    if (!b) return false;
    const br = b.getBoundingClientRect();
    const sb = findSidebarRect();
    const width = sb ? Math.max(96, Math.round(sb.width) - 24) : 224;
    const height = Math.max(28, Math.round(br.height) || 32);
    const left = sb ? Math.round(sb.left) + 8 : 8;
    navEl.style.width = width + "px";
    navEl.style.height = height + "px";
    navEl.style.left = left + "px";
    let top = Math.round(br.top) - height - 14;
    for (let i = 0; i < 12 && top > 60 && !spotFree(left, top, width, height); i++) top -= 6;
    navEl.style.top = Math.max(60, top) + "px";
    return true;
  }

  function findNavButton(overlay) {
    if (navRef && navRef.isConnected && overlay.contains(navRef)) return navRef;
    navRef = null;
    for (const b of overlay.querySelectorAll("button")) {
      if ((b.textContent || "").trim() !== "外观") continue;
      const r = b.getBoundingClientRect();
      if (r.width < 80) continue;
      navRef = b;
      return b;
    }
    return null;
  }

  /** 读一个导航项完整 class，用来推算项目间距（不依赖写死的像素） */
  function measureStep(btn) {
    const r = btn.getBoundingClientRect();
    const next = btn.nextElementSibling;
    if (next) {
      const nr = next.getBoundingClientRect();
      if (nr.height > 0 && nr.top > r.top) return Math.round(nr.top - r.top);
    }
    return Math.round(r.height + 4);
  }

  /** 侧栏里那个能滚动的导航容器 */
  function findNavColumn(btn) {
    let el = btn.parentElement;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.getBoundingClientRect().height > 200) return el;
      el = el.parentElement;
    }
    return btn.parentElement ? btn.parentElement.parentElement : null;
  }

  /** 这个位置中心点上有没有压着 ZCode 自己的按钮（有就不能放） */
  function spotFree(left, top, width, height) {
    const stack = document.elementsFromPoint(left + width / 2, top + height / 2).filter((e) => !layer.contains(e));
    return !stack.some((e) => e.tagName === "BUTTON" || e.getAttribute("role") === "button" || e.getAttribute("role") === "tab");
  }

  /** 把「壁纸」贴成 ZCode 原生导航项；试几个候选位置，挑第一个不压住原生按钮的 */
  function placeNav(btn, container) {
    if (!container) return false;
    const r = btn.getBoundingClientRect();
    const step = measureStep(btn);
    const cr = container.getBoundingClientRect();
    const group = btn.parentElement;
    const gr = group ? group.getBoundingClientRect() : r;
    const width = Math.round(r.width);
    const height = Math.round(r.height);
    const left = Math.round(r.left);
    const lo = Math.round(cr.top) + 2;
    const hi = Math.round(cr.bottom - height - 10);

    const candidates = [
      Math.round(gr.bottom + step), // 排在「基础设置」这一组最后一项的下方
      hi,                           // 贴侧栏底部
      Math.round(r.bottom + step),  // 紧随“外观”之后
    ];

    navEl.style.width = width + "px";
    navEl.style.height = height + "px";
    navEl.style.left = left + "px";

    for (const c of candidates) {
      const top = Math.max(lo, Math.min(hi, c));
      if (top < lo) continue;
      if (spotFree(left, top, width, height)) {
        navEl.style.top = top + "px";
        return true;
      }
    }
    // 候选都压住了：从最后一个候选往上挪，直到让开遮挡
    let top = Math.max(lo, Math.min(hi, candidates[candidates.length - 1]));
    for (let i = 0; i < 40 && top >= lo; i++, top -= 4) {
      if (spotFree(left, top, width, height)) {
        navEl.style.top = top + "px";
        return true;
      }
    }
    navEl.style.top = Math.max(lo, hi) + "px";
    return true;
  }

  function setPanel(on) {
    uiActive = !!on;
    if (!panelEl) return;
    panelEl.style.display = uiActive ? "flex" : "none";
    syncNav();
    if (uiActive) {
      refreshLibrary();
      let main = null;
      const overlay = findOverlay();
      if (overlay) main = overlay.querySelector("main");
      if (!main) {
        for (const m of document.querySelectorAll("main")) {
          const r = m.getBoundingClientRect();
          if (r.width > 400 && r.height > 200) {
            main = m;
            break;
          }
        }
      }
      if (main) {
        hiddenMain = main;
        main.style.visibility = "hidden";
      }
      tick();
    } else if (hiddenMain) {
      hiddenMain.style.visibility = "";
      hiddenMain = null;
    }
    if (!uiActive) clearHl(); // 收起面板时把页面上的高亮描边一并撤掉
  }

  function syncNav() {
    if (navEl) {
      navEl.className = "zcbg-nav " + (uiActive ? NAV_ACTIVE : NAV_BASE);
      if (uiActive) navEl.setAttribute("aria-current", "page");
      else navEl.removeAttribute("aria-current");
    }
    if (navLabel) navLabel.className = "truncate text-ui-base " + (uiActive ? "text-foreground" : "text-foreground-subtle");
  }

  /** 按媒体类型重建「画面铺排」分段按钮（视频没有平铺） */
  function rebuildSeg() {
    if (!segEl) return;
    segEl.textContent = "";
    for (const o of FIT_OPTIONS) {
      if (o.imageOnly && (state.mediaType === "video" || state.mediaType === "web")) continue;
      const b = h("button", null, o.label);
      b.type = "button";
      b.dataset.fit = o.v;
      b.addEventListener("click", () => {
        state.fit = o.v;
        syncUi();
        paintBg();
        queueSave();
      });
      segEl.appendChild(b);
    }
  }

  function syncUi() {
    for (const k of Object.keys(switchEls)) {
      switchEls[k].setAttribute("aria-checked", state[k] ? "true" : "false");
    }
    for (const k of Object.keys(rangeEls)) {
      rangeEls[k].value = String(state[k]);
      const v = valEls[k];
      if (v) v.el.textContent = v.fmt(state[k]);
    }
    if (segEl) {
      if (segEl.dataset.mt !== state.mediaType) {
        segEl.dataset.mt = state.mediaType;
        rebuildSeg();
      }
      for (const b of segEl.querySelectorAll("button")) {
        b.setAttribute("data-on", b.dataset.fit === state.fit ? "1" : "0");
      }
    }
    if (alignRow) alignRow.style.display = state.fit === "contain" ? "" : "none";
    if (alignSel) alignSel.value = ALIGN_VALUES.indexOf(state.align) >= 0 ? state.align : "center";
    // 预设激活态：当前 extraCss 正好等于某个预设时把它点亮；「撤销」只在真的有东西可退时可用
    if (undoBtn) undoBtn.disabled = undoCss === null;
    for (const pb of presetBtns) pb.el.setAttribute("data-on", state.extraCss === pb.css ? "1" : "0");
    if (videoSec) videoSec.style.display = state.mediaType === "video" ? "" : "none";
    if (thumbImg && thumbVideo) {
      const isVideo = state.mediaType === "video";
      // 网页壁纸没有能当预览的媒体 URL：缩略图位留空（label 行已有「当前：…（网页）」）
      thumbImg.style.display = !isVideo && state.url && state.mediaType !== "web" ? "" : "none";
      thumbVideo.style.display = isVideo && state.url ? "" : "none";
      if (isVideo) {
        if (thumbVideo.getAttribute("src") !== state.url) {
          if (state.url) {
            thumbVideo.src = state.url;
            thumbVideo.load();
          } else {
            thumbVideo.removeAttribute("src");
          }
        }
        if (state.url) thumbVideo.play().catch(() => {});
        else thumbVideo.pause();
      } else if (state.mediaType !== "web") {
        thumbVideo.pause();
        if (state.url) {
          if (thumbImg.getAttribute("src") !== state.url) thumbImg.src = state.url;
        } else {
          thumbImg.removeAttribute("src");
        }
      }
    }
    if (labelEl) {
      const kind = state.mediaType === "video" ? "（视频）" : state.mediaType === "web" ? "（网页）" : "（图片）";
      labelEl.textContent = "当前：" + (state.label ? state.label + kind : state.url ? "(已内嵌图片)" : "未设置");
    }
  }

  /** 每 ~500ms 重新贴一次位置（设置页里贴到「外观」旁边，平时钉在侧栏底部） */
  function tick() {
    if (!document.body) return;
    ensureLayer();
    layer.style.display = "block";

    const overlay = findOverlay();
    const btn = overlay ? findNavButton(overlay) : null;
    let area = null;

    if (overlay && btn) {
      placeNav(btn, findNavColumn(btn));
      const main = overlay.querySelector("main");
      if (main) area = main.getBoundingClientRect();
    } else {
      pinNavToSidebar();
    }
    if (!area) area = mainAreaRect();

    panelEl.style.left = Math.round(area.left) + "px";
    panelEl.style.top = Math.round(area.top) + "px";
    panelEl.style.width = Math.round(area.width) + "px";
    panelEl.style.height = Math.round(area.height) + "px";
    syncNav();
  }

  /* --------------------------- 选文件 / 壁纸库 --------------------------- */

  /** 把页面里选中的文件流式上传给主进程的本地媒体服务，返回 {ok,name,rel,type,url,…} */
  async function uploadToHost(f) {
    if (!state.mediaBase) throw new Error("壁纸后台服务不可用");
    const resp = await fetch(
      state.mediaBase + "/upload?name=" + encodeURIComponent(f.name || "wallpaper"),
      { method: "POST", body: f },
    );
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try {
        const j = await resp.json();
        if (j && j.error) msg = j.error;
      } catch (e) { /* 非 JSON 响应，用状态码 */ }
      throw new Error(msg);
    }
    const j = await resp.json();
    if (!j || !j.ok) throw new Error((j && j.error) || "上传失败");
    return j;
  }

  /** 换用壁纸库里的某一项（库点击、上传成功、🎲 随机都走这一条路） */
  function useLibraryItem(it) {
    state.enabled = true;
    state.mediaType = it.type === "video" ? "video" : it.type === "web" ? "web" : "image";
    state.label = it.name;
    state.url = it.url || "";
    // 「随时间」条目：记下换段端点和时段边界，页面定时器才能到点自动换段
    state.timeUrl = it.time ? String(it.url || "") : "";
    state.timeBounds = it.time && it.bounds && typeof it.bounds === "object" ? it.bounds : null;
    if ((state.mediaType === "video" || state.mediaType === "web") && state.fit === "tile") state.fit = "cover";
    syncUi();
    paintBg();
    send({ op: "config", patch: { wallpaper: it.rel, enabled: true } });
    refreshLibrary();
  }
  // 上传成功的回调：把媒体服务返回的 {name, rel, url, type} 当作一次「选用壁纸」。
  // （v5.1 修复：之前 mediaType 依赖外部传入的第三参，两个调用点都没传，
  //  乐观更新阶段 mediaType 会短暂是 undefined，靠主进程回写才纠正。）
  function applyPicked(j, fallbackName, type) {
    useLibraryItem({
      name: j.name || fallbackName,
      rel: j.rel,
      url: j.url || state.url,
      type: j.type === "video" || type === "video" ? "video" : "image",
    });
  }

  // 🎲 一键随机：从壁纸库里抽一个没用着的（图和视频都算），没有就给句人话提示。
  function pickRandomWallpaper() {
    if (!state.mediaBase) {
      setStatus("壁纸库暂时读不到——重新打开 ZCode 后即可恢复。", true);
      return;
    }
    // 当前项过滤和卡片选中态同一套匹配：随时间壁纸的 label 带「（随时间 · 当前夜晚）」后缀，
    // 只比名字的话会把「当前这张的另一个时段」也抽进来
    const isCur = (it) => !!state.label && (state.label === it.name || (it.time && state.label.indexOf(it.name) === 0));
    const pool = libItems.concat(weItems).filter((it) => !isCur(it));
    if (!pool.length) {
      setStatus(libItems.length || weItems.length ? "壁纸库只有当前这一个，没得换了 😄" : "壁纸库还是空的——先用上面的按钮选一张图片或视频。", true);
      return;
    }
    const it = pool[Math.floor(Math.random() * pool.length)];
    useLibraryItem(it);
    setStatus("🎲 随机换到「" + it.name + "」，正在自动保存…");
  }

  /** 统一的「应用一个本地媒体文件」入口：选图片、选视频、拖拽三条路都汇到这里。
   *  视频必须走媒体服务上传（视频没法内嵌）；图片优先上传，服务不在时回退内嵌 data:URL（仅本次有效）。 */
  function usePickedFile(f) {
    if (!f) return;
    const isVideo = (f.type && f.type.indexOf("video/") === 0) || /\.(mp4|m4v|webm|mov|mkv|avi|ogv)$/i.test(f.name || "");
    const isImage = (f.type && f.type.indexOf("image/") === 0) || /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(f.name || "");
    if (isVideo) {
      if (f.size > 1024 * 1024 * 1024) {
        setStatus("⚠ 视频超过 1 GB，请先压缩或剪辑。", true);
        return;
      }
      if (!state.mediaBase) {
        setStatus("⚠ 视频播放服务没在运行，播不了视频——点上面的「打开文件夹」把视频放进去，重新打开 ZCode 后从「壁纸库」选用。", true);
        return;
      }
      setStatus("正在复制视频（" + fmtBytes(f.size) + "），大文件会花一点时间…");
      uploadToHost(f)
        .then((j) => {
          applyPicked(j, f.name);
          setStatus("✔ 视频壁纸已应用：" + (j.name || f.name));
        })
        .catch((e) =>
          setStatus("⚠ 视频复制失败：" + e + "。也可以把视频文件直接放进壁纸文件夹（点上面的「打开文件夹」），再从「壁纸库」选用。", true),
        );
      return;
    }
    if (!(f.type && f.type.indexOf("image/") === 0) && !/\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(f.name || "")) {
      setStatus("⚠ 只认图片或视频文件——「" + (f.name || "这份文件") + "」两种都不是。", true);
      return;
    }
    if (f.size > 15 * 1024 * 1024) {
      setStatus("⚠ 图片超过 15 MB，请换小一点的（或先用其它工具压缩）。", true);
      return;
    }
    if (state.mediaBase) {
      uploadToHost(f)
        .then((j) => {
          applyPicked(j, f.name);
          setStatus("✔ 已应用「" + (j.name || f.name) + "」，正在自动保存…");
        })
        .catch((e) => setStatus("⚠ 复制失败（" + e + "）——改用内嵌方式（只对本次有效）。", true));
      return;
    }
    // 回退：没有本地媒体服务时，走老的内嵌 data:URL 流程（仅图片）
    const fr = new FileReader();
    fr.onload = () => {
      state.url = String(fr.result);
      state.enabled = true;
      state.mediaType = "image";
      state.label = f.name + "（正在保存…）";
      syncUi();
      paintBg();
      if (send({ op: "image", dataUrl: state.url, name: f.name })) {
        setStatus("图片已应用，正在存入壁纸文件夹…");
      }
    };
    fr.onerror = () => setStatus("⚠ 读取图片失败。", true);
    fr.readAsDataURL(f);
  }

  function onPickImage() {
    const f = fileEl && fileEl.files && fileEl.files[0];
    if (fileEl) fileEl.value = "";
    usePickedFile(f);
  }

  function onPickVideo() {
    const f = fileVideo && fileVideo.files && fileVideo.files[0];
    if (fileVideo) fileVideo.value = "";
    usePickedFile(f);
  }

  /** 拉取 wallpaper\ 目录清单，渲染成可点选的缩略图网格（最多 24 个） */
  function refreshLibrary() {
    if (!libEl) return;
    if (!state.mediaBase) {
      libEl.textContent = "壁纸库暂时读不到——把图片/视频放进壁纸文件夹（点上面的「打开文件夹」），重新打开 ZCode 后就能在这里选用。";
      if (weEl) weEl.textContent = "壁纸库读不到，Wallpaper Engine 创意工坊也一样——重新打开 ZCode 后即可恢复。";
      return;
    }
    fetch(state.mediaBase + "/list")
      .then((r) => r.json())
      .then((j) => {
        if (!libEl) return;
        const items = (j && j.items) || [];
        libItems = items; // 完整清单（随机换一张的池子也要算上它们）；网格最多画 24 张
        // Wallpaper Engine 创意工坊条目（主进程 /list 的 we 数组；没有则视为未装）
        weItems = Array.isArray(j && j.we) ? j.we : [];
        weAllItems = Array.isArray(j && j.weAll) ? j.weAll : [];
        weLow = Number(j && j.weLow) || 0;
        state.weDirPresent = !!(j && j.weDir);
        renderWe();
        libEl.textContent = "";
        if (!items.length) {
          libEl.textContent = "壁纸文件夹还是空的——用上面的按钮选一张图片或一段视频，或点「打开文件夹」把文件放进来。";
          return;
        }
        const grid = h("div", "zcbg-lib");
        for (const it of items.slice(0, 24)) {
          const b = h("button", "zcbg-lib-item");
          b.type = "button";
          b.title = it.name + (it.size ? "（" + fmtBytes(it.size) + "）" : "");
          if (state.label && state.label === it.name) b.setAttribute("data-cur", "1");
          if (it.type === "video") {
            b.appendChild(h("span", "zcbg-lib-v", "▶"));
          } else if (it.url) {
            const im = h("img");
            im.alt = it.name;
            im.loading = "lazy";
            im.src = it.url;
            b.appendChild(im);
          }
          // 左上角类型＋分辨率角标（和创意工坊卡片同款）：图片/视频 + 4K/2K/1080p/宽×高（+ 低码率提示）
          const kindText = (it.type === "video" ? "视频" : "图片");
          b.appendChild(kindBadge(kindText, it));
          b.appendChild(h("span", "zcbg-lib-name", it.name));
          // 每张卡片右上角的删除点：不用去资源管理器里翻文件夹。
          // 两步确认（点一下变红字「删掉?」，3 秒内再点一下才真的删），
          // 因为这里没有原生 confirm 可用——electron 里 window.confirm 会把渲染进程卡住。
          const del = h("span", "zcbg-lib-del", "✕");
          del.title = "从壁纸文件夹删掉这个文件";
          let armTimer = 0;
          const disarm = () => {
            clearTimeout(armTimer);
            del.removeAttribute("data-arm");
            del.textContent = "✕";
            del.title = "从壁纸文件夹删掉这个文件";
          };
          const arm = () => {
            del.setAttribute("data-arm", "1");
            del.textContent = it.name === state.label ? "删掉?（会换一张）" : "删掉?";
            del.title = "再点一下确认删除";
            armTimer = setTimeout(disarm, 3000);
          };
          // 关键：stopPropagation，否则这一下会冒泡到外层按钮，变成「顺便换了壁纸」
          del.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (del.getAttribute("data-arm") !== "1") {
              arm();
              setStatus("再点一下「删掉?」就从壁纸文件夹删除 " + it.name + "。");
              return;
            }
            disarm();
            b.setAttribute("data-busy", "1");
            del.setAttribute("data-busy", "1");
            if (!send({ op: "delete", name: it.name })) {
              b.removeAttribute("data-busy");
              del.removeAttribute("data-busy");
              return;
            }
            setStatus("正在删除 " + it.name + " …");
          });
          b.appendChild(del);
          b.addEventListener("click", () => {
            useLibraryItem(it);
            setStatus("已切换到「" + it.name + "」，正在自动保存…");
          });
          grid.appendChild(b);
        }
        libEl.appendChild(grid);
        // 面板最多画 24 张卡片；多出来的不吭声就会被当成「丢了」，明说放在哪
        if (items.length > 24) {
          libEl.appendChild(
            h("div", "zcbg-hint", "还有 " + (items.length - 24) + " 个没有显示——这里最多列 24 个，完整清单在壁纸文件夹里（点上面的「打开文件夹」直达）。"),
          );
        }
      })
      .catch(() => {
        if (libEl) libEl.textContent = "⚠ 读取壁纸库失败——壁纸后台程序可能退出了；重新打开 ZCode 即可恢复。";
        if (weEl) weEl.textContent = "";
      });
  }

  /** 渲染 Wallpaper Engine 工坊条目：缩略图 + 类型角标（视频/素材/静帧），带删除点。 */
  /* 分辨率标签：优先熟知的档位名，没有就给实际宽×高 */
  function resLabel(it) {
    if (!it || !it.w || !it.h) return "";
    if (it.h >= 2000) return "4K";
    if (it.h >= 1400) return "1440p";
    if (it.h >= 1300) return "2K";
    if (it.h >= 1000) return "1080p";
    if (it.h >= 720) return "720p";
    return it.w + "×" + it.h;
  }

  /** 画质提示：低码率（码率撑不起这个分辨率，放全屏糊——假 4K 常见）/有损纹理（DXT 块压缩抽帧）。
   *  主进程已经算好 lowBps/dxt 标记，这里只负责显示；都没有返回空串。 */
  function qualityHint(it) {
    if (!it) return "";
    if (it.lowBps) return "低码率";
    if (it.dxt) return "有损纹理";
    return "";
  }

  /** 卡片左上角角标文案：类型 + 分辨率 + 画质提示（提示存在时角标变橙、title 里写明白） */
  function kindBadge(kindText, it) {
    const res = resLabel(it);
    const q = qualityHint(it);
    const text = kindText + (res ? " " + res : "") + (q ? " · " + q : "");
    const span = h("span", "zcbg-lib-kind", text);
    if (q) {
      span.setAttribute("data-warn", "1");
      const why =
        q === "低码率"
          ? `码率只有 ${it.bps || "?"} Mbps，撑不起 ${res || "这个分辨率"}——放全屏会糊，是压制时就没给够，任何播放端都救不回来`
          : "静帧是从 DXT 块压缩纹理解出来的，细看有轻微块状痕迹（工坊场景包里的纹理就是这个格式）";
      span.title = why;
    } else if (it && it.bps) {
      span.title = `码率 ${it.bps} Mbps——足够撑起这个分辨率`;
    }
    return span;
  }

  function renderWe() {
    if (!weEl) return;
    weEl.textContent = "";
    if (wePickMode) {
      renderWePicker();
      return;
    }
    if (!weItems.length) {
      // 区分两种空：工坊库没找到（真没有）vs 库在但还没导入任何项目
      weEl.textContent = state.weDirPresent
        ? "「创意工坊」还是空的——点上方「从工坊导入」挑选要装的壁纸（工坊里已下载的全部项目都能选）。"
        : "没找到 Wallpaper Engine 的创意工坊库——装了 Steam 版 Wallpaper Engine 并下载过壁纸后会出现；也可以在 config.json 里加 \"weDir\" 手动指定工坊目录。";
      return;
    }
    const grid = h("div", "zcbg-lib");
    for (const it of weItems) {
      const b = h("button", "zcbg-lib-item");
      b.type = "button";
      b.title = it.name + (it.kind ? "（" + it.kind + "）" : "") + (it.size ? "（" + fmtBytes(it.size) + "）" : "") + (it.time ? "——按系统时间自动切换清晨/白天/黄昏/夜晚" : "");
      // 时间壁纸的当前壁纸名带「（随时间 · 当前夜晚）」后缀，前缀匹配也能点亮选中态
      if (state.label && (state.label === it.name || (it.time && state.label.indexOf(it.name) === 0))) b.setAttribute("data-cur", "1");
      const previewSrc = it.preview || (it.type === "image" ? it.url : "");
      if (previewSrc) {
        const im = h("img");
        im.alt = it.name;
        im.loading = "lazy";
        im.src = previewSrc;
        b.appendChild(im);
      } else {
        b.appendChild(h("span", "zcbg-lib-v", "▶"));
      }
      b.appendChild(kindBadge(it.kind || "", it));
      b.appendChild(h("span", "zcbg-lib-name", it.name));
      // 工坊条目也带删除点：只清 .we-pkg-cache 里的抽取产物 + 在 config.json 里隐藏整个项目，
      // Steam 工坊目录一个字节不动，Wallpaper Engine 本体随时照常播放。
      const del = h("span", "zcbg-lib-del", "✕");
      del.title = "清掉抽取缓存并从面板移除（不影响 Wallpaper Engine）";
      let armTimer = 0;
      const disarm = () => {
        clearTimeout(armTimer);
        del.removeAttribute("data-arm");
        del.textContent = "✕";
        del.title = "清掉抽取缓存并从面板移除（不影响 Wallpaper Engine）";
      };
      const arm = () => {
        del.setAttribute("data-arm", "1");
        del.textContent = "删掉?";
        del.title = "再点一下确认：清理抽取缓存，从面板移除整个项目";
        armTimer = setTimeout(disarm, 3000);
      };
      del.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation(); // 别冒泡成「顺便换壁纸」
        if (del.getAttribute("data-arm") !== "1") {
          arm();
          setStatus("再点一下「删掉?」就清掉「" + it.name + "」的抽取缓存并从面板移除（Wallpaper Engine 本体不受影响）。");
          return;
        }
        disarm();
        b.setAttribute("data-busy", "1");
        del.setAttribute("data-busy", "1");
        if (!send({ op: "weDelete", name: it.name, rel: it.rel, src: it.src })) {
          b.removeAttribute("data-busy");
          del.removeAttribute("data-busy");
          return;
        }
        setStatus("正在删除 " + it.name + " 的抽取缓存…");
      });
      b.appendChild(del);
      b.addEventListener("click", () => {
        useLibraryItem(it);
        setStatus(
          it.time
            ? "已切换到「" + it.name + "」（随时间）——会按系统时间在清晨/白天/黄昏/夜晚间自动切换。"
            : "已切换到 Wallpaper Engine 的「" + it.name + "」（" + (it.kind || "视频") + (res ? "，" + res : "") + "），正在自动保存…",
        );
      });
      grid.appendChild(b);
    }
    weEl.appendChild(grid);
    // 场景型壁纸只剩一张几百像素的封面图时放全屏必糊——不列出，但明说还有多少个
    if (weLow > 0) {
      const tip = h("div", "zcbg-hint");
      tip.textContent = "另有 " + weLow + " 个场景型壁纸只有低分辨率的封面图，放全屏会很糊，没有列出——完整播放请在 Wallpaper Engine 里打开。";
      weEl.appendChild(tip);
    }
  }

  /** 「从工坊导入」的选择列表：工坊目录里的全部项目（含被 ✕ 隐藏和只有低清封面的），
   *  标题 + 封面缩略图 + 状态角标，点一张就把那个项目装进「创意工坊」区块并自动应用。 */
  function renderWePicker() {
    if (!weAllItems.length) {
      weEl.textContent = "没找到 Wallpaper Engine 的创意工坊项目——在 Wallpaper Engine 里下载过壁纸后这里会出现完整清单。";
      return;
    }
    weEl.appendChild(h("p", "zcbg-hint", "点一张卡片就把它装进「创意工坊」并自动应用："));
    const grid = h("div", "zcbg-lib");
    for (const p of weAllItems) {
      const b = h("button", "zcbg-lib-item");
      b.type = "button";
      // v24 起「已在工坊」= 已导入（区块只列 wePinned 里的项目，两者同一回事）
      const tag = p.listed ? "已在工坊" : p.hidden ? "已隐藏" : "";
      b.title = p.title + (tag ? "（" + tag + "）" : "") + "——点一下装进「创意工坊」并应用";
      if (p.preview) {
        const im = h("img");
        im.alt = p.title;
        im.loading = "lazy";
        im.src = p.preview;
        b.appendChild(im);
      }
      b.appendChild(h("span", "zcbg-lib-name", tag ? tag + " · " + p.title : p.title));
      if (p.listed) b.setAttribute("data-cur", "1");
      b.addEventListener("click", () => {
        if (!send({ op: "wePin", src: p.src })) return;
        b.setAttribute("data-busy", "1");
        setStatus("正在把「" + p.title + "」装进「创意工坊」…");
      });
      grid.appendChild(b);
    }
    weEl.appendChild(grid);
  }

  function onUseSample() {
    send({ op: "sample" });
    setStatus("已请求切回内置示例图…");
  }

  /* --------------------------- 给主进程的调用接口 --------------------------- */

  function setState(s) {
    if (!s) return;
    if (typeof s.enabled === "boolean") state.enabled = s.enabled;
    if (typeof s.url === "string" && s.url) state.url = s.url;
    if (typeof s.label === "string") state.label = s.label;
    if (s.mediaType === "video" || s.mediaType === "web" || s.mediaType === "image") state.mediaType = s.mediaType;
    if (FIT_VALUES.indexOf(s.fit) >= 0) state.fit = s.fit;
    if (ALIGN_VALUES.indexOf(s.align) >= 0) state.align = s.align;
    if (typeof s.panelAlpha === "number") state.panelAlpha = s.panelAlpha;
    if (typeof s.dim === "number") state.dim = s.dim;
    if (typeof s.imageBlurPx === "number") state.imageBlurPx = s.imageBlurPx;
    if (typeof s.sharpen === "number") state.sharpen = clamp(s.sharpen, 0, 1);
    if (typeof s.videoMuted === "boolean") state.videoMuted = s.videoMuted;
    if (typeof s.videoSpeed === "number" && s.videoSpeed > 0) state.videoSpeed = clamp(s.videoSpeed, 0.25, 4);
    if (typeof s.videoPauseWhenHidden === "boolean") state.videoPauseWhenHidden = s.videoPauseWhenHidden;
    if (typeof s.timeUrl === "string") state.timeUrl = s.timeUrl;
    if (s.timeBounds === null || (s.timeBounds && typeof s.timeBounds === "object")) state.timeBounds = s.timeBounds;
    if (typeof s.autoTranslucent === "boolean") state.autoTranslucent = s.autoTranslucent;
    if (typeof s.mediaBase === "string") state.mediaBase = s.mediaBase;
    if (Array.isArray(s.translucentClasses)) state.translucentClasses = s.translucentClasses;
    if (Array.isArray(s.overrides)) state.overrides = s.overrides.filter(ovOk).slice(0, 24);
    if (typeof s.extraCss === "string") state.extraCss = s.extraCss;
    if ((state.mediaType === "video" || state.mediaType === "web") && state.fit === "tile") state.fit = "cover";
    syncUi();
    paintBg();
  }

  function hostReply(r) {
    if (!r) return;
    if (r.label) {
      state.label = r.label;
      syncUi();
    }
    if (r.message) setStatus(r.message, !!r.error);
    // 工坊导入：主进程扫出的 WE 条目直接当「选用壁纸」，第一个立即应用（同点卡片）；
    // 装好就收起选择列表，刷新后的工坊区块里能看到它
    if (Array.isArray(r.picked) && r.picked.length) {
      const it = r.picked[0];
      if (it && it.url) useLibraryItem(it);
      wePickMode = false;
      refreshLibrary();
    }
    // 删除壁纸后主进程会要求重拉一次清单，否则被删的卡片还留在网格里
    if (r.reloadLibrary) refreshLibrary();
  }

  function destroy() {
    clearTimeout(saveTimer);
    clearTimeout(tickTimer);
    clearTimeout(scrollTimer);
    clearTimeout(mutTimer);
    if (mutObs) {
      try {
        mutObs.disconnect();
      } catch (e) { /* ignore */ }
      mutObs = null;
    }
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    document.removeEventListener("scroll", onDocScroll, true);
    window.removeEventListener("resize", tick);
    downPos = null;
    if (thumbVideo) {
      try {
        thumbVideo.pause();
        thumbVideo.removeAttribute("src");
        thumbVideo.load();
      } catch (e) { /* ignore */ }
    }
    if (typeof applyVideoState === "function") {
      try { applyVideoState(null); } catch (e) { /* ignore */ }
    }
    if (hiddenMain) {
      hiddenMain.style.visibility = "";
      hiddenMain = null;
    }
    const a = document.getElementById(STYLE_ID);
    if (a) a.remove();
    const b = document.getElementById(UI_STYLE_ID);
    if (b) b.remove();
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = navEl = panelEl = null;
    overlayRef = navRef = null;
    try {
      delete host.__zcodeBgUi;
      host.__zcodeBg = undefined;
    } catch (e) {
      /* ignore */
    }
    return true;
  }

  /* -------------------------------- 启动 -------------------------------- */

  function onDocMouseDown(e) {
    // 记下按下的位置：用来区分“点一下空白处”和“拖拽/选词”
    downPos = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  }

  /**
   * 点面板外面（侧栏空白、窗口边缘…）就收起面板。
   * 这里只监听、不 preventDefault，所以点到 ZCode 自己的按钮时，
   * 它照样会被点到，同时面板收起来 —— 两边都不耽误。
   */
  function onDocClick(e) {
    if (!uiActive) return;
    if (e.button !== 0) return;
    if (layer && layer.contains(e.target)) return;
    if (downPos) {
      const dx = Math.abs(e.clientX - downPos.x);
      const dy = Math.abs(e.clientY - downPos.y);
      downPos = null;
      if (dx > 6 || dy > 6) return; // 拖拽/选中文字，不算“点空白处”
    }
    setPanel(false);
  }

  function onDocKeyDown(e) {
    if (!uiActive) return;
    if (e.key === "Escape") setPanel(false);
  }

  /* —— 定位节拍：面板开着 0.5s（拖动窗口/滚动侧栏时要跟手）；关着 2s（导航钉位基本不动）。
     响应性靠事件补：滚动（capture 捕获侧栏等任意元素的滚动）停稳 200ms、布局变化
     （MutationObserver，停稳 400ms——ZCode 聊天流式输出会持续产生 mutation，
     靠 debounce 把「边流边重贴」挡掉）各自补一轮，不再纯靠轮询。 —— */
  let tickTimer = 0;
  let scrollTimer = 0;
  let mutTimer = 0;
  let mutObs = null;
  function scheduleTick() {
    clearTimeout(tickTimer);
    tickTimer = setTimeout(() => {
      tick();
      scheduleTick();
    }, uiActive ? 500 : 2000);
  }
  function onDocScroll() {
    if (uiActive) return; // 面板开着本来就是 0.5s 节拍
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(tick, 200);
  }
  function onLayoutMutate() {
    if (uiActive) return;
    clearTimeout(mutTimer);
    mutTimer = setTimeout(tick, 400);
  }

  paintBg();
  paintUiStyle();
  tick();
  scheduleTick();
  window.addEventListener("resize", tick);
  document.addEventListener("mousedown", onDocMouseDown, true);
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("keydown", onDocKeyDown, true);
  document.addEventListener("scroll", onDocScroll, true);
  if (window.MutationObserver) {
    try {
      mutObs = new MutationObserver(onLayoutMutate);
      mutObs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      mutObs = null;
    }
  }
  if (document.readyState !== "complete") {
    document.addEventListener("DOMContentLoaded", tick, { once: true });
  }

  function paintUiStyle() {
    let st = document.getElementById(UI_STYLE_ID);
    if (!st) {
      st = document.createElement("style");
      st.id = UI_STYLE_ID;
      (document.head || document.documentElement).appendChild(st);
    }
    st.textContent = UI_CSS;
  }

  syncUi();
  host.__zcodeBgUi = {
    version: VERSION,
    state: state,
    destroy: destroy,
    setState: setState,
    hostReply: hostReply,
    open: () => setPanel(true),
    close: () => setPanel(false),
    refresh: tick,
  };
  return true;
})()
