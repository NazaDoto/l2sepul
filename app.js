(() => {
  const SOURCE = "https://www.sepul.com.ar/?page=boss";
  const CACHE_KEY = "l2sepul_bosses_v1";
  const CACHE_FLUSH_KEY = "l2sepul_flush";
  const CACHE_FLUSH_VER = "20260917d";
  const SPAWN_CACHE_KEY = "l2sepul_spawns_v1";
  const LIVE_TTL_MS = 90 * 1000;

  try {
    if (localStorage.getItem(CACHE_FLUSH_KEY) !== CACHE_FLUSH_VER) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("l2sepul_") === 0) keys.push(k);
      }
      keys.forEach(function (k) {
        localStorage.removeItem(k);
      });
      localStorage.setItem(CACHE_FLUSH_KEY, CACHE_FLUSH_VER);
    }
  } catch (_) {}

  function asHtmlPayload(html) {
    if (!html || String(html).length < 1500) throw new Error("html corto");
    if (!/Antharas|Boss Status|Epic Bosses|Raid Bosses/i.test(html)) {
      throw new Error("html sin bosses");
    }
    return { type: "html", data: html };
  }

  // Proxies CORS publicos. Sepul no manda Access-Control-Allow-Origin.
  // Corsfix: sin cupo diario, HTML original. El resto son fallbacks.
  const LIVE_SOURCES = [
    {
      id: "corsfix",
      url: "https://proxy.corsfix.com/?url=" + encodeURIComponent(SOURCE),
      parse: async (res) => asHtmlPayload(await res.text()),
    },
    {
      id: "corsfix-raw",
      url: "https://proxy.corsfix.com/?" + SOURCE,
      parse: async (res) => asHtmlPayload(await res.text()),
    },
    {
      id: "corslol",
      url: "https://api.cors.lol/?url=" + encodeURIComponent(SOURCE),
      timeout: 12000,
      parse: async (res) => asHtmlPayload(await res.text()),
    },
    {
      id: "microlink",
      url:
        "https://api.microlink.io/?url=" +
        encodeURIComponent(SOURCE) +
        "&data.html.attr=html&meta=false",
      parse: async (res) => {
        const data = await res.json();
        const html = data && data.data && data.data.html;
        if (!html || data.status !== "success") throw new Error("microlink empty");
        return asHtmlPayload(html);
      },
    },
    {
      id: "allorigins",
      url: "https://api.allorigins.win/get?url=" + encodeURIComponent(SOURCE),
      timeout: 18000,
      parse: async (res) => {
        const data = await res.json();
        const html = data && data.contents;
        if (!html) throw new Error("allorigins empty");
        return asHtmlPayload(html);
      },
    },
  ];

  const DESKTOP_MQ = "(min-width: 1100px)";

  const state = {
    bosses: [],
    cat: "all",
    city: "all",
    query: "",
    timer: null,
    selectedName: null,
    selectedCity: null,
  };

  function isDesktopLayout() {
    return window.matchMedia(DESKTOP_MQ).matches;
  }

  const $ = (id) => document.getElementById(id);
  const listEl = $("list");
  const loaderEl = $("loader");
  const toastEl = $("toast");
  const lastUpdateEl = $("lastUpdate");
  const refreshBtn = $("refreshBtn");
  const searchInput = $("searchInput");
  const cityChipsEl = $("cityChips");

  function normalizeName(name) {
    return String(name)
      .toLowerCase()
      .replace(/[''`\u00b4\u2018\u2019]/g, "")
      .replace(/,/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function resolveCity(name) {
    const key = normalizeName(name);
    return (window.BOSS_LOCATIONS || {})[key] || "-";
  }

  function isQuestBoss(name) {
    return !!(window.QUEST_BOSSES || {})[normalizeName(name)];
  }

  function isAlive(status) {
    const s = String(status).toLowerCase();
    if (/muerto|dead|died|down/.test(s)) return false;
    return /vivo|alive|\balive\b|\blive\b/.test(s);
  }

  function isEpic(category) {
    return /epic/i.test(category || "");
  }

  function parseRespawn(raw) {
    if (!raw || raw === "-" || raw === "\u2014" || raw === "\u2013") return null;
    const m = String(raw)
      .trim()
      .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    const h = Number(m[4]);
    const mi = Number(m[5]);
    // Sepul times are Argentina (UTC-3)
    return new Date(Date.UTC(y, mo - 1, d, h + 3, mi, 0));
  }

  function formatWhen(date) {
    if (!date) return "";
    return date.toLocaleString("es-AR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatCountdown(ms) {
    if (ms <= 0) return { text: "Ya!", cls: "up" };
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    let text;
    if (d > 0) text = d + "d " + h + "h " + m + "m";
    else if (h > 0) text = h + "h " + m + "m " + String(s).padStart(2, "0") + "s";
    else text = m + "m " + String(s).padStart(2, "0") + "s";
    return { text, cls: ms < 3600000 ? "soon" : "" };
  }

  function stripTags(html) {
    return String(html)
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();
  }

  function parseTableRows(table, category) {
    const bosses = [];
    for (const tr of table.querySelectorAll("tr")) {
      const tds = [...tr.querySelectorAll("td")];
      if (tds.length < 4) continue;
      const name = stripTags(tds[0].innerHTML);
      if (!name || /nombre|name/i.test(name)) continue;
      const status = stripTags(tds[2].innerHTML);
      const respawnRaw = stripTags(tds[3].innerHTML);
      bosses.push({
        name,
        level: parseInt(stripTags(tds[1].innerHTML), 10) || 0,
        status,
        respawnRaw,
        respawnAt: parseRespawn(respawnRaw),
        category,
        city: resolveCity(name),
        epic: isEpic(category),
        quest: isQuestBoss(name),
        alive: isAlive(status),
      });
    }
    return bosses;
  }

  function nextTable(fromEl) {
    let el = fromEl.nextElementSibling;
    while (el) {
      if (el.tagName === "TABLE") return el;
      const inner = el.querySelector && el.querySelector("table");
      if (inner) return inner;
      el = el.nextElementSibling;
    }
    return null;
  }

  function parseBossHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const bosses = [];
    const headings = [...doc.querySelectorAll("h1, h2, h3")];
    for (const h of headings) {
      const category = h.textContent.trim();
      if (!/boss/i.test(category)) continue;
      const table = nextTable(h);
      if (!table) continue;
      bosses.push.apply(bosses, parseTableRows(table, category));
    }
    if (bosses.length) return bosses;

    for (const table of doc.querySelectorAll("table")) {
      let category = "Raid Bosses";
      let prev = table.previousElementSibling;
      while (prev && !/^H[1-4]$/.test(prev.tagName)) prev = prev.previousElementSibling;
      if (prev) category = prev.textContent.trim() || category;
      bosses.push.apply(bosses, parseTableRows(table, category));
    }
    return bosses;
  }

  function parseBossJson(data) {
    const list = Array.isArray(data) ? data : data.bosses || [];
    return list.map((b) => ({
      name: b.name,
      level: Number(b.level) || 0,
      status: b.status,
      respawnRaw: b.respawn || b.respawnRaw || "-",
      respawnAt: parseRespawn(b.respawn || b.respawnRaw),
      category: b.category || (b.epic ? "Epic Bosses" : "Raid Bosses"),
      city: resolveCity(b.name),
      epic: b.epic != null ? !!b.epic : isEpic(b.category),
      quest: b.quest != null ? !!b.quest : isQuestBoss(b.name),
      alive: b.alive != null ? !!b.alive : isAlive(b.status),
    }));
  }

  async function fetchLive(source) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), source.timeout || 15000);
    try {
      const res = await fetch(source.url, {
        signal: ctrl.signal,
        cache: "no-store",
        mode: "cors",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await source.parse(res);
    } finally {
      clearTimeout(t);
    }
  }

  function loadEmbeddedCache() {
    if (Array.isArray(window.BOSSES_CACHE) && window.BOSSES_CACHE.length) {
      return window.BOSSES_CACHE;
    }
    return null;
  }

  function finalizeBosses(list) {
    const seen = new Set();
    return list.filter((b) => {
      const k = normalizeName(b.name) + "|" + b.level;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function readSessionCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cached && Array.isArray(cached.bosses) && cached.bosses.length) return cached;
    } catch (_) {}
    return null;
  }

  function cacheLooksStale(bosses) {
    const list = Array.isArray(bosses) ? bosses : [];
    const dated = list.filter(function (b) {
      const raw = b.respawn || b.respawnRaw;
      return raw && raw !== "-" && parseRespawn(raw);
    });
    if (dated.length < 8) return false;
    const overdue = dated.filter(function (b) {
      const at = parseRespawn(b.respawn || b.respawnRaw);
      return at && Date.now() - at.getTime() > 8 * 3600 * 1000;
    });
    return overdue.length > dated.length * 0.45;
  }

  function applyBosses(list, source) {
    state.bosses = finalizeBosses(list);
    return state.bosses.length > 0 ? source : null;
  }

  async function loadBosses(opts) {
    const force = !!(opts && opts.force);
    setLoading(true);
    let lastErr = null;
    let source = null;
    state.bosses = [];

    try {
      if (!force) {
        const session = readSessionCache();
        if (
          session &&
          Date.now() - session.at < LIVE_TTL_MS &&
          !cacheLooksStale(session.bosses)
        ) {
          source = applyBosses(parseBossJson(session.bosses), "session");
        }
      }

      if (!source) {
        for (const live of LIVE_SOURCES) {
          try {
            const result = await fetchLive(live);
            let bosses =
              result.type === "json" ? parseBossJson(result.data) : parseBossHtml(result.data);
            bosses = finalizeBosses(bosses);
            if (bosses.length < 10) throw new Error("parse incompleto");
            state.bosses = bosses;
            source = "live";
            try {
              localStorage.setItem(
                CACHE_KEY,
                JSON.stringify({ at: Date.now(), bosses: bosses.map(serializeBoss) })
              );
            } catch (_) {}
            break;
          } catch (e) {
            lastErr = e;
          }
        }
      }

      if (!source) {
        try {
          const raw = loadEmbeddedCache();
          if (!raw) throw new Error("Cache vacio");
          if (cacheLooksStale(raw)) throw new Error("Cache viejo");
          source = applyBosses(parseBossJson(raw), "cache");
        } catch (e) {
          lastErr = e;
        }
      }

      if (!source) {
        const session = readSessionCache();
        if (session && !cacheLooksStale(session.bosses)) {
          source = applyBosses(parseBossJson(session.bosses), "local");
        } else if (session) {
          source = applyBosses(parseBossJson(session.bosses), "local");
        }
      }

      if (!state.bosses.length) {
        showToast("No se pudieron cargar los bosses.");
        lastUpdateEl.textContent = "Sin datos";
        render();
        throw lastErr || new Error("No data");
      }

      const labels = {
        live: "sepul.com.ar (live)",
        session: "sepul.com.ar",
        cache: "Cache local",
        local: "Ultima sesion",
      };
      lastUpdateEl.textContent =
        (labels[source] || source) +
        " · " +
        new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
      if (source === "cache" || source === "local") {
        showToast("No hubo respuesta live. Mostrando cache.");
      }
      render();
      ensureDesktopPins();
    } finally {
      setLoading(false);
    }
  }

  function serializeBoss(b) {
    return {
      name: b.name,
      level: b.level,
      status: b.status,
      respawn: b.respawnRaw,
      category: b.category,
    };
  }

  function filtered() {
    const q = state.query.trim().toLowerCase();
    return state.bosses.filter((b) => {
      if (state.cat === "epic" && !b.epic) return false;
      if (state.cat === "raid" && b.epic) return false;
      if (state.cat === "quest" && !b.quest) return false;
      if (state.cat === "vivo" && !b.alive) return false;
      if (state.cat === "muerto" && b.alive) return false;
      if (state.city !== "all" && b.city !== state.city) return false;
      if (q) {
        const hay = (b.name + " " + b.city + " " + b.level).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function sortBosses(list) {
    return [...list].sort((a, b) => {
      // Vivos al final: priorizar los que van a respawnear pronto
      if (a.alive !== b.alive) return a.alive ? 1 : -1;
      const ta = a.respawnAt ? a.respawnAt.getTime() : Infinity;
      const tb = b.respawnAt ? b.respawnAt.getTime() : Infinity;
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
  }

  function cardHtml(b, i) {
    const delay = Math.min(i * 18, 220);
    let timeHtml;
    let meterWidth = 100;
    if (b.alive) {
      timeHtml = '<div class="alive-label">VIVO</div><div class="meter"><i style="width:100%"></i></div>';
    } else if (b.respawnAt) {
      const ms = b.respawnAt - Date.now();
      const cd = formatCountdown(ms);
      // barra tipo HP: más llena = más cerca del respawn (o tiempo restante relativo a 24h)
      const day = 24 * 3600 * 1000;
      meterWidth = ms <= 0 ? 100 : Math.max(6, Math.min(100, Math.round(100 - (ms / day) * 100)));
      timeHtml =
        '<div class="countdown ' +
        cd.cls +
        '" data-ts="' +
        b.respawnAt.getTime() +
        '">' +
        cd.text +
        "</div>" +
        '<div class="when">' +
        formatWhen(b.respawnAt) +
        "</div>" +
        '<div class="meter"><i style="width:' +
        meterWidth +
        '%"></i></div>';
    } else {
      timeHtml = '<div class="when">Sin hora</div><div class="meter"><i style="width:0%"></i></div>';
    }

    return (
      '<article class="card' +
      (b.alive ? " is-alive" : "") +
      '" style="animation-delay:' +
      delay +
      'ms" data-name="' +
      escapeHtml(b.name) +
      '" data-city="' +
      escapeHtml(b.city) +
      '" role="button" tabindex="0">' +
      '<h3 class="card-name">' +
      escapeHtml(b.name) +
      "</h3>" +
      '<div class="card-time">' +
      timeHtml +
      "</div>" +
      '<div class="card-meta">' +
      '<span class="badge ' +
      (b.alive ? "alive" : "dead") +
      '">' +
      (b.alive ? "Vivo" : "Muerto") +
      "</span>" +
      '<span class="badge lvl">Lv ' +
      b.level +
      "</span>" +
      '<span class="badge city">' +
      escapeHtml(b.city) +
      "</span>" +
      '<span class="badge cat' +
      (b.quest ? " quest" : "") +
      '">' +
      (b.quest ? "Quest" : b.epic ? "Epic" : "Raid") +
      "</span>" +
      "</div></article>"
    );
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render() {
    const list = sortBosses(filtered());
    if (state.selectedName && !list.some(function (b) { return b.name === state.selectedName; })) {
      state.selectedName = null;
      state.selectedCity = null;
    }

    if (!list.length) {
      listEl.innerHTML =
        '<div class="empty"><strong>No matches</strong>Proba otra ciudad o limpia la busqueda.</div>';
      renderPins();
      return;
    }

    // Una sola lista ordenada por respawn (próximos primero)
    const dead = list.filter((b) => !b.alive);
    const alive = list.filter((b) => b.alive);
    let html = "";
    if (dead.length) {
      html += '<div class="section-title">Proximos respawns · ' + dead.length + "</div>";
      html += dead.map((b, i) => cardHtml(b, i)).join("");
    }
    if (alive.length && state.cat !== "muerto") {
      html += '<div class="section-title">Vivos · ' + alive.length + "</div>";
      html += alive.map((b, i) => cardHtml(b, i + dead.length)).join("");
    }
    listEl.innerHTML = html;
    syncSelectedCard();
    renderPins();
  }

  function syncSelectedCard() {
    const cards = listEl.querySelectorAll(".card[data-name]");
    cards.forEach((card) => {
      const on = !!state.selectedName && card.dataset.name === state.selectedName;
      card.classList.toggle("is-selected", on);
    });
  }

  function tickCountdowns() {
    const now = Date.now();
    document.querySelectorAll(".countdown[data-ts]").forEach((el) => {
      const ts = Number(el.dataset.ts);
      const cd = formatCountdown(ts - now);
      el.textContent = cd.text;
      el.className = "countdown " + cd.cls;
    });
  }

  function setLoading(on) {
    loaderEl.classList.toggle("is-on", on);
    loaderEl.hidden = !on;
    refreshBtn.classList.toggle("spin", on);
    refreshBtn.disabled = on;
  }

  let toastTimer;
  function showToast(msg) {
    toastEl.hidden = false;
    toastEl.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 4200);
  }

  const mapOverlay = $("mapOverlay");
  const mapBossName = $("mapBossName");
  const mapMeta = $("mapMeta");
  const mapCoords = $("mapCoords");
  const mapCanvas = $("mapCanvas");
  const mapPins = $("mapPins");
  const mapCloseBtn = $("mapCloseBtn");
  const mapLoader = $("mapLoader");
  const spawnCache = Object.create(null);
  let lastSpawn = null;
  let mapDrawRaf = 0;
  let pinRenderTimer = 0;
  let spawnLoading = false;
  let mapView = { ox: 0, oy: 0, scale: 1, sx: 0, sy: 0 };
  let spawnLoadToken = 0;
  const cam = { x: 0, y: 0, scale: 1, fitted: false, user: false };
  const mapFrame = mapCanvas.parentElement;
  let mapDrag = null;
  let suppressPinClick = false;
  const PIN_SVG =
    '<svg viewBox="0 0 16 22" aria-hidden="true"><path class="pin-body" d="M8 21S1.4 13.1 1.4 8A6.6 6.6 0 0 1 14.6 8C14.6 13.1 8 21 8 21z" fill="#d4453d" stroke="#f0d79a" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="7.6" r="2" fill="#f3e2b0"/></svg>';

  // Calibración mundo → píxeles (l2dife/php-map BASE_* para 1812x2620)
  const MAP_IMG_SRC = "interlude.png";
  const MAP_W = 1812;
  const MAP_H = 2620;
  const MAP_SCALE = 199.55;
  const MAP_BX = 655;
  const MAP_BY = 1310;
  const MAP_CROP = 460; // área visible en px del mapa fuente (zoom local)

  const mapImg = new Image();
  mapImg.decoding = "async";
  mapImg.src = MAP_IMG_SRC;
  let mapImgReady = false;
  mapImg.onload = function () {
    mapImgReady = true;
  };

  function worldToMapPx(x, y) {
    return {
      px: x / MAP_SCALE + MAP_BX,
      py: y / MAP_SCALE + MAP_BY,
    };
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function drawBossPin(ctx, mx, my, alive) {
    const h = 16;
    const w = 11;
    ctx.save();
    ctx.translate(mx, my);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-w / 2, -h * 0.32, -w / 2, -h * 0.72, 0, -h);
    ctx.bezierCurveTo(w / 2, -h * 0.72, w / 2, -h * 0.32, 0, 0);
    ctx.closePath();
    ctx.fillStyle = alive ? "#2f9e5a" : "#d4453d";
    ctx.fill();
    ctx.strokeStyle = "#f0d79a";
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -h * 0.62, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = "#f3e2b0";
    ctx.fill();
    ctx.restore();
  }

  function mapViewSize() {
    const cssW = mapCanvas.clientWidth || 360;
    if (isDesktopLayout()) {
      return { cssW: cssW, cssH: mapCanvas.clientHeight || cssW };
    }
    return { cssW: cssW, cssH: cssW };
  }

  function cropForView(cssW, cssH) {
    const aspect = cssW / Math.max(cssH, 1);
    let cropH = MAP_CROP;
    let cropW = cropH * aspect;
    if (cropW > MAP_W) {
      cropW = MAP_W;
      cropH = cropW / aspect;
    }
    if (cropH > MAP_H) {
      cropH = MAP_H;
      cropW = cropH * aspect;
    }
    return { cropW: cropW, cropH: cropH };
  }

  function worldToScreen(x, y) {
    const pos = worldToMapPx(x, y);
    return {
      x: mapView.ox + (pos.px - mapView.sx) * mapView.scale,
      y: mapView.oy + (pos.py - mapView.sy) * mapView.scale,
    };
  }

  function fitCamToWidth(cssW, cssH) {
    cam.scale = cssW / MAP_W;
    cam.x = 0;
    const viewH = cssH / cam.scale;
    cam.y = viewH >= MAP_H ? (MAP_H - viewH) / 2 : (MAP_H - viewH) / 2;
    cam.fitted = true;
    clampCam(cssW, cssH);
  }

  function clampCam(cssW, cssH) {
    const viewW = cssW / cam.scale;
    const viewH = cssH / cam.scale;
    if (viewW >= MAP_W) cam.x = (MAP_W - viewW) / 2;
    else cam.x = clamp(cam.x, 0, MAP_W - viewW);
    if (viewH >= MAP_H) cam.y = (MAP_H - viewH) / 2;
    else cam.y = clamp(cam.y, 0, MAP_H - viewH);
  }

  function centerCamOnSpawn(spawn) {
    if (!isDesktopLayout() || !spawn || typeof spawn.x !== "number" || typeof spawn.y !== "number") {
      return;
    }
    const size = mapViewSize();
    if (size.cssW < 8 || size.cssH < 8) return;
    const pos = worldToMapPx(spawn.x, spawn.y);
    const fitW = size.cssW / MAP_W;
    const minScale = Math.min(fitW, size.cssH / MAP_H) * 0.92;
    const maxScale = fitW * 8;
    const targetCrop = 540;
    let scale = Math.max(size.cssW / targetCrop, size.cssH / targetCrop);
    const marginX = Math.max(48, Math.min(pos.px, MAP_W - pos.px));
    const marginY = Math.max(48, Math.min(pos.py, MAP_H - pos.py));
    scale = Math.max(scale, size.cssW / (2 * marginX), size.cssH / (2 * marginY));
    cam.scale = clamp(scale, minScale, maxScale);
    cam.x = pos.px - size.cssW / (2 * cam.scale);
    cam.y = pos.py - size.cssH / (2 * cam.scale);
    cam.fitted = true;
    cam.user = true;
    clampCam(size.cssW, size.cssH);
    scheduleMapDraw();
  }

  function syncMapViewFromCam() {
    mapView = { ox: 0, oy: 0, scale: cam.scale, sx: cam.x, sy: cam.y };
  }

  function drawDesktopMap(ctx, cssW, cssH) {
    if (!cam.fitted || !cam.user) fitCamToWidth(cssW, cssH);
    else clampCam(cssW, cssH);
    syncMapViewFromCam();
    const viewW = cssW / cam.scale;
    const viewH = cssH / cam.scale;
    ctx.drawImage(mapImg, cam.x, cam.y, viewW, viewH, 0, 0, cssW, cssH);
  }

  function positionPins() {
    if (!mapPins || !isDesktopLayout()) return;
    const pins = mapPins.children;
    for (let i = 0; i < pins.length; i++) {
      const pin = pins[i];
      const spawn = spawnCache[pin.dataset.name];
      if (!spawn || typeof spawn.x !== "number") {
        pin.style.display = "none";
        continue;
      }
      const p = worldToScreen(spawn.x, spawn.y);
      pin.style.left = p.x.toFixed(1) + "px";
      pin.style.top = p.y.toFixed(1) + "px";
      pin.style.display = "";
    }
  }

  function drawWorldMap(spawn) {
    if (arguments.length) lastSpawn = spawn;
    spawn = lastSpawn;

    const ctx = mapCanvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = mapViewSize();
    const cssW = size.cssW;
    const cssH = size.cssH;
    if (cssW < 8 || cssH < 8) return;
    mapCanvas.width = Math.round(cssW * dpr);
    mapCanvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#1a1510";
    ctx.fillRect(0, 0, cssW, cssH);

    if (!mapImgReady || !mapImg.complete || !mapImg.naturalWidth) {
      ctx.fillStyle = "#d8d2c6";
      ctx.font = "600 13px 'Noto Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Cargando mapa…", cssW / 2, cssH / 2);
      ctx.textAlign = "start";
      if (!mapImg.src) mapImg.src = MAP_IMG_SRC;
      mapImg.decode().then(function () {
        mapImgReady = true;
        drawWorldMap();
      }).catch(function () {});
      return;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (isDesktopLayout()) {
      drawDesktopMap(ctx, cssW, cssH);
      if (mapPins.childElementCount) positionPins();
      else renderPins();
      return;
    }

    mapPins.hidden = true;
    const hasSpawn = spawn && typeof spawn.x === "number" && typeof spawn.y === "number";
    const crop = cropForView(cssW, cssH);
    let sx;
    let sy;

    if (hasSpawn) {
      const pos = worldToMapPx(spawn.x, spawn.y);
      sx = clamp(pos.px - crop.cropW / 2, 0, MAP_W - crop.cropW);
      sy = clamp(pos.py - crop.cropH / 2, 0, MAP_H - crop.cropH);
    } else {
      sx = (MAP_W - crop.cropW) / 2;
      sy = (MAP_H - crop.cropH) / 2;
    }

    mapView = {
      ox: 0,
      oy: 0,
      scale: cssW / crop.cropW,
      sx: sx,
      sy: sy,
    };
    ctx.drawImage(mapImg, sx, sy, crop.cropW, crop.cropH, 0, 0, cssW, cssH);

    const grd = ctx.createRadialGradient(
      cssW / 2,
      cssH / 2,
      Math.min(cssW, cssH) * 0.35,
      cssW / 2,
      cssH / 2,
      Math.min(cssW, cssH) * 0.78
    );
    grd.addColorStop(0, "rgba(0,0,0,0)");
    grd.addColorStop(1, "rgba(8,10,16,0.35)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, cssW, cssH);

    if (!hasSpawn) {
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.fillStyle = "#f3e2b0";
      ctx.font = "600 13px 'Noto Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Sin coordenadas de spawn", cssW / 2, cssH / 2);
      ctx.textAlign = "start";
      return;
    }

    const pos = worldToMapPx(spawn.x, spawn.y);
    const mx = ((pos.px - sx) / crop.cropW) * cssW;
    const my = ((pos.py - sy) / crop.cropH) * cssH;
    const boss = state.bosses.find(function (b) {
      return b.name === state.selectedName;
    });
    drawBossPin(ctx, mx, my, !!(boss && boss.alive));
  }

  function schedulePinRender() {
    if (pinRenderTimer) return;
    pinRenderTimer = setTimeout(function () {
      pinRenderTimer = 0;
      renderPins();
    }, 180);
  }

  function scheduleMapDraw() {
    cancelAnimationFrame(mapDrawRaf);
    mapDrawRaf = requestAnimationFrame(function () {
      if (isDesktopLayout() || mapOverlay.classList.contains("is-on")) {
        drawWorldMap();
      }
    });
  }

  function renderPins() {
    if (!mapPins) return;
    if (!isDesktopLayout()) {
      mapPins.hidden = true;
      mapPins.innerHTML = "";
      return;
    }
    const parts = [];
    filtered().forEach(function (b) {
      const spawn = spawnCache[b.name];
      if (!spawn || typeof spawn.x !== "number" || typeof spawn.y !== "number") return;
      const p = worldToScreen(spawn.x, spawn.y);
      const selected = b.name === state.selectedName;
      parts.push(
        '<button type="button" class="map-pin ' +
          (b.alive ? "is-alive" : "is-dead") +
          (selected ? " is-selected" : "") +
          '" data-name="' +
          escapeHtml(b.name) +
          '" data-city="' +
          escapeHtml(b.city) +
          '" title="' +
          escapeHtml(b.name) +
          '" aria-label="' +
          escapeHtml(b.name) +
          '" style="left:' +
          p.x.toFixed(1) +
          "px;top:" +
          p.y.toFixed(1) +
          'px">' +
          PIN_SVG +
          "</button>"
      );
    });
    mapPins.hidden = false;
    mapPins.innerHTML = parts.join("");
    updateDesktopMapStatus();
  }

  function syncSelectedPin() {
    if (!mapPins) return;
    mapPins.querySelectorAll(".map-pin").forEach(function (pin) {
      pin.classList.toggle("is-selected", pin.dataset.name === state.selectedName);
    });
  }

  function updateDesktopMapStatus() {
    if (!isDesktopLayout()) return;
    const visible = filtered();
    const total = visible.length;
    const ready = visible.filter(function (b) {
      const spawn = spawnCache[b.name];
      return spawn && typeof spawn.x === "number";
    }).length;
    if (state.selectedName) return;
    mapBossName.textContent = "Mapa";
    mapMeta.textContent =
      ready === total
        ? ready + " ubicaciones"
        : "Cargando ubicaciones · " + ready + "/" + total;
    mapCoords.textContent = "";
  }

  function applySpawnMeta(spawn, fallbackCity) {
    const bits = [];
    if (spawn.location && spawn.location.name) bits.push(spawn.location.name);
    if (spawn.region && spawn.region.name) bits.push(spawn.region.name);
    if (fallbackCity && fallbackCity !== "-") bits.push(fallbackCity);
    mapMeta.textContent = bits.filter(Boolean).join(" · ") || "Ubicación encontrada";
    mapCoords.textContent =
      "X: " + spawn.x + "   Y: " + spawn.y + "   Z: " + spawn.z + "   ID: " + spawn.id;
  }

  function readSpawnCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(SPAWN_CACHE_KEY) || "null");
      if (raw && typeof raw === "object") {
        Object.keys(raw).forEach(function (name) {
          if (raw[name] && typeof raw[name].x === "number") spawnCache[name] = raw[name];
        });
      }
    } catch (_) {}
  }

  function writeSpawnCache() {
    try {
      localStorage.setItem(SPAWN_CACHE_KEY, JSON.stringify(spawnCache));
    } catch (_) {}
  }

  async function fetchMonsterCatalog() {
    const [grand, raid] = await Promise.all([
      apiJson("https://l2api.dev/api/interlude/monsters?npcType=GrandBoss&limit=50"),
      apiJson("https://l2api.dev/api/interlude/monsters?npcType=RaidBoss&limit=300"),
    ]);
    return [].concat((grand && grand.data) || [], (raid && raid.data) || []);
  }

  async function fetchSpawnsOnly(monsterId) {
    try {
      const npcSpawns = await apiJson(
        "https://l2api.dev/api/interlude/npcs/" + monsterId + "/spawns"
      );
      if (npcSpawns.data && npcSpawns.data[0]) return npcSpawns.data[0];
    } catch (_) {}
    const raw = await apiJson(
      "https://l2api.dev/api/interlude/raw/monsters/" + monsterId + "/spawns"
    );
    return (raw.data && raw.data[0]) || null;
  }

  function catalogByName(list) {
    const map = Object.create(null);
    (list || []).forEach(function (m) {
      const key = normalizeName(m.name);
      const prev = map[key];
      if (!prev || /GrandBoss/i.test(m.npcType || "")) map[key] = m;
    });
    return map;
  }

  async function loadAllBossSpawns() {
    if (spawnLoading) return;
    spawnLoading = true;
    const token = ++spawnLoadToken;
    try {
      readSpawnCache();
      renderPins();
      const pending = state.bosses.filter(function (b) {
        return !(spawnCache[b.name] && typeof spawnCache[b.name].x === "number");
      });
      if (!pending.length) return;

      let catalogMap = null;
      try {
        catalogMap = catalogByName(await fetchMonsterCatalog());
      } catch (_) {
        catalogMap = Object.create(null);
      }
      if (token !== spawnLoadToken) return;

      let i = 0;
      async function worker() {
        while (i < pending.length && token === spawnLoadToken) {
          const b = pending[i++];
          try {
            const hint = catalogMap[normalizeName(b.name)] || null;
            await fetchSpawn(b.name, hint, { skipDetail: true });
            if (i % 12 === 0) writeSpawnCache();
            schedulePinRender();
          } catch (_) {}
        }
      }
      await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
      if (token === spawnLoadToken) {
        writeSpawnCache();
        renderPins();
      }
    } finally {
      spawnLoading = false;
    }
  }

  function ensureDesktopPins() {
    if (!isDesktopLayout() || !state.bosses.length) return;
    scheduleMapDraw();
    loadAllBossSpawns().catch(function () {});
  }

  async function apiJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(function () {
      ctrl.abort();
    }, 12000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "force-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  function pickMonster(list, name) {
    const key = normalizeName(name);
    const scored = (list || []).map(function (m) {
      const n = normalizeName(m.name || "");
      let score = 0;
      if (n === key) score += 100;
      else if (n.indexOf(key) === 0) score += 35;
      else if (n.includes(key) || key.includes(n)) score += 15;
      // preferir el nombre más corto en empates (Zaken > Zaken's Pikeman)
      score += Math.max(0, 12 - n.length * 0.15);
      if (/GrandBoss/i.test(m.npcType || "")) score += 30;
      else if (/RaidBoss/i.test(m.npcType || "")) score += 20;
      if (m.title === "Raid Boss") score += 8;
      return { m: m, score: score };
    });
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return scored[0] && scored[0].score >= 30 ? scored[0].m : null;
  }

  async function fetchSpawn(name, monsterHint, opts) {
    if (spawnCache[name] && typeof spawnCache[name].x === "number") return spawnCache[name];
    let monster = monsterHint || null;
    if (!monster) {
      const q = encodeURIComponent(name);
      const search = await apiJson(
        "https://l2api.dev/api/interlude/monsters?q=" + q + "&limit=40"
      );
      monster = pickMonster(search.data, name);
    }
    if (!monster) throw new Error("Boss no encontrado en l2api");

    const spawn = await fetchSpawnsOnly(monster.id);
    if (!spawn) throw new Error("Sin coordenadas de spawn");

    let region = spawn.region || null;
    let location = spawn.location || null;

    if (!region || !location) {
      if (!(opts && opts.skipDetail)) {
        try {
          const detail = await apiJson(
            "https://l2api.dev/api/interlude/monsters/" + monster.id
          );
          region = region || (detail.data && detail.data.primaryRegion) || null;
          location = location || (detail.data && detail.data.primaryLocation) || null;
        } catch (_) {}
      }
    }

    const result = {
      id: monster.id,
      name: monster.name,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      region: region,
      location: location,
    };
    spawnCache[name] = result;
    return result;
  }

  function setMapLoading(on) {
    mapLoader.classList.toggle("is-on", on);
    mapLoader.hidden = !on;
  }

  function showMapPanel() {
    mapOverlay.hidden = false;
    mapOverlay.classList.add("is-on");
    mapOverlay.querySelector(".map-window").setAttribute(
      "aria-modal",
      isDesktopLayout() ? "false" : "true"
    );
  }

  function scrollCardIntoList(card) {
    if (!card || !listEl) return;
    const listRect = listEl.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const header = listEl.querySelector(".section-title");
    const pad = (header ? header.getBoundingClientRect().height : 32) + 6;
    if (cardRect.top < listRect.top + pad) {
      listEl.scrollTop += cardRect.top - listRect.top - pad;
    } else if (cardRect.bottom > listRect.bottom) {
      listEl.scrollTop += cardRect.bottom - listRect.bottom;
    }
  }

  function selectBoss(name, fallbackCity, fromPin) {
    state.selectedName = name;
    state.selectedCity = fallbackCity || null;
    syncSelectedCard();
    syncSelectedPin();
    if (fromPin) {
      const card = listEl.querySelector(".card.is-selected");
      if (card) scrollCardIntoList(card);
    }
    mapBossName.textContent = name;
    const cached = spawnCache[name];
    if (cached && typeof cached.x === "number") {
      applySpawnMeta(cached, fallbackCity);
      centerCamOnSpawn(cached);
    } else {
      mapMeta.textContent = fallbackCity && fallbackCity !== "-" ? "Ciudad: " + fallbackCity : "…";
      mapCoords.textContent = "";
    }
  }

  function openMap(name, fallbackCity, fromPin) {
    selectBoss(name, fallbackCity, fromPin);
    showMapPanel();

    if (isDesktopLayout()) {
      const cached = spawnCache[name];
      if (cached && typeof cached.x === "number") return;
      fetchSpawn(name)
        .then(function (spawn) {
          if (state.selectedName !== name) return;
          applySpawnMeta(spawn, fallbackCity);
          writeSpawnCache();
          renderPins();
          centerCamOnSpawn(spawn);
        })
        .catch(function (err) {
          if (state.selectedName !== name) return;
          mapMeta.textContent =
            "No se pudo obtener el mapa" +
            (fallbackCity && fallbackCity !== "-" ? " · Ciudad: " + fallbackCity : "");
          mapCoords.textContent = String(err.message || err);
        });
      return;
    }

    mapMeta.textContent = fallbackCity && fallbackCity !== "-" ? "Ciudad: " + fallbackCity : "…";
    mapCoords.textContent = "";
    setMapLoading(true);
    if (!lastSpawn) drawWorldMap(null);

    fetchSpawn(name)
      .then(function (spawn) {
        if (state.selectedName !== name) return;
        applySpawnMeta(spawn, fallbackCity);
        drawWorldMap(spawn);
      })
      .catch(function (err) {
        if (state.selectedName !== name) return;
        mapMeta.textContent =
          "No se pudo obtener el mapa" +
          (fallbackCity && fallbackCity !== "-" ? " · Ciudad: " + fallbackCity : "");
        mapCoords.textContent = String(err.message || err);
        drawWorldMap(null);
      })
      .finally(function () {
        if (state.selectedName === name) setMapLoading(false);
      });
  }

  function resetDesktopMap() {
    state.selectedName = null;
    state.selectedCity = null;
    syncSelectedCard();
    syncSelectedPin();
    setMapLoading(false);
    updateDesktopMapStatus();
    scheduleMapDraw();
  }

  function closeMap() {
    if (isDesktopLayout()) {
      resetDesktopMap();
      return;
    }
    setMapLoading(false);
    mapOverlay.classList.remove("is-on");
    mapOverlay.hidden = true;
    state.selectedName = null;
    state.selectedCity = null;
  }

  function syncMapChrome() {
    if (isDesktopLayout()) {
      showMapPanel();
      ensureDesktopPins();
    } else if (!state.selectedName) {
      setMapLoading(false);
      mapOverlay.classList.remove("is-on");
      mapOverlay.hidden = true;
      if (mapPins) {
        mapPins.hidden = true;
        mapPins.innerHTML = "";
      }
    } else {
      scheduleMapDraw();
    }
  }

  function buildCityChips() {
    const cities = ["all"].concat(window.CITIES || []);
    cityChipsEl.innerHTML = cities
      .map(function (c) {
        return (
          '<button type="button" class="l2-tab' +
          (c === "all" ? " active" : "") +
          '" data-city="' +
          c +
          '">' +
          (c === "all" ? "Todas" : c) +
          "</button>"
        );
      })
      .join("");
  }

  function bind() {
    $("catChips").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cat]");
      if (!btn) return;
      state.cat = btn.dataset.cat;
      $("catChips")
        .querySelectorAll(".l2-tab")
        .forEach((c) => c.classList.toggle("active", c === btn));
      render();
    });

    cityChipsEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-city]");
      if (!btn) return;
      state.city = btn.dataset.city;
      cityChipsEl
        .querySelectorAll(".l2-tab")
        .forEach((c) => c.classList.toggle("active", c === btn));
      render();
    });

    searchInput.addEventListener("input", () => {
      state.query = searchInput.value;
      render();
    });

    refreshBtn.addEventListener("click", () => {
      loadBosses({ force: true }).catch(() => {});
    });

    listEl.addEventListener("click", (e) => {
      const card = e.target.closest(".card[data-name]");
      if (!card) return;
      openMap(card.dataset.name, card.dataset.city);
    });

    listEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest(".card[data-name]");
      if (!card) return;
      e.preventDefault();
      openMap(card.dataset.name, card.dataset.city);
    });

    mapCloseBtn.addEventListener("click", closeMap);
    mapOverlay.addEventListener("click", (e) => {
      if (isDesktopLayout()) return;
      if (e.target === mapOverlay) closeMap();
    });
    mapPins.addEventListener(
      "click",
      (e) => {
        if (suppressPinClick) {
          e.preventDefault();
          e.stopPropagation();
          suppressPinClick = false;
          return;
        }
        const pin = e.target.closest(".map-pin");
        if (!pin) return;
        openMap(pin.dataset.name, pin.dataset.city, true);
      },
      true
    );
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && mapOverlay.classList.contains("is-on")) closeMap();
    });

    const desktopMq = window.matchMedia(DESKTOP_MQ);
    if (desktopMq.addEventListener) {
      desktopMq.addEventListener("change", syncMapChrome);
    } else if (desktopMq.addListener) {
      desktopMq.addListener(syncMapChrome);
    }
    window.addEventListener("resize", scheduleMapDraw);
    if (window.ResizeObserver) {
      if (mapFrame) {
        new ResizeObserver(function () {
          if (!cam.user) cam.fitted = false;
          scheduleMapDraw();
        }).observe(mapFrame);
      }
    }
    bindMapNav();
  }

  function bindMapNav() {
    if (!mapFrame) return;

    mapFrame.addEventListener(
      "wheel",
      function (e) {
        if (!isDesktopLayout()) return;
        e.preventDefault();
        const size = mapViewSize();
        if (size.cssW < 8 || size.cssH < 8) return;
        const rect = mapFrame.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const mapX = cam.x + mx / cam.scale;
        const mapY = cam.y + my / cam.scale;
        const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
        const minScale = Math.min(size.cssW / MAP_W, size.cssH / MAP_H) * 0.92;
        const maxScale = (size.cssW / MAP_W) * 8;
        cam.scale = clamp(cam.scale * factor, minScale, maxScale);
        cam.x = mapX - mx / cam.scale;
        cam.y = mapY - my / cam.scale;
        cam.fitted = true;
        cam.user = true;
        clampCam(size.cssW, size.cssH);
        scheduleMapDraw();
      },
      { passive: false }
    );

    mapFrame.addEventListener("pointerdown", function (e) {
      if (!isDesktopLayout() || e.button !== 0) return;
      e.preventDefault();
      mapDrag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        camX: cam.x,
        camY: cam.y,
        moved: false,
      };
      try {
        mapFrame.setPointerCapture(e.pointerId);
      } catch (_) {}
    });

    mapFrame.addEventListener("pointermove", function (e) {
      if (!mapDrag || e.pointerId !== mapDrag.id) return;
      const dx = e.clientX - mapDrag.x;
      const dy = e.clientY - mapDrag.y;
      if (!mapDrag.moved && dx * dx + dy * dy < 25) return;
      mapDrag.moved = true;
      suppressPinClick = true;
      cam.x = mapDrag.camX - dx / cam.scale;
      cam.y = mapDrag.camY - dy / cam.scale;
      cam.fitted = true;
      cam.user = true;
      const size = mapViewSize();
      clampCam(size.cssW, size.cssH);
      mapFrame.classList.add("is-panning");
      scheduleMapDraw();
    });

    function endDrag(e) {
      if (!mapDrag || (e && e.pointerId !== mapDrag.id)) return;
      const moved = mapDrag.moved;
      const cx = e.clientX;
      const cy = e.clientY;
      mapDrag = null;
      mapFrame.classList.remove("is-panning");
      if (moved) {
        suppressPinClick = true;
        setTimeout(function () {
          suppressPinClick = false;
        }, 0);
        return;
      }
      if (e.type !== "pointerup") return;
      const el = document.elementFromPoint(cx, cy);
      const pin = el && el.closest ? el.closest(".map-pin") : null;
      if (pin) openMap(pin.dataset.name, pin.dataset.city, true);
    }

    mapFrame.addEventListener("pointerup", endDrag);
    mapFrame.addEventListener("pointercancel", endDrag);
    mapCanvas.addEventListener("dragstart", function (e) {
      e.preventDefault();
    });
  }

  buildCityChips();
  bind();
  syncMapChrome();
  state.timer = setInterval(tickCountdowns, 1000);
  loadBosses().catch(() => {});
})();
