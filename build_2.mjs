// build.mjs — самодостатній збірник каталогу (для GitHub Action).
// Читає наявний catalog.json як СИД, оновлює живі джерела і перезаписує catalog.json.
// Ціни: під кожного постачальника — див. pickSheetPrice/atmoPrice/yugtorg.
//
// Ця копія автономна: не залежить від жодного іншого репозиторію.
// Усі зовнішні джерела зібрані в блоці SRC нижче — це єдине місце, де прописані ID таблиць.
import { readFileSync, writeFileSync } from "fs";

// ============================================================================
//  SRC — усі джерела даних в одному місці.
//  Будь-який ID можна перевизначити без правки коду: Settings → Secrets and
//  variables → Actions → вкладка Variables (напр. змінна SLAVIK_SHEET).
//
//  Змінна не задана або порожня → береться значення за замовчуванням звідси.
//  (GitHub Actions підставляє незадану змінну як порожній рядок, тому саме
//   порожній рядок означає «не задано», а не «вимкнути».)
//  Щоб вимкнути джерело — задайте значення «off».
// ============================================================================
const env = (k, d) => {
  const v = (process.env[k] || "").trim();
  if (v === "") return d;      // не задано → значення за замовчуванням
  if (v === "off") return "";  // явне вимкнення джерела
  return v;
};
const SRC = {
  // — таблиці постачальників (публічні, чужі акаунти) —
  sakoenergy: env("SAKOENERGY_SHEET", "1fL5fwlGeWSeiogJFD6NeXQrmtdD3-SeDZljh0XYMBRc"),
  intersolar: env("INTERSOLAR_SHEET", "1urSlWzmui3nszA03kA9XFUoXgFhUHwUFRfraaiC5hE8"),
  sunrise:    env("SUNRISE_SHEET",    "1Wog9MpKlV90ItO3GfagvxUHqGbWPLiZJ9fJnL_KbAFc"),
  priceH:     env("PRICEH_SHEET",     "1OpG0sPkM8oFXYCNgVCUp-EZx5AIhj0aS_WGVQahWrt8"),
  ratech:     env("RATECH_SHEET",     "1w9YuFd4pqGR1bkW1FeVD1kGjMHOuKHWTSU1EaroHkoc"),
  avtonomka:  env("AVTONOMKA_SHEET",  "1hUWLK904eO_jA5wtsJRXIcuyfwHeNJdeo5CteDCY4-0"),

  // — наші власні таблиці (акаунт anna.escore@gmail.com) —
  // Мають бути відкриті «Всім, хто має посилання — Переглядач», інакше бот отримає 401.
  slavik:         env("SLAVIK_SHEET",     "1RzpyWCbIYrxz9zX58FU1iOUpED0rysGNhfYdcA4dnY0"),
  solarityMirror: env("SOLARITY_MIRROR",  "1i3u_awTfs-TMYt1YvHqXmfzguB_ThPGSt4bJYh4vg70"),
  datasheets:     env("DS_SHEET",         "1ARtSVPQ9n03UZdtlP3sy9iRUUDQ3dOLvLMQSsHT75Mc"),

  // — сайти з логіном (секрети в Settings → Secrets → Actions) —
  yugtorgBase: "https://b2b.yugtorg.com/index.php?route=product/category&category_id=",
  atmoBase:    "https://my.atmo.pro",
};

