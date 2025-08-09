import React, { CSSProperties, useEffect, useRef, useState } from "react";
import {
  BrowserMultiFormatReader,
  IScannerControls,
  BarcodeFormat,
  DecodeHintType,
} from "@zxing/browser";

// === nastav svoju Vercel URL (končí /api/evaluate) ===
const EVAL_URL = "https://radka-celiakia.vercel.app/api/evaluate";

type EvalStatus = "safe" | "avoid" | "maybe";
type HistoryItem = { code: string; brand: string; name: string; status: EvalStatus; ts: number };

const ACCENT = "#7c3aed";

// ===== Pretty styles =====
const page: CSSProperties = { minHeight: "100vh", background: "linear-gradient(180deg,#f8fafc,#f6f5ff)", padding: 16 };
const container: CSSProperties = { maxWidth: 820, margin: "0 auto" };
const card = (extra?: CSSProperties): CSSProperties => ({
  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 16, padding: 16,
  boxShadow: "0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -4px rgba(0,0,0,0.06)", ...extra
});
const chip = (extra?: CSSProperties): CSSProperties => ({
  fontSize: 12, background: "#f5f3ff", color: "#4c1d95", padding: "6px 10px",
  borderRadius: 999, border: "1px solid #ddd6fe", fontWeight: 600, ...extra
});
const btnBase: CSSProperties = {
  padding: "10px 14px", borderRadius: 12, border: "1px solid #e5e7eb",
  cursor: "pointer", transition: "transform .06s, box-shadow .12s, background .2s"
};
const btn = (extra?: CSSProperties): CSSProperties => ({
  ...btnBase, background: "#fff", boxShadow: "0 1px 2px rgba(16,24,40,.06), 0 1px 1px rgba(16,24,40,.04)", ...extra
});
const btnPrimary = (disabled?: boolean): CSSProperties => ({
  ...btnBase,
  background: disabled ? "linear-gradient(90deg,#e5e7eb,#e5e7eb)" : `linear-gradient(90deg, ${ACCENT}, #a78bfa)`,
  color: disabled ? "#6b7280" : "#fff", border: "none",
  boxShadow: disabled ? "none" : "0 10px 15px -3px rgba(124,58,237,.35)"
});

