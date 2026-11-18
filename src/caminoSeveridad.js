// caminoSeveridad.js
//
// Clasifica qué tan "poseada" está la calle a partir de los puntos que traen
// `camino` ({ rough, peak_g, n }), que solo manda el equipo con MPU.
//
// No mide la superficie (tierra o asfalto): mide cuánto se sacude el vehículo.
// Sin dependencias ni variables de entorno: todos los valores están en CONFIG
// para ajustarlos a mano a medida que se sumen recorridos.
//
// Índice base: rough / √velocidad. Dividir por la velocidad sobrecorrige; con
// √v el asfalto bueno da ~0.009 a 14, 28 y 40 km/h.
//
// Uso típico (FleetTracker, visor de historial):
//
//   const porPatente = clasificarHistorial(puntosDelHistorial);
//   const pts = porPatente['AG760SD'] || [];
//   segmentosParaMapa(pts).forEach((s) =>
//     L.polyline([s.desde, s.hasta], {
//       color: s.color, weight: 6, opacity: 0.9,
//       dashArray: s.discontinuo ? '4 8' : null,
//     }).addTo(capa));
//   eventosParaMapa(pts).forEach((e) => { /* marcador de lomo o pozo */ });


export const CONFIG = {
  // --- Puntos válidos para calcular el índice ---
  VEL_MIN_KMH: 10, // por debajo de esto el dato no es confiable
  N_MIN: 60, // muestras mínimas del MPU por fix (lo normal es ~88)

  // --- Suavizado (mediana móvil) ---
  VENTANA_PUNTOS: 3,
  VENTANA_MAX_S: 10, // no mezclar puntos separados por más de esto
  MIN_VALIDOS: 2, // puntos válidos mínimos dentro de la ventana

  // --- Cortes del índice rough/√v (provisorios) ---
  NORMALIZAR: true, // true: índice = rough/√v; false: rough crudo, sin corregir por velocidad
  CORTE_EXCELENTE: 0.015, // menor o igual: excelente (ruta nueva medida: mediana ~0.013)
  CORTE_BUENO: 0.018, // menor o igual: bueno
  CORTE_PRECAUCION: 0.028, // mayor: mucha precaución (o intransitable)

  // --- Golpes ---
  EVENTO_G: 1.0, // desde este peak_g un golpe cuenta como pozo
  LOMO_G_MIN: 0.5, // un lomo se acepta desde este peak_g (más bajo que un pozo) si además hay frenada
  POZO_GRAVE_G: 1.5, // golpe grave, cuenta para "intransitable"
  POZOS_INTRANSITABLE: 2, // golpes graves cerca, en la misma pasada
  RADIO_INTRANSITABLE_M: 100,
  GOLPES_INTRANSITABLE: 3, // o esta cantidad de golpes (cualquier pozo, desde EVENTO_G) a menos de RADIO_GOLPES_M: calle destrozada, con el índice ya en "mucha precaución"
  RADIO_GOLPES_M: 150,
  PASADA_MAX_S: 60, // dos golpes son de la misma pasada si están a menos de esto

  // --- Lomo vs pozo ---
  LOMO_CAIDA_VEL: 0.25, // frenó al menos 25% respecto de los puntos previos
  LOMO_VENTANA_S: 8,
  LOMO_PUNTOS_PREVIOS: 4, //en 2, lo aumentamos a 4 cuando aumentos los registros de cada 2 segundos a cada segundo.
  LOMO_VECINOS: 5,

  // --- Segmentos para el mapa ---
  GAP_SEGMENTO_S: 3, // más de esto entre dos puntos: tramo sin dato
  SEGMENTO_MIN_M: 2, // no dibujar tramos más cortos (vehículo quieto). Con un punto por segundo, 5 m dejaba afuera todo lo que va a menos de ~18 km/h
};

// Versión SIN normalizar: mismo algoritmo, pero el índice es el rough tal cual
// viene del equipo. Los cortes son los de arriba llevados a 30 km/h
// (0.018·√30 ≈ 0.10 y 0.028·√30 ≈ 0.15), así que coinciden con la versión
// normalizada a esa velocidad y se separan a medida que la velocidad cambia.
export const CONFIG_CRUDO = Object.assign({}, CONFIG, {
  NORMALIZAR: false,
  CORTE_EXCELENTE: 0.082, // 0.015·√30
  CORTE_BUENO: 0.1,
  CORTE_PRECAUCION: 0.15,
});

