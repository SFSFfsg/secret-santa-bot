// Тайный Санта NF Group — Telegram Mini App.
// Все данные приходят с сервера после проверки подписи Telegram; здесь — только отображение.

const tg = window.Telegram?.WebApp;
const INIT = tg?.initData || "";
const app = document.getElementById("app");
const YEAR = new Date().getFullYear();
const state = { me: null, poll: null, festive: false };

// ---------------------------------------------------------------- утилиты
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const linkify = (escaped) => escaped.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" data-link="${u}">${u}</a>`);
const haptic = (k = "light") => { try { tg?.HapticFeedback?.impactOccurred(k); } catch {} };
const buzz = (k = "success") => { try { tg?.HapticFeedback?.notificationOccurred(k); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];

function toast(text, err = false) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("on"));
  setTimeout(() => { el.classList.remove("on"); setTimeout(() => el.remove(), 300); }, err ? 4200 : 2800);
}

function confirmBox(text) {
  try {
    if (tg?.showConfirm && tg.isVersionAtLeast?.("6.2")) return new Promise((r) => tg.showConfirm(text, r));
  } catch {}
  return Promise.resolve(window.confirm(text));
}

function modal(html) {
  const el = document.createElement("div");
  el.className = "modal";
  el.innerHTML = `<div class="sheet">${html}<button class="btn" data-close style="margin-top:18px">Понятно</button></div>`;
  el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-close]")) el.remove(); });
  document.body.appendChild(el);
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { authorization: `tma ${INIT}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("Нет связи с сервером. Проверьте интернет и попробуйте ещё раз."), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || "Что-то пошло не так. Попробуйте ещё раз."), { status: res.status, code: data?.code });
  return data;
}

// ---------------------------------------------------------------- даты
const TIMEZONES = [
  ["Europe/Kaliningrad", "Калининград (UTC+2)"], ["Europe/Moscow", "Москва (UTC+3)"], ["Europe/Samara", "Самара (UTC+4)"],
  ["Asia/Yekaterinburg", "Екатеринбург (UTC+5)"], ["Asia/Omsk", "Омск (UTC+6)"], ["Asia/Novosibirsk", "Новосибирск (UTC+7)"],
  ["Asia/Krasnoyarsk", "Красноярск (UTC+7)"], ["Asia/Irkutsk", "Иркутск (UTC+8)"], ["Asia/Yakutsk", "Якутск (UTC+9)"],
  ["Asia/Vladivostok", "Владивосток (UTC+10)"], ["Asia/Magadan", "Магадан (UTC+11)"], ["Asia/Kamchatka", "Камчатка (UTC+12)"],
  ["Asia/Dubai", "Дубай (UTC+4)"], ["Asia/Makassar", "Бали (UTC+8)"], ["Asia/Nicosia", "Кипр (UTC+2/+3)"], ["Europe/Istanbul", "Стамбул (UTC+3)"],
];
const fmt = (ms, tz, opts) => new Intl.DateTimeFormat("ru-RU", { timeZone: tz, ...opts }).format(new Date(ms));
const fmtFull = (ms, tz) => fmt(ms, tz, { day: "numeric", month: "long", weekday: "short", hour: "2-digit", minute: "2-digit" });
const fmtShort = (ms, tz) => fmt(ms, tz, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
function parts(ms, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}
const toInput = (ms, tz) => { const p = parts(ms, tz); return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`; };
function daysLeft(ms, tz) {
  const a = parts(Date.now(), tz), b = parts(ms, tz);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
}
const plural = (n, f) => { const a = Math.abs(n); return a % 10 === 1 && a % 100 !== 11 ? f[0] : a % 10 >= 2 && a % 10 <= 4 && !(a % 100 >= 12 && a % 100 <= 14) ? f[1] : f[2]; };
function countdown(g) {
  if (g.status === "revealed") return "";
  const d = daysLeft(g.exchange_at, g.timezone);
  if (d > 1) return `⏳ До сделки ${d} ${plural(d, ["день", "дня", "дней"])}`;
  if (d === 1) return "⏳ Сделка завтра!";
  if (d === 0) return "🎉 Сделка сегодня!";
  return "";
}
function defaultExchange() {
  const now = new Date();
  let y = now.getFullYear();
  if (now.getMonth() === 11 && now.getDate() >= 24) y++;
  return `${y}-12-26T18:00`;
}

// ---------------------------------------------------------------- графика
let svgId = 0;
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function skyline(seed = 7) {
  const r = rng(seed);
  const base = 292;
  const towers = [[18, 64, 110], [90, 54, 150], [152, 96, 200], [256, 60, 160], [324, 80, 118], [412, 58, 178], [478, 92, 134]];
  let wins = "", body = "";
  for (const [x, w, h] of towers) {
    const top = base - h;
    body += `<rect x="${x}" y="${top}" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="1"/>`;
    for (let wy = top + 14; wy < base - 12; wy += 16)
      for (let wx = x + 9; wx < x + w - 10; wx += 13) wins += `<rect class="win${r() < 0.3 ? " lit" : ""}" x="${wx}" y="${wy}" width="5" height="8"/>`;
  }
  const [tx, tw, th] = towers[2];
  const cx = tx + tw / 2, ty = base - th - 40;
  let snow = "";
  for (let i = 0; i < 40; i++) { const rr = r() < 0.7 ? 1 : 1.6; snow += `<circle cx="${(r() * 600).toFixed(0)}" cy="${(10 + r() * 250).toFixed(0)}" r="${rr}" fill="currentColor" opacity="0.35"/>`; }
  return `<svg class="skyline" viewBox="0 0 600 300" role="img" aria-label="Ночной деловой квартал, на самой высокой башне — шапка Санты" style="color:var(--beige)">
    ${snow}${body}${wins}
    <line x1="${cx}" y1="${base - th}" x2="${cx}" y2="${ty}" stroke="currentColor"/>
    <g class="hat" data-egg="hat">
      <path d="M${cx - 20} ${ty + 10} L${cx + 20} ${ty + 10} L${cx + 30} ${ty - 30} L${cx + 4} ${ty - 22} Z" fill="#C8102E"/>
      <rect x="${cx - 24}" y="${ty + 4}" width="48" height="12" rx="6" fill="#fff"/>
      <circle cx="${cx + 31}" cy="${ty - 31}" r="7" fill="#fff"/>
      <rect x="${cx - 34}" y="${ty - 44}" width="76" height="64" fill="transparent"/>
    </g>
    <line x1="0" y1="${base}" x2="600" y2="${base}" stroke="currentColor"/>
  </svg>`;
}

