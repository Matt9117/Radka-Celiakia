import React, { useEffect, useMemo, useRef, useState } from 'react'

// ====== KONŠTANTY ===========================================================
type EvalStatus = 'safe' | 'avoid' | 'maybe'
const EVAL_URL = 'https://radka-celiakia.vercel.app/api/eval' // <— TVOJ AI endpoint

// timeout helper
function withTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('AI timeout')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }).catch((e) => { clearTimeout(t); reject(e) })
  })
}

// ====== UI POMOCNÉ VECI =====================================================
function Badge({ children, tone = 'neutral' }: { children: React.ReactNode, tone?: 'neutral'|'good'|'warn'|'bad' }) {
  const map: Record<typeof tone, string> = {
    neutral: '#eef2ff',
    good: '#dcfce7',
    warn: '#fef3c7',
    bad:  '#fee2e2',
  } as any
  const color: Record<typeof tone, string> = {
    neutral: '#4338ca',
    good: '#166534',
    warn: '#a16207',
    bad:  '#b91c1c',
  } as any
  return (
    <span style={{
      background: map[tone],
      color: color[tone],
      padding: '6px 10px',
      borderRadius: 999,
      fontWeight: 600,
      fontSize: 13,
      border: '1px solid rgba(0,0,0,0.06)',
    }}>{children}</span>
  )
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #eceef3',
      borderRadius: 16,
      padding: 14,
      boxShadow: '0 6px 24px rgba(16,24,40,.06)'
    }}>{children}</div>
  )
}

