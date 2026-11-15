/* ==========================================================
   2. CONFIGURACIÓN: lo más probable que quieras cambiar.
   ========================================================== */
const CONFIG = {
  MAPBOX_TOKEN: 'pk.eyJ1IjoiMzUyMzExMDQzNCIsImEiOiJjbXdneXpybXUwNGJhMnpwdGFzbWJiODhxIn0.7lbpDTZa6dPpYccvQGv1ZA',                 // Pega aquí tu token público (pk...) o ingrésalo desde la pantalla de inicio
  DEFAULT_VIEW: { center: [-100, 20], zoom: 1.7 },
  STYLES: {
    dark:    'mapbox://styles/mapbox/dark-v11',
    sat:     'mapbox://styles/mapbox/satellite-streets-v12',
    terrain: 'mapbox://styles/mapbox/outdoors-v12'
  },
  SPIN_DEG_PER_SEC: 1.5,            // Velocidad de rotación del globo
  SPIN_MAX_ZOOM: 3.2,               // Por encima de este zoom el globo deja de girar
  LIVE_EVERY_MS: 7000,              // Cada cuánto llega un foco nuevo en modo Live
  PREDICT_API: '',                  // Dirección del back-end de predicción (vacío = ecuación local de prueba)
  DEMO_DAYS: 60                     // Días de datos de demostración
};

/* Sustituye esta función por tu fuente real (NASA FIRMS, BigQuery, tu API...).
   Debe devolver un GeoJSON de puntos con estas propiedades:
   day (días desde 1970), date 'AAAA-MM-DD', time 'HH:MM', sev 1-5, frp (MW),
   conf (%), sensor ('VIIRS' o 'MODIS'), region (texto). */
async function loadHotspots() {
  return buildDemoData();
}

/* ---------- Utilidades ---------- */
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pad = n => String(n).padStart(2, '0');
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m, d) / 864e5);
const now0 = new Date();
const TODAY = dayNum(now0.getFullYear(), now0.getMonth(), now0.getDate());
const dayISO = n => new Date(n * 864e5).toISOString().slice(0, 10);
const fmtShort = n => { const [y, m, d] = dayISO(n).split('-'); return `${d}/${m}`; };
const fmtFull = n => { const [y, m, d] = dayISO(n).split('-'); return `${d}/${m}/${y}`; };
let SEV_NAMES, SRC, MESES, SRCN, COLS;
const sevColor = s => css('--sev-' + s);
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },

  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};

/* ==========================================================
   IDIOMA (ES / EN). Para añadir o corregir un texto fijo del HTML,
   agrégalo al diccionario EN (clave = texto en español, tal cual).
   Los textos que arma el código usan L('español','english').
   ========================================================== */