// ---------- helpers ----------
async function fetchHtml(url, cookie) {
  const res = await fetch(url, {
    headers: { cookie: cookie || "", "user-agent": "Mozilla/5.0 (catalog-bot ESCORE)", "accept-language": "uk,ru;q=0.9" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const html = await res.text();
  if (/name="password"|Авторизація/i.test(html) && !/warehouse|Склад|Артикул|кВт/i.test(html))
    throw new Error("не авторизовано (cookie протух?)");
  return html;
}
const stripTags = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
function normAvail(t) {
  const s = (t || "").toLowerCase();
  if (/нет наличия|немає в наявн|розпрод|закінч/.test(s)) return "no";
  if (/очіку|ожида|в производстве|у резерв|передзамов|під замов|\d{1,2}[.\-/]\d{1,2}/.test(s)) return "soon";
  if (/є в наявн|в наявн|в наличии|\+/.test(s)) return "yes";
  return "no";
}
function classify(name) {
  const s = name || "";
  // ІНВЕРТОР перевіряємо ПЕРШИМ: у гібридного інвертора в описі може бути «АКБ/батарея», але це інвертор.
  if (/deye/i.test(s) && /(інверт|инверт|SUN-?\d)/i.test(s)) return "inv";
  if (/deye/i.test(s) && /(BOS|SE-F|SE-G|LiFePO|LFP|акумул|аккумул|батаре|АКБ)/i.test(s)) return "bat";
  // Felicity (інвертори серії IVEM/IVGM/IVPM; АКБ серії FLA/FLB, LiFePO4)
  if (/felicity/i.test(s) && /(інверт|инверт|IVEM|IVGM|IVPM|IVSM)/i.test(s)) return "inv";
  if (/felicity/i.test(s) && /(LiFePO|LFP|акумул|аккумул|батаре|АКБ|FL[AB]\d|LPBA|\d+\s*ah)/i.test(s)) return "bat";
  if (/(сонячн(а|у) панел|солнечн(ая|ую) панел|фотомодул)/i.test(s) ||
      /\b(Longi|Jinko|JA Solar|Canadian|Risen|Trina|Tongwei|ReneSola|Luxen|Sunerise|Solitek)\b/i.test(s)) return "pan";
  return null;
}
function parseInverter(name) {
  const s = name.toUpperCase();
  let kw = null;
  const kwM = s.match(/(\d{1,3})\s*К?ВТ/) || s.match(/SUN-?(\d{1,3})K/);
  if (kwM) kw = Number(kwM[1]);
  // Felicity IVEM (низьковольтні): IVEM<потужність><напруга 3 цифри>, напр. IVEM6048=6кВт/48В, IVEM12048=12кВт/48В
  if (kw == null) { const f = s.match(/IVEM\s*-?\s*(\d{4,6})/); if (f) { const p = Number(f[1].slice(0, -3)); if (p >= 1 && p <= 60) kw = p; } }
  // дробові позначення потужності: "4K6"=4.6кВт
  if (kw == null) { const fr = s.match(/(\d{1,3})K(\d)(?![\dK])/); if (fr) kw = Number(fr[1]) + Number(fr[2]) / 10; }
  // Felicity IVGM (три фази, високовольтні): "IVGM125K…"=125кВт
  if (kw == null) { const hk = s.match(/IV[A-Z]M\D{0,6}(\d{2,3})K(?!\d)/); if (hk) kw = Number(hk[1]); }
  let ph = null;
  if (/ТРЕХФАЗ|ТРИФАЗ|3\s*ФАЗ|LP3|HP3|P3G/.test(s)) ph = 3; else if (/ОДНОФАЗ|1\s*ФАЗ|LP1|HP1|P1G|P2G/.test(s)) ph = 1;
  return { kw, ph, hv: /\bHV\b|HP3|HP1|IVGM/.test(s) };
}
function parseBattery(name) {
  // ємність акумулятора: «5,12 кВт·год», «16 kWh», а також «16KW»/«16 кВт» (постачальники часто пишуть kW замість kWh).
  const m = name.match(/([\d.,]+)\s*(?:кВт[\s·*\-]*год|квт[\s·*\-]*год|kwh|kwt|kw\b|квт\b)/i);
  let kwh = m ? Number(m[1].replace(",", ".")) : null;
  // фолбек: якщо немає кВт·год, рахуємо з напруги×ємності (Felicity: «51.2V 100Ah» → 5.12 кВт·год)
  if (kwh == null) {
    const vm = name.match(/([\d.,]+)\s*[VВ](?![a-zа-яіїєґ])/i), am = name.match(/([\d.,]+)\s*(?:ah|а·?год|ач)/i);
    if (vm && am) { const v = Number(vm[1].replace(",", ".")), ah = Number(am[1].replace(",", ".")); if (v > 0 && ah > 0) kwh = Math.round(v * ah / 10) / 100; }
  }
  return { kwh, hv: /BOS|HV/i.test(name) && !/48\s?[ВB]/i.test(name) };
}
function parsePanelWatt(name) {
  const s = name || "";
  // 1) явна одиниця: "620 W", "450Вт", "600 Wp"
  const u = s.match(/(\d{3,4})\s*(?:wp|w|вт|ватт)\b/i);
  if (u) return Number(u[1]);
  // 2) інакше — перше число 100..900, що НЕ є частиною габариту (не оточене * х ×)
  const re = /(?<![\d.,])(\d{3,4})(?![\d.,])/g; let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1]); if (n < 100 || n > 900) continue; // 1722/2382 тощо — це розмір, не ват
    const before = s.slice(Math.max(0, m.index - 2), m.index);
    const after = s.slice(re.lastIndex, re.lastIndex + 2);
    if (/[*хx×]\s*$/i.test(before) || /^\s*[*хx×]/i.test(after)) continue; // частина розміру
    return n;
  }
  return null;
}
function parseDim(s) { // повертає {dim:"1722×1134", len:1722} з тексту, якщо є габарит
  const m = (s || "").match(/(\d{3,4})\s*[*хx×]\s*(\d{3,4})/i);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (a < 300 || b < 300 || a > 3000 || b > 3000) return null;
  return { dim: Math.max(a, b) + "×" + Math.min(a, b), len: Math.max(a, b) };
}
function panelSize(len, watt) { // 'small' | 'med' | 'large'
  // Пороги від Anna: малі ≤465Вт (≈1762мм), середні 466–485Вт (≈1800мм), великі >485Вт.
  if (watt != null) return watt <= 465 ? "small" : watt <= 485 ? "med" : "large";
  if (len) return len <= 1780 ? "small" : len <= 1850 ? "med" : "large";
  return null;
}
function panelInfo(name, cells) { // watt (виправлено) + розмір + клас
  const watt = parsePanelWatt(name);
  let d = parseDim(name);
  if (!d && cells) for (const c of cells) { d = parseDim(c); if (d) break; } // напр. колонка «Розмір» у таблиці
  return { watt, dim: d ? d.dim : null, len: d ? d.len : null, size: panelSize(d ? d.len : null, watt) };
}
function panelBrand(name) { const b = name.match(/\b(Longi|Jinko|JA Solar|JA|Canadian|Risen|Trina|Tongwei|ReneSola|Luxen|Sunerise|Solitek)\b/i); return b ? b[1] : null; }
const D = (id) => "https://drive.google.com/file/d/" + id + "/view";
function datasheetFor(it) {
  if (it.cat !== "pan") return null; const m = (it.model || "").toUpperCase(); const b = (it.brand || "").toLowerCase(); const w = it.watt;
  if (b.includes("longi")) { if (w===445) return D("1ZePdEDRupd_OoEUU6qsmearNHtEv3pra"); if (w===480||w===485) return D("1DJ40A4QXEG71i5j1QOE6r2C2iqNFkcC_"); if (w===615) return D("1MlcaC8l-yIgtavlFrtcqZR98h6gM_0MF"); if (w===620) return /72HGD/.test(m)?D("1PDTfzF7RApdLF7sG3ySxyDg_xUmyheRv"):D("1MlcaC8l-yIgtavlFrtcqZR98h6gM_0MF"); if (w===645) return D("1awbrcqFqujX77zM1CCkLPVTOH6ZThu6R"); if (w===650) return D("18vt_4LfNzNBPMKKYBYMTfVZ-M1-IO7AC"); if (w===655) return D("1XX1WB0Pvjqllv5qle992UKZGPpRZawKt"); }
  if (b.includes("jinko")) { if (w===450||w===460) return D("1rQq46SwyXfR6EoaZnFjxJMhFJthhOmhS"); if (w===465) return D("1sx19xz6qhNZ6PZvKS36BnzrPMBAXpYPz"); if (w===590) return D("1q61Dx6h1XHQHT3IdEXo7S_rGO2uNfxx7"); if (w===620) return D("1-nWc28iHCpss_BOgYc1qyYEH0ekZPHJ5"); if (w===625) return D("1zfwuKd82B4Cy2PT-TBkzEbeS2vll8Mui"); if (w===630) return D("1H1wfgeHAryi7Qff5ohPSk6sL0H4X2pol"); }
  if (b==="ja"||b.includes("ja solar")) { if (w===460||w===465) return D("1AbwcWmCHFu9JeLwTtWZ1nMq0zICzerp8"); if (w===590) return D("1eSkLlyrdzWbX8Qq-mQu1lP_oOokyCQLM"); if (w===610) return D("1fHykKDHWKVpoZWy9q7PMKX4Y8fHiX6Xz"); if (w===620) return D("15vPIPgHKePAYoKoh344hBn4l94hj5gX4"); if (w===630) return D("19JSAtWLa-1qLTDawNAy4aMpk_gDqApcM"); if (w===635) return D("1PTHpfwXQ-JbaTy02E2BaJdFNb-qgECF4"); if (w===645) return D("1eTdcKnEmSge1LgnMpB0VuYth7PXovvE_"); }
  return null;
}

