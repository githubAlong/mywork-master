﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿/* 我的工作台 Service Worker
   作用只有两个：可添加到主屏幕、断网时能打开。

   === 为什么首页网络优先、静态资源按缓存版本更新 ===
   首页必须网络优先，才能及时发现新版本；JS/CSS 则跟随 CACHE 整体换版，
   同一个缓存版本内内容不变，可以直接使用预缓存。每次发布必须递增 CACHE，
   新 Service Worker 激活时会重新预取并删除旧缓存，不会长期停在旧版本。
   这样避免每次打开都把近百个模块重新请求一遍，慢网络下也不至于白屏一分钟。

   === 【2026-10 白屏事故复盘，别再犯】 ===
   现象：同一台电脑，Chrome 正常、另一个浏览器整个页面空白（书签栏还在，
        页面内容一片灰），刷新有时好有时坏。
   原因：这份清单是从上一代项目「班级资料站」抄过来的，里面列着
        student.html、student.bundle.js、app.js 这三个文件 ——
        它们在本仓库里确实还留着（旧项目的残骸），但「我的工作台」
        根本不用它们。本项目真正要缓存的是 index.html + js/main.js + js/*.js。
        于是 install 阶段这几个请求要么 404、要么去拉那个 674KB 的旧 app.js
        在 GitHub Pages 上卡几十秒。install 超时被浏览器丢掉，
        而 fetch 又是「网络优先、失败回退缓存」：
        网络一抖，navigate 请求就退到一份半截的 index.html 上 —— 白屏。
        不同浏览器对 install 超时的容忍度不同，所以「换个浏览器就好了 / 就坏了」。
   修法：
     1) 清单只列本项目真实存在的文件，并且用脚本核对过全部 200。
     2) 导航请求（打开页面本身）单独处理：网络失败才用缓存；
        缓存也没有就返回一个「加载失败，点这里重试」的极简页，
        不用固定超时把仍在传输的线上页面误判成离线。
     3) 清单里的 JS 与 index.html 版本绑定在同一个 CACHE 名上，
        改名即全量换新，不会出现「新 HTML 配旧 JS」的错配。

   资源清单用相对路径：线上可能挂在 /xxx/ 子路径下，写死 '/' 会缓存错东西。 */

/* 版本号改动 = 全量换缓存。
   每次发布只要改这里一个地方，activate 会把旧缓存整个删掉。 */
const CACHE = 'wb-v435-org-tables';

/* 【只列真实存在的文件】
   这份清单必须和 index.html 及 js/ 目录的实际内容对得上。
   加新模块时记得同步加进来，否则断网时那个页面打不开
   （联网且缓存缺失时会回源，发布时随 CACHE 整体换版）。
   核对方法：把下面每个路径拼到站点根地址后面，应当全部返回 200。 */