let lang = store.get('iris_lang');
if (lang !== 'es' && lang !== 'en') lang = /^en/i.test(navigator.language || '') ? 'en' : 'es';
const L = (es, en) => lang === 'en' ? en : es;
const LOC = () => lang === 'en' ? 'en-US' : 'es-MX';
const EN = {
  "Mapa global de focos de calor": "Global hotspot map",
  "Logo de IRIS": "IRIS logo",
  "Recibir focos nuevos en tiempo real": "Receive new hotspots in real time",
  "Mostrar focos nuevos en el mapa": "Show new hotspots on the map",
  "Línea del tiempo": "Timeline",
  "Predicción de riesgo (experimental)": "Risk prediction (experimental)",
  "Predicción": "Prediction",
  "Lenguaje": "Language",
  "En vivo": "Live",
  "Nuevo ⚠️": "New ⚠️",
  "Lugar o coordenadas (19.04, -98.2)": "Place or coordinates (19.04, -98.2)",
  "Buscar lugar o coordenadas": "Search place or coordinates",
  "Buscar": "Search",
  "Acercar": "Zoom in",
  "Alejar": "Zoom out",
  "Tipo de vista": "View type",
  "Globo": "Globe",
  "Mapa": "Map",
  "Ajustes": "Settings",
  "Filtros": "Filters",
  "Token de Mapbox": "Mapbox token",
  "Predicción experimental": "Experimental prediction",
  "Cerrar": "Close",
  "Quitar zona": "Remove area",
  "Estilo base": "Base style",
  "Oscuro": "Dark",
  "Satélite": "Satellite",
  "Terreno": "Terrain",
  "Manchas de calor (en vez de puntos)": "Heat blobs (instead of dots)",
  "Resaltar fronteras y costas": "Highlight borders and coastlines",
  "Avisos de focos nuevos": "New hotspot alerts",
  "Focos": "Hotspots",
  "Tamaño": "Size",
  "Opacidad": "Opacity",
  "Movimiento": "Motion",
  "Rotación automática del globo": "Auto-rotate globe",
  "Guardar": "Save",
  "Al guardar, la página se recarga con el nuevo token.": "Saving reloads the page with the new token.",
  "Restablecer vista": "Reset view",
  "Elige un año y un mes. Si quieres, también un día.": "Pick a year and a month. Optionally, a day too.",
  "🕒 Línea del tiempo": "🕒 Timeline",
  "🔥 Ir al foco más intenso": "🔥 Go to strongest hotspot",
  "✕ Volver a hoy": "✕ Back to today",
  "1 · Año": "1 · Year",
  "2 · Mes": "2 · Month",
  "3 · Día": "3 · Day",
  "(opcional)": "(optional)",
  "🔮 Predicción de riesgo": "🔮 Risk prediction",
  "Calcula el riesgo de incendio en la zona del centro del mapa. Por ahora usa una ecuación de prueba; después se conectará al back-end.": "Estimates fire risk for the area at the center of the map. For now it uses a test equation; it will connect to the back-end later.",
  "Calcular aquí": "Calculate here",
  "Quitar del mapa": "Remove from map",
  "Ver la ecuación": "View the equation",
  "T temperatura · H humedad · V viento · D días sin lluvia · S vegetación seca · F focos cercanos": "T temperature · H humidity · V wind · D days without rain · S dry vegetation · F nearby hotspots",
  "Reproducción terminada": "Playback finished",
  "¿Te gustaría ver el listado más detallado de los incendios de este mes?": "Would you like to see the detailed list of this month's fires?",
  "No, gracias": "No, thanks",
  "Sí, ver listado": "Yes, show list",
  "📋 Listado de incendios": "📋 Fire list",
  "Día": "Day",
  "© 2026 IRIS · Datos de demostración": "© 2026 IRIS · Demo data",
  "Coordenadas": "Coordinates",
  "Términos y condiciones": "Terms and conditions",
  "1. Uso informativo": "1. Informational use",
  "IRIS muestra focos de calor con fines informativos. No sustituye a protección civil, bomberos ni a ninguna autoridad. En una emergencia llama al número oficial de tu país (en México, 911).": "IRIS shows heat hotspots for informational purposes only. It does not replace civil protection, firefighters or any authority. In an emergency, call your country's official number (in Mexico, 911).",
  "2. Datos de demostración": "2. Demo data",
  "Mientras no se conecte la fuente real (NASA FIRMS u otra), los focos, la línea del tiempo y la predicción son simulados y no representan incendios reales.": "Until the real source (NASA FIRMS or another) is connected, the hotspots, timeline and prediction are simulated and do not represent real fires.",
  "3. Precisión": "3. Accuracy",
  "Los datos satelitales pueden tener retraso, errores de ubicación o falsos positivos (por ejemplo fábricas o volcanes). No tomes decisiones de seguridad basándote solo en IRIS.": "Satellite data may be delayed, mislocated or contain false positives (for example factories or volcanoes). Do not make safety decisions based on IRIS alone.",
  "4. Predicción experimental": "4. Experimental prediction",
  "La predicción de riesgo es una función de prueba. Su resultado es una estimación y puede ser incorrecto.": "The risk prediction is a test feature. Its result is an estimate and may be wrong.",
  "5. Privacidad": "5. Privacy",
  "El token de Mapbox se guarda solo en tu navegador. Las búsquedas de lugares se envían a Mapbox y a OpenStreetMap para obtener resultados.": "The Mapbox token is stored only in your browser. Place searches are sent to Mapbox and OpenStreetMap to get results.",
  "6. Responsabilidad": "6. Liability",
  "El servicio se ofrece «tal cual», sin garantías. Los autores no se hacen responsables por daños derivados de su uso.": "The service is provided “as is”, without warranties. The authors are not liable for damages arising from its use.",
  "7. Cambios": "7. Changes",
  "Estos términos pueden actualizarse. Seguir usando IRIS implica aceptar la versión vigente.": "These terms may be updated. Continuing to use IRIS means accepting the current version.",
  "Texto base de ejemplo: pide que lo revise un abogado antes de publicar.": "Sample base text: have a lawyer review it before publishing.",
  "Entendido": "Got it",
  "Conecta tu mapa": "Connect your map",
  "IRIS usa Mapbox para dibujar el globo. Pega tu token público (empieza con": "IRIS uses Mapbox to draw the globe. Paste your public token (starts with",
  ") para continuar. Se guarda solo en este navegador.": ") to continue. It is saved only in this browser.",
  "Obtener un token en Mapbox": "Get a token from Mapbox",
  "Guardar y abrir el mapa": "Save and open the map",
  "California, EE. UU.": "California, USA",
  "Amazonia, Brasil": "Amazon, Brazil",
  "Sierra Madre, México": "Sierra Madre, Mexico",
  "Canadá boreal": "Boreal Canada",
  "Siberia, Rusia": "Siberia, Russia",
  "Mediterráneo": "Mediterranean",
  "África central": "Central Africa",
  "Chile central": "Central Chile",
  "Península ibérica": "Iberian Peninsula",
  "Volcán Popocatépetl, México": "Popocatépetl Volcano, Mexico",
  "Volcán Etna, Italia": "Mount Etna, Italy",
  "Volcán Kīlauea, Hawái": "Kīlauea Volcano, Hawaii",
  "Volcán Merapi, Indonesia": "Merapi Volcano, Indonesia",
  "Complejo industrial, Houston": "Industrial complex, Houston",
  "Complejo petroquímico, Jubail": "Petrochemical complex, Jubail",
  "Cuenca del Ruhr, Alemania": "Ruhr Valley, Germany",
  "Zona siderúrgica, Tangshan": "Steel district, Tangshan",
  "Sonda de Campeche, Golfo de México": "Bay of Campeche, Gulf of Mexico",
  "Mar del Norte": "North Sea",
  "Golfo Pérsico": "Persian Gulf",
  "Temperatura": "Temperature",
  "Humedad del aire": "Air humidity",
  "Viento": "Wind",
  "Días sin lluvia": "Days without rain",
  "Vegetación seca": "Dry vegetation",
  "Aire seco": "Dry air",
  "Focos cercanos": "Nearby hotspots",
  "días": "days",
  "Fecha": "Date",
  "Hora (UTC)": "Time (UTC)",
  "Lugar": "Place",
  "Latitud": "Latitude",
  "Longitud": "Longitude",
  "Intensidad": "Intensity",
  "Tipo": "Type"
};
const T = s => (lang === 'en' && Object.prototype.hasOwnProperty.call(EN, s)) ? EN[s] : s;
const U = u => u === ' días' ? ' ' + T('días') : u;
function buildLangData() {
  const en = lang === 'en';
  SEV_NAMES = en ? ['', 'Low', 'Moderate', 'High', 'Critical', 'Extreme'] : ['', 'Bajo', 'Moderado', 'Alto', 'Crítico', 'Extremo'];
  MESES = en ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
             : ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  SRCN = en ? { veg: 'Vegetation', vol: 'Active volcano', ind: 'Static (factories)', sea: 'Sea (oil spill)' }
            : { veg: 'Vegetación', vol: 'Volcán activo', ind: 'Estático (fábricas)', sea: 'Mar (derrame de petróleo)' };
  SRC = en ? { veg: '🌲 Vegetation', vol: '🌋 Active volcano', ind: '🏭 Static (factories)', sea: '🛢️ Sea (oil spill)' }
           : { veg: '🌲 Vegetación', vol: '🌋 Volcán activo', ind: '🏭 Estático (fábricas)', sea: '🛢️ Mar (derrame de petróleo)' };
  COLS = [T('Fecha'), T('Hora (UTC)'), T('Lugar'), T('Latitud'), T('Longitud'), T('Intensidad'), T('Tipo')];
}
buildLangData();
const dayLbl = d => lang === 'en' ? `${MESES[TL.m]} ${d}` : `${d} de ${MESES[TL.m]}`;
const dayOpts = () => `<option value="0">${L('Todo el mes', 'Whole month')}</option>` + Array.from({ length: dim(TL.y, TL.m) }, (_, i) => `<option value="${i + 1}">${dayLbl(i + 1)}</option>`).join('');
const NO_TR = '#filters,#tlM,#tlD,#tlS,#tlY,#tlP,#prOut,#prF,#ldT,#ldSub,#alerts,#areaName,#toast,#sug,#coords,script,style';
function translateDOM() {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), nodes = []; let n;
  while ((n = w.nextNode())) nodes.push(n);
  nodes.forEach(n => {
    const p = n.parentElement; if (!p || p.closest(NO_TR)) return;
    if (n.__es === undefined) { if (!n.nodeValue.trim()) return; n.__es = n.nodeValue; }
    const o = n.__es, k = o.trim();
    n.nodeValue = (lang === 'en' && Object.prototype.hasOwnProperty.call(EN, k)) ? o.replace(k, () => EN[k]) : o;
  });
  document.querySelectorAll('[title],[placeholder],[aria-label]').forEach(el => {
    if (el.closest(NO_TR)) return;
    ['title', 'placeholder', 'aria-label'].forEach(a => {
      if (!el.hasAttribute(a)) return; el.__es = el.__es || {};
      if (el.__es[a] === undefined) el.__es[a] = el.getAttribute(a);
      el.setAttribute(a, T(el.__es[a]));
    });
  });
}
function applyMapLang() {
  if (!map) return;
  try { map.getStyle().layers.forEach(l => {
    if (l.type !== 'symbol') return;
    const tf = map.getLayoutProperty(l.id, 'text-field'); if (!tf || !/name/.test(JSON.stringify(tf))) return;
    map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name_' + lang], ['get', 'name']]);
  }); } catch (e) {}
}
function setLang(l) {
  lang = l; store.set('iris_lang', l);
  document.documentElement.lang = l; document.documentElement.dataset.lang = l;
  buildLangData(); translateDOM();
  document.querySelectorAll('#lmenu button').forEach(b => b.setAttribute('aria-checked', b.dataset.l === l));
  renderFilters(); prInit(); $('prOut').innerHTML = '';
  if (TL.on) tlRender();
  if ($('listDlg').open) { const v = LD.d; $('ldDay').innerHTML = dayOpts(); $('ldDay').value = v; listRender(); }
  if (map && map.isStyleLoaded()) applyMapLang();
}
/* ---------- Coordenadas bajo el cursor ---------- */
let ptr = null;
function showCoords() {
  const el = $('coords'); if (!el || !map) return;
  if (!ptr) { el.textContent = '—'; return; }
  const ll = map.unproject(ptr), q = map.project(ll);
  if (!isFinite(ll.lat) || !isFinite(ll.lng) || Math.hypot(q.x - ptr.x, q.y - ptr.y) > 4) { el.textContent = '—'; return; }
  el.textContent = `${ll.lat.toFixed(4)}, ${(((ll.lng + 540) % 360) - 180).toFixed(4)}`;
}


/* ---------- Estado ---------- */
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const state = {
  start: TODAY - 6, end: TODAY, picking: false,
  sev: new Set([1, 2, 3, 4, 5]), src: new Set(['veg','vol','ind','sea']), pauseUntil: 0,
  live: true, spin: !reduceMotion, interacting: false,
  projection: 'globe', style: 'terrain', size: 1, opacity: 0.95,
  layers: { hot: false, heat: true, pred: false, warn: false },
  alerts: true, borders: true,
  viewY: now0.getFullYear(), viewM: now0.getMonth()
};
let map = null, HOTSPOTS = { type: 'FeatureCollection', features: [] }, RISK = { type: 'FeatureCollection', features: [] };
let liveTimer = null, toastTimer = null;

/* ==========================================================
   3. DATOS DE DEMOSTRACIÓN (no son lecturas reales de la NASA)
   ========================================================== */