// ---------- YugTorg (OpenCart, HTML, класи name_good/warehouse) ----------
const YUG_BASE = SRC.yugtorgBase;
const YUG_CATS = [38429, 36851, 32360, 44908, 37262, 30211, 38559, 38558, 31271, 38584];
// Індекси цінових колонок за шапкою таблиці: СПЕЦ = готівка, «цена у.е.» = ПДВ.
function yugHeaderCols(html) {
  const hr = html.split(/<tr[\s>]/i).find((r) => /<th[\s>]/i.test(r)) || "";
  const ths = (hr.match(/<th[\s\S]*?<\/th>/gi) || []).map(stripTags);
  const find = (re) => ths.findIndex((t) => re.test(t));
  return { spec: find(/спец/i), ue: find(/у\.?\s*[ео]\.?|цена\s*у/i) };
}
// Автологін YugTorg: POST email+password на index.php?route=login/login (без CSRF/капчі).
// Логін/пароль з секретів YUGTORG_EMAIL/YUGTORG_PASSWORD. Повертає рядок cookie «PHPSESSID=...» або null.
// Перевага перед ручним YUGTORG_COOKIE: сесія створюється й використовується з одного IP (GitHub), не протухає.
async function yugtorgLogin() {
  const email = process.env.YUGTORG_EMAIL, password = process.env.YUGTORG_PASSWORD;
  if (!email || !password) return null;
  const BASE = "https://b2b.yugtorg.com/index.php";
  const UA = "Mozilla/5.0 (catalog-bot ESCORE)";
  const sidOf = (res) => {
    const arr = (res.headers.getSetCookie && res.headers.getSetCookie()) || [res.headers.get("set-cookie")].filter(Boolean);
    for (const c of arr) { const m = /PHPSESSID=([^;]+)/.exec(c || ""); if (m) return m[1]; }
    return null;
  };
  // 1) GET — отримати початковий PHPSESSID
  const g = await fetch(`${BASE}?route=login/login`, { headers: { "user-agent": UA }, redirect: "manual" });
  let sid = sidOf(g);
  const ck = () => (sid ? `PHPSESSID=${sid}` : "");
  // 2) POST — облікові дані
  const body = new URLSearchParams({ email, password, redirect: "" }).toString();
  const p = await fetch(`${BASE}?route=login/login`, {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest", cookie: ck() },
    body, redirect: "manual",
  });
  sid = sidOf(p) || sid;
  if (!sid) return null;
  // 3) перевірка авторизації на реальній сторінці категорії
  const v = await fetch(`${BASE}?route=product/category&category_id=${YUG_CATS[0]}&limit=5`, { headers: { "user-agent": UA, cookie: ck() }, redirect: "follow" });
  const html = await v.text();
  if (/name="password"|Авторизація|LogIn/i.test(html) && !/warehouse|Склад|Артикул|кВт/i.test(html)) return null; // не авторизовано (невірний логін/пароль?)
  return ck();
}
async function yugtorg() {
  let cookie = null;
  try { cookie = await yugtorgLogin(); } catch (e) { console.warn("YugTorg автологін: " + e.message); }
  if (cookie) console.log("YugTorg: автологін успішний");
  else { cookie = process.env.YUGTORG_COOKIE; if (cookie) console.log("YugTorg: автологін не вдався → fallback на YUGTORG_COOKIE"); }
  if (!cookie) { console.warn("YugTorg: немає ні автологіну (YUGTORG_EMAIL/PASSWORD), ні YUGTORG_COOKIE — пропускаю"); return []; }
  const items = [];
  let npY = 0;
  for (const cid of YUG_CATS) {
    for (let page = 1; page <= 8; page++) {
      let rows = [];
      try {
        const html = await fetchHtml(`${YUG_BASE}${cid}&limit=100&page=${page}`, cookie);
        const cols = yugHeaderCols(html);
        for (const r of html.split(/<tr[\s>]/i).slice(1)) {
          const nm = r.match(/name_good[^>]*>([\s\S]*?)<\/td>/i), wh = r.match(/warehouse[^>]*>([\s\S]*?)<\/td>/i);
          if (!nm || !wh) continue;
          const tds = r.match(/<td[\s\S]*?<\/td>/gi) || [];
          const price = {};
          if (cols.spec >= 0 && tds[cols.spec]) { const s = stripTags(tds[cols.spec]); const v = roundP(parsePrice(s), 1, 2); if (v != null) { price.cash = v; price.cur = price.cur || curOf(s); } }
          if (cols.ue >= 0 && tds[cols.ue]) { const s = stripTags(tds[cols.ue]); const v = roundP(parsePrice(s), 1, 2); if (v != null) { price.vat = v; price.cur = price.cur || curOf(s) || "у.е."; } }
          rows.push({ name: stripTags(nm[1]), avail: normAvail(stripTags(wh[1])), price: Object.keys(price).length ? price : null });
        }
      } catch (e) { console.warn(`YugTorg cat ${cid} p${page}: ${e.message}`); break; }
      if (!rows.length) break;
      for (const { name, avail, price } of rows) {
        const cat = classify(name); if (!cat) continue;
        if (price) npY++;
        const P = price ? { price } : {};
        if (cat === "inv") { const s = parseInverter(name); if (s.kw) items.push({ cat, model: name, sup: "YugTorg", avail, ...s, ...P }); }
        else if (cat === "bat") { const s = parseBattery(name); items.push({ cat, model: name, sup: "YugTorg", avail, ...s, ...P }); }
        else { const pi = panelInfo(name); if (pi.watt != null || pi.len != null) items.push({ cat, model: name, sup: "YugTorg", avail, watt: pi.watt, brand: panelBrand(name), dim: pi.dim, size: pi.size, ...P }); }
      }
    }
  }
  console.log(`YugTorg: ${items.length} позицій (${npY} з ціною)`);
  return items;
}