const ASSETS = [
  './',
  './index.html',
  './app.html',
  './manifest.webmanifest',
  './icons/favicon-tai.svg',
  './css/app.css',
  './css/design-refresh.css',
  './css/student-workbench.css',
  './css/student-purple.css',
  './css/student-dashboard.css',
  './css/teacher-ui.css',
  './css/home-responsive.css',
  './css/attendance-workspace.css',
  './css/attendance-prd.css',
  './css/attendance-hub.css',
  './css/attendance-org.css',
  './css/workbench-unified.css',
  './css/timetable-redesign.css',
  './css/sticky-notes.css',
  './css/trips-redesign.css',
  './css/study-records.css',
  './css/sync-status.css',
  './css/teacher-polish.css',
  './js/trips.js',
  './js/trips-domain.mjs',
  './css/auth-redesign.css',
  './assets/teacher-ui/hero-scene.webp',
  './assets/teacher-ui/brand-avatar.png',
  /* 入口与它直接依赖的三个 */
  './js/main.js',
  './js/editable-choices.js',
  './js/ui.js',
  './js/core.js',
  './js/class-picker.mjs',
  './js/choice-panel.mjs',
  './js/cloudsync.js',
  './js/sync-journal.mjs',
  './js/sync-status.js',
  './js/cloud.js',
  './js/environment-config.mjs',
  './js/assistant-route.mjs',
  './js/auth-identifier.mjs',
  './js/auth.js',
  './js/migrate.js',
  './js/startup-safety.mjs',
  /* 实时同步：这两个不进预缓存也不会坏（它们是用 import() 按需拉的），
     但进了清单离线时才有「一端改了另一端自己变」的正经体验 */
  './js/realtime.js',
  './js/live.js',
  /* 数据层 */
  './js/localapi.js',
  './js/localdb.js',
  './js/prep-domain.mjs',
  './js/prep-csv.mjs',
  './js/timetable-periods.mjs',
  './js/timetable-schedule.mjs',
  './js/invigilation.js',
  './js/invigilation-domain.mjs',
  /* 各业务页面 */
  './js/home.js',
  './js/weather-location.mjs',
  './js/weather-view.mjs',
  './js/work.js',
  './js/punish-seeds.mjs',
  './js/material-sharing.mjs',
  './js/material-compress.mjs',
  './student.html',
  './js/class-records.js',
  './js/prep.js',
  './js/timetable.js',
  './js/daily.js',
  './js/sticky-notes.js',
  './js/sticky-notes-domain.mjs',
  './js/todo-item-sync.mjs',
  './js/task-messages.mjs',
  './js/study.js',
  './js/study-records.js',
  './js/study-records-domain.mjs',
  './js/me.js',
  './js/demo-data-scan.mjs',
  './js/clean-demo-data.js',
  './js/repairs.js',
  './js/repairs-domain.mjs',
  './js/recycle.js',
  './js/selfstudy.js',
  './js/grade-class.mjs',
  './js/selfstudy-task-image.mjs',
  './js/rich-text.mjs',
  /* 功能模块 */
  './js/attendance.js',
  './js/attendance-prd.js',
  './js/attendance-prd-domain.mjs',
  './js/attendance-day-periods.mjs',
  './js/ocr.js',
  './js/alarm.js',
  './js/qrdecode.js',
  './js/pdfprint.js',
  './js/ttimage.js',
  './js/attimage.js',
  './js/homelayout.js',
  './js/homegrid.js',
  './js/xlsx-lite.js',
  './js/att-parse.js',
  './js/attvoice.js',
  './js/attstats.js',
  './js/attleave.js',
  './js/attday.js',
  './js/attendance-domain.mjs',
  /* 独立表源码保留（路由已下线，随时可切回），仍随包预缓存 */
  './js/attendance-hub.js',
  './js/attendance-hub-domain.mjs',
  './js/attendance-departments.js',
  './js/attendance-org.js',
  './js/attendance-legacy-restore.mjs',
  './js/attendance-tab-route.mjs',
  './js/attendance-export.mjs',
  './js/attgrade.js',
  './js/attindex.js',
  './js/attreset.js',
  './js/roster-import.mjs',
  './js/roster-batch.mjs',
  './js/roster-photo-parser.mjs',
  './js/roster-photo-parsers.mjs',
  './js/roster-structure.mjs',
];

/* 【发布后不再留「空缓存窗口」】
   新版本的缓存在 install 阶段是空的（原因见下面的 install 说明：冷启动预取会和
   当前页面抢连接，所以刻意不预取），而 activate 又会把旧缓存整份删掉。
   于是发布后的一小段时间里，浏览器手里一份能用的页面都没有：
   这时网络只要抖一下 —— 导航请求失败、缓存也没有 —— 用户看到的就是兜底页。
   2026-11-26 实测事故：v432 发布 24 分钟后，学生点链接正好撞上这个组合。
   修法：activate 先把「打开页面必需的壳」拉进新缓存，再去删旧缓存。
   四个文件并行拉、单个失败即跳过，不阻塞激活流程。 */
const SHELL = ['./', './index.html', './app.html', './student.html'];

async function warmShell() {
  let warmed = 0;
  try {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (rel) => {
      try {
        const url = new URL(rel, self.registration.scope).href;
        const response = await fetch(url, { cache: 'reload' });
        if (!response || !response.ok) return;
        await cache.put(new Request(url), response.clone());
        warmed += 1;
      } catch (error) {
        /* 单个壳文件拉不到不影响其它几个，下一次实际访问会照常写入 */
      }
    }));
  } catch (error) {
    /* 缓存打不开（隐私模式等）：当作热身失败，不往外抛 */
  }
  return warmed;
}