const REGIONS = [
  { n: 'California, EE. UU.', c: [-120.5, 37.5], r: 2.6, w: 5 },
  { n: 'Amazonia, Brasil', c: [-58, -8.5], r: 5, w: 8 },
  { n: 'Bolivia', c: [-63, -16], r: 3, w: 3 },
  { n: 'Sierra Madre, México', c: [-105, 24], r: 3.5, w: 3 },
  { n: 'Canadá boreal', c: [-110, 56], r: 5, w: 4 },
  { n: 'Siberia, Rusia', c: [110, 60], r: 8, w: 4 },
  { n: 'Mediterráneo', c: [22, 39.5], r: 4, w: 3 },
  { n: 'África central', c: [22, -6], r: 8, w: 9 },
  { n: 'Australia', c: [146, -31], r: 5, w: 4 },
  { n: 'Indonesia', c: [113, -1.5], r: 4, w: 3 },
  { n: 'Chile central', c: [-71.5, -36], r: 1.8, w: 2 },
  { n: 'Península ibérica', c: [-6, 40], r: 2, w: 2 },
  { n: 'Volcán Popocatépetl, México', c: [-98.62, 19.02], r: .1, w: .5, t: 'vol' }, { n: 'Volcán Etna, Italia', c: [15, 37.75], r: .1, w: .5, t: 'vol' },
  { n: 'Volcán Kīlauea, Hawái', c: [-155.28, 19.41], r: .1, w: .5, t: 'vol' }, { n: 'Volcán Merapi, Indonesia', c: [110.44, -7.54], r: .1, w: .5, t: 'vol' },
  { n: 'Complejo industrial, Houston', c: [-95, 29.7], r: .3, w: .6, t: 'ind' }, { n: 'Complejo petroquímico, Jubail', c: [49.6, 27], r: .3, w: .6, t: 'ind' },
  { n: 'Cuenca del Ruhr, Alemania', c: [7, 51.4], r: .3, w: .6, t: 'ind' }, { n: 'Zona siderúrgica, Tangshan', c: [118.2, 39.6], r: .3, w: .6, t: 'ind' },
  { n: 'Sonda de Campeche, Golfo de México', c: [-92, 19.6], r: .8, w: .6, t: 'sea' }, { n: 'Mar del Norte', c: [2.5, 58], r: 1, w: .5, t: 'sea' },
  { n: 'Golfo Pérsico', c: [51.5, 27.5], r: 1, w: .5, t: 'sea' }
];
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const regF = (r, m) => 0.3 + 0.7 * (1 + Math.cos(2 * Math.PI * (m - (r.c[1] > 10 ? 6.5 : r.c[1] < -10 ? 9 : 8)) / 12)) / 2;
function pickRegion(rnd, m) {
  const w = r => r.w * (r.t || m == null ? 1 : regF(r, m)), total = REGIONS.reduce((s, r) => s + w(r), 0); let x = rnd() * total;
  for (const r of REGIONS) { if ((x -= w(r)) <= 0) return r; } return REGIONS[0];
}
const monthLoad = m => { const v = REGIONS.filter(r => !r.t); return v.reduce((s, r) => s + r.w * regF(r, m), 0) / v.reduce((s, r) => s + r.w, 0); };
function jitter(rnd, r) { return ((rnd() + rnd() + rnd()) / 3 - 0.5) * 2 * r; }
function pickSev(rnd) {
  const x = rnd() * 100; return x < 40 ? 1 : x < 68 ? 2 : x < 86 ? 3 : x < 96 ? 4 : 5;
}
function makeFeature(rnd, region, lng, lat, sev, day, time) {
  const sensor = rnd() < 0.62 ? 'VIIRS' : 'MODIS', frp = Math.round(4 + sev * sev * 13 * (0.4 + rnd()));
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [+lng.toFixed(4), +lat.toFixed(4)] },
    properties: {
      day, date: dayISO(day), time, sev, region: region.n, sensor,
      frp, ha: Math.round(frp * (2 + sev * 0.6)), src: region.t || 'veg',
      conf: Math.min(99, Math.round(55 + sev * 7 + rnd() * 10))
    }
  };
}
function genDay(day) {
  const m = new Date(day * 864e5).getUTCMonth(), rnd = mulberry32(day * 7919 + 13), out = [];
  const nc = Math.max(2, Math.round((8 + rnd() * 5) * (0.35 + monthLoad(m))));
  for (let k = 0; k < nc; k++) {
    const reg = pickRegion(rnd, m), cLng = reg.c[0] + jitter(rnd, reg.r), cLat = reg.c[1] + jitter(rnd, reg.r * 0.8);
    const base = pickSev(rnd), n = 3 + Math.floor(rnd() * 5), time = `${pad(Math.floor(rnd() * 24))}:${pad(Math.floor(rnd() * 60))}`;
    for (let i = 0; i < n; i++) out.push(makeFeature(rnd, reg, cLng + jitter(rnd, 0.28), cLat + jitter(rnd, 0.22), Math.max(1, Math.min(5, base + Math.round((rnd() - 0.5) * 2))), day, time));
  }
  return out;
}
function buildDemoData() { const f = []; for (let d = 0; d < CONFIG.DEMO_DAYS; d++) f.push(...genDay(TODAY - d)); return { type: 'FeatureCollection', features: f }; }
function buildRisk() {
  const rnd = mulberry32(777), feats = [];
  for (let i = 0; i < 70; i++) {
    const reg = pickRegion(rnd);
    feats.push({ type: 'Feature', properties: { risk: +(0.35 + rnd() * 0.65).toFixed(2) },
      geometry: { type: 'Point', coordinates: [reg.c[0] + jitter(rnd, reg.r * 1.3), reg.c[1] + jitter(rnd, reg.r) ] } });
  }
  return { type: 'FeatureCollection', features: feats };
}

/* ==========================================================
   4. MAPA (Mapbox GL JS)
   ========================================================== */
const heatRadius = S => ['interpolate', ['linear'], ['zoom'], 0, 3 * S, 3, 5 * S, 6, 14 * S, 9, 28 * S];
function radiusExpr(m) {
  return ['interpolate', ['linear'], ['zoom'],
    0, ['*', m, ['+', 1.2, ['*', 0.45, ['get', 'sev']]]],
    4, ['*', m, ['+', 2.5, ['*', 0.9, ['get', 'sev']]]],
    10, ['*', m, ['+', 7, ['*', 2, ['get', 'sev']]]]];
}
function sevMatch(out) {
  return ['match', ['get', 'sev'], 1, out[0], 2, out[1], 3, out[2], 4, out[3], 5, out[4], out[0]];
}
function currentFilter() {
  return ['all', ['>=', ['get', 'day'], state.start], ['<=', ['get', 'day'], state.end],
    ['in', ['get', 'sev'], ['literal', [...state.sev]]], ['in', ['get', 'src'], ['literal', [...state.src]]]];
}
function warnFilter() {
  return ['all', ['==', ['get', 'day'], TODAY], ['in', ['get', 'sev'], ['literal', [...state.sev]]], ['in', ['get', 'src'], ['literal', [...state.src]]]];
}

function warnImg() {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  x.font = '46px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('⚠️', 32, 34); return x.getImageData(0, 0, 64, 64);
}
function inFilter(f) {
  const p = f.properties; return p.day >= state.start && p.day <= state.end && state.sev.has(p.sev);
}

function addData() {
  const colors = [1, 2, 3, 4, 5].map(sevColor);
  if (!map.getSource('risk')) map.addSource('risk', { type: 'geojson', data: RISK });
  addBase();
  if (!map.getSource('hotspots')) map.addSource('hotspots', { type: 'geojson', data: curData() });

  map.addLayer({
    id: 'pred', type: 'circle', source: 'risk',
    layout: { visibility: state.layers.pred ? 'visible' : 'none' },
    paint: {
      'circle-color': css('--layer-prediction'),
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 16, 5, 60, 9, 140],
      'circle-blur': 0.9,
      'circle-opacity': ['*', 0.5, ['get', 'risk']]
    }
  });
  map.addLayer({
    id: 'heat', type: 'heatmap', source: 'hotspots', filter: currentFilter(),
    layout: { visibility: state.layers.heat ? 'visible' : 'none' },
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'sev'], 1, 0.15, 5, 0.8],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 3, 0.8, 6, 1.6],
      'heatmap-radius': heatRadius(1),
      'heatmap-opacity': 0.8,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(11,18,32,0)', 0.25, 'rgba(250,204,21,0.3)', 0.5, colors[1], 0.78, colors[2], 1, colors[3]]
    }
  });
  map.addLayer({
    id: 'hs-glow', type: 'circle', source: 'hotspots', filter: currentFilter(),
    layout: { visibility: state.layers.hot ? 'visible' : 'none' },
    paint: { 'circle-color': sevMatch(colors), 'circle-radius': radiusExpr(state.size * 2.6), 'circle-blur': 1, 'circle-opacity': 0.2 * state.opacity }
  });
  map.addLayer({
    id: 'hs-core', type: 'circle', source: 'hotspots', filter: currentFilter(),
    layout: { visibility: state.layers.hot ? 'visible' : 'none' },
    paint: {
      'circle-color': sevMatch(colors), 'circle-radius': radiusExpr(state.size), 'circle-opacity': state.opacity,
      'circle-stroke-color': ['case', ['==', ['get', 'sev'], 5], css('--sev-5-halo'), css('--bg')],
      'circle-stroke-width': ['case', ['==', ['get', 'sev'], 5], 1.6, 0.8]
    }
  });
  if (!map.hasImage('warn')) map.addImage('warn', warnImg(), { pixelRatio: 2 });
  map.addLayer({
    id: 'warn', type: 'symbol', source: 'hotspots', filter: warnFilter(),
    layout: { visibility: 'none', 'icon-image': 'warn', 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 5, 0.7, 10, 1] }
  });
  setLayerVisibility();
}