// ---------- Atmo (api-my.atmo.pro, JSON API, логін email/пароль → Bearer-токен) ----------
const ATMO_BASE = "https://api-my.atmo.pro";
const ATMO_CATS = [448, 494, 202]; // Інвертори (448), Акумуляторні батареї (494), Фотоелектричні модулі (202)
function deepFindToken(o) {
  if (!o || typeof o !== "object") return null;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === "string" && /token/i.test(k) && !/expir/i.test(k) && v.length > 20) return v;
  }
  for (const k of Object.keys(o)) { const r = deepFindToken(o[k]); if (r) return r; }
  return null;
}
function atmoAvail(q) {
  if (!q) return "no";
  // ВАЖЛИВО: available = free + reserved. Орієнтуємось на ВІЛЬНИЙ залишок (без резерву),
  // інакше повністю зарезервовані позиції хибно показуються як «в наявності».
  const free = (typeof q.free === "number") ? q.free : (q.available || 0) - (q.reserved || 0);
  if (free > 0) return "yes";
  if ((q.expected || 0) > 0) return "soon"; // вільного немає, але очікується поставка
  return "no";                              // все в резерві / немає
}
// Ціна Atmo (структура API підтверджена на живих даних):
//   Готівка «ціна ФОП дилерська» = cashPrices.dealer.price
//   ПДВ    «ціна ТОВ дилерська»  = cashlessPrices.dealer.price
function atmoPrice(p) {
  const cash = roundP(parsePrice(p && p.cashPrices && p.cashPrices.dealer && p.cashPrices.dealer.price), 1, 2);
  const vat = roundP(parsePrice(p && p.cashlessPrices && p.cashlessPrices.dealer && p.cashlessPrices.dealer.price), 1, 2);
  const out = {}; if (cash != null) out.cash = cash; if (vat != null) out.vat = vat;
  if (Object.keys(out).length) {
    const sym = (p.cashPrices && p.cashPrices.basic && p.cashPrices.basic.currency && p.cashPrices.basic.currency.symbol) ||
      (p.cashPrices && p.cashPrices.dealer && p.cashPrices.dealer.currency && p.cashPrices.dealer.currency.symbol);
    const cur = curOf(sym); if (cur) out.cur = cur;
  }
  return Object.keys(out).length ? out : null;
}
async function atmoLogin() {
  const email = process.env.ATMO_EMAIL, password = process.env.ATMO_PASSWORD;
  if (!email || !password) { console.warn("Atmo: немає ATMO_EMAIL/ATMO_PASSWORD — пропускаю"); return null; }
  const res = await fetch(`${ATMO_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) { console.warn("Atmo login: HTTP " + res.status + " (перевір ATMO_EMAIL/ATMO_PASSWORD)"); return null; }
  const tok = deepFindToken(await res.json());
  if (!tok) console.warn("Atmo: токен не знайдено у відповіді логіна");
  return tok;
}
async function atmo() {
  const tok = await atmoLogin();
  if (!tok) return [];
  const H = { headers: { authorization: "Bearer " + tok, accept: "application/json" } };
  const items = [];
  let npA = 0;
  for (const cid of ATMO_CATS) {
    for (let page = 1; page <= 40; page++) {
      let j;
      try {
        const url = `${ATMO_BASE}/api/v1/products?pagination[page]=${page}&pagination[per_page]=100&filters[categoryId]=${cid}`;
        const res = await fetch(url, H);
        if (!res.ok) { console.warn(`Atmo cat ${cid} p${page}: HTTP ${res.status}`); break; }
        j = await res.json();
      } catch (e) { console.warn(`Atmo cat ${cid} p${page}: ${e.message}`); break; }
      const rows = (j.data && j.data.data) || [];
      if (!rows.length) break;
      for (const p of rows) {
        const name = p.name || "";
        const cat = classify(name); if (!cat) continue;
        const avail = atmoAvail(p.quantity);
        const price = atmoPrice(p); if (price) npA++;
        const P = price ? { price } : {};
        if (cat === "inv") { const s = parseInverter(name); if (s.kw) items.push({ cat, model: name, sup: "Atmo", avail, ...s, ...P }); }
        else if (cat === "bat") { const s = parseBattery(name); items.push({ cat, model: name, sup: "Atmo", avail, ...s, ...P }); }
        else { const pi = panelInfo(name); if (pi.watt != null || pi.len != null) items.push({ cat, model: name, sup: "Atmo", avail, watt: pi.watt, brand: panelBrand(name), dim: pi.dim, size: pi.size, ...P }); }
      }
      const pi = j.data && j.data.paginatorInfo;
      if (pi && (pi.hasMorePages === false || (pi.currentPage && pi.lastPage && pi.currentPage >= pi.lastPage))) break;
    }
  }
  console.log(`Atmo: ${items.length} позицій (${npA} з ціною)`);
  return items;
}

// ---------- Ціни ----------
// Число з ячейки/поля: "1 234,56" / "1234.56" / "12 345" → число (2 знаки). Порожнє/0/сміття → null.
function parsePrice(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/ /g, " ");
  const m = s.match(/\d[\d\s.,]*/);
  if (!m) return null;
  let t = m[0].replace(/\s+/g, "");
  const dot = t.lastIndexOf("."), com = t.lastIndexOf(",");
  if (dot >= 0 && com >= 0) { if (com > dot) { t = t.replace(/\./g, "").replace(",", "."); } else { t = t.replace(/,/g, ""); } }
  else if (com >= 0) { const after = t.length - com - 1, before = t.slice(0, com); t = (after === 1 || after === 2 || before === "0" || before === "") ? t.replace(",", ".") : t.replace(/,/g, ""); } // «0,185»=десяткова; «29,032»=тисячі
  t = t.replace(/,/g, "");
  const n = Number(t);
  return isFinite(n) && n > 0 ? Math.round(n * 10000) / 10000 : null; // тримаємо до 4 знаків, фінальне округлення — у roundP
}
// округлення з коефіцієнтом і точністю p (знаків після коми); Solarity — 3 (до тисячних), решта — 2.
const roundP = (v, f, p) => { if (v == null) return null; const m = Math.pow(10, p == null ? 2 : p); return Math.round(v * (f || 1) * m) / m; };
// валюта з тексту ячейки/заголовка (€ / $ / грн / у.е.)
function curOf(...vals) {
  for (const raw of vals) {
    const s = String(raw == null ? "" : raw);
    if (/€|eur/i.test(s)) return "€";
    if (/\$|usd|дол/i.test(s)) return "$";
    if (/₴|грн|uah/i.test(s)) return "грн";
    if (/у\.?\s?[ео]\.?/i.test(s)) return "у.е.";
  }
  return null;
}
// індекс колонки за заголовком (шукаємо у перших 20 рядках)
function findCol(rows, re) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) { const r = rows[i] || []; for (let j = 0; j < r.length; j++) if (re.test(r[j] || "")) return j; }
  return -1;
}
// Постачальники з фіксованими колонками ціни (лише готівка). Букви → індекси: C=2, F=5, J=9.
const SHEET_PRICE = { Sakoenergy: { cash: 2, cur: "$" }, Intersolar: { cash: 9, cur: "$" }, SunRise: { cash: 5, cur: "$" } };
function pickSheetPrice(cells, cfg) {
  if (!cfg) return null;
  const f = cfg.factor || 1, p = cfg.round, out = {};
  if (cfg.cash != null) { const v = roundP(parsePrice(cells[cfg.cash]), f, p); if (v != null) out.cash = v; }
  if (cfg.vat != null) { const v = roundP(parsePrice(cells[cfg.vat]), f, p); if (v != null) out.vat = v; }
  if (cfg.cashCols) { const t = cfg.cashCols.map((c) => roundP(parsePrice(cells[c]), f, p)); if (t.some((x) => x != null)) out.cashTiers = t; }
  if (cfg.vatCols) { const t = cfg.vatCols.map((c) => roundP(parsePrice(cells[c]), f, p)); if (t.some((x) => x != null)) out.vatTiers = t; }
  // валюта — СПОЧАТКУ з ячейки самої позиції (лист може мішати $/€ у різних секціях!), потім фолбек cfg.cur
  if (Object.keys(out).length) { const cur = curOf(cells[cfg.cash], cells[cfg.vat], ...(cfg.cashCols || []).map((c) => cells[c]), ...(cfg.vatCols || []).map((c) => cells[c])) || cfg.cur; if (cur) out.cur = cur; }
  return Object.keys(out).length ? out : null;
}

// ---------- Google Sheets постачальників (публічні, gviz CSV, без логіну) ----------
// Живі: Sakoenergy, Intersolar, Helius, SunRise + Solarity (через публічне дзеркало IMPORTRANGE).
// Altek/Vimmer поки лишаються сидом (нестандартна верстка).
// Дзеркало Solarity: приватна таблиця постачальника → публічне дзеркало з 3 вкладками
// (panels / inv / bat, кожна IMPORTRANGE відповідної вкладки Solarity). ID — у SRC.
const SOLARITY_MIRROR = SRC.solarityMirror;
const SHEETS_LIVE = [
  ...(SRC.sakoenergy ? [{ sup: "Sakoenergy", id: SRC.sakoenergy }] : []),
  ...(SRC.intersolar ? [{ sup: "Intersolar", id: SRC.intersolar }] : []),
  ...(SRC.sunrise ? [{ sup: "SunRise", id: SRC.sunrise }] : []),
  // Price H: два блоки цін — C/D = в наявності, E/F = передзамовлення; валюта $
  ...(SRC.priceH ? [{ sup: "Price H", id: SRC.priceH, twoBlock: true }] : []),
  ...(SOLARITY_MIRROR ? [
    { sup: "Solarity", id: SOLARITY_MIRROR, tab: "panels" },
    { sup: "Solarity", id: SOLARITY_MIRROR, tab: "inv" },
    { sup: "Solarity", id: SOLARITY_MIRROR, tab: "bat" },
  ] : []),
];
const KNOWN_BRAND = /deye|longi|jinko|ja solar|\bja\b|canadian|risen|trina|tongwei|renesola|luxen|sunerise|solitek/i;
const normCell = (s) => {
  const v = (s || "").replace(/[‐‑‒–—−]/g, "-").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return /^#(REF|N\/A|ERROR|VALUE|DIV|NAME|NUM|NULL)!?/i.test(v) ? "" : v; // ігнор помилок формул (#REF! у колонці бренду)
};
function sectionOf(cells) {
  const ne = cells.map(normCell).filter(Boolean);
  const uniq = [...new Set(ne)];
  if (uniq.length !== 1 || uniq[0].length >= 60) return "";
  const v = uniq[0];
  // не плутати з рядком-товаром (модель): напр. "SUN-5K", "450 Вт", "BOS-G"
  if (/\d{2,}\s*(вт|w|kw|кв|год)/i.test(v) || /(SUN|BOS|SE-)[\s-]?\d/i.test(v)) return "";
  return v;
}
function parseCSV(s) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; } else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else if (c === "\r") {} else cur += c; }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function sheetAvail(t) {
  // Увага: \b у JS-regex не працює з кирилицею — не використовувати навколо укр/рос слів.
  const s = (t || "").toLowerCase();
  if (/нема|стоп|розпрод|закінчил|знято|відсутн|нет налич|нет в/.test(s)) return "no";
  if (/в наявн|наявн|сьогодн|в налич/.test(s)) return "yes";
  return "soon"; // очікується/предзамовлення/в дорозі/в роботі/дата/порожньо → консервативно "скоро"
}
async function sheets() {
  const items = [];
  for (const { sup, id, tab, twoBlock } of SHEETS_LIVE) {
    const label = sup + (tab ? "/" + tab : "");
    try {
      const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv` + (tab ? `&sheet=${encodeURIComponent(tab)}` : "");
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (catalog-bot ESCORE)" }, redirect: "follow" });
      if (!res.ok) { console.warn(`${label}: HTTP ${res.status}`); continue; }
      const rows = parseCSV(await res.text());
      let availCol = -1;
      for (let i = 0; i < Math.min(rows.length, 25) && availCol < 0; i++)
        for (let j = 0; j < rows[i].length; j++) if (/наявн|статус|status/i.test(rows[i][j] || "")) { availCol = j; break; }
      // конфіг ціни під постачальника (Solarity завжди −5%)
      let cfg = null;
      if (sup === "Solarity") {
        if (tab === "panels") cfg = { cashCols: [9, 10, 11], vatCols: [6, 7, 8], factor: 0.95, cur: "$/Вт", round: 3 }; // J/K/L, G/H/I; ціна за ВАТ, до тисячних
        else { const c = findCol(rows, /ціна.{0,4}шт.{0,4}без.{0,4}пдв/i), v = findCol(rows, /ціна.{0,4}шт.{0,4}з\s*пдв/i); cfg = { cash: c >= 0 ? c : 6, vat: v >= 0 ? v : 5, factor: 0.95, round: 3 }; } // «Ціна, шт без ПДВ»=G(6) готівка, «з ПДВ»=F(5) ПДВ; до тисячних
      } else if (SHEET_PRICE[sup]) cfg = { ...SHEET_PRICE[sup] };
      // валюта постачальника (фолбек на весь лист): для Solarity НЕ вгадуємо — там $/€ мішані по секціях,
      // валюта береться поштучно з ячейки позиції (див. pickSheetPrice).
      if (cfg && !cfg.cur && sup !== "Solarity") {
        const cols = [cfg.cash, cfg.vat, ...(cfg.cashCols || []), ...(cfg.vatCols || [])].filter((c) => c != null);
        let cur = null;
        for (let i = 0; i < Math.min(rows.length, 20) && !cur; i++) for (const c of cols) { cur = curOf((rows[i] || [])[c]); if (cur) break; }
        if (cur) cfg.cur = cur;
      }
      let section = "", n = 0, np = 0;
      for (const cells of rows) {
        const sec = sectionOf(cells); if (sec) { section = sec; continue; }
        // 1) пряме розпізнавання: перша ячейка, що класифікується за назвою
        let cat = null, model = null;
        for (const c of cells) { const cc = normCell(c); if (cc.length >= 8) { const k = classify(cc); if (k) { cat = k; model = cc; break; } } }
        // 2) фолбек для секцій без бренду в рядку (напр. Deye у Solarity): найдовша «літерна» ячейка + бренд секції
        if (!cat) {
          let cand = ""; for (const c of cells) { const cc = normCell(c); if (/[a-zа-яіїєґ]/i.test(cc) && cc.length > cand.length) cand = cc; }
          if (cand.length >= 6) {
            let name = cand;
            if (!KNOWN_BRAND.test(name) && /deye/i.test(section)) name = "Deye " + name;
            const k = classify(name); if (k) { cat = k; model = name; }
          }
        }
        if (!cat) continue;
        model = normCell(model);
        if (/бренд|модель|наявність|прайс|найменування/i.test(model)) continue; // рядок-шапка, не товар
        let avail, price;
        if (twoBlock) {
          // Price H: C/D = «в наявності» (yes), E/F = «передзамовлення» (soon), H(РПЦ) ігнор. Валюта $, без −5%.
          const C = roundP(parsePrice(cells[2]), 1, 2), D = roundP(parsePrice(cells[3]), 1, 2), E = roundP(parsePrice(cells[4]), 1, 2), F = roundP(parsePrice(cells[5]), 1, 2);
          if (C != null || D != null) { avail = "yes"; price = { cur: "$" }; if (C != null) price.cash = C; if (D != null) price.vat = D; }
          else if (E != null || F != null) { avail = "soon"; price = { cur: "$" }; if (E != null) price.cash = E; if (F != null) price.vat = F; }
          else continue; // ні наявності, ні передзамовлення (тільки РПЦ або порожньо) — пропускаємо
        } else {
          let raw = availCol >= 0 ? (cells[availCol] || "") : "";
          if (!raw) raw = cells.find((c) => /наявн|немає|стоп|дороз|очіку|замов/i.test(c || "")) || "";
          avail = sheetAvail(raw);
          price = pickSheetPrice(cells, cfg);
        }
        if (price) np++;
        const P = price ? { price } : {};
        if (cat === "inv") { const s = parseInverter(model); if (s.kw) { items.push({ cat, model, sup, avail, ...s, ...P }); n++; } }
        else if (cat === "bat") { const s = parseBattery(model); items.push({ cat, model, sup, avail, ...s, ...P }); n++; }
        else { const pi = panelInfo(model, cells); if (pi.watt != null || pi.len != null) { items.push({ cat, model, sup, avail, watt: pi.watt, brand: panelBrand(model), dim: pi.dim, size: pi.size, ...P }); n++; } }
      }
      console.log(`${label}: ${n} позицій${(cfg || twoBlock) ? ` (${np} з ціною)` : ""}`);
    } catch (e) { console.warn(`${label}: ${e.message}`); }
  }
  return items;
}