function stamp(cls = "stamp") {
  const id = ++svgId;
  return `<svg class="${cls}" viewBox="0 0 220 220" aria-hidden="true">
    <defs><path id="st${id}" d="M 40 110 A 70 70 0 0 1 180 110"/><path id="sb${id}" d="M 30 110 A 80 80 0 0 0 190 110"/></defs>
    <g fill="none" stroke="#C8102E"><circle cx="110" cy="110" r="104" stroke-width="5"/><circle cx="110" cy="110" r="90" stroke-width="1.5"/></g>
    <g fill="#C8102E" font-family="Montserrat, sans-serif">
      <text font-size="16" font-weight="500" letter-spacing="3"><textPath href="#st${id}" startOffset="50%" text-anchor="middle">СОГЛАСОВАНО</textPath></text>
      <text font-size="13" letter-spacing="2"><textPath href="#sb${id}" startOffset="50%" text-anchor="middle">СЕВЕРНЫЙ ПОЛЮС</textPath></text>
      <text x="110" y="124" text-anchor="middle" font-size="36" font-weight="500" letter-spacing="4">NF</text>
    </g></svg>`;
}

function snowfall(n = 26) {
  const box = document.getElementById("snow");
  if (!box) return;
  box.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const f = document.createElement("i");
    const s = 2 + Math.random() * 2.5;
    f.style.cssText = `left:${Math.random() * 100}%;width:${s}px;height:${s}px;animation-duration:${9 + Math.random() * 10}s;animation-delay:${-Math.random() * 18}s;--dx:${(Math.random() * 60 - 30).toFixed(0)}px`;
    box.appendChild(f);
  }
}

// ---------------------------------------------------------------- пасхалки
const DUE_DILIGENCE = `<div class="eyebrow">NF Research</div><h3 class="h-thin sm" style="color:var(--navy)">Due diligence Санты</h3>
  <p>• Обременения: не выявлены<br>• Мешок с подарками: в собственности, не в залоге<br>• Олени: на балансе, техосмотр пройден<br>• Судебные споры: один, с Гринчем, урегулирован<br>• Риск-профиль: низкий</p>
  <p class="small"><i>Заключение: сделку рекомендуем к закрытию. Личность Санты — коммерческая тайна 🤫</i></p>`;

const IDEAS = [
  "☕ Хорошая кофейная кружка + пачка зернового кофе — классика класса А.",
  "📚 Книга, о которой подопечный упоминал на кухне или в курилке.",
  "🧦 Тёплые носки с оленями — ликвидный актив сезона.",
  "🪴 Растение в горшке: озеленение рабочего места повышает капитализацию.",
  "🎲 Настольная игра для пятничных вечеров в офисе.",
  "🍫 Набор крафтового шоколада — высокая доходность при низких рисках.",
  "🕯 Ароматическая свеча (только если в ТЗ нет запрета на свечи!).",
  "🎧 Чехол для наушников или подставка под телефон — инфраструктура рабочего места.",
  "🧩 Пазл с панорамой Москва-Сити — на случай, если подопечный скучает по объектам.",
  "🍵 Чайный набор с дегустационной картой.",
  "📓 Красивый блокнот для записи сделок и новогодних планов.",
  "🔋 Пауэрбанк — чтобы презентация объекта не села в самый важный момент.",
  "🧣 Шарф в фирменных тёмно-синих тонах — дресс-код соблюдён.",
  "🍊 Ящик мандаринов: спрос стабильно превышает предложение.",
  "🖼 Постер с планировкой вымышленного пентхауса мечты.",
  "🎟 Сертификат на мастер-класс — инвестиция в нематериальные активы.",
  "🧸 Мягкая игрушка-талисман для переговорной.",
  "🌶 Набор соусов для смелых — для тех, кто любит рынок поострее.",
];

function bindEggs() {
  const wm = $(".wordmark");
  if (wm) {
    let t;
    const start = () => { t = setTimeout(() => { buzz(); modal(DUE_DILIGENCE); }, 700); };
    const stop = () => clearTimeout(t);
    wm.addEventListener("pointerdown", start);
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => wm.addEventListener(ev, stop));
  }
  const hat = $("[data-egg=hat]");
  if (hat) {
    let taps = 0, timer;
    hat.addEventListener("click", () => {
      haptic();
      taps++;
      clearTimeout(timer);
      timer = setTimeout(() => (taps = 0), 2500);
      if (taps >= 5) {
        taps = 0;
        state.festive = !state.festive;
        $$(".skyline").forEach((s) => s.classList.toggle("festive", state.festive));
        snowfall(state.festive ? 90 : 26);
        buzz();
        toast(state.festive ? "🎄 Режим «Новогодний квартал»: все окна горят!" : "Квартал вернулся к рабочему режиму");
      }
    });
    if (state.festive) $$(".skyline").forEach((s) => s.classList.add("festive"));
  }
}

// ---------------------------------------------------------------- каркас страницы
const STATUS = { open: ["Идёт набор", ""], drawn: ["Сделки закрыты", "ok"], revealed: ["Карты раскрыты", "warn"] };
const statusChip = (s) => `<span class="chip ${STATUS[s]?.[1] ?? ""}">${STATUS[s]?.[0] ?? s}</span>`;

function page(label, html, footer = true) {
  return `<header class="topbar"><span class="wordmark" title="NF GROUP">NF GROUP</span><span class="label">${esc(label)}</span></header>${html}
    ${footer ? '<div class="footer">Конфиденциально · только для резидентов</div>' : ""}`;
}

function lotCard(g, members) {
  const cd = countdown(g);
  return `<div class="card">
    <div class="eyebrow">Лот № ${String(g.id).padStart(4, "0")}</div>
    <h1 class="h-thin sm">${esc(g.title)}</h1>
    <div class="row wrap">${statusChip(g.status)}${cd ? `<span class="small">${esc(cd)}</span>` : ""}</div>
    <div class="specs">
      <div><div class="k">Бюджет</div><div class="v">${esc(g.budget)}</div></div>
      <div><div class="k">Дата сделки</div><div class="v">${esc(fmtShort(g.exchange_at, g.timezone))}</div></div>
      ${members !== undefined ? `<div><div class="k">Резидентов</div><div class="v">${members}</div></div>` : ""}
    </div>
    ${g.place ? `<div class="small muted" style="margin-top:10px">📍 ${esc(g.place)}</div>` : ""}
    ${g.status === "open" && g.draw_at ? `<div class="small muted">🎲 Жеребьёвка: ${esc(fmtFull(g.draw_at, g.timezone))}</div>` : ""}
  </div>`;
}

function errorView(e) {
  app.innerHTML = page("Ошибка", `<div class="card"><div class="eyebrow">Что-то пошло не так</div><p>${esc(e.message)}</p>
    <button class="btn ghost" data-go="/">На главную</button></div>`);
}

// ---------------------------------------------------------------- роутер
const routes = [];
const route = (re, fn) => routes.push([re, fn]);
const go = (path) => { haptic(); location.hash = "#" + path; };
function parentOf(path) {
  if (/^\/game\/\d+\/.+/.test(path)) return path.replace(/^(\/game\/\d+).*$/, "$1");
  return "/";
}