function applyFilters() {
  if (map && map.isStyleLoaded()) {
    const f = currentFilter();
    ['heat', 'hs-glow', 'hs-core'].forEach(id => { if (map.getLayer(id)) map.setFilter(id, f); });
    if (map.getLayer('warn')) map.setFilter('warn', warnFilter());
  }
  renderLegend(); renderFilters();
}
function setLayerVisibility() {
  const v = b => b ? 'visible' : 'none', set = (id, b) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v(b)); };
  set('hs-glow', !state.layers.heat); set('hs-core', true); set('heat', state.layers.heat); set('pred', state.layers.pred); set('warn', state.layers.warn);
  applyPaint();
}
function applyPaint() {
  if (!map.getLayer('hs-core')) return;
  const h = state.layers.heat, o = state.opacity, S = state.size, P = (id, k, v) => { if (map.getLayer(id)) map.setPaintProperty(id, k, v); };
  P('hs-core', 'circle-radius', radiusExpr(S)); P('hs-glow', 'circle-radius', radiusExpr(S * 2.6));
  P('hs-core', 'circle-opacity', h ? 0.01 : o); P('hs-core', 'circle-stroke-opacity', h ? 0 : o); P('hs-glow', 'circle-opacity', 0.2 * o);
  P('heat', 'heatmap-opacity', 0.8 * o); P('heat', 'heatmap-radius', heatRadius(S));
  if (map.getLayer('warn')) { map.setLayoutProperty('warn', 'icon-size', ['interpolate', ['linear'], ['zoom'], 0, 0.45 * S, 5, 0.7 * S, 10, S]); map.setPaintProperty('warn', 'icon-opacity', o); }
  ['iris-borders', 'iris-admin1'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', state.borders ? 'visible' : 'none'); });
}
function addSatEsri() {
  if (state.style !== 'sat') return;
  if (!map.getSource('esri')) {
    // Justo encima del satélite original, para que fronteras y etiquetas queden por encima
    const capas = map.getStyle().layers, i = capas.findIndex(l => l.id === 'satellite');
    const antesDe = i >= 0 ? capas[i + 1] : capas.find(l => l.type === 'line' || l.type === 'symbol');
    map.addSource('esri', {
      type: 'raster', tileSize: 256, maxzoom: 17,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Imágenes © Esri, Maxar, Earthstar Geographics'
    });
    map.addLayer({ id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-brightness-max': 0.75 } }, antesDe ? antesDe.id : undefined);
    try { map.setLayoutProperty('satellite', 'visibility', 'none'); } catch (err) { }
  }
  // Quitar ruido: calles, puntos de interés, ciudades menores
  const ocultar = /road|poi|transit|airport|settlement-minor|settlement-subdivision|natural|waterway|building|ferry|bridge|tunnel/;
  map.getStyle().layers.forEach(l => { if (ocultar.test(l.id) && l.type !== 'raster') map.setLayoutProperty(l.id, 'visibility', 'none'); });
}
function setFog() {
  if (state.style === 'terrain' || state.style === 'sat') {
    map.setFog({ color: 'rgb(40,60,60)', 'high-color': 'rgb(40,50,10)', 'horizon-blend': 0.1, 'space-color': 'rgb(5,0,8)', 'star-intensity': 0.9 });
    return;
  }
  map.setFog({
    color: 'rgb(20,28,46)', 'high-color': 'rgb(14,165,196)', 'horizon-blend': 0.08,
    'space-color': css('--bg'), 'star-intensity': state.style === 'sat' ? 0.6 : 0.4
  });
}

let spinT = null, pop = null, pinned = false; const geoCache = {};
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function stopSpin() { state.spin = false; $('mSpin').checked = false; clearTimeout(spinT); if (map) map.stop(); }
function spin() {
  if (!map || !state.spin || state.interacting || state.projection !== 'globe' || map.getZoom() > CONFIG.SPIN_MAX_ZOOM) return;
  const w = state.pauseUntil - Date.now(); if (w > 0) { clearTimeout(spinT); spinT = setTimeout(spin, w + 30); return; }
  const c = map.getCenter(); c.lng -= CONFIG.SPIN_DEG_PER_SEC; map.easeTo({ center: c, duration: 1000, easing: n => n });
}
async function placeName(c, id) {
  const k = c[1].toFixed(2) + ',' + c[0].toFixed(2); let t = geoCache[k];
  if (!t) { try { const r = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${c[0]},${c[1]}.json?types=locality,place,district,region&language=${lang}&limit=1&access_token=${mapboxgl.accessToken}`);
    const j = await r.json(); t = j.features && j.features[0] && j.features[0].place_name; if (t) geoCache[k] = t; } catch (e) {} }
  const el = $(id); if (t && el) el.textContent = t;
}
function popAnchor(pt) {
  const W = 300, H = 270, top = 125, bot = innerHeight - 40;
  const v = pt.y - top > H + 14 ? 'bottom' : bot - pt.y > H + 14 ? 'top' : '';
  const h = pt.x < W / 2 + 70 ? 'left' : innerWidth - pt.x < W / 2 + 30 ? 'right' : '';
  return [v, h].filter(Boolean).join('-') || (pt.x < innerWidth / 2 ? 'left' : 'right');
}
function showPopup(e, pin) {
  const f = e.features[0], p = f.properties, c = f.geometry.coordinates.slice(), id = 'z' + Math.random().toString(36).slice(2, 8);
  while (Math.abs(e.lngLat.lng - c[0]) > 180) c[0] += e.lngLat.lng > c[0] ? 360 : -360;
  if (pop) { pop.remove(); pop = null; } pinned = pin;
  const html = `<div class="pp" style="--c:${sevColor(p.sev)}"><div class="pp-h"><i></i>${SRC[p.src] || SRC.veg} · ${SEV_NAMES[p.sev]}</div>
    <dl><dt>${L('Coordenadas', 'Coordinates')}</dt><dd>${c[1].toFixed(3)}, ${c[0].toFixed(3)}</dd><dt>${L('Zona', 'Area')}</dt><dd id="${id}">${esc(T(p.region))}</dd>
    <dt>${L('Área quemada', 'Burned area')}</dt><dd>${(+p.ha).toLocaleString(LOC())} ha</dd><dt>${L('Detección', 'Detection')}</dt><dd>${p.sensor} · ${fmtFull(p.day)} ${p.time} UTC</dd>
    <dt>${L('Confianza', 'Confidence')}</dt><dd>${p.conf}%</dd><dt>FRP</dt><dd>${p.frp} MW</dd></dl><p class="pp-n">${L('Dato de demostración', 'Demo data')}</p></div>`;
  pop = new mapboxgl.Popup({ closeButton: pin, closeOnClick: false, offset: 12, className: 'iris-popup', maxWidth: '320px', anchor: popAnchor(map.project(c)) }).setLngLat(c).setHTML(html).addTo(map);
  if (pin) pop.on('close', () => { pinned = false; state.interacting = false; });
  placeName(c, id);
}
function initMap(token) {
  mapboxgl.accessToken = token;
  RISK = buildRisk();
  map = new mapboxgl.Map({
    container: 'map', style: CONFIG.STYLES[state.style], projection: state.projection,
    center: CONFIG.DEFAULT_VIEW.center, zoom: CONFIG.DEFAULT_VIEW.zoom, attributionControl: false
  });
  map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'top-right');

  map.on('style.load', () => {
    map.setProjection(state.projection);
    setFog(); addSatEsri(); addData(); styleBase(); applyMapLang(); renderLegend(); renderFilters();
    spin();
  });
  map.on('error', e => {
    const s = e && e.error && e.error.status;
    if (s === 401 || s === 403) { toast(L('El token de Mapbox no es válido. Revisa que empiece con pk.', 'The Mapbox token is not valid. Check that it starts with pk.'), true); $('tokenDlg').showModal(); }
  });
  ['dragstart', 'zoomstart', 'pitchstart', 'rotatestart'].forEach(ev => map.on(ev, e => { if (e.originalEvent) state.interacting = true; }));
  ['dragend', 'zoomend', 'pitchend', 'rotateend'].forEach(ev => map.on(ev, e => { state.interacting = pinned ? false : false; if (e.originalEvent) state.pauseUntil = Date.now() + 4000; spin(); }));
  map.on('moveend', spin);
  map.on('mousemove', e => { ptr = e.point; showCoords(); });
  map.on('click', e => { ptr = e.point; showCoords(); });
  map.on('move', () => { if (ptr) showCoords(); });
  map.getCanvas().addEventListener('mouseleave', () => { ptr = null; showCoords(); });
  map.on('mouseenter', 'hs-core', e => { map.getCanvas().style.cursor = 'pointer'; if (pinned) return; state.interacting = true; map.stop(); showPopup(e, false); });
  map.on('mouseleave', 'hs-core', () => { map.getCanvas().style.cursor = ''; if (pinned) return; if (pop) { pop.remove(); pop = null; } state.interacting = false; spin(); });
  map.on('click', 'hs-core', e => { stopSpin(); showPopup(e, true); });
  map.on('click', e => {
    const ls = ['hs-core', 'warn'].filter(id => map.getLayer(id));
    if (ls.length && map.queryRenderedFeatures(e.point, { layers: ls }).length) return;
    drill(e.lngLat);
  });
  map.on('click', 'warn', e => { stopSpin(); map.flyTo({ center: e.features[0].geometry.coordinates, zoom: 6, duration: 2200 }); });
  if (state.live) startLive();
}

/* ---------- Modo Live ---------- */
function startLive() {
  stopLive();
  if (state.end !== TODAY) { const len = state.end - state.start; state.end = TODAY; state.start = TODAY - len; applyFilters(); }
  liveTimer = setInterval(addLiveHotspot, CONFIG.LIVE_EVERY_MS);
}
function stopLive() { clearInterval(liveTimer); liveTimer = null; }
function addLiveHotspot() {
  if (!map || !map.getSource('hotspots') || TL.on) return;
  const rnd = Math.random, reg = pickRegion(rnd), d = new Date();
  const sev = Math.min(5, Math.max(1, pickSev(rnd) + (rnd() < 0.3 ? 1 : 0)));
  const f = makeFeature(rnd, reg, reg.c[0] + jitter(rnd, reg.r), reg.c[1] + jitter(rnd, reg.r * 0.8), sev, TODAY, `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`);
  HOTSPOTS.features.push(f);
  map.getSource('hotspots').setData(HOTSPOTS);
  const el = document.createElement('div'); el.className = 'pulse-w'; el.style.setProperty('--c', sevColor(sev)); el.innerHTML = '<div class="pulse"></div>';
  const mk = new mapboxgl.Marker({ element: el }).setLngLat(f.geometry.coordinates).addTo(map);
  setTimeout(() => mk.remove(), 6500);
  renderLegend();
  alertNew(f, reg, sev);
}

/* ==========================================================
   5. INTERFAZ
   ========================================================== */
function toast(msg, isError, go) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('error', !!isError); t.classList.toggle('link', !!go); t.classList.add('show');
  t.onclick = go ? () => { stopSpin(); map.flyTo({ center: go, zoom: 6, duration: 2200 }); t.classList.remove('show'); } : null;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), go ? 8000 : 4200);
}

function renderLegend() {
  if (!$('legend')) return;
  const counts = [0, 0, 0, 0, 0, 0];
  HOTSPOTS.features.forEach(f => { const p = f.properties; if (p.day >= state.start && p.day <= state.end && state.src.has(p.src)) counts[p.sev]++; });
  let total = 0; state.sev.forEach(s => total += counts[s]);
  $('legend').innerHTML = [1, 2, 3, 4, 5].map(s =>
    `<button class="chip" data-s="${s}" style="--c:${sevColor(s)}" aria-pressed="${state.sev.has(s)}"><i></i><b>${SEV_NAMES[s]}</b><small>${counts[s].toLocaleString(LOC())}</small></button>`
  ).join('') + `<span class="total"><strong>${total.toLocaleString(LOC())}</strong> focos en el rango</span><span class="demo">Datos de demostración</span>`;
}

function setRange(a, b) { state.start = a; state.end = b; state.picking = false; applyFilters(); }

function setProjection(p) {
  state.projection = p;
  $('vGlobe').setAttribute('aria-pressed', p === 'globe'); $('vFlat').setAttribute('aria-pressed', p !== 'globe');
  if (!map) return;
  map.setProjection(p);
  if (p === 'globe') spin(); else map.stop();
}

async function geocode(q, auto, n) {
  const c = map.getCenter(), px = map.getZoom() > 4 ? `&proximity=${c.lng.toFixed(3)},${c.lat.toFixed(3)}` : '';
  const r = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?limit=${n}&language=${lang}&fuzzyMatch=true&autocomplete=${auto}${px}&access_token=${mapboxgl.accessToken}`);
  return (await r.json()).features || [];
}
async function searchPlace() {
  const q = $('q').value.trim(); if (!q || !map) return;
  const m = q.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) { stopSpin(); map.flyTo({ center: [+m[2], +m[1]], zoom: 12, duration: 2200 }); return; }
  try {
    const f = (await geocode(q, false, 1))[0];
    if (!f) { toast(L(`No encontré «${q}». Prueba con otro nombre o con coordenadas.`, `I couldn't find “${q}”. Try another name or coordinates.`), true); return; }
    $('sug').hidden = true; goFeature(f);
  } catch (e) { toast(L('No se pudo buscar. Revisa tu conexión.', 'Search failed. Check your connection.'), true); }
}

/* ---------- Filtros, búsqueda predictiva, bordes satélite e índice ---------- */
function renderFilters() {
  const el = $('filters'); if (!el) return;
  el.innerHTML = '<h2>' + L('Intensidad del incendio', 'Fire intensity') + '</h2>' + [1, 2, 3, 4, 5].map(s => `<label class="chk"><input type="checkbox" data-s="${s}" ${state.sev.has(s) ? 'checked' : ''}><i style="--c:${sevColor(s)}"></i>${SEV_NAMES[s]}</label>`).join('')
    + '<h2>' + L('Origen del calor', 'Heat source') + '</h2>' + Object.entries(SRC).map(([k, v]) => `<label class="chk"><input type="checkbox" data-t="${k}" ${state.src.has(k) ? 'checked' : ''}>${v}</label>`).join('');
}
function togglePanel(id) {
  ['settings', 'filters'].forEach(p => { const el = $(p), open = p === id && el.hidden; el.hidden = !open; $(p === 'settings' ? 'btnSettings' : 'btnFilters').setAttribute('aria-expanded', open); });
}
let sugF = [], sugT = null;
async function suggest() {
  const q = $('q').value.trim(), b = $('sug'); if (q.length < 2 || !map) { b.hidden = true; return; }
  try {
    sugF = await geocode(q, true, 6);
    b.innerHTML = sugF.map((f, i) => `<button data-i="${i}"><b>${esc(f.text)}</b> <small>${esc(f.place_name.replace(f.text + ', ', ''))}</small></button>`).join(''); b.hidden = !sugF.length;
  } catch (e) { b.hidden = true; }
}
function goFeature(f) {
  stopSpin(); $('sug').hidden = true; $('q').value = f.place_name;
  const t = (f.place_type || [])[0], fine = t === 'address' || t === 'poi';
  DR.l = TYPES.indexOf(t) >= 0 ? TYPES.indexOf(t) : (fine ? TYPES.length : 2); DR.bbox = f.bbox || null;
  if (fine) map.flyTo({ center: f.center, zoom: 17, pitch: 0, duration: 2400 });
  else if (f.bbox) map.fitBounds(f.bbox, { padding: 90, duration: 2400, maxZoom: t === 'neighborhood' ? 16 : 13 });
  else map.flyTo({ center: f.center, zoom: 13, duration: 2400 });
  showArea(f, fine);
}
let areaMk = null, areaGJ = { type: 'FeatureCollection', features: [] };
/* ---------- Clic para bajar de nivel ---------- */
const TYPES = ['country', 'region', 'district', 'place', 'locality', 'neighborhood'], DR = { l: -1, bbox: null, busy: false, hint: false };
function ringIn(r, x, y) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function polyIn(p, x, y) { return ringIn(p[0], x, y) && !p.slice(1).some(h => ringIn(h, x, y)); }
function geomIn(g, x, y) { return g.type === 'Polygon' ? polyIn(g.coordinates, x, y) : g.type === 'MultiPolygon' ? g.coordinates.some(p => polyIn(p, x, y)) : false; }
function inCurrent(ll) {
  if (DR.l < 0) return false;
  if (areaGJ.features.length) return areaGJ.features.some(f => geomIn(f.geometry, ll.lng, ll.lat));
  const b = DR.bbox; return !!b && ll.lng >= b[0] && ll.lng <= b[2] && ll.lat >= b[1] && ll.lat <= b[3];
}
async function revGeo(ll, t) {
  const r = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${ll.lng},${ll.lat}.json?types=${t}&language=${lang}&limit=1&access_token=${mapboxgl.accessToken}`);
  return ((await r.json()).features || [])[0] || null;
}
async function drill(ll) {
  if (DR.busy || !map) return; DR.busy = true;
  try {
    const start = inCurrent(ll) ? DR.l + 1 : 0;
    if (start >= TYPES.length) { toast(L('Ya estás en el nivel más detallado.', 'You are already at the most detailed level.')); return; }
    for (let i = start; i < TYPES.length; i++) {
      const f = await revGeo(ll, TYPES[i]);
      if (f) { goFeature(f); if (!DR.hint) { DR.hint = true; toast(L('Vuelve a tocar dentro de la zona para ver el siguiente nivel.', 'Click again inside the area to go one level deeper.')); } return; }
    }
    toast(L('No hay más subdivisiones en este punto.', 'No further subdivisions at this point.'));
  } catch (e) { toast(L('No se pudo consultar la zona. Revisa tu conexión.', 'Could not look up the area. Check your connection.'), true); }
  finally { DR.busy = false; }
}
function setArea(gj, name) { areaGJ = gj; const s = map && map.getSource('area'); if (s) s.setData(gj); $('areaChip').hidden = !name; $('areaName').textContent = name || ''; }
function clearArea() { setArea({ type: 'FeatureCollection', features: [] }, ''); if (areaMk) { areaMk.remove(); areaMk = null; } }
async function showArea(f, fine) {
  clearArea(); const name = f.place_name; setArea(areaGJ, name);
  if (fine) { areaMk = new mapboxgl.Marker({ color: css('--accent') }).setLngLat(f.center).addTo(map); return; }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&polygon_threshold=0.0004&limit=3&accept-language=${lang}&q=${encodeURIComponent(name)}`);
    const hit = (await r.json()).find(x => x.geojson && /Polygon/.test(x.geojson.type));
    if (hit && $('areaName').textContent === name) setArea({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: hit.geojson }] }, name);
  } catch (e) {}
}
function addBase() {
  if (!map.getSource('area')) map.addSource('area', { type: 'geojson', data: areaGJ });
  try {
    if (!map.getSource('cb')) map.addSource('cb', { type: 'vector', url: 'mapbox://mapbox.country-boundaries-v1' });
    map.addLayer({ id: 'iris-borders', type: 'line', source: 'cb', 'source-layer': 'country_boundaries',
      filter: ['any', ['==', 'all', ['get', 'worldview']], ['in', 'US', ['get', 'worldview']]],
      layout: { visibility: state.borders ? 'visible' : 'none' },
      paint: { 'line-color': state.style === 'dark' ? '#8FB4E8' : state.style === 'terrain' ? '#5a4a40' : state.style === 'sat' ? '#c8ccd0' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 0, state.style === 'terrain' ? 0.6 : state.style === 'sat' ? 0.4 : 1, 5, state.style === 'terrain' ? 1.1 : state.style === 'sat' ? 0.8 : 1.8], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, state.style === 'terrain' ? 0.45 : state.style === 'sat' ? 0.4 : 0.9, 6.5, 0] } });
  } catch (e) {}
  try {
    if (!map.getSource('mbs')) map.addSource('mbs', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
    map.addLayer({ id: 'iris-admin1', type: 'line', source: 'mbs', 'source-layer': 'admin', minzoom: 1.8,
      filter: ['all', ['==', ['get', 'admin_level'], 1], ['==', ['get', 'maritime'], 'false'], ['any', ['!', ['has', 'worldview']], ['==', 'all', ['get', 'worldview']], ['in', 'US', ['get', 'worldview']]]],
      layout: { visibility: state.borders ? 'visible' : 'none', 'line-join': 'round' },
      paint: { 'line-color': state.style === 'dark' ? '#7C93BF' : state.style === 'terrain' ? '#5a4a40' : state.style === 'sat' ? '#c8ccd0' : '#ffffff', 'line-width': state.style === 'sat' ? ['interpolate', ['linear'], ['zoom'], 2, 0.3, 6, 0.7, 10, 1.2] : ['interpolate', ['linear'], ['zoom'], 2, 0.5, 6, 1.2, 10, 2],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 2, state.style === 'sat' ? 0.2 : 0.3, 4, state.style === 'terrain' ? 0.5 : state.style === 'sat' ? 0.4 : 0.7] } });
  } catch (e) {}
  map.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': css('--primary'), 'fill-opacity': 0.14 } });
  map.addLayer({ id: 'area-glow', type: 'line', source: 'area', paint: { 'line-color': css('--primary'), 'line-width': 10, 'line-blur': 8, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'area-line', type: 'line', source: 'area', layout: { 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 2.2 } });
}
function alertNew(f, reg, sev) {
  if (!state.alerts) return; const box = $('alerts'), el = document.createElement('button');
  el.className = 'al'; el.style.setProperty('--c', sevColor(sev));
  el.innerHTML = `<i></i><span><b>${L(`Nuevo foco ${SEV_NAMES[sev].toLowerCase()}`, `New ${SEV_NAMES[sev].toLowerCase()} hotspot`)}</b><small>${esc(T(reg.n))} · ${L('toca para verlo', 'tap to view')}</small></span><span class="x" aria-label="${L('Cerrar', 'Close')}">✕</span>`;
  el.onclick = e => { if (!e.target.closest('.x')) { stopSpin(); map.flyTo({ center: f.geometry.coordinates, zoom: 6, duration: 2200 }); } el.remove(); };
  box.prepend(el); while (box.children.length > 3) box.lastChild.remove(); setTimeout(() => el.remove(), 7000);
}
function styleBase() {
  const dk = state.style === 'dark', ter = false, sat = false;
  if (state.style === 'sat') { try { map.getStyle().layers.forEach(l => { if (l.type !== 'line' || !/^admin-[01]-boundary/.test(l.id)) return; map.setPaintProperty(l.id, 'line-opacity', /bg/.test(l.id) ? 0.15 : 0.4); map.setPaintProperty(l.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 1, 0.4, 8, 1]); }); } catch (e) {} return; }
  if (!dk) return;
  try { map.getStyle().layers.forEach(l => {
    if (dk && l.type === 'background') map.setPaintProperty(l.id, 'background-color', '#1C2742');
    if (dk && l.id === 'water') map.setPaintProperty(l.id, 'fill-color', '#070B16');
    if (l.type !== 'line' || !/^admin-[01]-boundary/.test(l.id)) return;
    const bg = /bg/.test(l.id), a0 = l.id.startsWith('admin-0'), k = a0 ? 1 : 0.6, w = ter ? 0.6 : 1;
    map.setPaintProperty(l.id, 'line-color', bg ? (sat ? '#000' : '#0B1220') : sat ? '#fff' : a0 ? '#B7CCF0' : '#6F86B3');
    map.setPaintProperty(l.id, 'line-opacity', bg ? (ter ? 0.25 : 0.55) : (ter ? 0.5 : 1));
    map.setPaintProperty(l.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 1, (bg ? 3 : 1.4) * k * w, 8, (bg ? 6 : 3.2) * k * w]);
  }); } catch (e) {}
}

