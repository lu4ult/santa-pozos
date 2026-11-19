import { useState, useEffect, useMemo } from "react";
import {
  CONFIG, NIVELES,
  clasificarHistorial, segmentosParaMapa, eventosParaMapa,
} from "./caminoSeveridad.js";

// ── Valores ajustables ────────────────────────────────────────────────────────
// Dos fuentes, se elige con la prop `modo`:
//   "consolidado": el backend ya clasifica y consolida, cada tramo de calle viene una sola vez ({ segs, eventos }).
//   "raw":         array de puntos crudos de los últimos 7 días, se clasifica acá (como antes).
const BASE_URL = "https://rai-backend-production.up.railway.app/alltrack/caminos";
const URL_POR_MODO = { consolidado: BASE_URL, raw: `${BASE_URL}/raw` };
const ETIQUETA_MODO = { consolidado: "Consolidado", raw: "Puntos (raw)" };
const DATOS_VACIOS = { segs: [], eventos: [] };
const REFRESCO_MS = 60 * 1000;   // mientras la capa está activa, se vuelve a pedir cada tanto
const NIVELES_LEYENDA = ["excelente", "bueno", "complicado", "precaucion", "intransitable",
  //  "sin_dato"
];

// Advertencia de lomo de burro (igual que en HistorialPlayer)
const SVG_LOMO = `<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 0 2px rgba(0,0,0,.6))"><polygon points="12,2 23,21 1,21" fill="#f59e0b" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/><rect x="11" y="8.5" width="2" height="6.5" fill="#111827"/><rect x="11" y="16.5" width="2" height="2" fill="#111827"/></svg>`;
const makeIconLomo = () => window.L.divIcon({ className: "", html: SVG_LOMO, iconSize: [20, 20], iconAnchor: [10, 12] });

function fmt(ms) {
  return new Date(ms).toLocaleDateString("es-AR", {
    day: "2-digit", month: "2-digit",
  });
}

const css = `
  .leaflet-tooltip.ft-cam-tip {
    background: rgba(11,15,26,.85); color: #e5e7eb;
    border: 1px solid rgba(255,255,255,.14); box-shadow: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px; padding: 1px 6px;
  }
  .ft-cam-leg {
    position: absolute; top: 10px; left: 10px; z-index: 900;
    display: flex; flex-direction: column; gap: 4px;
    background: rgba(17,24,39,.9); border: 1px solid rgba(255,255,255,.14);
    border-radius: 8px; padding: 8px 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10px; color: #9aa4b2;
    backdrop-filter: blur(4px);
  }
  .ft-cam-chip { display: flex; align-items: center; gap: 6px; }
  .ft-cam-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .ft-cam-err { color: #e53e3e; }
  .ft-cam-modo { color: #e5e7eb; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
`;

//TODO importante: a futuro, con más datos, analizar cómo optimizar el tooltip de leaflet, ahora que pasamos de guardar datos de cada dos segundos, a cada segundo.
// formato compacto del backend (/raw) -> formato que usa caminoSeveridad.js
const aFormatoFront = (p) => ({
  t: p.t,
  patente: p.pat,
  latitud: p.lat,
  longitud: p.lng,
  speed: p.speed,
  ubicacion: p.loc,
  camino: { rough: p.rough, peak_g: p.peak_g, n: p.n },
});

