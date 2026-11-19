// MapaCaminos.jsx
import { useEffect, useRef, useState } from "react";
import CaminosLayer from "./CaminosLayer";

const CENTRO = [-36.62, -64.29];   // Santa Rosa
const ZOOM = 13;

export default function MapaCaminos() {
  const contRef = useRef(null);
  const [ready, setReady] = useState(!!window.L);
  const [map, setMap] = useState(null);

  // Leaflet desde CDN, igual que en FleetTracker
  useEffect(() => {
    if (window.L) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    script.onload = () => setReady(true);
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    if (!ready || !contRef.current) return;
    const L = window.L;
    const m = L.map(contRef.current, { zoomControl: false }).setView(CENTRO, ZOOM);
    L.control.zoom({ position: "bottomleft" }).addTo(m);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
    }).addTo(m);
    setMap(m);
    return () => { setMap(null); m.remove(); };
  }, [ready]);

  return (
    <div style={{ position: "relative", height: "100vh" }}>
      <div ref={contRef} style={{ height: "100%" }} />
      <CaminosLayer map={map} visible modo="consolidado" />
    </div>
  );
}