/* 安装阶段不预取文件。冷启动时即使只预取首页核心，也会和当前页面争用
   慢网络连接；所有资源首次实际使用时由 fetch 处理程序写入同一个 CACHE。
   ASSETS 仍保留完整清单，供版本换缓存、资源核对和已访问页面离线使用。 */
self.addEventListener('install', () => {
  // 立刻进入 waiting → activate，不等所有旧标签页关掉
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 先把新版本的壳装进缓存，再动旧缓存（顺序不能反）
    const warmed = await warmShell();
    const ks = await caches.keys();
    const stale = ks.filter((k) => k !== CACHE);
    /* 热身一个都没成功，说明这会儿网络或缓存就是坏的：
       把旧缓存留着当最后的兜底，等下一次激活再清。
       只要有一个成功就照常清 —— 静态资源是按「所有缓存」查的，
       新旧两份并存会拿旧 JS 配新 HTML，那种错配比兜底页更难查。 */
    if (warmed === 0 && stale.length) {
      console.warn('[sw] 新缓存热身失败，暂留旧缓存兜底：', stale.join(', '));
    } else {
      await Promise.all(stale.map((k) => caches.delete(k)));
      console.log('[sw] 壳文件并入新缓存：', warmed + '/' + SHELL.length, CACHE);
    }
    // 立刻接管已经打开的页面，不用等用户关标签页
    await self.clients.claim();
    // 告诉每个页面「有新版本了，可以刷新」
    const cs = await self.clients.matchAll({ type: 'window' });
    cs.forEach((c) => c.postMessage({ type: 'WB_SW_UPDATED', cache: CACHE }));
  })());
});

/* 页面主动查版本：main.js 从 v388 起就在 ready 后发 WB_PING 唤醒 waiting 的 SW，
   但这里一直没有应答，查询等于石沉大海。补上应答后，学生端能拿它当兜底——
   activate 广播万一丢在后台/切换瞬间，下次页面起来问一句就知道自己是不是旧版。 */
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'WB_PING') return;
  e.source?.postMessage({ type: 'WB_VERSION', cache: CACHE });
});

/* 【兜底页：能自己重试的页面】
   网络挂了、缓存里也没有这个页面时返回它。
   历史教训（两个版本都踩过）：
     v1 直接 throw → 浏览器一片灰白，用户以为网站坏了；
     v2 换成静态提示页 + 「重新加载」按钮 → 按钮就是 location.reload()，
        网络还失败就又回到这张一模一样的页。页面没有任何变化，
        用户只会说「点了没反应」。
   v3（本版）：
     1) 点重试先显示「正在重试…」和尝试次数 —— 每次点击都有可见反馈；
     2) 真拿到 HTML 就 document.write 原地渲染，不用再赌一次整页导航；
     3) 还是失败就写明原因（含代理/VPN 提示），给「强制更新」「打开首页」出口；
     4) 重试带 12 秒超时，避免一直转圈什么都不说。 */