// ---------- RaTech (публічний gviz CSV, кілька вкладок з різною версткою) ----------
// Бренд у стовпці A, модель у B → склеюємо для classify. Валюта $.
//  Вкладка «Гібридні інвертори/АКБ» (Deye): Готівка=J(9), ПДВ=K(10), наявність=L(11).
//  Вкладка «Сонячні панелі» (будь-який бренд, $/Вт): наявність=E(4);
//    «до палети»=H(7) → тариф <36 (тільки готівка); «від палети» без ПДВ=I(8) / з ПДВ=J(9) → тарифи 36–108 і >108.
const RATECH_ID = SRC.ratech;
async function ratechTab(tab) {
  const url = `https://docs.google.com/spreadsheets/d/${RATECH_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (catalog-bot ESCORE)" }, redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return parseCSV(await res.text());
}
async function ratech() {
  const items = [];
  if (!RATECH_ID) { console.log("RaTech: джерело вимкнене"); return items; }
  // 1) Deye інвертори + АКБ
  try {
    const rows = await ratechTab("Гібридні інвертори/АКБ");
    let n = 0;
    for (const cells of rows) {
      const brand = normCell(cells[0]), mr = normCell(cells[1]);
      if (mr.length < 4 || /модель|бренд/i.test(mr)) continue;
      const model = KNOWN_BRAND.test(mr) ? mr : (brand ? brand + " " + mr : mr);
      const cat = classify(model); if (cat !== "inv" && cat !== "bat") continue;
      const cash = roundP(parsePrice(cells[9]), 1, 2), vat = roundP(parsePrice(cells[10]), 1, 2);
      if (cash == null && vat == null) continue;
      const price = { cur: "$" }; if (cash != null) price.cash = cash; if (vat != null) price.vat = vat;
      const avail = sheetAvail(normCell(cells[11]));
      if (cat === "inv") { const s = parseInverter(model); if (s.kw) { items.push({ cat, model, sup: "RaTech", avail, ...s, price }); n++; } }
      else { const s = parseBattery(model); items.push({ cat, model, sup: "RaTech", avail, ...s, price }); n++; }
    }
    console.log(`RaTech/інв+АКБ: ${n} позицій`);
  } catch (e) { console.warn("RaTech/інв+АКБ: " + e.message); }
  // 2) Панелі (будь-який бренд, $/Вт, тарифи за кількістю: <36=H, 36–108/>108=від палети I/J)
  try {
    const rows = await ratechTab("Сонячні панелі");
    let n = 0;
    for (const cells of rows) {
      const brand = normCell(cells[0]), mr = normCell(cells[1]);
      if (mr.length < 3 || /модель|бренд/i.test(mr) || !/\d/.test(mr)) continue;
      const H = roundP(parsePrice(cells[7]), 1, 3), I = roundP(parsePrice(cells[8]), 1, 3), J = roundP(parsePrice(cells[9]), 1, 3);
      if (H == null && I == null && J == null) continue;
      const cashTiers = [H, I, I], vatTiers = [null, J, J];
      const price = { cur: "$/Вт" };
      if (cashTiers.some((x) => x != null)) price.cashTiers = cashTiers;
      if (vatTiers.some((x) => x != null)) price.vatTiers = vatTiers;
      const model = brand && !KNOWN_BRAND.test(mr) ? brand + " " + mr : mr;
      const avail = sheetAvail(normCell(cells[4]));
      const pi = panelInfo(model, cells);
      items.push({ cat: "pan", model, sup: "RaTech", avail, watt: pi.watt, brand: panelBrand(model), dim: pi.dim, size: pi.size, price }); n++;
    }
    console.log(`RaTech/панелі: ${n} позицій`);
  } catch (e) { console.warn("RaTech/панелі: " + e.message); }
  console.log(`RaTech: ${items.length} позицій`);
  return items;
}

// ---------- Avtonomka (публічний gviz; секції: категорія→бренд; ціна в D($), наявність «+» в G) ----------
// Беремо ТІЛЬКИ Deye + Felicity (інвертори/АКБ). MUST/DAH SOLAR не додаємо. Панелей у прайсі немає. Тільки готівка.
const AVTONOMKA_ID = SRC.avtonomka;
async function avtonomka() {
  const items = [];
  if (!AVTONOMKA_ID) { console.log("Avtonomka: джерело вимкнене"); return items; }
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${AVTONOMKA_ID}/gviz/tq?tqx=out:csv`, { headers: { "user-agent": "Mozilla/5.0 (catalog-bot ESCORE)" }, redirect: "follow" });
    if (!res.ok) { console.warn("Avtonomka: HTTP " + res.status); return items; }
    const rows = parseCSV(await res.text());
    let category = null, brand = null, n = 0;
    for (const cells of rows) {
      const ne = cells.map(normCell);
      const joined = ne.filter(Boolean).join(" ").toLowerCase();
      if (/залишок/.test(joined)) { category = /інвертор/.test(joined) ? "inv" : /акумулятор/.test(joined) ? "bat" : null; brand = null; continue; } // рядок-категорія
      if (/кабель|зарядн|автомат|інші товари/.test(joined)) { category = null; brand = null; continue; }
      const lone = ne.filter(Boolean);
      if (lone.length <= 2 && /^(deye|felicity|must|dah\s*solar|dah)$/i.test(lone[0])) { brand = lone[0].toLowerCase().replace(/\s+/g, " "); continue; } // рядок-бренд
      const b = ne[1]; if (!b || b.length < 5) continue; // товар: модель у B
      if (!category || (brand !== "deye" && brand !== "felicity")) continue;
      const price = roundP(parsePrice(cells[3]), 1, 2); if (price == null) continue; // ціна в об'єднаній D:F → у D
      const g = ne[6];
      const avail = /\+/.test(g) ? "yes" : /закінч|нема|немає|відсут|знято/i.test(g) ? "no" : "soon";
      const model = /deye|felicity/i.test(b) ? b : (brand === "deye" ? "Deye " : "Felicity ") + b;
      const P = { price: { cash: price, cur: "$" } };
      if (category === "inv") { const s = parseInverter(model); items.push({ cat: "inv", model, sup: "Avtonomka", avail, ...s, ...P }); n++; }
      else { const s = parseBattery(model); items.push({ cat: "bat", model, sup: "Avtonomka", avail, ...s, ...P }); n++; }
    }
    console.log(`Avtonomka: ${n} позицій`);
  } catch (e) { console.warn("Avtonomka: " + e.message); }
  return items;
}