// ====== APP ================================================================
export default function App() {
  const [scanning, setScanning] = useState(false)
  const [useFront, setUseFront] = useState(false)
  const [barcode, setBarcode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [product, setProduct] = useState<any>(null)
  const [evaluation, setEvaluation] = useState<EvalStatus | null>(null)
  const [notes, setNotes] = useState<string[]>([])

  const [history, setHistory] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem('radka_scan_history') || '[]') } catch { return [] }
  })

  // DEBUG panel – uvidíš posledný request/response z AI aj z mobilu
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugLog, setDebugLog] = useState<string[]>([])
  function log(line: string) {
    setDebugLog((d) => [new Date().toLocaleTimeString() + '  ' + line, ...d].slice(0, 50))
  }

  // kamera
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const readerRef = useRef<any>(null) // ZXing reader

  useEffect(() => {
    localStorage.setItem('radka_scan_history', JSON.stringify(history.slice(0, 50)))
  }, [history])

  // spustenie/vypnutie kamery
  useEffect(() => {
    let cancelled = false
    async function start() {
      if (!scanning) return
      setError(null)
      try {
        const constraints: MediaStreamConstraints = {
          video: useFront ? { facingMode: 'user' } : { facingMode: { ideal: 'environment' } },
          audio: false
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        // lazy import zxing
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        readerRef.current = new BrowserMultiFormatReader()

        // kontinuálne čítanie – keď niečo nájde, vypne kameru a spracuje
        const decodeLoop = async () => {
          if (!readerRef.current || !videoRef.current) return
          try {
            const res = await readerRef.current.decodeOnceFromVideoElement(videoRef.current)
            const code = res.getText()
            handleCode(code)
          } catch (e: any) {
            // ignoruj, skúšaj ďalej, ak stále skenujeme
            if (scanning && videoRef.current) requestAnimationFrame(decodeLoop)
          }
        }
        requestAnimationFrame(decodeLoop)
      } catch (e: any) {
        setError('Kamera sa nedá spustiť: ' + (e?.message || e))
      }
    }
    async function stop() {
      if (readerRef.current?.reset) { try { readerRef.current.reset() } catch {} }
      readerRef.current = null
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
      if (videoRef.current) {
        videoRef.current.pause()
        videoRef.current.srcObject = null
      }
    }
    if (scanning) start()
    else stop()
    return () => { cancelled = true; stop() }
  }, [scanning, useFront])

  // spracovanie naskenovaného alebo zadaného kódu
  async function handleCode(code: string) {
    if (!code) return
    setBarcode(code)
    setScanning(false) // okamžite vypni kameru, nech to nečíta znova
    await fetchProduct(code)
  }

  // OFF fetch + lokálne vyhodnotenie + prípadný AI fallback
  async function fetchProduct(code: string) {
    setLoading(true); setError(null); setProduct(null); setEvaluation(null); setNotes([])
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json`)
      if (!res.ok) throw new Error('Chyba pripojenia k Open Food Facts')
      const data = await res.json()
      if (data.status !== 1 || !data.product) {
        setError('Produkt sa nenašiel v databáze.')
        return
      }
      const p = data.product
      setProduct(p)

      // lokálne vyhodnotenie
      const local = evaluateLocal(p)
      setEvaluation(local.status)
      setNotes(local.notes)

      // história
      setHistory(h => [{
        code,
        brand: p.brands || '',
        name: p.product_name || p.generic_name || 'Neznámy produkt',
        status: local.status,
        ts: Date.now(),
      }, ...h.filter(x => x.code !== code)].slice(0, 50))

      // AI fallback
      if (local.status === 'maybe') {
        const ai = await fetchAI({
          code,
          name: p.product_name || p.generic_name || '',
          ingredients: p.ingredients_text_sk || p.ingredients_text_cs || p.ingredients_text || '',
          allergens: (p.allergens_hierarchy || []).map((t: string) => t.replace(/^.*:/,'')).join(', '),
          lang: 'sk'
        })
        if (ai?.status) setEvaluation(ai.status as EvalStatus)
        if (ai?.notes?.length) setNotes(ai.notes)
      }
    } catch (e: any) {
      setError(e?.message || 'Neznáma chyba')
    } finally {
      setLoading(false)
    }
  }

  // lokálne (rýchle) vyhodnotenie
  function evaluateLocal(p: any): { status: EvalStatus, notes: string[] } {
    const notes: string[] = []

    const allergenTags: string[] = p.allergens_tags || []
    const hasGlutenTag = allergenTags.some((t) => /(^|:)gluten$/i.test(t))
    const hasMilkTag = allergenTags.some((t) => /(^|:)milk$/i.test(t))

    const ingrAnalysis = p.ingredients_analysis_tags || []
    const maybeGluten = ingrAnalysis.some((t: string) => /may-contain-gluten/i.test(t))

    const ingredientsText = (p.ingredients_text || p.ingredients_text_en || p.ingredients_text_sk || '').toLowerCase()
    const milkTerms = ['mlieko','mliecna bielkovina','mliečna bielkovina','srvátka','whey','casein','kazein','kazeín','maslo','smotana','syr','tvaroh','mliečny']
    const glutenTerms = ['lepok','pšenica','psenica','wheat','jačmeň','jacmen','barley','raž','raz','rye','špalda','spelta','spelt','ovos']
    const hasMilkText = milkTerms.some((t) => ingredientsText.includes(t))
    const hasGlutenText = glutenTerms.some((t) => ingredientsText.includes(t))

    const claims = `${p.labels || ''} ${p.traces || ''} ${(p.traces_tags || []).join(' ')}`.toLowerCase()
    const saysGlutenFree = /gluten[- ]?free|bez lepku|bezlepkov/i.test(claims)

    let status: EvalStatus = 'maybe'
    if (hasMilkTag || hasMilkText) {
      status = 'avoid'
      notes.push('Obsahuje mliečnu bielkovinu (napr. srvátka/kazeín).')
    }
    if (hasGlutenTag || hasGlutenText) {
      status = 'avoid'
      notes.push('Obsahuje lepok alebo obilniny s lepkovými bielkovinami.')
    }
    if (!hasMilkTag && !hasMilkText && !hasGlutenTag && !hasGlutenText) {
      if (saysGlutenFree && !maybeGluten) {
        status = 'safe'
        notes.push('Deklarované ako bezlepkové a bez mlieka v ingredienciách.')
      } else {
        status = 'maybe'
        notes.push('Nenašli sa rizikové alergény, ale deklarácia nie je jasná.')
      }
    }
    const tracesText = (p.traces || (p.traces_tags || []).join(', ') || '').toLowerCase()
    if (/milk/.test(tracesText)) {
      notes.push('Upozornenie: môže obsahovať stopy mlieka.')
      if (status === 'safe') status = 'maybe'
    }
    if (/gluten|wheat|barley|rye/.test(tracesText)) {
      notes.push('Upozornenie: môže obsahovať stopy lepku.')
      if (status === 'safe') status = 'maybe'
    }
    return { status, notes }
  }

  // volanie AI
  async function fetchAI(payload: {
    code: string
    name: string
    ingredients: string
    allergens: string
    lang: 'sk'|'cs'
  }): Promise<{status?: EvalStatus, notes: string[]}|null> {
    try {
      log('AI → POST ' + EVAL_URL)
      log('AI req: ' + JSON.stringify(payload))
      const res = await withTimeout(fetch(EVAL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }), 12000)
      const text = await res.text()
      log('AI status ' + res.status + ', body: ' + text)
      if (!res.ok) throw new Error('AI ' + res.status)
      const data = JSON.parse(text)
      // očakávaný tvar: { status: 'safe'|'avoid'|'maybe', notes: string[] }
      return {
        status: (data.status === 'safe' || data.status === 'avoid' || data.status === 'maybe') ? data.status : undefined,
        notes: Array.isArray(data.notes) ? data.notes : [],
      }
    } catch (e: any) {
      log('AI error: ' + (e?.message || e))
      return null
    }
  }

  // status badge
  function statusBadge(s: EvalStatus | null) {
    if (s === 'safe') return <Badge tone="good">Bezpečné</Badge>
    if (s === 'avoid') return <Badge tone="bad">Vyhnúť sa</Badge>
    if (s === 'maybe') return <Badge tone="warn">Neisté</Badge>
    return <Badge>—</Badge>
  }

  // vyčistenie histórie
  function clearHistory() {
    setHistory([])
    localStorage.removeItem('radka_scan_history')
  }

  // ====== RENDER ============================================================
  return (
    <div style={{minHeight:'100vh', background:'#f6f7fb', padding:'16px'}}>
      <div style={{maxWidth: 860, margin:'0 auto'}}>
        {/* header */}
        <div style={{
          background:'linear-gradient(180deg,#ede9fe, #f7f7ff)',
          border:'1px solid #eceef3', borderRadius:20, padding:16, marginBottom:14,
          display:'grid', gridTemplateColumns:'1fr auto auto', gap:10, alignItems:'center'
        }}>
          <div style={{opacity:.35, fontWeight:800, fontSize:36, lineHeight:1.1}}>Radka<br/>Scanner</div>
          <button onClick={()=>setUseFront(s=>!s)} style={{
            background:'#fff', border:'1px solid #e5e7eb', borderRadius:14, padding:'10px 14px', fontWeight:600
          }}>Prepnúť kameru</button>
          <label style={{display:'flex', alignItems:'center', gap:10, background:'#fff', border:'1px solid #e5e7eb', borderRadius:14, padding:'10px 14px'}}>
            <input type="checkbox" checked={scanning} onChange={e=>setScanning(e.target.checked)} />
            <span style={{opacity:.6,fontWeight:700}}>Kamera</span>
          </label>
        </div>

        {/* scanner panel */}
        <SectionCard>
          <div style={{fontWeight:800, fontSize:20, marginBottom:8, color:'#111827', opacity:.9}}>Skenovanie čiarového kódu</div>

          {scanning && (
            <div style={{borderRadius:12, overflow:'hidden', border:'1px solid #e5e7eb', background:'#000', aspectRatio:'16/9', marginBottom:8}}>
              <video ref={videoRef} style={{width:'100%', height:'100%', objectFit:'cover'}} />
            </div>
          )}

          <div style={{display:'grid', gridTemplateColumns:'1fr auto', gap:10}}>
            <input
              placeholder="Zadaj EAN/UPC kód"
              value={barcode}
              onChange={e=>setBarcode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && barcode) handleCode(barcode) }}
              style={{padding:'12px 14px', border:'1px solid #e5e7eb', borderRadius:12, fontSize:16, background:'#fff'}}
            />
            <button
              onClick={()=>barcode && handleCode(barcode)}
              disabled={!barcode || loading}
              style={{padding:'12px 18px', borderRadius:12, border:'1px solid #e5e7eb',
                      background: loading ? '#f3f4f6' : 'linear-gradient(135deg,#7c3aed,#8b5cf6)',
                      color: loading ? '#111827' : '#fff', fontWeight:700}}>
              {loading ? 'Načítavam…' : 'Vyhľadať'}
            </button>
          </div>

          <div style={{fontSize:13, color:'#6b7280', marginTop:8}}>
            Dáta: Open Food Facts → ak je neisté, doplní AI z tvojho endpointu.
          </div>

          {error && (
            <div style={{marginTop:10, padding:'10px 12px', borderRadius:12, border:'1px solid #fecaca', background:'#fee2e2', color:'#991b1b'}}>
              {error}
            </div>
          )}
        </SectionCard>

        {/* výsledok */}
        {product && (
          <div style={{height:10}} />
        )}
        {product && (
          <SectionCard>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap'}}>
              <div style={{fontWeight:800, fontSize:20}}>{product.product_name || product.generic_name || 'Neznámy produkt'}</div>
              {statusBadge(evaluation)}
            </div>
            <div style={{fontSize:13, color:'#6b7280', marginTop:4}}>Kód: {product.code}</div>

            {notes.length>0 && (
              <ul style={{marginLeft:18, lineHeight:1.5, marginTop:8}}>
                {notes.map((n, i) => <li key={i} style={{fontSize:14}}>{n}</li>)}
              </ul>
            )}

            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:12}}>
              <div>
                <div style={{fontWeight:700, marginBottom:6}}>Alergény (z databázy)</div>
                <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
                  {(product.allergens_hierarchy || []).length
                    ? (product.allergens_hierarchy || []).map((t: string) => (
                      <span key={t} style={{fontSize:12, background:'#f3f4f6', padding:'4px 8px', borderRadius:999, border:'1px solid #e5e7eb'}}>{t.replace(/^.*:/,'')}</span>
                    ))
                    : <span style={{fontSize:13, color:'#6b7280'}}>Neuvádzané</span>}
                </div>
              </div>
              <div>
                <div style={{fontWeight:700, marginBottom:6}}>Ingrediencie (sk/cs/en)</div>
                <div style={{fontSize:13, maxHeight:120, overflow:'auto', padding:8, borderRadius:10, background:'#f9fafb', border:'1px solid #e5e7eb'}}>
                  {product.ingredients_text_sk || product.ingredients_text_cs || product.ingredients_text_en || product.ingredients_text || 'Neuvádzané'}
                </div>
              </div>
            </div>

            <div style={{fontSize:12, color:'#6b7280', marginTop:10}}>
              Zdroj: Open Food Facts • Posledná aktualizácia: {product.last_modified_t ? new Date(product.last_modified_t*1000).toLocaleDateString() : 'neuvedené'}
            </div>
          </SectionCard>
        )}

        {/* história */}
        <div style={{height:10}} />
        <SectionCard>
          <div style={{fontWeight:800, fontSize:18, marginBottom:6, color:'#0f172a'}}>Posledné skeny</div>
          {history.length === 0 ? (
            <div style={{fontSize:13, color:'#6b7280'}}>Zatiaľ prázdne</div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:8, marginTop:6}}>
              {history.map((h) => (
                <button key={h.code} onClick={() => handleCode(h.code)} style={{
                  textAlign:'left', border:'1px solid #eceef3', borderRadius:12, padding:10, background:'#fff',
                  display:'flex', justifyContent:'space-between', alignItems:'center'
                }}>
                  <div>
                    <div style={{fontWeight:700}}>{h.name}</div>
                    <div style={{fontSize:12, color:'#6b7280'}}>{h.brand} • {h.code}</div>
                  </div>
                  <div>
                    {h.status==='safe' ? <Badge tone="good">Bezpečné</Badge>
                     : h.status==='avoid' ? <Badge tone="bad">Vyhnúť sa</Badge>
                     : <Badge tone="warn">Neisté</Badge>}
                  </div>
                </button>
              ))}
            </div>
          )}
          <div style={{marginTop:10}}>
            <button onClick={clearHistory} style={{padding:'8px 12px', borderRadius:10, border:'1px solid #e5e7eb'}}>Vymazať históriu</button>
          </div>
        </SectionCard>

        {/* DEBUG panel */}
        <div style={{height:10}} />
        <SectionCard>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <div style={{fontWeight:800}}>Debug (AI volanie)</div>
            <button onClick={()=>setDebugOpen(d=>!d)} style={{border:'1px solid #e5e7eb', borderRadius:8, padding:'6px 10px', background:'#fff'}}>
              {debugOpen ? 'Skryť' : 'Zobraziť'}
            </button>
          </div>
          {debugOpen && (
            <div style={{marginTop:8, maxHeight:180, overflow:'auto', fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, background:'#f9fafb', border:'1px solid #e5e7eb', borderRadius:8, padding:8}}>
              {debugLog.length === 0 ? <div style={{color:'#6b7280'}}>Žiadne záznamy…</div> :
                debugLog.map((l, i) => <div key={i} style={{whiteSpace:'pre-wrap'}}>{l}</div>)
              }
            </div>
          )}
        </SectionCard>

        <div style={{textAlign:'center', fontSize:12, color:'#6b7280', paddingTop:12}}>
          Toto je pomocný nástroj. Pri nejasnostiach vždy skontroluj etiketu výrobku.
        </div>
      </div>
    </div>
  )
}