async function render() {
  clearInterval(state.poll);
  const path = location.hash.slice(1) || "/";
  try {
    if (tg?.BackButton) path === "/" ? tg.BackButton.hide() : tg.BackButton.show();
  } catch {}
  for (const [re, fn] of routes) {
    const m = re.exec(path);
    if (!m) continue;
    try {
      await fn(...m.slice(1));
      bindEggs();
    } catch (e) {
      errorView(e);
    }
    window.scrollTo(0, 0);
    return;
  }
  go("/");
}

app.addEventListener("click", (e) => {
  const link = e.target.closest("[data-link]");
  if (link) {
    e.preventDefault();
    try { tg?.openLink ? tg.openLink(link.dataset.link) : window.open(link.dataset.link, "_blank"); } catch {}
    return;
  }
  const el = e.target.closest("[data-go]");
  if (el) { e.preventDefault(); go(el.dataset.go); }
});

function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = "…"; } else if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
}

async function action(btn, fn) {
  busy(btn, true);
  try { await fn(); } catch (e) { buzz("error"); toast(e.message, true); } finally { busy(btn, false); }
}

// ---------------------------------------------------------------- главная
route(/^\/$/, async () => {
  const me = (state.me = await api("GET", "/api/me"));
  const active = me.games.filter((g) => g.status !== "revealed");
  const done = me.games.filter((g) => g.status === "revealed");
  const card = (g) => `<div class="card tap" data-go="/game/${g.id}">
      <div class="row between"><div class="card-title grow">${esc(g.title)}</div>${g.is_organizer ? '<span class="chip red">Организатор</span>' : ""}</div>
      <div class="row wrap small muted" style="margin-top:8px">${statusChip(g.status)}<span>📅 ${esc(fmtShort(g.exchange_at, g.timezone))}</span><span>👥 ${g.members}</span></div>
    </div>`;
  app.innerHTML = page(`Secret Santa · ${YEAR}`, `
    <div class="hero">${skyline(YEAR)}</div>
    <div class="eyebrow" style="margin-top:18px">Новогодний проект</div>
    <h1 class="h-thin">Тайный Санта</h1>
    <div class="sub">Объект класса А+ для обмена подарками</div>
    <p style="margin:18px 0 6px">Привет, ${esc(me.user.name)}! 🎅</p>
    <div class="h2">Мои игры</div>
    ${active.length ? active.map(card).join("") : `<div class="empty">Пока нет активных игр.<br>${me.can_create ? "Откройте свой лот или вступите по приглашению." : "Попросите у организатора ссылку-приглашение."}</div>`}
    ${me.can_create ? `<button class="btn" data-go="/new">＋ Открыть новый лот</button>` : ""}
    <div class="card" style="margin-top:18px">
      <div class="eyebrow">Вступить по коду</div>
      <div class="row"><input class="input grow" id="code" placeholder="Код или ссылка-приглашение" autocomplete="off"><button class="btn small" id="join-go">Открыть</button></div>
    </div>
    ${done.length ? `<div class="h2">Завершённые</div>${done.map(card).join("")}` : ""}
    <button class="btn ghost" data-go="/ideas">💡 Идея подарка</button>
  `);
  $("#join-go").onclick = () => {
    const v = $("#code").value.trim();
    const m = /join_([A-Za-z0-9]{6,20})/.exec(v) || /^([A-Za-z0-9]{6,20})$/.exec(v);
    if (!m) return toast("Не похоже на код приглашения", true);
    go(`/join/${m[1]}`);
  };
});