export const NIVELES = {
  excelente: { id: 'excelente', etiqueta: 'Excelente', color: '#00c853', orden: 0 },
  bueno: { id: 'bueno', etiqueta: 'Bueno', color: '#23894d', orden: 1 },
  complicado: { id: 'complicado', etiqueta: 'Complicado', color: '#e6b800', orden: 2 },
  precaucion: { id: 'precaucion', etiqueta: 'Mucha precaución', color: '#f07d1a', orden: 3 },
  intransitable: { id: 'intransitable', etiqueta: 'Intransitable', color: '#d11a2a', orden: 4 },
  // sin_dato: { id: 'sin_dato', etiqueta: 'Sin dato', color: '#9aa0a6', orden: -1 },
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
const R_TIERRA_M = 6371000;

export function distanciaM(lat1, lon1, lat2, lon2) {
  const dy = (lat2 - lat1) * RAD * R_TIERRA_M;
  const dx = (lon2 - lon1) * RAD * R_TIERRA_M * Math.cos(((lat1 + lat2) / 2) * RAD);
  return Math.sqrt(dx * dx + dy * dy);
}

function mediana(valores) {
  const v = valores.slice().sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Acepta `t` (ms, como el logger) o `timestamp` (ISO, como dataCombinada).
function tiempoMs(p) {
  if (typeof p.t === 'number') return p.t;
  if (p.timestamp != null) {
    const ms = new Date(p.timestamp).getTime();
    if (isFinite(ms)) return ms;
  }
  return null;
}

function cercaEnTiempo(a, b, maxS) {
  if (a == null || b == null) return true; // sin tiempo no se puede descartar
  return Math.abs(a - b) <= maxS * 1000;
}

// ---------------------------------------------------------------------------
// Índice por punto
// ---------------------------------------------------------------------------

// rough / √v, o null si el punto no sirve (sin camino, pocas muestras o lento).
// Si `n` no viene (datos viejos) se acepta igual.
export function indicePunto(p, cfg) {
  cfg = cfg || CONFIG;
  const c = p.camino;
  if (!c || typeof c.rough !== 'number') return null;
  if (typeof c.n === 'number' && c.n < cfg.N_MIN) return null;
  if (!(p.speed >= cfg.VEL_MIN_KMH)) return null;
  return cfg.NORMALIZAR === false ? c.rough : c.rough / Math.sqrt(p.speed);
}

// ---------------------------------------------------------------------------
// Lomo o pozo
// ---------------------------------------------------------------------------

// Lomo: el vehículo venía frenando y la calle de alrededor es lisa.
// Sin contexto suficiente se asume pozo (lo más prudente).
function esLomo(pts, i, cfg) {
  const p = pts[i];
  if (!(p.speed > 0)) return false;

  let vPrevMax = 0;
  for (let k = 1; k <= cfg.LOMO_PUNTOS_PREVIOS && i - k >= 0; k++) {
    const q = pts[i - k];
    if (!cercaEnTiempo(p.t, q.t, cfg.LOMO_VENTANA_S)) break;
    if (q.speed > vPrevMax) vPrevMax = q.speed;
  }
  if (vPrevMax <= 0) return false;
  if ((vPrevMax - p.speed) / vPrevMax < cfg.LOMO_CAIDA_VEL) return false;

  const vecinos = [];
  for (let j = Math.max(0, i - cfg.LOMO_VECINOS); j <= Math.min(pts.length - 1, i + cfg.LOMO_VECINOS); j++) {
    if (j === i) continue;
    const q = pts[j];
    if (q.indice == null) continue;
    if (!cercaEnTiempo(p.t, q.t, cfg.VENTANA_MAX_S)) continue;
    if (q.camino && q.camino.peak_g >= cfg.EVENTO_G) continue;
    vecinos.push(q.indice);
  }
  if (vecinos.length < cfg.MIN_VALIDOS) return false;
  return mediana(vecinos) <= cfg.CORTE_BUENO;
}

// ---------------------------------------------------------------------------
// Clasificación de un recorrido (un solo vehículo)
// ---------------------------------------------------------------------------

// `puntos`: [{ latitud, longitud, speed, camino: { rough, peak_g, n }, t | timestamp }]
// Devuelve los mismos puntos, ordenados por tiempo y sin repetidos, con:
//   indice       rough/√v del punto (o null)
//   indiceSuave  mediana móvil (o null)
//   nivel        'excelente' | 'bueno' | 'complicado' | 'precaucion' | 'intransitable' | 'sin_dato'
//   evento       { tipo: 'lomo' | 'pozo', peak_g } si hubo un golpe puntual
export function clasificarRecorrido(puntos, cfg) {
  cfg = cfg || CONFIG;

  const ordenados = puntos
    .map((p) => ({ p, t: tiempoMs(p) }))
    .sort((a, b) => (a.t == null ? 0 : a.t) - (b.t == null ? 0 : b.t));

  // 1) ordenar, descartar repetidos y calcular el índice
  const pts = [];
  for (let k = 0; k < ordenados.length; k++) {
    const p = ordenados[k].p;
    const t = ordenados[k].t;
    const prev = pts[pts.length - 1];
    if (prev && prev.t === t && prev.latitud === p.latitud && prev.longitud === p.longitud) continue;
    const q = Object.assign({}, p, { t: t });
    q.indice = indicePunto(q, cfg);
    pts.push(q);
  }

  // 2) mediana móvil
  for (let i = 0; i < pts.length; i++) {
    const vals = [];
    const desde = Math.max(0, i - cfg.VENTANA_PUNTOS);
    const hasta = Math.min(pts.length - 1, i + cfg.VENTANA_PUNTOS);
    for (let j = desde; j <= hasta; j++) {
      const q = pts[j];
      if (q.indice == null) continue;
      if (!cercaEnTiempo(pts[i].t, q.t, cfg.VENTANA_MAX_S)) continue;
      vals.push(q.indice);
    }
    pts[i].indiceSuave = vals.length >= cfg.MIN_VALIDOS ? mediana(vals) : null;
  }

  // 3) golpes puntuales
  for (let i = 0; i < pts.length; i++) {
    const g = pts[i].camino ? pts[i].camino.peak_g : null;
    if (typeof g !== 'number' || g < cfg.LOMO_G_MIN) continue;
    if (esLomo(pts, i, cfg)) pts[i].evento = { tipo: 'lomo', peak_g: g };
    else if (g >= cfg.EVENTO_G) pts[i].evento = { tipo: 'pozo', peak_g: g };
  }

  // 4) nivel de cada punto
  const pozos = pts.filter((q) => q.evento && q.evento.tipo === 'pozo');
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const s = p.indiceSuave;
    if (s == null) {
      p.nivel = 'sin_dato';
    } else if (s > cfg.CORTE_PRECAUCION) {
      // intransitable: varios golpes graves muy cerca, o muchos golpes (graves o no) en un tramo corto, en la misma pasada
      let graves = 0;
      let golpes = 0;
      for (let k = 0; k < pozos.length; k++) {
        const g = pozos[k];
        if (!cercaEnTiempo(p.t, g.t, cfg.PASADA_MAX_S)) continue;
        const d = distanciaM(p.latitud, p.longitud, g.latitud, g.longitud);
        if (d <= cfg.RADIO_GOLPES_M) golpes++;
        if (d <= cfg.RADIO_INTRANSITABLE_M && g.evento.peak_g >= cfg.POZO_GRAVE_G) graves++;
      }
      p.nivel = graves >= cfg.POZOS_INTRANSITABLE || golpes >= cfg.GOLPES_INTRANSITABLE ? 'intransitable' : 'precaucion';
    } else {
      p.nivel = s > cfg.CORTE_BUENO ? 'complicado' : s > cfg.CORTE_EXCELENTE ? 'bueno' : 'excelente';
    }
  }

  return pts;
}

// Para el visor de historial: recibe los puntos de todos los vehículos y
// devuelve { patente: [puntos clasificados] } solo para los que traen `camino`
// (hoy, el equipo con MPU).
export function clasificarHistorial(puntos, cfg) {
  const porPatente = {};
  for (let i = 0; i < puntos.length; i++) {
    const p = puntos[i];
    if (!p.camino) continue;
    if (!porPatente[p.patente]) porPatente[p.patente] = [];
    porPatente[p.patente].push(p);
  }
  const salida = {};
  Object.keys(porPatente).forEach((pat) => {
    salida[pat] = clasificarRecorrido(porPatente[pat], cfg);
  });
  return salida;
}

// ---------------------------------------------------------------------------
// Salidas para el mapa
// ---------------------------------------------------------------------------

function peorNivel(x, y) {
  if (x === 'sin_dato') return y;
  if (y === 'sin_dato') return x;
  return NIVELES[x].orden >= NIVELES[y].orden ? x : y;
}

// Un tramo por cada par de puntos consecutivos, listo para L.polyline.
// Un tramo con nivel 'sin_dato' (gris) NO significa calle buena: significa que
// no hay datos confiables ahí (muy lento, pocas muestras o corte de señal).
export function segmentosParaMapa(pts, cfg) {
  cfg = cfg || CONFIG;
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = distanciaM(a.latitud, a.longitud, b.latitud, b.longitud);
    if (d < cfg.SEGMENTO_MIN_M) continue;
    const gapS = a.t != null && b.t != null ? (b.t - a.t) / 1000 : 0;
    const hayGap = gapS > cfg.GAP_SEGMENTO_S;
    const nivel = hayGap ? 'sin_dato' : peorNivel(a.nivel, b.nivel);
    segs.push({
      desde: [a.latitud, a.longitud],
      hasta: [b.latitud, b.longitud],
      nivel: nivel,
      color: NIVELES[nivel].color,
      discontinuo: hayGap,
      metros: d,
      indice: a.indiceSuave != null && b.indiceSuave != null ? (a.indiceSuave + b.indiceSuave) / 2 : null,
      speed: b.speed,
      t: b.t,
    });
  }
  return segs;
}

// Marcadores de lomos y pozos.
export function eventosParaMapa(pts) {
  return pts
    .filter((p) => p.evento)
    .map((p) => ({
      lat: p.latitud,
      lng: p.longitud,
      tipo: p.evento.tipo,
      peak_g: p.evento.peak_g,
      speed: p.speed,
      t: p.t,
    }));
}

// Metros recorridos por nivel (para chequear que la clasificación tenga sentido).
export function metrosPorNivel(segmentos) {
  const out = {};
  segmentos.forEach((s) => {
    out[s.nivel] = (out[s.nivel] || 0) + s.metros;
  });
  return out;
}