/* ---------- Línea del tiempo ---------- */

const TL = { on: false, y: now0.getFullYear(), m: now0.getMonth(), d: 0, days: [], ky: '', timer: null, wasLive: false, built: false, fc: null };
const dim = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const curData = () => (TL.on && TL.fc) ? TL.fc : HOTSPOTS;
const tlStop = () => { clearInterval(TL.timer); TL.timer = null; };
function tlSet(o) {
  Object.assign(TL, o);
  const n = dim(TL.y, TL.m), first = dayNum(TL.y, TL.m, 1), key = TL.y + '-' + TL.m;
  if (TL.ky !== key) { TL.ky = key; TL.days = Array.from({ length: n }, (_, i) => first + i <= TODAY ? genDay(first + i) : []); }
  TL.fc = { type: 'FeatureCollection', features: TL.d ? TL.days[TL.d - 1] : TL.days.flat() };
  state.start = TL.d ? first + TL.d - 1 : first; state.end = TL.d ? state.start : first + n - 1;
  if (map && map.getSource('hotspots')) { map.getSource('hotspots').setData(TL.fc); applyFilters(); }
  tlRender();
}
function tlRender() {
  const Y = now0.getFullYear(), M = now0.getMonth(), D = now0.getDate(), n = dim(TL.y, TL.m), cnt = TL.days.map(a => a.length), mx = Math.max(1, ...cnt);
  document.querySelectorAll('#tlY [data-y]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.y === TL.y));
  $('tlM').innerHTML = MESES.map((s, i) => `<button data-m="${i}" aria-pressed="${i === TL.m}" ${TL.y === Y && i > M ? 'disabled' : ''} style="--t:${monthLoad(i).toFixed(2)}"><b>${s.slice(0, 3)}</b><i></i></button>`).join('');
  const pl = !!TL.timer; $('tl').classList.toggle('playing', pl);
  $('tlD').innerHTML = pl ? Array.from({ length: TL.d }, (_, i) => `<div class="pd" style="--t:${(cnt[i] / mx).toFixed(2)}"><b>${i + 1}</b><small>${cnt[i]}</small></div>`).join('')
    : `<button class="all" data-d="0" aria-pressed="${!TL.d}">${L('Todo el mes', 'Whole month')}</button>` + Array.from({ length: n }, (_, i) =>
    `<button data-d="${i + 1}" aria-pressed="${TL.d === i + 1}" ${TL.y === Y && TL.m === M && i + 1 > D ? 'disabled' : ''} style="--t:${(cnt[i] / mx).toFixed(2)}" title="${cnt[i]} ${L('focos', 'hotspots')}">${i + 1}</button>`).join('');
  const f = TL.fc.features, sv = [0, 0, 0, 0, 0, 0]; f.forEach(x => sv[x.properties.sev]++);
  const top = sv[5] ? 5 : sv[4] ? 4 : sv[3] ? 3 : sv[2] ? 2 : 1, title = TL.d ? (lang === 'en' ? `${MESES[TL.m]} ${TL.d}, ${TL.y}` : `${TL.d} de ${MESES[TL.m]} ${TL.y}`) : `${MESES[TL.m]} ${TL.y}`;
  $('tlS').innerHTML = f.length ? `<div class="big"><b>${f.length.toLocaleString(LOC())}</b><span>${L('focos', 'hotspots')} · ${title}</span></div>
    <div class="sv">${[1, 2, 3, 4, 5].map(s => `<i style="flex:${sv[s]};background:${sevColor(s)}" title="${SEV_NAMES[s]}: ${sv[s]}"></i>`).join('')}</div>
    <p>${TL.d ? '' : `${L('Día con más focos', 'Busiest day')}: <b>${cnt.indexOf(mx) + 1}</b> (${mx}). `}${L('Intensidad máxima', 'Peak intensity')}: <b style="color:${sevColor(top)}">${SEV_NAMES[top]}</b></p>`
    : `<div class="big"><b>0</b><span>${L('Aún no hay datos para esta fecha', 'No data for this date yet')}</span></div>`;
  $('tlP').textContent = TL.timer ? L('⏸ Pausar', '⏸ Pause') : L('▶ Reproducir mes', '▶ Play month');
  $('tlD').scrollLeft = TL.timer ? 1e5 : 0;
}
function tlOpen() {
  $('pred').hidden = true; $('btnPred').setAttribute('aria-pressed', false);
  TL.wasLive = state.live; if (state.live) { state.live = false; $('btnLive').setAttribute('aria-pressed', false); stopLive(); }
  TL.on = true; $('tl').hidden = false; $('btnTl').setAttribute('aria-pressed', true); document.body.classList.add('tl-open');
  if (!TL.built) { $('tlY').innerHTML = Array.from({ length: now0.getFullYear() - 1999 }, (_, i) => `<button data-y="${2000 + i}">${2000 + i}</button>`).join(''); TL.built = true; }
  TL.ky = ''; tlSet({});
  const c = document.querySelector('#tlY [aria-pressed="true"]'); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest' });
}
function tlExit() {
  tlStop(); if (!TL.on) return; TL.on = false; TL.fc = null; TL.ky = '';
  $('tl').hidden = true; $('btnTl').setAttribute('aria-pressed', false); document.body.classList.remove('tl-open');
  setRange(TODAY - 6, TODAY); if (map && map.getSource('hotspots')) map.getSource('hotspots').setData(HOTSPOTS);
  if (TL.wasLive) { state.live = true; $('btnLive').setAttribute('aria-pressed', true); startLive(); }
}
function tlPlay() {
  if (TL.timer) { tlStop(); return tlRender(); }
  const last = TL.y === now0.getFullYear() && TL.m === now0.getMonth() ? now0.getDate() : dim(TL.y, TL.m); TL.done = false;
  tlSet({ d: TL.d && TL.d < last ? TL.d : 1 });
  TL.timer = setInterval(() => { if (TL.d >= last) { tlStop(); TL.done = true; tlSet({ d: 0 }); return $('askDlg').showModal(); } tlSet({ d: TL.d + 1 }); }, 900);
  tlRender();
}
function tlClick(e) {
  const b = e.target.closest('button'); if (!b || b.disabled) return; const a = b.dataset;
  if (a.a === 'list') return listOpen(); if (a.a === 'play') return tlPlay(); if (a.a === 'exit') return tlExit();
  if (a.a === 'peak') { const t = TL.fc.features.reduce((p, q) => !p || q.properties.sev > p.properties.sev ? q : p, null); if (t) { stopSpin(); map.flyTo({ center: t.geometry.coordinates, zoom: 5, duration: 2200 }); } return; }
  tlStop(); TL.done = false;
  if (a.y) { const y = +a.y; tlSet({ y, d: 0, m: y === now0.getFullYear() ? Math.min(TL.m, now0.getMonth()) : TL.m }); }
  else if (a.m !== undefined) tlSet({ m: +a.m, d: 0 });
  else if (a.d !== undefined) tlSet({ d: +a.d });
}

/* ---------- Listado detallado y descargas ---------- */

const LD = { d: 0 };
function listRows() {
  const r = [];
  TL.days.forEach((a, i) => { if (LD.d && LD.d !== i + 1) return;
    a.slice().sort((x, y) => x.properties.time < y.properties.time ? -1 : 1).forEach(f => { const p = f.properties, c = f.geometry.coordinates;
      r.push({ [COLS[0]]: fmtFull(p.day), [COLS[1]]: p.time, [COLS[2]]: T(p.region), [COLS[3]]: c[1], [COLS[4]]: c[0], [COLS[5]]: SEV_NAMES[p.sev], [COLS[6]]: SRCN[p.src] || SRCN.veg, _s: p.sev }); }); });
  return r;
}
function listRender() {
  const r = listRows(), sh = r.slice(0, 1500);
  $('ldSub').textContent = `${MESES[TL.m]} ${TL.y}${LD.d ? L(' · día ', ' · day ') + LD.d : ''} · ${r.length.toLocaleString(LOC())} ${L('incendios', 'fires')}` + (r.length > sh.length ? L(` (se muestran ${sh.length}; la descarga incluye todos)`, ` (showing ${sh.length}; the download includes all)`) : '');
  $('ldT').innerHTML = `<thead><tr>${COLS.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>` + sh.map(o => `<tr>${COLS.map(c => c === COLS[5] ? `<td><i class="dot" style="background:${sevColor(o._s)}"></i>${o[c]}</td>` : `<td>${esc(o[c])}</td>`).join('')}</tr>`).join('') + '</tbody>';
}
function listOpen() {
  LD.d = TL.d; $('ldDay').innerHTML = dayOpts();
  $('ldDay').value = LD.d; listRender(); $('listDlg').showModal();
}
function dl(name, type, txt) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function listDownload(fmt) {
  const rows = listRows().map(({ _s, ...o }) => o), nm = `iris-incendios-${TL.y}-${pad(TL.m + 1)}${LD.d ? '-' + pad(LD.d) : ''}`;
  if (fmt === 'json') return dl(nm + '.json', 'application/json', JSON.stringify(rows, null, 2));
  if (fmt === 'csv') return dl(nm + '.csv', 'text/csv;charset=utf-8', '\ufeff' + [COLS, ...rows.map(o => COLS.map(c => o[c]))].map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n'));
  if (fmt === 'doc') return dl(nm + '.doc', 'application/msword', `<html><head><meta charset="utf-8"></head><body><h2>IRIS · ${L('Incendios', 'Fires')} ${MESES[TL.m]} ${TL.y}</h2><table border="1" cellspacing="0" cellpadding="4"><tr>${COLS.map(c => `<th>${c}</th>`).join('')}</tr>${rows.map(o => `<tr>${COLS.map(c => `<td>${esc(o[c])}</td>`).join('')}</tr>`).join('')}</table></body></html>`);
  if (window.XLSX) { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Incendios'); XLSX.writeFile(wb, nm + '.xlsx'); }
  else alert(L('No se pudo cargar la librería de Excel (¿sin internet?). Usa CSV: también abre en Excel.', 'Could not load the Excel library (offline?). Use CSV: it also opens in Excel.'));
}

/* ---------- Predicción (EXPERIMENTAL) ----------
   riskEquation() es la ecuación de prueba. Cuando exista el back-end, pon su dirección
   en CONFIG.PREDICT_API: la página le enviará los datos y espera { score: 0-100, terms: [{label, value}] }. */
const PRF = [['T', 'Temperatura', 5, 45, '°C'], ['H', 'Humedad del aire', 5, 100, '%'], ['V', 'Viento', 0, 80, ' km/h'], ['D', 'Días sin lluvia', 0, 40, ' días'], ['S', 'Vegetación seca', 0, 100, '%']];
const PR = { T: 30, H: 30, V: 20, D: 10, S: 0.6 };
const lvl = s => s < 20 ? 0 : s < 40 ? 1 : s < 60 ? 2 : s < 80 ? 3 : 4;
function riskEquation(i) {
  const t = [['Temperatura', 0.09 * (i.T - 28)], ['Aire seco', 0.04 * (35 - i.H)], ['Viento', 0.04 * (i.V - 15)], ['Días sin lluvia', 0.1 * (i.D - 7)], ['Vegetación seca', 1.5 * (i.S - 0.5)], ['Focos cercanos', 0.5 * Math.log(1 + i.F)]];
  const z = t.reduce((s, x) => s + x[1], -0.4);
  return { score: Math.round(100 / (1 + Math.exp(-z))), terms: t.map(([label, value]) => ({ label, value })) };
}
async function predictRisk(i) {
  if (CONFIG.PREDICT_API) { try { const r = await fetch(CONFIG.PREDICT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(i) }); if (r.ok) return await r.json(); } catch (e) {} }
  return riskEquation(i);
}
const nearbyFires = (lng, lat, r) => HOTSPOTS.features.filter(f => f.properties.day >= TODAY - 7 && Math.hypot(f.geometry.coordinates[0] - lng, f.geometry.coordinates[1] - lat) < r).length;
function prInit() {
  $('prF').innerHTML = PRF.map(([k, n, a, b, u]) => { const v = k === 'S' ? PR[k] * 100 : PR[k]; return `<div class="row"><label for="p${k}">${T(n)}</label><input id="p${k}" data-k="${k}" type="range" min="${a}" max="${b}" value="${v}"><output id="o${k}">${v}${U(u)}</output></div>`; }).join('');
  $('prF').oninput = e => { const k = e.target.dataset.k; if (!k) return; const v = +e.target.value; PR[k] = k === 'S' ? v / 100 : v; $('o' + k).textContent = v + U(PRF.find(x => x[0] === k)[4]); };
  $('prGo').onclick = prRun; $('prOff').onclick = () => { state.layers.pred = false; if (map) setLayerVisibility(); };
}
async function prRun() {
  if (!map) return; const c = map.getCenter(), F = nearbyFires(c.lng, c.lat, 0.6); $('prOut').innerHTML = '<p class="hint">' + L('Calculando…', 'Calculating…') + '</p>';
  const out = await predictRisk({ ...PR, F, lat: +c.lat.toFixed(3), lng: +c.lng.toFixed(3) }), li = lvl(out.score), mx = Math.max(0.01, ...out.terms.map(t => Math.abs(t.value)));
  $('prOut').innerHTML = `<div class="pr-s" style="--c:${sevColor(li + 1)}"><b>${out.score}</b><span>${L(`de 100 · riesgo ${SEV_NAMES[li + 1].toLowerCase()}`, `of 100 · ${SEV_NAMES[li + 1].toLowerCase()} risk`)}</span></div>`
    + out.terms.map(t => `<div class="pr-t"><span>${esc(T(t.label))}</span><u><i class="${t.value < 0 ? 'neg' : ''}" style="width:${Math.abs(t.value) / mx * 100}%"></i></u></div>`).join('')
    + `<p class="hint">${L('Naranja = sube el riesgo · azul = lo baja. Focos cercanos (7 días)', 'Orange = raises risk · blue = lowers it. Nearby hotspots (7 days)')}: ${F}.</p>`;
  const f = []; for (let gx = -5; gx <= 5; gx++) for (let gy = -5; gy <= 5; gy++) {
    const x = c.lng + gx * 0.3, y = c.lat + gy * 0.3, w = Math.sin(gx * 12.98 + gy * 78.23) * 2;
    f.push({ type: 'Feature', properties: { risk: riskEquation({ ...PR, T: PR.T + w, F: nearbyFires(x, y, 0.4) }).score / 250 }, geometry: { type: 'Point', coordinates: [x, y] } });
  }
  RISK = { type: 'FeatureCollection', features: f }; map.getSource('risk').setData(RISK); state.layers.pred = true; setLayerVisibility();
}

function resetAll() {
  if (TL.on) tlExit();
  if (map) { map.flyTo({ center: CONFIG.DEFAULT_VIEW.center, zoom: CONFIG.DEFAULT_VIEW.zoom, pitch: 0, bearing: 0, duration: 1800 }); setFog(); }
  setRange(TODAY - 6, TODAY);
}

function bindUI() {
  const lm = $('lmenu'), langMenu = o => { lm.hidden = !o; $('btnLang').setAttribute('aria-expanded', o); };
  $('btnLang').onclick = e => { e.stopPropagation(); langMenu(lm.hidden); };
  lm.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; setLang(b.dataset.l); langMenu(false); });
  document.addEventListener('click', e => { if (!e.target.closest('.langwrap')) langMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') langMenu(false); });
  const placeAlerts = () => { const al = $('alerts'); const b = [$('sug'), lm].filter(x => !x.hidden).map(x => x.getBoundingClientRect().bottom); al.style.top = b.length ? (Math.max(...b) + 10) + 'px' : ''; };
  new MutationObserver(placeAlerts).observe($('sug'), { attributes: true, attributeFilter: ['hidden'], childList: true });
  new MutationObserver(placeAlerts).observe(lm, { attributes: true, attributeFilter: ['hidden'] });
  addEventListener('resize', placeAlerts);
  $('zin').onclick = () => map && map.zoomIn(); $('zout').onclick = () => map && map.zoomOut();
  $('vGlobe').onclick = () => setProjection('globe'); $('vFlat').onclick = () => setProjection('mercator');

  $('btnLive').onclick = e => { if (TL.on) { TL.wasLive = false; tlExit(); }
    state.live = !state.live; e.currentTarget.setAttribute('aria-pressed', state.live);
    if (state.live) { startLive(); toast(L('Live encendido: recibirás focos nuevos.', 'Live on: you will receive new hotspots.')); } else { stopLive(); toast(L('Live en pausa.', 'Live paused.')); }
  };
  $('btnNews').onclick = e => {
    state.layers.warn = !state.layers.warn; e.currentTarget.setAttribute('aria-pressed', state.layers.warn); if (map) setLayerVisibility();
    toast(state.layers.warn ? L('⚠️ Mostrando focos nuevos de hoy. Toca uno para ir a él.', '⚠️ Showing today’s new hotspots. Tap one to fly to it.') : L('Focos nuevos ocultos.', 'New hotspots hidden.'));
  };
  $('btnTl').onclick = () => TL.on ? tlExit() : tlOpen();
  $('btnPred').onclick = () => { const o = $('pred').hidden; if (TL.on) tlExit(); $('pred').hidden = !o; $('btnPred').setAttribute('aria-pressed', o); };
  $('tl').addEventListener('click', tlClick);
  $('btnTerms').onclick = () => $('termsDlg').showModal();
  $('areaX').onclick = () => { clearArea(); DR.l = -1; DR.bbox = null; };
  $('sAlerts').onchange = e => { state.alerts = e.target.checked; if (!state.alerts) $('alerts').innerHTML = ''; };
  $('sBorders').onchange = e => { state.borders = e.target.checked; if (map) applyPaint(); };
  prInit(); $('sStyle').value = state.style; $('sHeat').checked = state.layers.heat;
  $('ldX').onclick = () => $('listDlg').close(); $('askNo').onclick = () => $('askDlg').close(); $('askYes').onclick = () => { $('askDlg').close(); listOpen(); }; $('ldDay').onchange = e => { LD.d = +e.target.value; listRender(); };
  document.querySelector('.ld-dl').onclick = e => { const b = e.target.closest('button'); if (b) listDownload(b.dataset.f); };
  $('filters').addEventListener('change', e => {
    const c = e.target, a = c.dataset.s !== undefined, set = a ? state.sev : state.src, key = a ? +c.dataset.s : c.dataset.t;
    if (c.checked) set.add(key); else if (set.size > 1) set.delete(key); else toast(L('Deja al menos una opción activa.', 'Keep at least one option active.'));
    applyFilters();
  });
  $('btnFilters').onclick = () => togglePanel('filters');
  $('sHeat').onchange = e => { state.layers.heat = e.target.checked; state.layers.hot = !e.target.checked; if (map) setLayerVisibility(); };
  $('sug').addEventListener('click', e => { const b = e.target.closest('button'); if (b) goFeature(sugF[+b.dataset.i]); });
  $('q').addEventListener('input', () => { clearTimeout(sugT); sugT = setTimeout(suggest, 250); });
  document.addEventListener('click', e => { if (!e.target.closest('#search')) $('sug').hidden = true; });

  const search = $('search');
  $('btnSearch').onclick = () => {
    if (!search.classList.contains('open')) { search.classList.add('open'); $('q').focus(); }
    else if ($('q').value.trim()) searchPlace(); else search.classList.remove('open');
  };
  $('q').addEventListener('keydown', e => { if (e.key === 'Enter') { if (sugF.length && !$('sug').hidden) goFeature(sugF[0]); else searchPlace(); } if (e.key === 'Escape') search.classList.remove('open'); });

  $('btnSettings').onclick = e => {
    togglePanel('settings');
  };
  $('sStyle').onchange = e => { state.style = e.target.value; if (map) map.setStyle(CONFIG.STYLES[state.style], { diff: false }); };
  $('rSize').oninput = e => { state.size = +e.target.value; $('vSize').textContent = Math.round(state.size * 100) + '%'; if (map) applyPaint(); };
  $('rOp').oninput = e => { state.opacity = +e.target.value; $('vOp').textContent = Math.round(state.opacity * 100) + '%'; if (map) applyPaint(); };
  $('mSpin').checked = state.spin;
  $('mSpin').onchange = e => { state.spin = e.target.checked; if (state.spin) spin(); else if (map) map.stop(); };
  $('btnToken').onclick = () => { const v = $('sToken').value.trim(); if (v) { store.set('iris_mapbox_token', v); location.reload(); } };
  $('btnReset').onclick = resetAll;

  $('dTokenSave').onclick = () => {
    const v = $('dToken').value.trim(); if (!v) return;
    store.set('iris_mapbox_token', v);
    if (map) location.reload(); else { $('tokenDlg').close(); start(v); }
  };
  $('dToken').addEventListener('keydown', e => { if (e.key === 'Enter') $('dTokenSave').click(); });
}

/* ---------- Arranque ---------- */
function start(token) { initMap(token); }
bindUI(); setLang(lang);
(async () => {
  HOTSPOTS = await loadHotspots(); renderLegend();
  const token = CONFIG.MAPBOX_TOKEN || store.get('iris_mapbox_token');
  if (token) { $('sToken').value = token; start(token); }
  else $('tokenDlg').showModal();
})();
