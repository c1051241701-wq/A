/* =========================================================
   Butterfly Hero — 蝴蝶视频 + 粒子拼字（无依赖，约 4 KB）
   ---------------------------------------------------------
   用法：
     <div class="butterfly-hero" data-butterfly-hero data-text="Shunyi Cheng">
       <video class="butterfly-hero__video" data-bh-video muted playsinline preload="auto">
         <source src="video/background.mp4" type="video/mp4">
       </video>
       <canvas class="butterfly-hero__canvas" data-bh-canvas></canvas>
     </div>

   可选的 data 属性（都写在容器上）：
     data-text="Shunyi Cheng"   粒子拼的文字
     data-ink="#1a1a1a"         渐变左端颜色（浅色片源用深墨，深色片源改浅色）
     data-accent="#ea580c"      渐变右端颜色（橙）
     data-fit="0.92"            文字最多占容器宽度的比例
     data-font="..."            粒子采样用的字体栈
     data-loop="1"              循环播放；不写则播一次停在最后一帧

   运行时接口：el.butterflyHero.setText("新文字") / el.butterflyHero.rebuild()
   ========================================================= */
(function () {
  "use strict";

  var COARSE = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  var REDUCE = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var ENTER_MS = 1100;   // 飞入时长
  var PUSH_R = 120;      // 指针推开半径
  var PUSH_MAX = 40;     // 最大位移

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  function hexToRgb(hex) {
    var h = String(hex || "").replace("#", "").trim();
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return [26, 26, 26];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function init(host) {
    if (host.dataset.bhReady === "1") return;
    var canvas = host.querySelector("[data-bh-canvas]");
    var ctx = canvas && canvas.getContext("2d");
    if (!ctx) return;
    host.dataset.bhReady = "1";

    var video = host.querySelector("[data-bh-video]");
    var TEXT = (host.getAttribute("data-text") || "Shunyi Cheng").trim() || "Shunyi Cheng";
    var COLOR_A = hexToRgb(host.getAttribute("data-ink") || "#1a1a1a");
    var COLOR_B = hexToRgb(host.getAttribute("data-accent") || "#ea580c");
    var FIT = parseFloat(host.getAttribute("data-fit") || "") || 0.92;
    var FONT = host.getAttribute("data-font") || '"Newsreader", Georgia, "Times New Roman", serif';

    var particles = [];
    var W = 0, H = 0, dpr = 1;
    var startTime = 0, entering = true, rafId = 0, visible = false, built = false;
    var mouse = { active: false, cx: 0, cy: 0, x: 0, y: 0, sx: 0, sy: 0, snap: false };
    var follow = COARSE ? 0.45 : 0.18;
    var spread = 180;

    /* ---------- 把文字采样成粒子 ---------- */
    function build() {
      var rect = host.getBoundingClientRect();
      W = Math.floor(rect.width);
      H = Math.floor(rect.height);
      if (W <= 0 || H <= 0) return;

      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 字号：先按容器高度估，再按可用宽度收，保证不溢出
      var fontSize = Math.min(H * 0.4, W * 0.22, 220);
      var font = "400 " + fontSize + "px " + FONT;

      var off = document.createElement("canvas");
      var octx = off.getContext("2d", { willReadFrequently: true });
      if (!octx) return;

      octx.font = font;
      var metrics = octx.measureText(TEXT);
      var maxW = FIT * W;
      if (metrics.width > maxW) {
        fontSize = Math.max(12, (maxW / Math.max(1, metrics.width)) * fontSize);
        font = "400 " + fontSize + "px " + FONT;
        octx.font = font;
        metrics = octx.measureText(TEXT);
      }

      var left = Math.ceil(metrics.actualBoundingBoxLeft || 0);
      var right = Math.ceil(metrics.actualBoundingBoxRight || metrics.width);
      var asc = Math.ceil(metrics.actualBoundingBoxAscent || fontSize * 0.78);
      var desc = Math.ceil(metrics.actualBoundingBoxDescent || fontSize * 0.22);
      var pad = Math.max(10, Math.ceil(fontSize * 0.08));

      off.width = Math.max(1, left + right) + pad * 2;
      off.height = Math.max(1, asc + desc) + pad * 2;
      octx.clearRect(0, 0, off.width, off.height);
      octx.font = font;
      octx.textAlign = "left";
      octx.textBaseline = "alphabetic";
      octx.fillStyle = "#fff";
      octx.fillText(TEXT, pad - left, pad + asc);

      // 采样字形像素：alpha > 40 的位置就是"笔画"。
      // 小屏用 1px 步长，否则笔画只有一列采样点，字会糊成一团
      var img = octx.getImageData(0, 0, off.width, off.height).data;
      var pts = [];
      var step = W >= 900 ? 2 : 1;
      for (var y = 0; y < off.height; y += step) {
        for (var x = 0; x < off.width; x += step) {
          if (img[(y * off.width + x) * 4 + 3] > 40) {
            pts.push({
              x: W / 2 - off.width / 2 + x,
              y: H / 2 - off.height / 2 + y
            });
          }
        }
      }
      if (!pts.length) return;

      // 粒子数量：面积越大越多，手机减量；小屏粒子要画粗一点，否则笔画散开、字认不出
      var target = Math.max(COARSE ? 700 : 800, Math.min(5200, Math.floor((W * H) / 90)));
      var every = Math.max(1, Math.ceil(pts.length / target));
      var size = W < 640 ? 2.2 : 1.8;
      spread = 0.16 * Math.min(W, H * 2.2);

      particles = [];
      for (var i = 0; i < pts.length; i += every) {
        var p = pts[i];
        // 伪随机：同一份文字每次刷新布局一致
        var seed = ((9301 * i + 49297) % 233280) / 233280;
        var depth = 0.45 + (((233 * i + 97) % 1000) / 1000) * 0.9;
        var mix = clamp(p.x / Math.max(1, W) + (seed - 0.5) * 0.35, 0, 1);
        var r = Math.round(COLOR_A[0] + (COLOR_B[0] - COLOR_A[0]) * mix);
        var g = Math.round(COLOR_A[1] + (COLOR_B[1] - COLOR_A[1]) * mix);
        var b = Math.round(COLOR_A[2] + (COLOR_B[2] - COLOR_A[2]) * mix);

        // 起点：目标点周围一个环，飞入时才有"聚拢"的感觉
        var ang = seed * Math.PI * 2;
        var rad = spread * (0.35 + 0.75 * depth) * 1.1;

        particles.push({
          x: p.x + Math.cos(ang) * rad,
          y: p.y + Math.sin(ang) * rad,
          sx: p.x + Math.cos(ang) * rad,
          sy: p.y + Math.sin(ang) * rad,
          tx: p.x,
          ty: p.y,
          size: size,
          color: "rgb(" + r + "," + g + "," + b + ")",
          seed: seed,
          depth: depth,
          delay: 240 * seed
        });
      }

      startTime = performance.now();
      entering = true;
      built = true;
    }

    /* ---------- 每帧 ---------- */
    function frame(now) {
      if (!visible) { rafId = 0; return; }
      ctx.clearRect(0, 0, W, H);

      // 屏幕坐标 → 容器内坐标（每帧换算，快速划动也不飘）
      var rect = host.getBoundingClientRect();
      mouse.x = mouse.cx - rect.left;
      mouse.y = mouse.cy - rect.top;
      if (mouse.snap) {
        mouse.sx = mouse.x;
        mouse.sy = mouse.y;
        mouse.snap = false;
      }
      mouse.sx += (mouse.x - mouse.sx) * follow;
      mouse.sy += (mouse.y - mouse.sy) * follow;

      var allDone = true;
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        var nx = p.tx;
        var ny = p.ty;
        var appear = 1;

        if (entering) {
          var t = clamp((now - startTime - p.delay) / ENTER_MS, 0, 1);
          appear = t;
          var e = 1 - Math.pow(1 - t, 3);          // 三次缓出
          nx = p.sx + (p.tx - p.sx) * e;
          ny = p.sy + (p.ty - p.sy) * e;
          if (t < 1) allDone = false;
        } else if (!REDUCE) {
          // 拼好之后轻轻呼吸
          var tt = now * 0.001;
          nx = p.tx + 0.15 * Math.sin(0.9 * tt + 10 * p.seed) * p.depth;
          ny = p.ty + 0.15 * Math.cos(0.75 * tt + 10 * p.depth) * p.depth;
        }

        if (mouse.active) {
          var dx = p.x - mouse.sx;
          var dy = p.y - mouse.sy;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < PUSH_R && dist > 0.1) {
            var push = (1 - dist / PUSH_R) * PUSH_MAX;
            nx += (dx / dist) * push;
            ny += (dy / dist) * push;
          }
        }

        p.x += (nx - p.x) * (entering ? 0.72 : 0.55);
        p.y += (ny - p.y) * (entering ? 0.72 : 0.55);

        ctx.globalAlpha = clamp(0.35 + 0.65 * appear, 0, 1);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;

      if (entering && allDone) entering = false;
      rafId = requestAnimationFrame(frame);
    }

    function kick() {
      if (!rafId && visible) rafId = requestAnimationFrame(frame);
    }

    function placeInstantly() {
      for (var i = 0; i < particles.length; i++) {
        particles[i].x = particles[i].tx;
        particles[i].y = particles[i].ty;
      }
      entering = false;
      kick();
    }

    /* ---------- 进出视野：省电 ---------- */
    function onVisible() {
      if (!built) build();
      if (!built) return;
      if (REDUCE) placeInstantly();
      else kick();
    }

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) onVisible();
      }, { threshold: 0 }).observe(host);
    } else {
      visible = true;
      onVisible();
    }

    /* ---------- 指针推开粒子 ---------- */
    function setPointer(cx, cy) {
      mouse.cx = cx;
      mouse.cy = cy;
      mouse.active = true;
    }
    function onMove(e) {
      if (e.getCoalescedEvents) {
        var evts = e.getCoalescedEvents();
        if (evts && evts.length) {
          var last = evts[evts.length - 1];
          setPointer(last.clientX, last.clientY);
          return;
        }
      }
      setPointer(e.clientX, e.clientY);
    }
    function onDown(e) {
      setPointer(e.clientX, e.clientY);
      mouse.snap = true;
    }
    function onLeave() {
      mouse.active = false;
    }

    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove, { passive: true });
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("pointerup", function (e) {
      if (e.pointerType !== "mouse") onLeave();   // 手指没有 hover，抬手就收
    });
    // 手机上拖动会触发 pointercancel，用 touchmove 兜住
    host.addEventListener("touchmove", function (e) {
      var t = e.touches && e.touches[0];
      if (t) setPointer(t.clientX, t.clientY);
    }, { passive: true });
    host.addEventListener("touchend", onLeave, { passive: true });
    host.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    /* ---------- 视频：露头才播 ----------
       默认播一次停在最后一帧；容器加 data-loop="1" 则循环播放（适合环境类短片） */
    if (video) {
      var LOOP = /^(1|true|yes|loop)$/i.test(host.getAttribute("data-loop") || "");
      video.loop = LOOP;
      var inView = false;

      function replay() {
        try {
          video.currentTime = 0;
          var pr = video.play();
          if (pr && pr.catch) pr.catch(function () {});
        } catch (e) {}
      }
      function maybePlay() {
        if (inView && !REDUCE) replay();
      }

      if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (entries) {
          var entry = entries[0];
          var arrived = entry.isIntersecting && entry.intersectionRatio >= 0.3;
          if (arrived && !inView) {
            inView = true;
            maybePlay();
          } else if (!arrived && inView) {
            inView = false;
            video.pause();
          }
        }, { threshold: [0, 0.3] }).observe(host);
      } else {
        inView = true;
        maybePlay();
      }

      document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
          video.pause();
        } else if (LOOP && inView) {
          // 循环片从头播反而会闪一下，接着播就行
          var pr = video.play();
          if (pr && pr.catch) pr.catch(function () {});
        } else {
          maybePlay();
        }
      });

      // 手机浏览器可能拦掉自动播：用户第一次碰屏幕补播一次
      function gesture() {
        if (video.paused && !video.ended) {
          inView = true;
          maybePlay();
        }
        document.removeEventListener("pointerdown", gesture);
        document.removeEventListener("touchstart", gesture);
      }
      document.addEventListener("pointerdown", gesture, { passive: true });
      document.addEventListener("touchstart", gesture, { passive: true });
    }

    /* ---------- 尺寸变化重建 ---------- */
    var resizeTimer = 0;
    function scheduleRebuild() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        build();
        if (built && !REDUCE) kick();
      }, 180);
    }
    if ("ResizeObserver" in window) {
      new ResizeObserver(scheduleRebuild).observe(host);
    } else {
      window.addEventListener("resize", scheduleRebuild);
    }

    /* ---------- 网页字体到位后重采样一次 ---------- */
    // 字体没加载完时采样的是回退字形，等真字体到了再拼一遍才准
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        if (!built) return;
        if (performance.now() - startTime < 1500) {
          build();
          kick();
        }
      });
    }

    /* ---------- 对外接口 ---------- */
    host.butterflyHero = {
      setText: function (next) {
        var t = String(next == null ? "" : next).trim();
        if (!t) return;
        TEXT = t;
        build();
        if (!REDUCE) kick();
        else placeInstantly();
      },
      rebuild: function () {
        build();
        if (!REDUCE) kick();
        else placeInstantly();
      }
    };
  }

  function boot() {
    var hosts = document.querySelectorAll("[data-butterfly-hero]");
    for (var i = 0; i < hosts.length; i++) init(hosts[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