// ---------- Slavik (публічний gviz; 2 колонки: A=модель, B=ціна $; секції «Гібридні інвертори»/«Акумулятори») ----------
// Тільки Готівка ($). Беремо ТІЛЬКИ Deye + Felicity (Must/DAH Solar не додаємо). Колонки наявності немає → "soon" (уточнюйте).
const SLAVIK_ID = SRC.slavik;
async function slavik() {
  const items = [];
  if (!SLAVIK_ID) { console.log("Slavik: джерело вимкнене"); return items; }
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${SLAVIK_ID}/gviz/tq?tqx=out:csv`, { headers: { "user-agent": "Mozilla/5.0 (catalog-bot ESCORE)" }, redirect: "follow" });
    if (!res.ok) { console.warn("Slavik: HTTP " + res.status); return items; }
    const rows = parseCSV(await res.text());
    let category = null, n = 0;
    for (const cells of rows) {
      const a = normCell(cells[0]), al = a.toLowerCase();
      // рядок-секція: A=назва категорії, B не число («Ціна, $»)
      if (parsePrice(cells[1]) == null) {
        if (/інвертор/.test(al)) category = "inv";
        else if (/акумул/.test(al)) category = "bat";
        continue;
      }
      if (!category || a.length < 5) continue;
      if (!/deye|felicity/i.test(a)) continue; // тільки Deye + Felicity
      const price = roundP(parsePrice(cells[1]), 1, 2); if (price == null) continue;
      const P = { price: { cash: price, cur: "$" } };
      const avail = "soon"; // прайс без колонки наявності
      if (category === "inv") { const s = parseInverter(a); if (s.kw) { items.push({ cat: "inv", model: a, sup: "Slavik", avail, ...s, ...P }); n++; } }
      else { const s = parseBattery(a); items.push({ cat: "bat", model: a, sup: "Slavik", avail, ...s, ...P }); n++; }
    }
    console.log(`Slavik: ${n} позицій`);
  } catch (e) { console.warn("Slavik: " + e.message); }
  return items;
}

// ---------- Датащити з довідника katalog_obladnannya (публічний gviz CSV) ----------
// Anna веде датащити в таблиці; тут матчимо їх до позицій каталогу за КОДОМ моделі + потужністю.
const DS_SHEET = SRC.datasheets;
const sigLat = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); // лише латиниця+цифри (код моделі)
function refCode(name) { // найдовший токен з літерами+цифрами (у довіднику назви чисті)
  let best = "";
  for (const t of (name || "").split(/[\s,()/]+/)) {
    if (/[a-z]/i.test(t) && /\d/.test(t)) { const c = sigLat(t); if (c.length > best.length) best = c; }
  }
  return best;
}
async function datasheets() {
  const list = [];
  if (!DS_SHEET) { console.log("datasheets: джерело вимкнене"); return list; }
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${DS_SHEET}/gviz/tq?tqx=out:csv`, {
      headers: { "user-agent": "Mozilla/5.0 (catalog-bot ESCORE)" }, redirect: "follow",
    });
    if (!res.ok) { console.warn("datasheets: HTTP " + res.status); return list; }
    const rows = parseCSV(await res.text());
    const head = rows[0] || []; const col = (re) => head.findIndex((h) => re.test(h || ""));
    const iName = col(/назва/i), iDs = col(/датащит|datasheet/i), iTyp = col(/^тип$|^type$/i);
    if (iName < 0 || iDs < 0) { console.warn("datasheets: не знайдено колонок назва/датащит"); return list; }
    for (const r of rows.slice(1)) {
      const name = r[iName] || "", ds = (r[iDs] || "").trim();
      if (!/drive\.google|^https?:/i.test(ds)) continue;
      const code = refCode(name); if (code.length < 4) continue;
      const typ = (iTyp >= 0 ? r[iTyp] || "" : "").toLowerCase();
      const cat = /панел|модул/.test(typ) ? "pan" : /інверт|инверт/.test(typ) ? "inv" : /акум|батар/.test(typ) ? "bat" : null;
      list.push({ code, cat, ds, watt: parsePanelWatt(name), kw: parseInverter(name).kw, kwh: parseBattery(name).kwh });
    }
    console.log(`datasheets: ${list.length} рядків довідника`);
  } catch (e) { console.warn("datasheets: " + e.message); }
  return list;
}
function attachDatasheet(it, dsList) {
  const sig = sigLat(it.model), catCode = refCode(it.model);
  for (const d of dsList) {
    if (d.cat && d.cat !== it.cat) continue;
    const hit = sig.includes(d.code) || (catCode.length >= 8 && (d.code.includes(catCode) || catCode.includes(d.code)));
    if (!hit) continue;
    if (it.cat === "pan") { if (d.watt != null && it.watt != null && Math.abs(d.watt - it.watt) > 25) continue; } // серія (JAM54D40 465/470/475…) — один datasheet, тому допуск ±25 Вт, а не точний збіг
    else if (it.cat === "inv") { if (d.kw != null && it.kw != null && d.kw !== it.kw) continue; }
    else if (it.cat === "bat") { if (d.kwh != null && it.kwh != null && Math.abs(d.kwh - it.kwh) > 0.3) continue; }
    return d.ds;
  }
  return null;
}

