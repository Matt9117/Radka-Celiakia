import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { BrowserMultiFormatReader, NotFoundException } from "@zxing/library";

type EvalStatus = "safe" | "avoid" | "maybe";

type HistoryItem = {
  code: string;
  name: string;
  brand: string;
  status: EvalStatus;
  ts: number;
};

export default function App() {
  // UI state
  const [scanning, setScanning] = useState<boolean>(false);
  const [barcode, setBarcode] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // camera & zxing
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const [cameraId, setCameraId] = useState<string | undefined>(undefined);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const lastCodeRef = useRef<string | null>(null); // anti-loop
  const lastScanTsRef = useRef<number>(0);

  // product
  const [product, setProduct] = useState<any>(null);
  const [evaluation, setEvaluation] = useState<EvalStatus | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  // history
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const raw = localStorage.getItem("radka_scan_history");
      return raw ? (JSON.parse(raw) as HistoryItem[]) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(
      "radka_scan_history",
      JSON.stringify(history.slice(0, 50))
    );
  }, [history]);

  // enumerate cameras once user enables scanning
  useEffect(() => {
    if (!scanning) return;

    (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        // needed on some Androids to reveal labels
        const tracks = media.getVideoTracks();
        tracks.forEach((t) => t.stop());
      } catch {
        // ignore; permissions might be granted later
      }
      const list = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "videoinput"
      );
      setDevices(list);
      if (!cameraId && list.length) {
        const back =
          list.find((d) => /back|rear|environment/i.test(d.label)) ?? list[0];
        setCameraId(back.deviceId);
      }
    })();
  }, [scanning]); // eslint-disable-line

  // start/stop scanning
  useEffect(() => {
    if (!scanning || !cameraId) return;

    let cancelled = false;
    const reader = new BrowserMultiFormatReader();
    readerRef.current = reader;

    const start = async () => {
      setError(null);
      try {
        if (!videoRef.current) return;

        await reader.decodeFromVideoDevice(
          (cameraId ?? null) as string | null,
          videoRef.current,
          (result, err) => {
            if (cancelled) return;

            if (result) {
              const code = result.getText();
              const now = Date.now();

              // Anti-duplicačná poistka (rovnaký kód ≤ 1500 ms ignoruj)
              if (
                code === lastCodeRef.current &&
                now - lastScanTsRef.current < 1500
              ) {
                return;
              }
              lastCodeRef.current = code;
              lastScanTsRef.current = now;

              setBarcode(code);
              setScanning(false); // stop loop
              stopReader();
              fetchProduct(code);
            } else if (err && !(err instanceof NotFoundException)) {
              // reálne chyby (iné ako "nič som nenašiel v tomto frame")
              setError(String(err));
            }
          }
        );
      } catch (e: any) {
        setError(e?.message || "Nepodarilo sa spustiť kameru.");
        stopReader();
        setScanning(false);
      }
    };

    start();

    return () => {
      cancelled = true;
      stopReader();
    };
  }, [scanning, cameraId]); // eslint-disable-line

  function stopReader() {
    try {
      // zastavíme zxing
      readerRef.current?.reset();
    } catch {}
    // a istotu: zastaviť aj stream z video elementu
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }

  function nextCamera() {
    if (!devices.length) return;
    const idx = devices.findIndex((d) => d.deviceId === cameraId);
    const next = devices[(idx + 1) % devices.length];
    setCameraId(next?.deviceId); // undefined nikdy neposielame readeru; ošetríme pri decode
  }

  async function fetchProduct(code: string) {
    setLoading(true);
    setError(null);
    setProduct(null);
    setEvaluation(null);
    setNotes([]);
    try {
      const res = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${code}.json`
      );
      if (!res.ok) throw new Error("Chyba pripojenia k databáze.");
      const data = await res.json();
      if (data.status !== 1 || !data.product) {
        setError(
          "Produkt sa nenašiel. Skús manuálne vyhľadávanie alebo skontroluj kód."
        );
        return;
      }
      const p = data.product;
      setProduct(p);
      const evalResult = evaluateProduct(p);
      setEvaluation(evalResult.status);
      setNotes(evalResult.notes);

      setHistory((h) =>
        [
          {
            code,
            brand: p.brands || "",
            name:
              p.product_name || p.generic_name || p.product || "Neznámy produkt",
            status: evalResult.status,
            ts: Date.now(),
          },
          ...h.filter((x) => x.code !== code),
        ].slice(0, 50)
      );
    } catch (e: any) {
      setError(e?.message || "Neznáma chyba.");
    } finally {
      setLoading(false);
    }
  }

  function evaluateProduct(p: any): { status: EvalStatus; notes: string[] } {
    const notes: string[] = [];
    const allergenTags: string[] = p.allergens_tags || [];
    const hasGlutenTag = allergenTags.some((t) => /(^|:)gluten$/i.test(t));
    const hasMilkTag = allergenTags.some((t) => /(^|:)milk$/i.test(t));

    const ingrAnalysis: string[] = p.ingredients_analysis_tags || [];
    const maybeGluten = ingrAnalysis.some((t) =>
      /may-contain-gluten/i.test(t)
    );

    const ingredientsText = (
      p.ingredients_text_sk ||
      p.ingredients_text ||
      p.ingredients_text_en ||
      ""
    )
      .toString()
      .toLowerCase();

    const milkTerms = [
      "mlieko",
      "mliecna bielkovina",
      "mliečna bielkovina",
      "srvátka",
      "whey",
      "casein",
      "kazein",
      "kazeín",
      "maslo",
      "smotana",
      "syr",
      "tvaroh",
      "mliečny",
    ];
    const glutenTerms = [
      "lepok",
      "pšenica",
      "psenica",
      "wheat",
      "jačmeň",
      "jacmen",
      "barley",
      "raž",
      "raz",
      "rye",
      "špalda",
      "spelta",
      "spelt",
      "ovos",
    ];

    const hasMilkText = milkTerms.some((t) => ingredientsText.includes(t));
    const hasGlutenText = glutenTerms.some((t) => ingredientsText.includes(t));

    const claims = `${p.labels || ""} ${p.traces || ""} ${(p.traces_tags || []).join(
      " "
    )}`.toLowerCase();
    const saysGlutenFree = /gluten[- ]?free|bez lepku|bezlepkov/i.test(claims);

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
      if (saysGlutenFree && !maybeGluten) {
        status = "safe";
        notes.push("Deklarované ako bezlepkové a bez mlieka v ingredienciách.");
      } else {
        status = "maybe";
        notes.push(
          "Nenašli sa rizikové alergény, ale deklarácia nie je jasná. Skontroluj etiketu."
        );
      }
    }

    const tracesText = (
      p.traces ||
      (p.traces_tags || []).join(", ") ||
      ""
    ).toLowerCase();
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

  // styles helpers (vracajú vždy CSSProperties – žiadne 'void')
  const card = (extra?: CSSProperties): CSSProperties => ({
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    padding: 12,
    ...extra,
  });

  const chip = (extra?: CSSProperties): CSSProperties => ({
    fontSize: 12,
    background: "#f3f4f6",
    padding: "4px 8px",
    borderRadius: 999,
    border: "1px solid #e5e7eb",
    ...extra,
  });

  const btn = (extra?: CSSProperties): CSSProperties => ({
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid #e5e7eb",
    background: "#fff",
    ...extra,
  });

  const btnPrimary = (disabled?: boolean): CSSProperties => ({
    ...btn(),
    background: disabled ? "#f3f4f6" : "#111827",
    color: disabled ? "#111827" : "#fff",
  });

  function statusLabel(s: EvalStatus | null) {
    if (s === "safe")
      return <span style={{ color: "#15803d", fontWeight: 600 }}>Bezpečné</span>;
    if (s === "avoid")
      return <span style={{ color: "#b91c1c", fontWeight: 600 }}>Vyhnúť sa</span>;
    if (s === "maybe")
      return <span style={{ color: "#a16207", fontWeight: 600 }}>Neisté</span>;
    return <span style={{ color: "#6b7280" }}>Zatiaľ nič</span>;
  }

  function clearHistory() {
    setHistory([]);
    localStorage.removeItem("radka_scan_history");
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", padding: 16 }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        {/* Header */}
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Radka Scanner</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={nextCamera}
              disabled={!devices.length}
              style={btn()}
              aria-label="Prepnúť kameru"
            >
              Prepnúť kameru
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={scanning}
                onChange={(e) => {
                  // pri zapnutí nulujeme proti-loop markery
                  if (e.target.checked) {
                    lastCodeRef.current = null;
                    lastScanTsRef.current = 0;
                  } else {
                    stopReader();
                  }
                  setScanning(e.target.checked);
                }}
              />
              <span>Kamera</span>
            </label>
          </div>
        </header>

        {/* Scanner */}
        <section style={card({ marginBottom: 12 })}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Skenovanie čiarového kódu
          </div>

          <div
            style={{
              borderRadius: 12,
              overflow: "hidden",
              border: "1px solid #e5e7eb",
              background: "#000",
              aspectRatio: "16/9",
              marginBottom: 8,
              position: "relative",
            }}
          >
            <video
              ref={videoRef}
              muted
              playsInline
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
            {/* rámik na mierne zviditeľnenie oblasti */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                border: "2px dashed rgba(255,255,255,0.55)",
                borderRadius: 12,
                pointerEvents: "none",
              }}
            />
          </div>

          {error && (
            <div
              style={{
                padding: 10,
                borderRadius: 10,
                border: "1px solid #fecaca",
                background: "#fee2e2",
                color: "#991b1b",
                marginBottom: 8,
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
            <input
              placeholder="Zadaj EAN/UPC kód"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && barcode) fetchProduct(barcode);
              }}
              style={{
                padding: 10,
                border: "1px solid #e5e7eb",
                borderRadius: 10,
                background: "#fff",
              }}
              inputMode="numeric"
            />
            <button
              onClick={() => barcode && fetchProduct(barcode)}
              disabled={!barcode || loading}
              style={btnPrimary(!barcode || loading)}
            >
              {loading ? "Načítavam…" : "Vyhľadať"}
            </button>
          </div>

          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
            Tip: Ak skener nenačíta, prepíš kód ručne. Dáta čerpáme z Open Food
            Facts.
          </div>
        </section>

        {/* Product */}
        {product && (
          <section style={card({ marginBottom: 12 })}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700 }}>
                {product.product_name ||
                  product.generic_name ||
                  product.product ||
                  "Neznámy produkt"}
              </div>
              <div>{statusLabel(evaluation)}</div>
            </div>

            <div style={{ fontSize: 13, color: "#6b7280" }}>Kód: {product.code}</div>

            {notes.length > 0 && (
              <ul style={{ marginLeft: 18, lineHeight: 1.4 }}>
                {notes.map((n, i) => (
                  <li key={i} style={{ fontSize: 14 }}>
                    {n}
                  </li>
                ))}
              </ul>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  Alergény (z databázy)
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(product.allergens_hierarchy || []).length ? (
                    (product.allergens_hierarchy || []).map((t: string) => (
                      <span key={t} style={chip()}>
                        {t.replace(/^.*:/, "")}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: 13, color: "#6b7280" }}>
                      Neuvádzané
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  Ingrediencie (sk/en)
                </div>
                <div
                  style={{
                    fontSize: 13,
                    maxHeight: 120,
                    overflow: "auto",
                    padding: 8,
                    borderRadius: 10,
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                  }}
                >
                  {product.ingredients_text_sk ||
                    product.ingredients_text_en ||
                    product.ingredients_text ||
                    "Neuvádzané"}
                </div>
              </div>
            </div>

            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
              Zdroj: Open Food Facts • Posledná aktualizácia:{" "}
              {product.last_modified_t
                ? new Date(product.last_modified_t * 1000).toLocaleDateString()
                : "neuvedené"}
            </div>
          </section>
        )}

        {/* History */}
        <section style={card()}>
          <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            Posledné skeny
          </div>

          {history.length === 0 ? (
            <div style={{ fontSize: 13, color: "#6b7280" }}>Zatiaľ prázdne</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {history.map((h) => (
                <button
                  key={h.code}
                  onClick={() => fetchProduct(h.code)}
                  style={{
                    textAlign: "left",
                    border: "1px solid #e5e7eb",
                    borderRadius: 12,
                    padding: 10,
                    background: "#fff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{h.name}</div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>
                        {h.brand} • {h.code}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        padding: "4px 8px",
                        borderRadius: 999,
                        border: "1px solid #e5e7eb",
                        background:
                          h.status === "safe"
                            ? "#dcfce7"
                            : h.status === "avoid"
                            ? "#fee2e2"
                            : "#fef3c7",
                      }}
                    >
                      {h.status === "safe"
                        ? "Bezpečné"
                        : h.status === "avoid"
                        ? "Vyhnúť sa"
                        : "Neisté"}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <button onClick={clearHistory} style={btn()}>
              Vymazať históriu
            </button>
          </div>
        </section>

        <div
          style={{
            textAlign: "center",
            fontSize: 12,
            color: "#6b7280",
            paddingTop: 12,
          }}
        >
          Toto je pomocný nástroj. Pri nejasnostiach vždy skontroluj etiketu
          výrobku.
        </div>
      </div>
    </div>
  );
                       }