// Capa con el estado de las calles.
// map: instancia de Leaflet. visible: si la capa se dibuja (y si se pide al backend).
// modo: "consolidado" (tramos consolidados con las últimas pasadas) o "raw" (puntos, últimos 7 días).
export default function CaminosLayer({ map, visible, modo = "consolidado" }) {
  const [datos, setDatos] = useState(DATOS_VACIOS);   // modo consolidado. segs: [{ desde, hasta, nivel, indice, speed, t, pasadas, metros }]
  const [puntos, setPuntos] = useState([]);           // modo raw. [{ t, patente, latitud, longitud, speed, ubicacion, camino }]
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState(false);

  // ── Panes propios (los crea antes de que se dibuje nada) ────────────────────
  // 390: debajo de las estelas en vivo (overlayPane 400). 590: debajo de los marcadores de vehículos (600).
  useEffect(() => {
    if (!map) return;
    if (!map.getPane("caminosTrails")) map.createPane("caminosTrails").style.zIndex = 390;
    if (!map.getPane("caminosMarkers")) map.createPane("caminosMarkers").style.zIndex = 590;
  }, [map]);

  // ── Carga: solo mientras está visible ───────────────────────────────────────
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    // al cambiar de modo (o al reabrir) se vacía lo anterior, para no mostrar datos del otro modo mientras carga
    setDatos(DATOS_VACIOS);
    setPuntos([]);
    setCargado(false);
    setError(false);

    const cargar = async () => {
      try {
        const res = await fetch(URL_POR_MODO[modo]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        if (modo === "raw") {
          setPuntos(Array.isArray(json?.datos) ? json.datos.map(aFormatoFront) : []);
        } else {
          setDatos({
            segs: Array.isArray(json?.segs) ? json.segs : [],
            eventos: Array.isArray(json?.eventos) ? json.eventos : [],
          });
        }
        setError(false);
        setCargado(true);
      } catch (e) {
        if (cancelled) return;
        console.error("Error cargando caminos:", e);
        setError(true);
      }
    };

    cargar();
    const id = setInterval(cargar, REFRESCO_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [visible, modo]);

  // ── Tramos con color ────────────────────────────────────────────────────────
  // raw: se clasifica acá (misma lógica que HistorialPlayer). consolidado: ya viene clasificado del backend.
  const severidad = useMemo(() => {
    if (modo === "raw") {
      const porPatente = clasificarHistorial(puntos, CONFIG);
      const segs = [];
      const eventos = [];
      Object.values(porPatente).forEach((pts) => {
        segs.push(...segmentosParaMapa(pts, CONFIG).filter((s) => !s.discontinuo && s.nivel !== "sin_dato"));
        eventos.push(...eventosParaMapa(pts));
      });
      return { segs, eventos };
    }
    const segs = datos.segs
      .filter((s) => NIVELES[s.nivel])
      .map((s) => ({ ...s, color: NIVELES[s.nivel].color }));
    return { segs, eventos: datos.eventos };
  }, [modo, puntos, datos]);

  // ── Dibujo ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const L = window.L;
    if (!map || !L || !visible || !severidad.segs.length) return;

    const fmtIdx = (v) => (v == null ? "—" : v.toFixed(3));
    const tramos = severidad.segs.map((s) =>
      L.polyline([s.desde, s.hasta], {
        pane: "caminosTrails", color: s.color, weight: 6, opacity: 0.9,
        dashArray: s.discontinuo ? "4 8" : null, lineCap: "butt",
      }).bindTooltip(
        `${NIVELES[s.nivel].etiqueta} · índice ${fmtIdx(s.indice)} · ${Math.round(s.speed ?? 0)} km/h`,
        { className: "ft-cam-tip", sticky: true }
      )
    );
    const pozos = severidad.eventos.filter((e) => e.tipo === "pozo").map((e) =>
      L.circleMarker([e.lat, e.lng], {
        pane: "caminosTrails", radius: e.peak_g >= CONFIG.POZO_GRAVE_G ? 8 : 6,
        color: "#ffffff", weight: 1.5, fillColor: "#111827", fillOpacity: 1,
      }).bindTooltip(
        `Pozo · ${e.peak_g} g · ${Math.round(e.speed ?? 0)} km/h · ${fmt(e.t)}`,
        { className: "ft-cam-tip" }
      )
    );
    const lomos = severidad.eventos.filter((e) => e.tipo === "lomo").map((e) =>
      L.marker([e.lat, e.lng], {
        pane: "caminosMarkers", icon: makeIconLomo(), keyboard: false,
      }).bindTooltip(
        `Lomo de burro · ${e.peak_g} g · ${Math.round(e.speed ?? 0)} km/h · ${fmt(e.t)}`,
        { className: "ft-cam-tip" }
      )
    );

    const layer = L.layerGroup([...tramos, ...pozos, ...lomos]).addTo(map);
    return () => map.removeLayer(layer);
  }, [map, severidad, visible]);

  // ── Leyenda ─────────────────────────────────────────────────────────────────
  if (!visible) return null;

  return (
    <>
      <style>{css}</style>
      <div className="ft-cam-leg">
        <span className="ft-cam-modo">{ETIQUETA_MODO[modo]}</span>
        {error && <span className="ft-cam-err">No se pudieron cargar los caminos</span>}
        {!error && !cargado && <span>Cargando caminos…</span>}
        {!error && cargado && severidad.segs.length === 0 && <span>Sin datos de camino</span>}
        {severidad.segs.length > 0 && (
          <>
            {NIVELES_LEYENDA.map((k) => (
              <span key={k} className="ft-cam-chip">
                <span className="ft-cam-dot" style={{ background: NIVELES[k].color }} />
                {NIVELES[k].etiqueta}              </span>
            ))}
            <span className="ft-cam-chip">
              <span className="ft-cam-dot" style={{ background: "#111827", border: "1px solid #fff" }} />
              Pozo
            </span>
            <span className="ft-cam-chip">
              <svg width="12" height="12" viewBox="0 0 24 24"><polygon points="12,2 23,21 1,21" fill="#f59e0b" stroke="#fff" strokeWidth="2" strokeLinejoin="round" /></svg>
              Lomo
            </span>
          </>
        )}
      </div>
    </>
  );
}