const OFFLINE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>教师个人工作台</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;min-height:100vh;
       font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
       background:#f5f6f8;color:#2a2f3a;padding:24px;box-sizing:border-box}
  .box{max-width:350px;text-align:center}
  .logo{width:52px;height:52px;border-radius:15px;margin:0 auto 16px;display:grid;place-items:center;
        background:linear-gradient(135deg,#4f6ef7,#7b5cf0);color:#fff;font-size:22px;font-weight:700}
  h1{font-size:17px;margin:0 0 8px;font-weight:700}
  p{font-size:13.5px;line-height:1.65;color:#6b7280;margin:0 0 18px}
  button{width:100%;height:44px;border:0;border-radius:12px;background:#4f6ef7;color:#fff;
         font-size:15px;font-weight:600;font-family:inherit;cursor:pointer}
  button[disabled]{opacity:.7;cursor:default}
  .ghost{background:#eef1f7;color:#2a2f3a;margin-top:10px}
  .sub{margin-top:12px;font-size:12px;color:#9aa1ad;line-height:1.6}
  .status{margin:0 0 14px;font-size:12.5px;line-height:1.6;color:#4b5563;min-height:18px}
</style></head><body>
<div class="box">
  <div class="logo">台</div>
  <h1>页面没能加载出来</h1>
  <p>这一次请求在网络上失败了（常见原因：网速抖动、代理/VPN 拦截）。<br>点下面按钮重新下载，不用关页面。</p>
  <div class="status" id="msg"></div>
  <button id="retry">重新加载</button>
  <div id="extra"></div>
  <div class="sub">重试不会清除本机资料或登录信息。</div>
</div>
<script>
(function () {
  var msg = document.getElementById('msg');
  var btn = document.getElementById('retry');
  var extra = document.getElementById('extra');
  var tried = 0;
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  /* 强制更新：清掉本站旧缓存并注销 Service Worker，再带新参数重进。
     只动静态资源缓存，不碰 localStorage / IndexedDB。
     注意必须保住原有查询串：学生端链接是 student.html?code=xxx，
     以前这里硬拼 '?v=时间戳' 会把 code 冲掉 —— 学生点一次「强制更新」，
     链接就变成「接口不存在」，只能回老师那边重新生成。 */
  function keepSearch() {
    var qs = '';
    try {
      var sp = new URLSearchParams(location.search);
      sp.delete('v');
      qs = sp.toString();
    } catch (e) {
      qs = String(location.search || '').replace(/^\\?/, '');
      qs = qs.split('&').filter(function (kv) {
        return kv && kv.split('=')[0] !== 'v';
      }).join('&');
    }
    return '?' + (qs ? qs + '&' : '') + 'v=' + Date.now();
  }
  function hardReset() {
    msg.textContent = '正在清理旧缓存…';
    btn.disabled = true;
    var go = function () { location.replace(location.pathname + keepSearch() + (location.hash || '')); };
    var jobs = [];
    try { if (window.caches && caches.keys) jobs.push(caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) { return caches.delete(k); })); }).catch(function () {})); } catch (e) {}
    try { if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) jobs.push(
      navigator.serviceWorker.getRegistrations().then(function (rs) {
        return Promise.all(rs.map(function (r) { return r.unregister(); })); }).catch(function () {})); } catch (e) {}
    var done = false;
    var finish = function () { if (done) return; done = true; go(); };
    if (!jobs.length) { finish(); return; }
    Promise.all(jobs).then(finish, finish);
    setTimeout(finish, 2500);
  }
  function paintExit() {
    extra.innerHTML = '<button class="ghost" id="hard">强制更新（清掉旧缓存）</button>'
      + '<div class="sub">还进不去就点「强制更新」：它只清本站在浏览器里的旧文件，不动你的资料和登录。</div>';
    var hard = document.getElementById('hard');
    if (hard) hard.onclick = hardReset;
  }
  function retry() {
    tried += 1;
    btn.disabled = true;
    btn.textContent = '正在重新加载…';
    msg.textContent = '第 ' + tried + ' 次重试，正在重新下载页面…';
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);
    fetch(location.href, { cache: 'reload', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (html) {
        clearTimeout(timer);
        msg.textContent = '已经连上，正在打开页面…';
        try {
          document.open(); document.write(html); document.close();
        } catch (e) {
          location.reload();
        }
      })
      .catch(function (err) {
        clearTimeout(timer);
        btn.disabled = false;
        btn.textContent = '再试一次';
        var reason = (err && (err.name === 'AbortError' ? '等太久没有响应' : (err.message || err.name))) || '网络错误';
        msg.innerHTML = '第 ' + tried + ' 次重试还是失败：<br><span style="color:#b45309">' + esc(reason) + '</span><br>'
          + '如果你开着代理 / VPN / 加速器，先关掉它或换个网络再试。';
        paintExit();
      });
  }
  btn.onclick = retry;
  paintExit();
})();
</script>
</body></html>`;

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* 【导航请求失败自动重试一次】
   DNS 慢半拍、代理握手失败、连接被重置，大多是一瞬间的事。
   以前一次失败就直接甩兜底页，用户看到「页面没能加载出来」；
   隔 1.2 秒再试一次，绝大多数抖动当场就过去了。
   5xx 也当失败处理：GitHub Pages 部署窗口会短暂返回 500/503，
   那种错误页给用户看没有意义，回退到缓存比它有用。 */
async function navFetch(request, tries = 2) {
  let lastError = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response && response.status < 500) return response;
      lastError = new Error('HTTP ' + (response && response.status));
    } catch (error) {
      lastError = error;
    }
    if (i < tries - 1) await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw lastError || new Error('导航请求失败');
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // 只处理同源的 GET。跨域（天气、字体、图床）和 /api 一律放行，
  // 否则会把第三方响应也塞进缓存，既占空间又可能拿到过期数据。
  if (e.request.method !== 'GET') return;
  if (u.origin !== self.location.origin) return;
  if (u.pathname.includes('/api/')) return;

  /* 【打开页面本身：网络优先 + 离线缓存兜底】
     首页不直接沿用缓存，避免新 HTML 与当前 CACHE 的静态资源错配。
     网络失败时才读缓存；网络也拿不到且没有缓存就返回兜底页。
     注意不能把「网络返回的错误页」当成功 —— 502/503 也要走兜底。 */
  if (e.request.mode === 'navigate') {
    const base = self.registration.scope;
    const url = new URL(e.request.url);
    const scopePath = new URL(base).pathname;
    /* 只有工作台首页（scope 根 / index.html）才按「首页壳」处理。
       以前所有导航都当成 index.html：打开 student.html 时断网会拿缓存的教师首页
       顶替（学生端就显示「页面没能加载出来」），联网时还会把学生端 HTML 写进
       首页缓存，反过来污染工作台。子页面改成网络优先、离线回退自己的缓存。
       从 v408 起：子页面成功打开后也写一份缓存（去掉查询串做 key），
       这样下一次网络抖动能直接显示上次的页面，而不是掉进兜底页。 */
    if (url.pathname !== scopePath && url.pathname !== scopePath + 'index.html') {
      e.respondWith((async () => {
        try {
          const response = await navFetch(e.request);
          if (response && response.ok) {
            const canonical = new Request(url.origin + url.pathname);
            caches.open(CACHE)
              .then((cache) => cache.put(canonical, response.clone()))
              .catch((cacheError) => console.warn('[sw] 子页面缓存写入失败：', cacheError && cacheError.message));
          }
          return response;
        } catch (error) {
          console.warn('[sw] 子页面网络失败，尝试使用缓存：', url.pathname, error && error.message);
          const cached = (await caches.match(new Request(url.origin + url.pathname)))
            || (await caches.match(e.request))
            || (url.pathname.includes('student') ? await caches.match(base + 'student.html') : null);
          return cached || offlineResponse();
        }
      })());
      return;
    }
    e.respondWith((async () => {
      /* 网络优先，但不人为缩短浏览器自身的网络超时。
         缓存只用于离线兜底：写入慢或失败都不能丢弃已经成功的网络响应。 */
      try {
        const response = await navFetch(e.request);
        if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status));
        caches.open(CACHE).then((cache) => Promise.all([
          cache.put(base + 'index.html', response.clone()),
          cache.put(base, response.clone()),
        ])).catch((cacheError) => {
          console.warn('[sw] 首页缓存写入失败，仍使用网络页面：', cacheError && cacheError.message);
        });
        return response;
      } catch (error) {
        console.warn('[sw] 导航网络请求失败，尝试使用缓存页面：', error && error.message);
        const cached = (await caches.match(base + 'index.html'))
          || (await caches.match(base))
          || (await caches.match('./index.html'))
          || (await caches.match('./'));
        return cached || offlineResponse();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    /* JS/CSS 与 CACHE 同版本：命中就直接返回，不再让近百个模块逐个等待网络。
       发布时递增 CACHE 并重新预缓存；旧缓存会在 activate 时删除。 */
    const cached = await caches.match(e.request);
    if (cached) return cached;
    try {
      /* 缓存未命中时绕过浏览器 HTTP 缓存：否则套着旧 max-age 的 JS 会被
         原样写进新版本的 CACHE，发布后还继续跑旧脚本。 */
      const response = await fetch(e.request, { cache: 'reload' });
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(e.request, response.clone());
      }
      return response;
    } catch (error) {
      console.warn('[sw] 静态资源网络请求失败：', e.request.url, error && error.message);
      throw error;
    }
  })());
});