// ---------- main ----------
async function main() {
  const prev = JSON.parse(readFileSync("catalog.json", "utf8"));
  const live = await yugtorg();
  let liveAtmo = [];
  try { liveAtmo = await atmo(); } catch (e) { console.warn("Atmo failed: " + e.message); }
  let liveSheets = [];
  try { liveSheets = await sheets(); } catch (e) { console.warn("sheets failed: " + e.message); }
  let liveRatech = [];
  try { liveRatech = await ratech(); } catch (e) { console.warn("RaTech failed: " + e.message); }
  let liveAvto = [];
  try { liveAvto = await avtonomka(); } catch (e) { console.warn("Avtonomka failed: " + e.message); }
  let liveSlavik = [];
  try { liveSlavik = await slavik(); } catch (e) { console.warn("Slavik failed: " + e.message); }
  const allLive = [...live, ...liveAtmo, ...liveSheets, ...liveRatech, ...liveAvto, ...liveSlavik];
  // будь-який постачальник, що дав живі дані, замінює свій сид; хто не відповів — лишається зі снимка
  const gotSups = new Set(allLive.map((i) => i.sup));
  const DROP = new Set(["Helius"]); // постачальники, повністю виключені з каталогу (і з живого збору, і зі снимка)
  const seed = (prev.items || []).filter((i) => !gotSups.has(i.sup) && !DROP.has(i.sup));
  const items = [...seed, ...allLive].filter((i) => !DROP.has(i.sup));
  const dsList = await datasheets(); // довідник датащитів (Anna веде в katalog_obladnannya)
  let dsCount = 0;
  for (const it of items) {
    // Перезбираємо посилання на datasheet КОЖНОГО прогону, а не лише для позицій без нього —
    // тоді виправлення в таблиці-довіднику доходять і до позицій, що лежать у знімку (Altek/Vimmer).
    // Якщо збігу немає — лишається те, що вже було.
    { const ds = attachDatasheet(it, dsList) || datasheetFor(it); if (ds) it.ds = ds; }
    if (it.ds) dsCount++;
    delete it.brand;
  }
  const out = { generated: new Date().toISOString().slice(0, 10), note: "Постачальники вживу: YugTorg, Atmo, Sakoenergy, Intersolar, SunRise, Price H, RaTech, Avtonomka, Slavik, Solarity (дзеркало). Altek/Vimmer — снимок. Бренди: Deye + Felicity. Ціни: Готівка/ПДВ під постачальника, Solarity −5%.", items };
  writeFileSync("catalog.json", JSON.stringify(out, null, 1));
  console.log(`catalog.json: ${items.length} позицій (сид ${seed.length} + YugTorg ${live.length} + Atmo ${liveAtmo.length} + таблиці ${liveSheets.length}); датащитів ${dsCount}`);
}
main();
