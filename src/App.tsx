import React, { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";

type EvalStatus = "safe" | "avoid" | "maybe";
type AiReply = { ok: boolean; status?: EvalStatus; notes?: string[] };

export default function App() {
  // camera / scanning
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const gotOneRef = useRef(false);

  // search/product
  const [barcode, setBarcode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [product, setProduct] = useState<any>(null);
  const [status, setStatus] = useState<EvalStatus | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  // history
  const [history, setHistory] = useState<any[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("radka_scan_history") || "[]");
    } catch { return []; }
  });
  useEffect(() => {
    localStorage.setItem("radka_scan_history", JSON.stringify(history.slice(0, 50)));
  }, [history]);

  // ---------- camera ----------
  useEffect(() => {
    if (!scanning) return;
    (async () => {
      try {
        // ask once to get labels
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
        tmp.getTracks().forEach(t => t.stop());

        const cams = (await navigator.mediaDevices.enumerateDevices())
          .filter(d => d.kind === "videoinput");
        setDevices(cams);
        if (!deviceId) {
          const back = cams.find(c => /back|rear|environment/i.test(c.label));
          setDeviceId(back?.deviceId ?? cams[0]?.deviceId ?? null);
        }
      } catch (e) {
        setError("Kameru sa nepodarilo inicializovať. Skontroluj povolenia.");
        setScanning(false);
      }
    })();
  }, [scanning]);

  useEffect(() => {
    if (!scanning || !deviceId || !videoRef.current) return;

    gotOneRef.current = false;
    const reader = new BrowserMultiFormatReader();
    readerRef.current = reader;

    reader.decodeFromVideoDevice(deviceId, videoRef.current, (result) => {
      if (!result || gotOneRef.current) return;
      gotOneRef.current = true;

      const code = result.getText();
      setBarcode(code);
      setScanning(false);
      stopReader();
      fetchProduct(code);
    }).catch(() => {
      setError("Nepodarilo sa spustiť dekódovanie videa.");
      setScanning(false);
      stopReader();
    });

    return () => stopReader();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, deviceId]);

  function stopReader() {
    try { readerRef.current?.reset(); } catch {}
    const v = videoRef.current;
    if (v?.srcObject) {
      (v.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      v.srcObject = null;
    }
  }
  function switchCamera() {
    if (!devices.length) return;
    const idx = Math.max(0, devices.findIndex(d => d.deviceId === deviceId));
    const next = devices[(idx + 1) % devices.length];
    setDeviceId(next.deviceId);
  }

  // ---------- data ----------
  async function fetchProduct(code: string) {
    if (!code) return;
    setLoading(true);
    setError(null);
    setProduct(null);
    setStatus(null);
    setNotes([]);

    try {
      const offRes = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`);
      if (!offRes.ok) throw new Error("Chyba pripojenia k databáze (OFF).");
      const off = await offRes.json();
      if (off.status !== 1 || !off.product) {
        setError("Produkt sa nenašiel. Skús manuálne zadať názov alebo skontroluj kód.");
        setLoading(false);
        return;
      }
      const p = off.product;
      setProduct(p);

      const base = evaluateLocal(p);

      const ai = await evaluateWithAI({
        code,
        name: p.product_name || p.generic_name || "",
        ingredients: p.ingredients_text_sk || p.ingredients_text_cs || p.ingredients_text_en || p.ingredients_text || "",
        allergens: (p.allergens_hierarchy || []).join(", "),
        lang: "sk"
      });

      const finalStatus = ai.status ?? base.status;
      const finalNotes = [...(base.notes || []), ...(ai.notes || [])];

      setStatus(finalStatus);
      setNotes(finalNotes);

      setHistory(h => [
        { code, brand: p.brands || "", name: p.product_name || p.generic_name || "Neznámy produkt", status: finalStatus, ts: Date.now() },
        ...h.filter((x: any) => x.code !== code)
      ]);
    } catch (e: any) {
      setError(e?.message || "Neznáma chyba");
    } finally {
      setLoading(false);
    }
  }

  function evaluateLocal(p: any): { status: EvalStatus; notes: string[] } {
    const notes: string[] = [];
    const tags: string[] = p.allergens_tags || [];
    const hasGlutenTag = tags.some(t => /(^|:)gluten$/i.test(t));
    const hasMilkTag = tags.some(t => /(^|:)milk$/i.test(t));

    const txt = (p.ingredients_text_sk || p.ingredients_text_cs || p.ingredients_text_en || p.ingredients_text || "").toLowerCase();
    const milkTerms = ["mlieko","mliecna bielkovina","mliečna bielkovina","srvátka","whey","casein","kazein","kazeín","maslo","smotana","syr","tvaroh","mliečny"];
    const glutenTerms = ["lepok","pšenica","psenica","wheat","jačmeň","jacmen","barley","raž","raz","rye","špalda","spelta","spelt","ovos"];

    const hasMilkText = milkTerms.some(t => txt.includes(t));
    const hasGlutenText = glutenTerms.some(t => txt.includes(t));

    const claims = `${p.labels || ""} ${p.traces || ""} ${(p.traces_tags || []).join(" ")}`.toLowerCase();
    const saysGF = /gluten[- ]?free|bez lepku|bezlepkov/i.test(claims);

    let st: EvalStatus = "maybe";
    if (hasMilkTag || hasMilkText) { st = "avoid"; notes.push("Obsahuje mliečnu bielkovinu (napr. srvátka/kazeín)."); }
    if (hasGlutenTag || hasGlutenText) { st = "avoid"; notes.push("Obsahuje lepok alebo obilniny s lepkovými bielkovinami."); }
    if (!hasMilkTag && !hasMilkText && !hasGlutenTag && !hasGlutenText) {
      if (saysGF) { st = "safe"; notes.push("Deklarované ako bezlepkové a bez mlieka v ingredienciách."); }
      else { st = "maybe"; notes.push("Nenašli sa rizikové alergény, ale deklarácia nie je jasná. Skontroluj etiketu."); }
    }

    const traces = (p.traces || (p.traces_tags || []).join(", ") || "").toLowerCase();
    if (/milk/.test(traces)) { notes.push("Upozornenie: môže obsahovať stopy mlieka."); if (st === "safe") st = "maybe"; }
    if (/gluten|wheat|barley|rye/.test(traces)) { notes.push("Upozornenie: môže obsahovať stopy lepku."); if (st === "safe") st = "maybe"; }

    return { status: st, notes };
  }

  async function evaluateWithAI(payload: { code: string; name: string; ingredients: string; allergens: string; lang: "sk" | "cs"; }): Promise<{ status?: EvalStatus; notes?: string[] }> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch("/api/eval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      clearTimeout(t);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { status: undefined, notes: [`AI doplnenie nie je dostupné (${res.status}). Pokračujem s OFF.`, ...(txt ? [txt] : [])] };
      }
      const data: AiReply = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) return { status: undefined, notes: ["AI odpoveď nebola v poriadku. Použité boli len dáta z OFF."] };
      return { status: data.status, notes: data.notes };
    } catch {
      return { status: undefined, notes: ["AI nie je dostupná (sieť/kvóta). Rozhodnutie je len podľa OFF."] };
    }
  }

  // ---------- UI helpers ----------
  const card = { background:"#FFFFFF", border:"1px solid rgba(0,0,0,0.06)", borderRadius:16, padding:12, boxShadow:"0 1px 3px rgba(0,0,0,0.06)" };
  const pill = (bg:string, color:string) => ({ display:"inline-block", padding:"4px 10px", borderRadius:999, fontSize:12, fontWeight:700 as const, background:bg, color, border:"1px solid rgba(0,0,0,0.06)" });
  const statusPill = (s:EvalStatus|null) =>
    s==="safe"  ? <span style={pill("#E8F8EE","#0A5A2A")}>Bezpečné</span> :
    s==="avoid" ? <span style={pill("#FDE7E7","#7E1111")}>Vyhnúť sa</span> :
    s==="maybe" ? <span style={pill("#FFF0C7","#7A5200")}>Neisté</span> :
                  <span style={pill("#F3F4F6","#374151")}>Zatiaľ nič</span>;

  function clearHistory(){ setHistory([]); localStorage.removeItem("radka_scan_history"); }

  // ---------- render ----------
  return (
    <div style={{ minHeight:"100vh", background:"#F6F7FB", color:"#111827", padding:16 }}>
      <div style={{ maxWidth:820, margin:"0 auto" }}>
        {/* header */}
        <div style={{ ...card, background:"linear-gradient(135deg, rgba(109,40,217,0.12), rgba(16,185,129,0.10))", borderRadius:20, marginBottom:16 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, flexWrap:"wrap" }}>
            <h1 style={{ margin:0, fontSize:28, fontWeight:800, color:"#1F2937" }}>Radka Scanner</h1>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={switchCamera} disabled={!devices.length}
                style={{ padding:"10px 14px", borderRadius:12, border:"1px solid rgba(0,0,0,0.1)", background:"#fff", fontWeight:600 }}>
                Prepnúť kameru
              </button>
              <label style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 12px", borderRadius:12, border:"1px solid rgba(0,0,0,0.1)", background:"#fff", fontWeight:600 }}>
                <input type="checkbox" checked={scanning} onChange={e=>{ setError(null); setProduct(null); setStatus(null); setNotes([]); setScanning(e.target.checked); }} />
                Kamera
              </label>
            </div>
          </div>
        </div>

        {/* scan */}
        <div style={{ ...card, marginBottom:16 }}>
          <div style={{ fontWeight:700, fontSize:18, marginBottom:10 }}>Skenovanie čiarového kódu</div>

          {scanning && (
            <div style={{ borderRadius:12, overflow:"hidden", border:"1px solid rgba(0,0,0,0.1)", background:"#000", aspectRatio:"16/9", marginBottom:10 }}>
              <video ref={videoRef} style={{ width:"100%", height:"100%", objectFit:"cover" }} muted playsInline autoPlay />
            </div>
          )}

          {error && (
            <div style={{ padding:10, borderRadius:10, border:"1px solid #FCA5A5", background:"#FEE2E2", color:"#7F1D1D", marginBottom:10 }}>
              {error}
            </div>
          )}

          <div style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:8 }}>
            <input
              placeholder="Zadaj EAN/UPC kód"
              value={barcode}
              onChange={e=>setBarcode(e.target.value)}
              onKeyDown={e=>{ if (e.key==="Enter" && barcode) fetchProduct(barcode); }}
              style={{ padding:"12px 12px", border:"1px solid rgba(0,0,0,0.12)", borderRadius:12, fontSize:16 }}
            />
            <button onClick={()=> barcode && fetchProduct(barcode)} disabled={!barcode || loading}
              style={{ padding:"12px 16px", borderRadius:12, border:"1px solid rgba(109,40,217,0.25)", background:loading ? "linear-gradient(135deg,#E5E7EB,#F3F4F6)" : "linear-gradient(135deg,#7C3AED,#6D28D9)", color:loading ? "#111827" : "#fff", fontWeight:700, boxShadow:"0 6px 20px rgba(109,40,217,0.25)" }}>
              {loading ? "Načítavam…" : "Vyhľadať"}
            </button>
          </div>

          <div style={{ fontSize:12, color:"#6B7280", marginTop:8 }}>
            Dáta: Open Food Facts → ak je neisté, doplní AI z tvojho endpointu.
          </div>
        </div>

        {/* product */}
        {product && (
          <div style={{ ...card, marginBottom:16 }}>
            <div style={{ display:"flex", justifyContent:"space-between", gap:10, alignItems:"center", flexWrap:"wrap" }}>
              <div style={{ fontWeight:800, fontSize:18 }}>{product.product_name || product.generic_name || "Neznámy produkt"}</div>
              <div>{statusPill(status)}</div>
            </div>
            <div style={{ fontSize:13, color:"#6B7280", marginTop:2 }}>Kód: {product.code}</div>

            {notes.length>0 && (
              <ul style={{ marginLeft:18, lineHeight:1.5, marginTop:8 }}>
                {notes.map((n,i)=>(<li key={i} style={{ fontSize:14 }}>{n}</li>))}
              </ul>
            )}

            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:8 }}>
              <div>
                <div style={{ fontWeight:700, marginBottom:4 }}>Alergény (z databázy)</div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  {(product.allergens_hierarchy || []).length
                    ? (product.allergens_hierarchy || []).map((t:string)=>(
                        <span key={t} style={{ fontSize:12, background:"#F3F4F6", padding:"4px 8px", borderRadius:999, border:"1px solid rgba(0,0,0,0.08)" }}>
                          {t.replace(/^.*:/,"")}
                        </span>
                      ))
                    : <span style={{ fontSize:13, color:"#6B7280" }}>Neuvádzané</span>}
                </div>
              </div>
              <div>
                <div style={{ fontWeight:700, marginBottom:4 }}>Ingrediencie (sk/cs/en)</div>
                <div style={{ fontSize:13, maxHeight:120, overflow:"auto", padding:8, borderRadius:10, background:"#F9FAFB", border:"1px solid rgba(0,0,0,0.08)" }}>
                  {product.ingredients_text_sk || product.ingredients_text_cs || product.ingredients_text_en || product.ingredients_text || "Neuvádzané"}
                </div>
              </div>
            </div>

            <div style={{ fontSize:12, color:"#6B7280", marginTop:8 }}>
              Zdroj: Open Food Facts • Posledná aktualizácia: {product.last_modified_t ? new Date(product.last_modified_t*1000).toLocaleDateString() : "neuvedené"}
            </div>
          </div>
        )}

        {/* history */}
        <div style={{ ...card, marginBottom:24 }}>
          <div style={{ fontWeight:800, fontSize:18 }}>Posledné skeny</div>
          {history.length===0 ? (
            <div style={{ fontSize:13, color:"#6B7280", marginTop:6 }}>Zatiaľ prázdne</div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:8 }}>
              {history.map((h:any)=>(
                <button key={h.code} onClick={()=>fetchProduct(h.code)}
                  style={{ textAlign:"left", border:"1px solid rgba(0,0,0,0.06)", borderRadius:12, padding:10, background:"#fff", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <div style={{ fontWeight:700 }}>{h.name}</div>
                    <div style={{ fontSize:12, color:"#6B7280" }}>{h.brand} • {h.code}</div>
                  </div>
                  <div style={{ fontSize:12, padding:"4px 8px", borderRadius:999, border:"1px solid rgba(0,0,0,0.06)",
                    background: h.status==="safe" ? "#E8F8EE" : h.status==="avoid" ? "#FDE7E7" : "#FFF0C7",
                    color:      h.status==="safe" ? "#0A5A2A" : h.status==="avoid" ? "#7E1111" : "#7A5200",
                    fontWeight:700 }}>
                    {h.status==="safe" ? "Bezpečné" : h.status==="avoid" ? "Vyhnúť sa" : "Neisté"}
                  </div>
                </button>
              ))}
            </div>
          )}
          <div style={{ marginTop:10 }}>
            <button onClick={clearHistory} style={{ padding:"8px 12px", borderRadius:10, border:"1px solid rgba(0,0,0,0.12)", background:"#fff", fontWeight:600 }}>
              Vymazať históriu
            </button>
          </div>
        </div>

        <div style={{ textAlign:"center", fontSize:12, color:"#6B7280", paddingBottom:24 }}>
          Toto je pomocný nástroj. Pri nejasnostiach vždy skontroluj etiketu výrobku.
        </div>
      </div>
    </div>
  );
}