// ---------------------------------------------------------------- новая игра
route(/^\/new$/, async () => {
  const me = state.me || (state.me = await api("GET", "/api/me"));
  if (!me.can_create) throw new Error("Открывать игры могут только организаторы.");
  app.innerHTML = page("Новый лот", `
    <div class="eyebrow">Открытие лота</div>
    <h1 class="h-thin sm">Новая игра</h1>
    <div class="field"><label>1 · Название</label><input class="input" id="title" maxlength="80" placeholder="Тайный Санта NF Group ${YEAR}"></div>
    <div class="field"><label>2 · Бюджет подарка</label><input class="input" id="budget" maxlength="120" placeholder="до 3000 ₽"></div>
    <div class="field"><label>3 · Дата и время вручения</label><input class="input" type="datetime-local" id="exchange" value="${defaultExchange()}"></div>
    <div class="field"><label>4 · Место вручения</label><input class="input" id="place" maxlength="120" placeholder="Переговорная на 5 этаже"></div>
    <div class="field"><label>Часовой пояс игры</label><select class="select" id="tz">${TIMEZONES.map(([v, l]) => `<option value="${v}" ${v === "Europe/Moscow" ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="field"><label>5 · Жеребьёвка</label>
      <label class="toggle"><input type="checkbox" id="auto"> Провести автоматически в назначенное время</label>
      <input class="input" type="datetime-local" id="draw" style="display:none;margin-top:10px">
      <div class="hint">Без галочки вы проведёте жеребьёвку сами кнопкой в кабинете организатора. За сутки до автожеребьёвки бот напомнит тем, кто не заполнил ТЗ.</div>
    </div>
    <div class="divider"></div>
    <label class="toggle"><input type="checkbox" id="join" checked> Я тоже участвую в обмене</label>
    <div id="join-box" style="margin-top:12px">
      <div class="field"><label>Ваше имя для коллег</label><input class="input" id="oname" maxlength="64" value="${esc(me.user.name)}"></div>
      <div class="field"><label>Ваше ТЗ для Санты</label><textarea class="textarea" id="owish" maxlength="1500" placeholder="Что хотели бы получить, а что дарить не стоит"></textarea></div>
    </div>
    <button class="btn" id="create">Открыть лот</button>
  `);
  $("#auto").onchange = (e) => ($("#draw").style.display = e.target.checked ? "block" : "none");
  $("#join").onchange = (e) => ($("#join-box").style.display = e.target.checked ? "block" : "none");
  $("#create").onclick = (e) => action(e.currentTarget, async () => {
    const join = $("#join").checked;
    const res = await api("POST", "/api/games", {
      title: $("#title").value, budget: $("#budget").value, place: $("#place").value, timezone: $("#tz").value,
      exchange_local: $("#exchange").value, draw_local: $("#auto").checked ? $("#draw").value || "invalid" : null,
      join, organizer_name: $("#oname").value, wishlist: $("#owish").value,
    });
    buzz();
    toast("🏢 Лот открыт! Пригласите коллег");
    go(`/game/${res.id}/admin`);
  });
});

// ---------------------------------------------------------------- приглашение
route(/^\/join\/([A-Za-z0-9]+)$/, async (code) => {
  const inv = await api("GET", `/api/invite/${code}`);
  const g = inv.game;
  const me = state.me || (state.me = await api("GET", "/api/me"));
  let body;
  if (inv.already) body = `<p>Вы уже в этой игре 🙂</p><button class="btn" data-go="/game/${g.id}">Открыть игру</button>`;
  else if (g.status !== "open") body = `<p>⏰ Жеребьёвка уже прошла — присоединиться нельзя. Напишите организатору.</p>`;
  else body = `
    <div class="field"><label>Как вас представить коллегам</label><input class="input" id="name" maxlength="64" value="${esc(me.user.name)}"></div>
    <div class="field"><label>Ваше ТЗ для Санты</label>
      <textarea class="textarea" id="wish" maxlength="1500" placeholder="Что хотели бы получить, а что дарить точно не стоит. Можно ссылками."></textarea>
      <div class="chips">${["книги", "кофе", "настолки", "сладкое", "не дарить свечи"].map((c) => `<span class="chip" data-chip="${c}">+ ${c}</span>`).join("")}</div>
      <div class="hint">ТЗ увидит только ваш Тайный Санта. Его можно изменить в любой момент или заполнить позже.</div>
    </div>
    <button class="btn" id="join">Подписать договор участия</button>`;
  app.innerHTML = page("Приглашение", `
    <div class="hero">${skyline(g.id)}</div>
    <div class="eyebrow" style="margin-top:18px">Эксклюзивное предложение</div>
    ${lotCard(g, inv.members)}
    ${body}`);
  bindChips("#wish");
  const btn = $("#join");
  if (btn) btn.onclick = (e) => action(e.currentTarget, async () => {
    const r = await api("POST", `/api/invite/${code}/join`, { name: $("#name").value, wishlist: $("#wish").value });
    buzz();
    toast(r.lucky13 ? "🍀 Вы — резидент № 13. Аналитики подтверждают: это к удаче!" : r.luxury ? "💼 Запрос передан в департамент элитной недвижимости 😉" : "🎉 Договор подписан! Вы в игре");
    go(`/game/${r.id}`);
  });
});

function bindChips(target) {
  $$("[data-chip]").forEach((ch) => (ch.onclick = () => {
    const ta = $(target);
    if (!ta) return;
    ta.value = (ta.value.trim() ? ta.value.trim() + ", " : "") + ch.dataset.chip;
    haptic();
  }));
}

// ---------------------------------------------------------------- игра
route(/^\/game\/(\d+)$/, async (id) => {
  const v = await api("GET", `/api/games/${id}`);
  const g = v.game, me = v.me;
  const results = g.status === "revealed" ? await api("GET", `/api/games/${id}/results`) : null;
  const unread = v.unread || { recipient: 0, santa: 0 };
  const badge = (n) => (n ? `<span class="badge">${n}</span>` : "");
  let html = lotCard(g, v.counts.members);

  if (v.is_organizer) {
    html += `<button class="btn ghost" data-go="/game/${id}/admin">⚙️ Кабинет организатора</button>`;
    if (g.status === "open") html += inviteBlock(v);
  }
  if (results && me) {
    const verdict = results.guessed === true ? "🎯 Вы угадали — аналитик года!" : results.guessed === false ? "🕶 Не угадали — конспирация класса А+!" : "Вы не делали прогноз — рынок непредсказуем 🙂";
    html += `<div class="h2">Итоги</div>
      <div class="flip" id="flip"><div class="flip-inner">
        <div class="card flip-face" style="display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;cursor:pointer">
          <div class="eyebrow">Раскрытие информации</div><div class="h-thin sm">Due diligence завершён</div><div class="muted small">Нажмите, чтобы узнать своего Санту</div></div>
        <div class="card light flip-face flip-back">
          <div class="eyebrow">Ваш Тайный Санта</div>
          <div class="doc-name" style="padding-right:0">${esc(results.my_santa ?? "—")}</div>
          <p>${esc(verdict)}</p></div>
      </div></div>
      ${nominationsCard(results.nominations)}
      <div class="btn-row"><button class="btn ghost" data-go="/game/${id}/chat/santa">🙏 Спасибо Санте ${badge(unread.santa)}</button><button class="btn ghost" data-go="/game/${id}/chat/recipient">💌 Подопечному ${badge(unread.recipient)}</button></div>`;
  } else if (me && g.status === "drawn") {
    html += `<div class="h2">Сделка</div>
      <button class="btn" data-go="/game/${id}/recipient">🎯 Мой подопечный</button>
      <div class="btn-row"><button class="btn ghost" data-go="/game/${id}/chat/recipient">💌 Подопечному ${badge(unread.recipient)}</button><button class="btn ghost" data-go="/game/${id}/chat/santa">🎅 Своему Санте ${badge(unread.santa)}</button></div>
      <div class="card" style="margin-top:14px"><label class="toggle"><input type="checkbox" id="ready" ${me.gift_ready ? "checked" : ""}> <span>🎁 Подарок готов</span></label>
        <div class="hint">Подопечный получит «инсайд», что подарок уже ждёт его. Ваше имя не раскрывается.</div></div>
      <div class="btn-row"><button class="btn ghost" data-go="/game/${id}/guess">🕵️ Угадать Санту</button><button class="btn ghost" data-go="/ideas">💡 Идея подарка</button></div>`;
  } else if (me) {
    html += `<div class="card"><div class="eyebrow">Статус</div><p>Ждём жеребьёвку${g.draw_at ? ` — ${esc(fmtFull(g.draw_at, g.timezone))}` : ""}. Когда она пройдёт, здесь появится ваш подопечный, а бот пришлёт уведомление.</p></div>`;
  }
  if (me) {
    html += `<div class="h2">Моё ТЗ для Санты</div>
      <div class="card tap" data-go="/game/${id}/wishlist">
        ${me.wishlist.trim() ? `<div class="pre">${linkify(esc(me.wishlist))}</div>` : `<div class="muted">ТЗ пока не заполнено — Санте будет сложнее 😉</div>`}
        <div class="sub" style="margin-top:10px">✏️ Изменить</div></div>
      <div class="card"><div class="row between"><div><div class="sub">Вы участвуете как</div><div style="font-weight:400">${esc(me.name)}</div></div><button class="btn small ghost" id="rename">Изменить</button></div></div>`;
    if (g.status === "open" && !v.is_organizer) html += `<button class="btn danger" id="leave">Выйти из игры</button>`;
  }
  app.innerHTML = page(`Лот № ${String(g.id).padStart(4, "0")}`, html);

  const flip = $("#flip");
  if (flip) flip.onclick = () => { flip.classList.toggle("flipped"); haptic("medium"); };
  const ready = $("#ready");
  if (ready) ready.onchange = async () => {
    try { await api("PATCH", `/api/games/${id}/me`, { gift_ready: ready.checked }); buzz(); toast(ready.checked ? "🎁 Отмечено! Индекс готовности растёт" : "Вернули статус «в работе»"); }
    catch (e) { ready.checked = !ready.checked; toast(e.message, true); }
  };
  const rename = $("#rename");
  if (rename) rename.onclick = async () => {
    const name = window.prompt("Как вас представить коллегам?", me.name);
    if (name === null) return;
    try { await api("PATCH", `/api/games/${id}/me`, { name }); toast("✅ Имя обновлено"); render(); } catch (e) { toast(e.message, true); }
  };
  const leave = $("#leave");
  if (leave) leave.onclick = async () => {
    if (!(await confirmBox("Точно выйти из игры? Ваше ТЗ будет удалено."))) return;
    action(leave, async () => { await api("DELETE", `/api/games/${id}/me`); toast("Вы вышли из игры"); go("/"); });
  };
  bindInvite(v);
});

function inviteBlock(v) {
  const link = v.invite?.link;
  return `<div class="card"><div class="eyebrow">Приглашение коллегам</div>
    ${link ? `<div class="input small" style="word-break:break-all;user-select:all">${esc(link)}</div>
      <div class="btn-row"><button class="btn ghost" id="copy">Скопировать</button><button class="btn" id="share">Отправить в чат</button></div>`
    : `<p class="small muted">Бот ещё не подключён — ссылка появится после настройки.</p>`}</div>`;
}

function bindInvite(v) {
  const link = v.invite?.link;
  if (!link) return;
  const copy = $("#copy"), share = $("#share");
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast("Ссылка скопирована"); } catch { toast("Выделите ссылку и скопируйте вручную", true); }
  };
  if (share) share.onclick = () => {
    const text = `🎅 Приглашаю в Тайного Санту «${v.game.title}»! Бюджет: ${v.game.budget}. Жмите, чтобы участвовать:`;
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    try { tg?.openTelegramLink ? tg.openTelegramLink(url) : window.open(url, "_blank"); } catch { window.open(url, "_blank"); }
  };
}

function nominationsCard(n) {
  if (!n) return "";
  return `<div class="card light"><div class="eyebrow">Номинации года</div>
    <p>🎯 <b>Аналитики года</b> (угадали Санту): ${n.analysts.length ? esc(n.analysts.join(", ")) : "рынок оказался непредсказуем"}</p>
    ${n.masters.length ? `<p>🕶 <b>Мастера конспирации</b>: ${esc(n.masters.join(", "))}</p>` : ""}
    ${n.broker ? `<p>💬 <b>Брокер года</b>: ${esc(n.broker.name)} — ${n.broker.messages} ${plural(n.broker.messages, ["сообщение", "сообщения", "сообщений"])}</p>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- ТЗ для Санты
route(/^\/game\/(\d+)\/wishlist$/, async (id) => {
  const v = await api("GET", `/api/games/${id}`);
  if (!v.me) throw new Error("Вы не участвуете в этой игре.");
  app.innerHTML = page("Моё ТЗ", `
    <div class="eyebrow">Техническое задание</div>
    <h1 class="h-thin sm">Моё ТЗ для Санты</h1>
    <p class="small muted">Что хотели бы получить, а что дарить точно не стоит. Видит только ваш Тайный Санта — организатор видит лишь, что ТЗ заполнено.</p>
    <textarea class="textarea" id="wish" maxlength="1500" style="min-height:200px">${esc(v.me.wishlist)}</textarea>
    <div class="row between small muted"><span id="cnt"></span><span>до 1500 символов</span></div>
    <div class="chips">${["книги", "кофе", "чай", "настолки", "сладкое", "не дарить свечи", "не дарить алкоголь"].map((c) => `<span class="chip" data-chip="${c}">+ ${c}</span>`).join("")}</div>
    <button class="btn" id="save">Сохранить</button>`);
  const ta = $("#wish"), cnt = $("#cnt");
  const upd = () => (cnt.textContent = ta.value.trim() ? `Заполнено: ${ta.value.length} симв.` : "Пока пусто");
  ta.oninput = upd; upd();
  bindChips("#wish");
  $$("[data-chip]").forEach((c) => c.addEventListener("click", upd));
  $("#save").onclick = (e) => action(e.currentTarget, async () => {
    const r = await api("PATCH", `/api/games/${id}/me`, { wishlist: ta.value });
    buzz();
    toast(r.luxury ? "💼 Запрос передан в департамент элитной недвижимости. Но бюджет, напоминаем, согласован 😉" : "📝 ТЗ сохранено");
    go(`/game/${id}`);
  });
});

// ---------------------------------------------------------------- подопечный
route(/^\/game\/(\d+)\/recipient$/, async (id) => {
  const [v, r] = await Promise.all([api("GET", `/api/games/${id}`), api("GET", `/api/games/${id}/recipient`)]);
  const g = v.game;
  let opened = false;
  try { opened = sessionStorage.getItem(`opened:${id}`) === "1"; } catch {}
  app.innerHTML = page(`Договор № ${esc(r.contract)}`, `
    <div class="card light" style="min-height:300px">
      ${stamp()}
      <div class="eyebrow">Сделка закрыта</div>
      <div class="sub" style="padding-right:96px">Вы — Тайный Санта для</div>
      <div class="doc-name">${esc(r.name)}</div>
      <div class="specs">
        <div><div class="k">Бюджет</div><div class="v">${esc(g.budget)}</div></div>
        <div><div class="k">Дата сделки</div><div class="v">${esc(fmtShort(g.exchange_at, g.timezone))}</div></div>
      </div>
      ${g.place ? `<div class="small" style="margin-top:10px">📍 ${esc(g.place)}</div>` : ""}
      <div class="sub" style="margin-top:14px">Гриф · строго конфиденциально</div>
      <div class="secret-cover ${opened ? "gone" : ""}" id="cover"><div class="lock">🔒</div><div class="eyebrow" style="margin:0">Строго конфиденциально</div><div class="small muted">Убедитесь, что никто не смотрит в экран, и нажмите</div></div>
    </div>
    <div class="h2">ТЗ подопечного</div>
    <div class="card">${r.wishlist.trim() ? `<div class="pre">${linkify(esc(r.wishlist))}</div>` : `<div class="muted">Подопечный пока не заполнил ТЗ. Задайте вопрос анонимно — или вдохновитесь идеями.</div>`}</div>
    <div class="btn-row"><button class="btn" data-go="/game/${id}/chat/recipient">💌 Написать</button><button class="btn ghost" data-go="/ideas">💡 Идея</button></div>
    ${v.me && g.status === "drawn" ? `<div class="card" style="margin-top:14px"><label class="toggle"><input type="checkbox" id="ready" ${v.me.gift_ready ? "checked" : ""}> 🎁 Подарок готов</label></div>` : ""}`);
  const cover = $("#cover");
  cover.onclick = () => { cover.classList.add("gone"); buzz(); try { sessionStorage.setItem(`opened:${id}`, "1"); } catch {} };
  const ready = $("#ready");
  if (ready) ready.onchange = async () => {
    try { await api("PATCH", `/api/games/${id}/me`, { gift_ready: ready.checked }); buzz(); toast(ready.checked ? "🎁 Отмечено!" : "Вернули статус «в работе»"); }
    catch (e) { ready.checked = !ready.checked; toast(e.message, true); }
  };
});

// ---------------------------------------------------------------- анонимный чат
route(/^\/game\/(\d+)\/chat\/(recipient|santa)$/, async (id, thread) => {
  const first = await api("GET", `/api/games/${id}/chat/${thread}`);
  const title = thread === "recipient" ? `Подопечный: ${first.counterpart ?? ""}` : first.revealed && first.counterpart ? `Ваш Санта: ${first.counterpart}` : "Ваш Тайный Санта";
  const note = thread === "recipient" ? (first.revealed ? "Карты раскрыты — теперь подопечный знает, кто вы." : "Ваше имя скрыто: подопечный видит только «Ваш Тайный Санта».")
    : first.revealed ? "Карты раскрыты. Самое время сказать спасибо 🙏" : "Кто это — коммерческая тайна до раскрытия карт. Подскажите размер, любимый цвет или что точно не дарить.";
  app.innerHTML = page("Анонимные переговоры", `
    <div class="eyebrow">${thread === "recipient" ? "Переговоры с подопечным" : "Переговоры с Сантой"}</div>
    <h1 class="h-thin sm">${esc(title)}</h1>
    <p class="small muted">${esc(note)}</p>
    <div class="chat" id="chat"></div>
    <div class="composer"><div class="inner"><textarea class="textarea" id="text" maxlength="1000" placeholder="Сообщение…" rows="1"></textarea><button class="btn" id="send">➤</button></div></div>`, false);
  const box = $("#chat");
  let last = 0;
  const add = (msgs) => {
    for (const m of msgs) {
      last = Math.max(last, m.id);
      const el = document.createElement("div");
      el.className = `bubble ${m.mine ? "me" : "them"}`;
      el.innerHTML = `${linkify(esc(m.text))}<time>${esc(new Date(m.at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</time>`;
      box.appendChild(el);
    }
    if (msgs.length) window.scrollTo(0, document.body.scrollHeight);
  };
  if (!first.messages.length) box.innerHTML = `<div class="empty" id="empty">Сообщений пока нет. Начните переговоры первым 🤝</div>`;
  add(first.messages);
  const refresh = async () => {
    try {
      const r = await api("GET", `/api/games/${id}/chat/${thread}?after=${last}`);
      if (r.messages.length) { $("#empty")?.remove(); add(r.messages); }
    } catch {}
  };
  state.poll = setInterval(refresh, 4000);
  const ta = $("#text");
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; };
  $("#send").onclick = (e) => {
    const text = ta.value.trim();
    if (!text) return;
    action(e.currentTarget, async () => {
      await api("POST", `/api/games/${id}/chat/${thread}`, { text });
      ta.value = ""; ta.style.height = "";
      haptic();
      $("#empty")?.remove();
      await refresh();
    });
  };
});

// ---------------------------------------------------------------- угадай Санту
route(/^\/game\/(\d+)\/guess$/, async (id) => {
  const [v, people] = await Promise.all([api("GET", `/api/games/${id}`), api("GET", `/api/games/${id}/people`)]);
  if (!v.me) throw new Error("Вы не участвуете в этой игре.");
  if (v.game.status === "revealed") return go(`/game/${id}`);
  const others = people.filter((p) => p.id !== v.me.id);
  app.innerHTML = page("Аналитика", `
    <div class="eyebrow">NF Research</div>
    <h1 class="h-thin sm">Кто ваш Тайный Санта?</h1>
    <p class="small muted">Вспомните стиль сообщений, подсказки в подарке, подозрительные взгляды у кофемашины… Прогноз можно менять до раскрытия карт.</p>
    <div class="list">${others.map((p) => `<div class="item tap" data-guess="${p.id}" style="cursor:pointer"><span class="grow">${esc(p.name)}</span>${v.me.guess_id === p.id ? '<span class="chip red">Мой прогноз</span>' : ""}</div>`).join("")}</div>`);
  $$("[data-guess]").forEach((el) => (el.onclick = async () => {
    try {
      await api("POST", `/api/games/${id}/guess`, { participant_id: Number(el.dataset.guess) });
      buzz();
      toast("📈 Прогноз принят. Посмотрим, подтвердит ли рынок");
      render();
    } catch (e) { toast(e.message, true); }
  }));
});

// ---------------------------------------------------------------- кабинет организатора
route(/^\/game\/(\d+)\/admin$/, async (id) => {
  const v = await api("GET", `/api/games/${id}`);
  if (!v.is_organizer) throw new Error("Это может сделать только организатор.");
  const g = v.game;
  const [members, exclusions] = await Promise.all([
    api("GET", `/api/games/${id}/members`),
    g.status === "open" ? api("GET", `/api/games/${id}/exclusions`) : Promise.resolve([]),
  ]);
  const c = v.counts;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const memberRow = (m) => `<div class="item"><span class="grow">${esc(m.name)}${m.is_organizer ? ' <span class="chip">вы</span>' : ""}</span>
      <span class="small" title="${m.has_wishlist ? "ТЗ заполнено" : "ТЗ пустое"}">${m.has_wishlist ? "📝" : "⏳"}</span>
      ${m.reachable ? "" : '<span class="small" title="Бот не сможет написать — пусть откроет бота">📵</span>'}
      ${g.status === "open" ? `<button class="icon-btn" data-kick="${m.id}" data-name="${esc(m.name)}" aria-label="Удалить">✕</button>` : ""}</div>`;
  let html = `<div class="eyebrow">Кабинет организатора</div><h1 class="h-thin sm">Управление лотом</h1>${lotCard(g, c.members)}`;
  if (g.status === "open") html += inviteBlock(v);
  html += `<div class="card"><div class="eyebrow">Сводка</div>
      <div class="specs">
        <div><div class="k">ТЗ заполнили</div><div class="v">${c.wishlists} из ${c.members}</div></div>
        ${g.status !== "open" ? `<div><div class="k">Подарки готовы</div><div class="v">${pct(c.ready, c.members)}%</div></div><div><div class="k">Прогнозы</div><div class="v">${c.guesses} из ${c.members}</div></div>` : ""}
      </div>
      <button class="btn ghost" data-go="/game/${id}/report">📊 NF Research — отчёт</button></div>
    <div class="h2">Резиденты · ${members.length}</div>
    <div class="list">${members.map(memberRow).join("") || '<div class="item muted">Пока никого. Отправьте приглашение.</div>'}</div>
    <p class="hint">📝 — ТЗ заполнено, ⏳ — ещё нет, 📵 — бот не сможет написать. Содержание ТЗ организатору не видно.</p>`;
  if (g.status === "open") {
    const opts = members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
    html += `<button class="btn ghost" id="nudge">🔔 Напомнить про ТЗ</button>
      <div class="h2">Исключения</div>
      <p class="small muted">Пары, которые не дарят друг другу ни в одну сторону — например, супруги.</p>
      <div class="list">${exclusions.map((x) => `<div class="item"><span class="grow">${esc(x.a_name)} ↔ ${esc(x.b_name)}</span><button class="icon-btn" data-unex="${x.id}" aria-label="Удалить">✕</button></div>`).join("") || '<div class="item muted">Пока нет</div>'}</div>
      ${members.length >= 2 ? `<div class="row" style="margin-top:10px"><select class="select grow" id="ex-a">${opts}</select><select class="select grow" id="ex-b">${opts}</select></div><button class="btn ghost" id="ex-add">＋ Добавить пару</button>` : ""}
      <div class="h2">Жеребьёвка</div>
      <div class="card" id="draw-box">${g.draw_at ? `<p class="small">🤖 Автожеребьёвка: <b>${esc(fmtFull(g.draw_at, g.timezone))}</b>. Можно провести и раньше вручную.</p>` : ""}
        <button class="btn red" id="draw-check">🎲 Проверить и провести жеребьёвку</button></div>`;
  }
  if (g.status === "drawn") html += `<div class="h2">Раскрытие карт</div><div class="card"><p class="small">Каждый узнает своего Санту, всем придут итоги и номинации. Сделать это можно один раз.</p><button class="btn red" id="reveal">🎭 Раскрыть карты</button></div>`;
  html += `<div class="h2">Рассылка резидентам</div>
    <textarea class="textarea" id="bc" maxlength="2000" placeholder="Например: вручаем подарки 26 декабря в 18:00 в переговорной"></textarea>
    <button class="btn ghost" id="bc-send">📢 Отправить всем</button>
    <div class="divider"></div>
    ${g.status !== "revealed" ? `<button class="btn ghost" data-go="/game/${id}/edit">✏️ Параметры лота</button>` : ""}
    <button class="btn danger" id="delete">🗑 Удалить игру</button>`;
  app.innerHTML = page("Кабинет организатора", html);
  bindInvite(v);

  $$("[data-kick]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox(`Удалить «${b.dataset.name}» из игры?`))) return;
    action(b, async () => { await api("DELETE", `/api/games/${id}/members/${b.dataset.kick}`); toast("Удалено"); render(); });
  }));
  $$("[data-unex]").forEach((b) => (b.onclick = () => action(b, async () => { await api("DELETE", `/api/games/${id}/exclusions/${b.dataset.unex}`); render(); })));
  const exAdd = $("#ex-add");
  if (exAdd) exAdd.onclick = () => action(exAdd, async () => {
    const r = await api("POST", `/api/games/${id}/exclusions`, { a_id: Number($("#ex-a").value), b_id: Number($("#ex-b").value) });
    toast(r.added ? "Пара добавлена" : "Такая пара уже есть");
    render();
  });
  const nudge = $("#nudge");
  if (nudge) nudge.onclick = () => action(nudge, async () => {
    const r = await api("POST", `/api/games/${id}/nudge`);
    toast(r.queued ? `Напомнили ${r.queued} ${plural(r.queued, ["резиденту", "резидентам", "резидентам"])}` : "Все уже заполнили ТЗ 👏");
  });
  const check = $("#draw-check");
  if (check) check.onclick = () => action(check, async () => drawFlow(id, await api("GET", `/api/games/${id}/draw/check`)));
  const reveal = $("#reveal");
  if (reveal) reveal.onclick = async () => {
    if (!(await confirmBox("Раскрыть карты? Каждый узнает своего Санту. Это действие нельзя отменить."))) return;
    action(reveal, async () => {
      await api("POST", `/api/games/${id}/reveal`, { confirm: true });
      buzz();
      toast("🎭 Карты раскрыты! Итоги отправлены всем");
      go(`/game/${id}`);
    });
  };
  $("#bc-send").onclick = (e) => {
    const text = $("#bc").value.trim();
    if (!text) return toast("Напишите сообщение", true);
    action(e.currentTarget, async () => {
      const r = await api("POST", `/api/games/${id}/broadcast`, { text });
      $("#bc").value = "";
      toast(`📢 Поставлено в очередь: ${r.queued}`);
    });
  };
  $("#delete").onclick = async () => {
    if (!(await confirmBox("Удалить игру вместе со всеми участниками, парами и перепиской?"))) return;
    if (!(await confirmBox("Точно удалить? Восстановить игру будет нельзя."))) return;
    action($("#delete"), async () => { await api("DELETE", `/api/games/${id}`, { confirm: true }); toast("Игра удалена"); go("/"); });
  };
});

function drawFlow(id, c) {
  const box = $("#draw-box");
  const list = (arr) => esc(arr.join(", "));
  box.innerHTML = `<div class="eyebrow">Проверка перед жеребьёвкой</div>
    <p>${c.ok ? "✅" : "⛔"} Резидентов: <b>${c.count}</b>${c.ok ? ", исключения позволяют провести жеребьёвку." : ""}</p>
    ${c.error ? `<p style="color:#ff8a9a">${esc(c.error)}</p>` : ""}
    ${c.no_wishlist.length ? `<p class="small">📝 Без ТЗ: ${list(c.no_wishlist)} — смогут дописать и после жеребьёвки, Санта получит уведомление.</p>` : ""}
    ${c.unreachable.length ? `<p class="small">📵 Бот не сможет написать: ${list(c.unreachable)} — свой результат они увидят в приложении.</p>` : ""}
    ${c.ok ? `<p class="small"><b>После жеребьёвки состав участников больше не меняется, отменить её нельзя.</b></p><button class="btn red" id="draw-go">Провести жеребьёвку среди ${c.count}</button>` : ""}
    <button class="btn ghost" id="draw-cancel">Назад</button>`;
  $("#draw-cancel").onclick = () => render();
  const goBtn = $("#draw-go");
  if (goBtn) goBtn.onclick = async () => {
    if (!(await confirmBox(`Провести жеребьёвку среди ${c.count} резидентов? Отменить её будет нельзя.`))) return;
    busy(goBtn, true);
    const stages = ["📑 Формируем пул объектов…", "🔍 Проводим due diligence каждого Санты…", "🤝 Подбираем арендаторов под ТЗ…", "🖋 Подписываем договоры дарения…", "🏛 Регистрируем сделки в реестре Северного полюса…"];
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = `<div class="box"><div class="eyebrow">Жеребьёвка</div>${stages.map((s) => `<div class="stage">${s}</div>`).join("")}${stamp("stamp-big")}<div id="ov-result" class="center" style="margin-top:14px"></div></div>`;
    document.body.appendChild(ov);
    const request = api("POST", `/api/games/${id}/draw`, { confirm: true }).then((r) => ({ r }), (e) => ({ e }));
    for (const el of $$(".stage", ov)) { await sleep(650); el.classList.add("on"); haptic(); }
    const { r, e } = await request;
    if (e) { ov.remove(); busy(goBtn, false); buzz("error"); toast(e.message, true); return; }
    await sleep(300);
    $(".stamp-big", ov).classList.add("on");
    buzz();
    $("#ov-result", ov).innerHTML = `<p><b>Сделки закрыты!</b> ${r.count} резидентов получают подопечных.<br><span class="small muted">Кто кому дарит — знает только бот 🤫</span></p><button class="btn" id="ov-ok">Готово</button>`;
    $("#ov-ok", ov).onclick = () => { ov.remove(); render(); };
  };
}

// ---------------------------------------------------------------- параметры лота
route(/^\/game\/(\d+)\/edit$/, async (id) => {
  const v = await api("GET", `/api/games/${id}`);
  if (!v.is_organizer) throw new Error("Это может сделать только организатор.");
  const g = v.game, open = g.status === "open";
  app.innerHTML = page("Параметры лота", `
    <div class="eyebrow">Параметры лота</div><h1 class="h-thin sm">${esc(g.title)}</h1>
    ${open ? `<div class="field"><label>Название</label><input class="input" id="title" maxlength="80" value="${esc(g.title)}"></div>
    <div class="field"><label>Бюджет</label><input class="input" id="budget" maxlength="120" value="${esc(g.budget)}"></div>
    <div class="field"><label>Часовой пояс</label><select class="select" id="tz">${TIMEZONES.map(([val, l]) => `<option value="${val}" ${val === g.timezone ? "selected" : ""}>${l}</option>`).join("")}</select></div>` : `<p class="small muted">После жеребьёвки можно менять только дату и место вручения.</p>`}
    <div class="field"><label>Дата и время вручения</label><input class="input" type="datetime-local" id="exchange" value="${toInput(g.exchange_at, g.timezone)}"></div>
    <div class="field"><label>Место</label><input class="input" id="place" maxlength="120" value="${esc(g.place)}"></div>
    ${open ? `<div class="field"><label>Автожеребьёвка</label><input class="input" type="datetime-local" id="draw" value="${g.draw_at ? toInput(g.draw_at, g.timezone) : ""}"><div class="hint">Оставьте пустым, чтобы провести вручную.</div></div>` : ""}
    <button class="btn" id="save">Сохранить</button>`);
  $("#save").onclick = (e) => action(e.currentTarget, async () => {
    const body = { place: $("#place").value, exchange_local: $("#exchange").value };
    if (open) Object.assign(body, { title: $("#title").value, budget: $("#budget").value, timezone: $("#tz").value, draw_local: $("#draw").value || null });
    await api("PATCH", `/api/games/${id}`, body);
    toast("✅ Сохранено");
    go(`/game/${id}/admin`);
  });
});

// ---------------------------------------------------------------- NF Research
route(/^\/game\/(\d+)\/report$/, async (id) => {
  const [v, r] = await Promise.all([api("GET", `/api/games/${id}`), api("GET", `/api/games/${id}/report`)]);
  const q = `Q${Math.floor(new Date().getMonth() / 3) + 1} ${YEAR}`;
  const kpi = (label, num, sub, pctv) => `<div class="kpi"><div class="sub">${label}</div><div class="num">${num}</div><div class="small">${sub}</div>${pctv !== undefined ? `<div class="bar"><span style="width:${pctv}%"></span></div>` : ""}</div>`;
  const d = r.delivery || {};
  app.innerHTML = page(`NF Research · ${q}`, `
    <div class="card light">
      <div class="eyebrow">Обзор рынка подарков</div>
      <h1 class="h-thin sm">${esc(v.game.title)}</h1>
      <div class="kpis">
        ${kpi("Заполняемость ТЗ", `${r.wishlist_pct}%`, `${r.wishlists} из ${r.members} резидентов`, r.wishlist_pct)}
        ${r.ready_pct !== null ? kpi("Индекс готовности", `${r.ready_pct}%`, "подарков готово", r.ready_pct) : kpi("Стадия", "PRE", "сделка в работе")}
        ${kpi("Переговоры", r.talks, "анонимных сообщений")}
      </div>
      ${r.top_words.length ? `<p>🔥 <b>Спрос</b> (встречается минимум у трёх резидентов): ${esc(r.top_words.join(", "))}</p>` : ""}
      <p>🔮 <b>Прогноз аналитиков:</b> ${esc(r.forecast)}</p>
      <p class="small">✉️ Уведомления: доставлено ${d.sent || 0}, в очереди ${(d.pending || 0) + (d.retry || 0) + (d.sending || 0)}, не доставлено ${(d.failed || 0) + (d.blocked || 0)}</p>
      <p class="small muted">Данные не являются публичной офертой.</p>
    </div>
    ${nominationsCard(r.nominations)}`);
});

// ---------------------------------------------------------------- идеи подарков
route(/^\/ideas$/, async () => {
  const show = () => ($("#idea").textContent = IDEAS[Math.floor(Math.random() * IDEAS.length)]);
  app.innerHTML = page("Идеи подарков", `
    <div class="eyebrow">Департамент идей</div><h1 class="h-thin sm">Идея подарка</h1>
    <div class="card light"><p id="idea" style="font-size:17px;margin:0"></p></div>
    <button class="btn" id="more">🎲 Ещё идею</button>
    <p class="small muted center" style="margin-top:16px">Совет аналитиков: сверьтесь с ТЗ подопечного и не выходите за бюджет 😉</p>`);
  show();
  $("#more").onclick = () => { haptic(); show(); };
});

// ---------------------------------------------------------------- запуск
function boot() {
  snowfall();
  if (!INIT) {
    app.innerHTML = page("Secret Santa", `<div class="hero">${skyline(3)}</div>
      <div class="eyebrow" style="margin-top:18px">Новогодний проект</div><h1 class="h-thin">Тайный Санта</h1>
      <div class="card"><p>Это приложение работает внутри Telegram. Откройте бота «Тайный Санта NF Group» и нажмите кнопку «Открыть».</p></div>`);
    bindEggs();
    return;
  }
  try {
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.("#13213A");
    tg.setBackgroundColor?.("#13213A");
    tg.disableVerticalSwipes?.();
    tg.BackButton?.onClick(() => go(parentOf(location.hash.slice(1) || "/")));
  } catch {}
  const sp = tg.initDataUnsafe?.start_param || "";
  if (!location.hash && sp.startsWith("join_")) location.hash = `#/join/${sp.slice(5)}`;
  window.addEventListener("hashchange", render);
  render();
}
boot();