// ===== App =====
export default function App() {
  // UI / data
  const [scanning, setScanning] = useState(false);
  const [barcode, setBarcode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [product, setProduct] = useState<any>(null);
  const [evaluation, setEvaluation] = useState<EvalStatus | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try { return JSON.parse(localStorage.getItem("radka_scan_history") || "[]") } catch { return [] }
  });

  // Camera
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [preferBack, setPreferBack] = useState(true);

  // Scanner internals
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastCodeRef = useRef<string | null>(null);
  const lastScanTsRef = useRef(0);

  useEffect(() => {
    try { localStorage.setItem("radka_scan_history", JSON.stringify(history.slice(0,50))) } catch {}
  }, [history]);

  // zisti kamery / preferuj zadnú
  useEffect(() => {
    (async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        const cams = all.filter(d => d.kind === "videoinput");
        setDevices(cams);
        if (!deviceId) {
          const back = cams.find(c => /back|rear|environment/i.test(c.label));
          const front = cams.find(c => /front|user/i.test(c.label));
          setDeviceId((preferBack ? back?.deviceId : front?.deviceId) ?? cams[0]?.deviceId ?? null);
        }
      } catch {/* ignore */}
    })();
  }, [preferBack]); // keď prepneš preferenciu, pokúsime sa vybrať inú kameru

  // Start/Stop scanning
  useEffect(() => {
    if (!scanning) return;

    let stopped = false;

    const start = async () => {
      try {
        // formáty, ktoré nás zaujímajú
        const formats = [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128];
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);

        const reader = new BrowserMultiFormatReader(hints, 400);

        // ak nemáme konkrétne deviceId, použijeme undefined (pre auto výber)
        const id = deviceId ?? undefined;

        controlsRef.current = await reader.decodeFromVideoDevice(id, videoRef.current!, (result) => {
          if (!result || stopped) return;
          const code = result.getText().trim();
          if (!code) return;
          const now = Date.now();
          if (code === lastCodeRef.current && now - lastScanTsRef.current < 1200) return; // debounce duplicitného čítania

          lastCodeRef.current = code;
          lastScanTsRef.current = now;

          stopped = true;
          try { controlsRef.current?.stop(); } catch {}
          setScanning(false);
          setBarcode(code);
          fetchProduct(code);
        });
      } catch (e) {
        setError("Nepodarilo sa spustiť kameru.");
        setScanning(false);
      }
    };

    start();

    // cleanup
    return () => {
      try { controlsRef.current?.stop(); } catch {}
    };
  }, [scanning, deviceId]);

  function toggleCamera() {
    if (!devices.length) return;
    setPreferBack(v => !v);
    setDeviceId(null);
    if (scanning) setScanning(false); // bezpečné vypnutie, nech si ju znova zapneš
  }

  // --- OFF + AI fallback ---
  async function fetchProduct(code: string) {
    if (!code) return;
    setLoading(true); setError(null); setProduct(null); setEvaluation(null); setNotes([]);

    try {
      // 1) Open Food Facts
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`);
      const ok = res.ok;
      const data = ok ? await res.json() : null;

      if (!ok || !data || data.status !== 1 || !data.product) {
        // OFF nič -> skús AI iba s EAN (môže vrátiť len "maybe")
        await aiEvaluate(null);
        return;
      }

      const p = data.product;
      setProduct(p);

      // lokálna heuristika
      const ev = evaluateProduct(p);
      setEvaluation(ev.status);
      setNotes(ev.notes);

      // ak je neisté -> spýtame sa AI
      if (ev.status === "maybe") {
        await aiEvaluate(p);
      }

      // história
      setHistory(h => ([
        { code, brand: p.brands || "", name: p.product_name || p.generic_name || "Neznámy produkt", status: ev.status, ts: Date.now() },
        ...h.filter(x => x.code !== code)
      ]).slice(0,50));
    } catch (e: any) {
      setError(e?.message || "Neznáma chyba");
    } finally {
      setLoading(false);
    }
  }

  async function aiEvaluate(p: any | null) {
    try {
      if (!EVAL_URL || EVAL_URL.includes("<tvoje-vercel>")) return; // ešte si nenastavil URL
      const payload = p ? {
        name: p.product_name || p.generic_name || "",
        brand: p.brands || "",
        ingredients: p.ingredients_text_sk || p.ingredients_text || p.ingredients_text_en || "",
        labels: p.labels || (p.labels_tags || []).join(", "),
        traces: p.traces || (p.traces_tags || []).join(", "),
      } : { name: "", brand: "", ingredients: "", labels: "", traces: "" };

      const r = await fetch(EVAL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const ai = await r.json();

      if (ai?.status) {
        setEvaluation(ai.status as EvalStatus);
        if (Array.isArray(ai.notes) && ai.notes.length) {
          setNotes(prev => [...prev, ...ai.notes]);
        } else {
          setNotes(prev => [...prev, "Doplnené AI hodnotením."]);
        }
      }
    } catch {
      // ticho – ostane pôvodný výsledok
    }
  }

  // === heuristika OFF (mlieko/lepok) + gluten-free fix ===
  function evaluateProduct(p: any): { status: EvalStatus; notes: string[] } {
    const notes: string[] = [];

    const allergenTags: string[] = p.allergens_tags || [];
    const hasGlutenTag = allergenTags.some((t: string) => /(^|:)gluten$/i.test(t));
    const hasMilkTag = allergenTags.some((t: string) => /(^|:)milk$/i.test(t));

    const ingrAnalysis: string[] = p.ingredients_analysis_tags || [];
    const maybeGluten = ingrAnalysis.some((t: string) => /may-contain-gluten/i.test(t));

    const ingredientsText = (p.ingredients_text_sk || p.ingredients_text_cs || p.ingredients_text || p.ingredients_text_en || "")
      .toString().toLowerCase();

    const milkTerms = ["mlieko","mliecna bielkovina","mliečna bielkovina","srvátka","whey","casein","kazein","kazeín","maslo","smotana","syr","tvaroh","mliečny"];
    const glutenTerms = ["lepok","pšenica","psenica","wheat","jačmeň","jacmen","barley","raž","raz","rye","špalda","spelta","spelt","ovos"];
    const hasMilkText = milkTerms.some(t => ingredientsText.includes(t));
    const hasGlutenText = glutenTerms.some(t => ingredientsText.includes(t));

    const tracesText = (p.traces || (p.traces_tags || []).join(", ") || "").toString().toLowerCase();

    // gluten-free z tagov alebo textu
    const labelsTags: string[] = p.labels_tags || [];
    const isLabeledGF = labelsTags.some((t) =>
      /(^|:)(gluten[- ]?free|en:gluten[- ]?free)$/.test(String(t).toLowerCase())
    );
    const nameText = `${p.product_name || ""} ${p.generic_name || ""}`.toLowerCase();
    const claimsText = `${p.labels || ""} ${p.traces || ""} ${(p.traces_tags || []).join(" ")} ${nameText}`.toLowerCase();
    const saysGF = /gluten[- ]?free|bez[\s-]?lepku|bezlepkov/i.test(claimsText);

    let status: EvalStatus = "maybe";

    if (hasMilkTag || hasMilkText) {
      status = "avoid";
      notes.push("Obsahuje mliečnu bielkovinu (napr. srvátka/kazeín).");
    }
    if (hasGlutenTag || hasGlutenText) {
      status = "avoid";
      notes.push("Obsahuje lepok alebo obilniny s lepkovými bielkovinami.");
    }

    if (!hasMilkTag && !hasMilkText && !hasGlutenTag && !hasGlutenText) {
      if ((isLabeledGF || saysGF) && !/gluten|wheat|barley|rye/.test(tracesText) && !maybeGluten) {
        status = "safe";
        notes.push("Deklarované ako bezlepkové (štítok/produkt) a bez mlieka.");
      } else {
        status = "maybe";
        notes.push("Nenašli sa rizikové alergény, ale deklarácia nie je jasná. Skontroluj etiketu.");
      }
    }

    if (/milk/.test(tracesText)) {
      notes.push("Upozornenie: môže obsahovať stopy mlieka.");
      if (status === "safe") status = "maybe";
    }
    if (/gluten|wheat|barley|rye/.test(tracesText)) {
      notes.push("Upozornenie: môže obsahovať stopy lepku.");
      if (status === "safe") status = "maybe";
    }

    return { status, notes };
  }

  function statusBadge(s: EvalStatus | null) {
    if (s === "safe")  return <span style={chip({ background:"#ecfdf5", color:"#065f46", border:"1px solid #a7f3d0" })}>Bezpečné</span>;
    if (s === "avoid") return <span style={chip({ background:"#fef2f2", color:"#991b1b", border:"1px solid #fecaca" })}>Vyhnúť sa</span>;
    if (s === "maybe") return <span style={chip({ background:"#fffbeb", color:"#92400e", border:"1px solid #fde68a" })}>Neisté</span>;
    return <span style={chip({ background:"#f3f4f6", color:"#374151" })}>Zatiaľ nič</span>;
  }

  return (
    <div style={page}>
      <div style={container}>
        {/* Header */}
        <header style={{
          display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, padding:12,
          borderRadius:16, background:"linear-gradient(90deg, rgba(124,58,237,0.10), rgba(167,139,250,0.10))",
          border:"1px solid #e5e7eb", boxShadow:"0 10px 15px -3px rgba(0,0,0,0.06), 0 4px 6px -4px rgba(0,0,0,0.05)"
        }}>
          <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: 0.2 }}>Radka Scanner</h1>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <button onClick={toggleCamera} disabled={!devices.length} style={btn()} aria-label="Prepnúť kameru">
              Prepnúť kameru
            </button>
            <label style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px",
              border:"1px solid #e5e7eb", borderRadius:12, background:"#fff", fontWeight:600 }}>
              <input
                type="checkbox"
                checked={scanning}
                onChange={(e) => {
                  if (!e.target.checked) { try { controlsRef.current?.stop(); } catch {} }
                  // pri zapnutí resetneme anti-dup markery
                  if (e.target.checked) { lastCodeRef.current = null; lastScanTsRef.current = 0; }
                  setScanning(e.target.checked);
                }}
              />
              <span>Kamera</span>
            </label>
          </div>
        </header>

        {/* Scanner */}
        <section style={card()}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Skenovanie čiarového kódu</div>

          {scanning && (
            <div style={{
              borderRadius:14, overflow:"hidden", border:"1px solid #e5e7eb",
              background:"#000", aspectRatio:"16/9", marginBottom:10, position:"relative"
            }}>
              <video ref={videoRef} style={{ width:"100%", height:"100%", objectFit:"cover" }} muted playsInline autoPlay />
              <div style={{ position:"absolute", inset:0, pointerEvents:"none",
                boxShadow:"inset 0 0 0 2px rgba(124,58,237,.55), inset 0 0 0 9999px rgba(0,0,0,.10)" }}/>
            </div>
          )}

          <div style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:8 }}>
            <input
              placeholder="Zadaj EAN/UPC kód"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && barcode.trim()) fetchProduct(barcode.trim()); }}
              style={{ padding:12, border:"1px solid #e5e7eb", borderRadius:12 }}
              inputMode="numeric"
            />
            <button onClick={() => barcode.trim() && fetchProduct(barcode.trim())} disabled={!barcode.trim() || loading} style={btnPrimary(!barcode.trim() || loading)}>
              {loading ? "Načítavam…" : "Vyhľadať"}
            </button>
          </div>

          <div style={{ fontSize:12, color:"#6b7280", marginTop:8 }}>
            Dáta: Open Food Facts → ak je neisté, doplní AI z tvojho endpointu.
          </div>

          {error && (
            <div style={{ marginTop:10, padding:10, borderRadius:12, border:"1px solid #fecaca", background:"#fee2e2", color:"#991b1b" }}>
              {error}
            </div>
          )}
        </section>

        {/* Product */}
        {product && (
          <section style={card({ marginTop: 12 })}>
            <div style={{ display:"flex", justifyContent:"space-between", gap:10, flexWrap:"wrap" }}>
              <div style={{ fontWeight: 700 }}>
                {product.product_name || product.generic_name || "Neznámy produkt"}
              </div>
              <div>{statusBadge(evaluation)}</div>
            </div>
            <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
              Kód: {product.code}
            </div>

            {notes.length > 0 && (
              <ul style={{ marginLeft: 18, lineHeight: 1.45, marginTop: 8 }}>
                {notes.map((n, i) => (<li key={i} style={{ fontSize: 14 }}>{n}</li>))}
              </ul>
            )}

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginTop:8 }}>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Alergény (z databázy)</div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  {(product.allergens_hierarchy || []).length
                    ? (product.allergens_hierarchy || []).map((t:string) => <span key={t} style={chip()}>{t.replace(/^.*:/,"")}</span>)
                    : <span style={{ fontSize: 13, color: "#6b7280" }}>Neuvádzané</span>}
                </div>
              </div>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Ingrediencie (sk/cs/en)</div>
                <div style={{ fontSize: 13, maxHeight: 120, overflow: "auto", padding: 10, borderRadius: 12, background: "#f9fafb", border: "1px solid #e5e7eb" }}>
                  {product.ingredients_text_sk || product.ingredients_text_cs || product.ingredients_text_en || product.ingredients_text || "Neuvádzané"}
                </div>
              </div>
            </div>

            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
              Zdroj: Open Food Facts • Posledná aktualizácia:{" "}
              {product.last_modified_t ? new Date(product.last_modified_t * 1000).toLocaleDateString() : "neuvedené"}
            </div>
          </section>
        )}

        {/* History */}
        <History history={history} onPick={(code) => fetchProduct(code)} />
      </div>
    </div>
  );
}

function History({ history, onPick }: { history: HistoryItem[]; onPick: (code: string) => void }) {
  return (
    <section style={card({ marginTop: 12 })}>
      <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>Posledné skeny</div>
      {history.length === 0 ? (
        <div style={{ fontSize: 13, color: "#6b7280" }}>Zatiaľ prázdne</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {history.map((h) => (
            <button
              key={h.code}
              onClick={() => onPick(h.code)}
              style={{
                ...btn(), textAlign: "left", borderRadius: 12, padding: 10,
                display: "flex", justifyContent: "space-between", alignItems: "center"
              }}
            >
              <div>
                <div style={{ fontWeight: 700 }}>{h.name}</div>
                <div style={{ fontSize: 12, color: "#6b7280" }}>{h.brand} • {h.code}</div>
              </div>
              <div style={{
                fontSize: 12, padding: "6px 10px", borderRadius: 999, border: "1px solid #e5e7eb",
                background: h.status === "safe" ? "#dcfce7" : h.status === "avoid" ? "#fee2e2" : "#fef3c7",
              }}>
                {h.status === "safe" ? "Bezpečné" : h.status === "avoid" ? "Vyhnúť sa" : "Neisté"}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
