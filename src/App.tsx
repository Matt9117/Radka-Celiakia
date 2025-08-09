import React, { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { DecodeHintType, BarcodeFormat, Result } from '@zxing/library'

type EvalStatus = 'safe' | 'avoid' | 'maybe'

export default function App() {
  // Kamera
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const readerRef = useRef<BrowserMultiFormatReader | null>(null)

  const [scanning, setScanning] = useState(false)
  const [cameraId, setCameraId] = useState<string | null>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [torchOn, setTorchOn] = useState(false)

  // Anti-duplicitné zámky
  const lastScanRef = useRef<{ code: string; at: number } | null>(null)
  const processingRef = useRef(false)
  const manualEditRef = useRef(false)

  // Produkt / UI
  const [barcode, setBarcode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [product, setProduct] = useState<any>(null)
  const [evaluation, setEvaluation] = useState<EvalStatus | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [history, setHistory] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem('radka_scan_history') || '[]') } catch { return [] }
  })

  // vybrať zadnú kameru
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices?.().then(devs => {
      const cams = devs.filter(d => d.kind === 'videoinput')
      if (cams.length) {
        const back = cams.find(c => /back|rear|environment/i.test(c.label))
        setCameraId(back?.deviceId ?? cams[0].deviceId ?? null)
      }
    }).catch(()=>{})
  }, [])

  // pomocné
  function stopStream() {
    try { streamRef.current?.getTracks().forEach(t => t.stop()) } catch {}
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }

  // spustiť / vypnúť skenovanie
  useEffect(() => {
    if (!scanning) { stopStream(); return }

    setCamError(null)

    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,  BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
      BarcodeFormat.ITF, BarcodeFormat.CODE_93,
      BarcodeFormat.QR_CODE
    ])
    hints.set(DecodeHintType.TRY_HARDER, true)

    const reader = new BrowserMultiFormatReader(hints as any)
    readerRef.current = reader

    // priamo decode z kamery (callback beží kontinuálne, my ho po prvom úspechu „zamkneme“)
    reader.decodeFromVideoDevice(
      cameraId ?? null,
      videoRef.current!,
      (res?: Result) => {
        if (!res) return
        const code = res.getText()

        // už niečo spracúvame? ignoruj ďalšie callbacky
        if (processingRef.current) return

        // debounce 2 s na rovnaký kód
        const now = Date.now()
        if (lastScanRef.current && lastScanRef.current.code === code && (now - lastScanRef.current.at) < 2000) return
        lastScanRef.current = { code, at: now }

        processingRef.current = true
        try { navigator.vibrate?.(50) } catch {}

        // zapíš do inputu len ak si user medzičasom nič neupravoval
        if (!manualEditRef.current) setBarcode(code)

        // vypni sken (zastavíme stream; callback ešte 1–2x môže dobehnúť, ale sme už „zamknutí“)
        setScanning(false)
        setTimeout(() => {
          fetchProduct(code).finally(() => {
            processingRef.current = false
          })
        }, 80)
      }
    ).catch((e:any) => {
      setScanning(false)
      setCamError(
        e?.name === 'NotAllowedError'
          ? 'Prístup ku kamere bol zamietnutý. Povoliť v Nastavenia > Aplikácie > Povolenia > Kamera.'
          : e?.message || 'Kameru sa nepodarilo spustiť.'
      )
    })

    return () => { stopStream() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, cameraId])

  // prepínanie kamery
  async function switchCamera() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      const cams = devs.filter(d => d.kind === 'videoinput')
      if (!cams.length) return
      const idx = cams.findIndex(c => c.deviceId === cameraId)
      const next = cams[(idx + 1) % cams.length]
      setCameraId(next?.deviceId ?? null)
    } catch {}
  }

  // svetlo (torch)
  async function toggleTorch() {
    try {
      const track = streamRef.current?.getVideoTracks?.()[0]
      if (!track) return
      const caps: any = track.getCapabilities?.()
      if (!caps || !('torch' in caps)) {
        setCamError('Svetlo nie je podporované na tejto kamere.')
        setTimeout(()=>setCamError(null), 2000)
        return
      }
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] } as any)
      setTorchOn(v => !v)
    } catch (e:any) {
      setCamError(e?.message || 'Torch sa nepodarilo zapnúť.')
      setTimeout(()=>setCamError(null), 2000)
    }
  }

  // história
  useEffect(() => {
    localStorage.setItem('radka_scan_history', JSON.stringify(history.slice(0,50)))
  }, [history])

  // načítanie produktu + vyhodnotenie
  async function fetchProduct(code: string) {
    setLoading(true); setError(null); setProduct(null); setEvaluation(null); setNotes([])
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json`)
      if (!res.ok) throw new Error('Chyba pripojenia k databáze')
      const data = await res.json()
      if (data.status !== 1 || !data.product) { setError('Produkt sa nenašiel. Skús manuálne zadať EAN.'); return }
      const p = data.product
      setProduct(p)
      const evalResult = evaluateProduct(p)
      setEvaluation(evalResult.status)
      setNotes(evalResult.notes)
      setHistory(h => [{
        code,
        brand: p.brands || '',
        name: p.product_name || p.generic_name || 'Neznámy produkt',
        status: evalResult.status,
        ts: Date.now(),
      }, ...h.filter((x:any)=>x.code!==code)].slice(0,50))
    } catch (e:any) {
      setError(e?.message || 'Neznáma chyba')
    } finally { setLoading(false) }
  }

  function evaluateProduct(p:any): {status:EvalStatus, notes:string[]} {
    const notes:string[]=[]
    const allergenTags:string[] = p.allergens_tags || []
    const hasGlutenTag = allergenTags.some(t=>/(^|:)gluten$/i.test(t))
    const hasMilkTag = allergenTags.some(t=>/(^|:)milk$/i.test(t))
    const ingrAnalysis = p.ingredients_analysis_tags || []
    const maybeGluten = ingrAnalysis.some((t:string)=>/may-contain-gluten/i.test(t))
    const ingredientsText = (p.ingredients_text || p.ingredients_text_en || p.ingredients_text_sk || '').toLowerCase()
    const milkTerms = ['mlieko','mliecna bielkovina','mliečna bielkovina','mlezivo','srvátka','whey','casein','kazein','kazeín','maslo','smotana','syr','tvaroh','mliečny']
    const glutenTerms = ['lepok','pšenica','psenica','wheat','jačmeň','jacmen','barley','raž','raz','rye','špalda','spelta','spelt','ovos']
    const hasMilkText = milkTerms.some(t=>ingredientsText.includes(t))
    const hasGlutenText = glutenTerms.some(t=>ingredientsText.includes(t))
    const claims = `${p.labels || ''} ${p.traces || ''} ${(p.traces_tags||[]).join(' ')}`.toLowerCase()
    const saysGlutenFree = /gluten[- ]?free|bez lepku|bezlepkov/i.test(claims)

    let status:EvalStatus = 'maybe'
    if (hasMilkTag || hasMilkText) { status='avoid'; notes.push('Obsahuje mliečnu bielkovinu.') }
    if (hasGlutenTag || hasGlutenText) { status='avoid'; notes.push('Obsahuje lepok.') }
    if (!hasMilkTag && !hasMilkText && !hasGlutenTag && !hasGlutenText) {
      if (saysGlutenFree && !maybeGluten) { status='safe'; notes.push('Deklarované ako bezlepkové a bez mlieka.') }
      else { status='maybe'; notes.push('Nenašli sa rizikové alergény, ale deklarácia nie je jasná.') }
    }
    const tracesText = (p.traces || (p.traces_tags||[]).join(', ') || '').toLowerCase()
    if (/milk/.test(tracesText)) { notes.push('Môže obsahovať stopy mlieka.'); if (status==='safe') status='maybe' }
    if (/gluten|wheat|barley|rye/.test(tracesText)) { notes.push('Môže obsahovať stopy lepku.'); if (status==='safe') status='maybe' }
    return { status, notes }
  }

  function statusLabel(s: EvalStatus | null) {
    if (s === 'safe') return (<span className="badge badge-ok">Bezpečné</span>)
    if (s === 'avoid') return (<span className="badge badge-bad">Vyhnúť sa</span>)
    if (s === 'maybe') return (<span className="badge badge-warn">Neisté</span>)
    return (<span className="badge">Zatiaľ nič</span>)
  }

  function clearHistory() {
    localStorage.removeItem('radka_scan_history')
    setHistory([])
  }

  // --- UI ---
  return (
    <div style={{minHeight:'100vh', background:'#0a1220', color:'#e5e7eb', padding:'16px'}}>
      <div style={{maxWidth: 820, margin:'0 auto'}}>

        <header style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div style={{fontSize:22, fontWeight:700}}>Radka Scanner</div>
          <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
            <label style={{display:'flex', alignItems:'center', gap:8}}>
              <input
                type="checkbox"
                checked={scanning}
                onChange={e=>{
                  processingRef.current = false
                  manualEditRef.current = false
                  setScanning(e.target.checked)
                }}
              />
              <span>Kamera</span>
            </label>
            <button onClick={()=>{ processingRef.current=false; manualEditRef.current=false; setScanning(true) }} style={btn()}>Skenovať znova</button>
            <button onClick={switchCamera} style={btn()}>Prepnúť kameru</button>
            <button onClick={toggleTorch} style={btn()}>{torchOn ? 'Svetlo: ON' : 'Svetlo: OFF'}</button>
          </div>
        </header>

        {camError && <div style={alert('bad')}>{camError}</div>}

        {scanning && (
          <div style={card()}>
            <div style={{borderRadius:12, overflow:'hidden', border:'1px solid #223049', background:'#000', aspectRatio:'16/9'}}>
              <video ref={videoRef} playsInline autoPlay muted style={{width:'100%',height:'100%',objectFit:'cover'}} />
            </div>
          </div>
        )}

        <div style={card()}>
          <div style={{fontWeight:600, marginBottom:8}}>Vyhľadanie podľa kódu</div>
          <div style={{display:'grid', gridTemplateColumns:'1fr auto', gap:8}}>
            <input
              placeholder="Zadaj EAN/UPC kód"
              value={barcode}
              onChange={e=>{ manualEditRef.current = true; setBarcode(e.target.value) }}
              onKeyDown={e=>{
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (!barcode || loading || processingRef.current) return
                  manualEditRef.current = true
                  processingRef.current = true
                  fetchProduct(barcode).finally(()=>{ processingRef.current = false })
                }
              }}
              style={{padding:'10px', border:'1px solid #223049', background:'#0f1b31', color:'#e5e7eb', borderRadius:10}}
            />
            <button
              onClick={()=>{
                if (!barcode || loading || processingRef.current) return
                manualEditRef.current = true
                processingRef.current = true
                fetchProduct(barcode).finally(()=>{ processingRef.current = false })
              }}
              style={btnPrimary(loading)}
              disabled={!barcode || loading || processingRef.current}
            >
              {loading ? 'Načítavam…' : 'Vyhľadať'}
            </button>
          </div>
          <div style={{fontSize:12, color:'#9aa5b4', marginTop:8}}>Tip: ak skener nenačíta, prepíš kód ručne. Dáta čerpáme z Open Food Facts.</div>
        </div>

        {error && <div style={alert('bad')}>{error}</div>}

        {product && (
          <div style={card()}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
              <div style={{fontWeight:700, fontSize:16}}>{product.product_name || product.generic_name || 'Neznámy produkt'}</div>
              <div>{statusLabel(evaluation)}</div>
            </div>
            <div style={{fontSize:13, color:'#9aa5b4'}}>Kód: {product.code}</div>

            {notes.length>0 && (
              <ul style={{margin:'8px 0 4px 18px', lineHeight:1.5}}>
                {notes.map((n:string,i:number)=><li key={i}>{n}</li>)}
              </ul>
            )}

            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
              <div>
                <div style={{fontWeight:600, marginBottom:6}}>Alergény (z databázy)</div>
                <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
                  {(product.allergens_hierarchy || []).length
                    ? (product.allergens_hierarchy || []).map((t:string)=>(
                      <span key={t} style={chip()}>{t.replace(/^.*:/,'')}</span>
                    ))
                    : <span style={{fontSize:13, color:'#9aa5b4'}}>Neuvádzané</span>}
                </div>
              </div>
              <div>
                <div style={{fontWeight:600, marginBottom:6}}>Ingrediencie (sk/en)</div>
                <div style={{fontSize:13, maxHeight:140, overflow:'auto', padding:10, borderRadius:12, background:'#0f1b31', border:'1px solid #223049'}}>
                  {product.ingredients_text_sk || product.ingredients_text_en || product.ingredients_text || 'Neuvádzané'}
                </div>
              </div>
            </div>

            <div style={{fontSize:12, color:'#9aa5b4', marginTop:6}}>Zdroj: Open Food Facts • Posledná aktualizácia: {product.last_modified_t ? new Date(product.last_modified_t*1000).toLocaleDateString() : 'neuvedené'}</div>
          </div>
        )}

        <div style={card()}>
          <div style={{fontWeight:600, marginBottom:8}}>Posledné skeny</div>
          {history.length===0 ? (
            <div style={{fontSize:13, color:'#9aa5b4'}}>Zatiaľ prázdne</div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {history.map((h:any)=>(
                <button key={h.code} onClick={()=>fetchProduct(h.code)} style={{textAlign:'left', border:'1px solid #223049', borderRadius:12, padding:10, background:'#0f1b31', color:'#e5e7eb'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                    <div>
                      <div style={{fontWeight:600}}>{h.name}</div>
                      <div style={{fontSize:12, color:'#9aa5b4'}}>{h.brand} • {h.code}</div>
                    </div>
                    <span className={
                      h.status==='safe' ? 'badge badge-ok' :
                      h.status==='avoid' ? 'badge badge-bad' :
                      'badge badge-warn'
                    } style={badge(
                      h.status==='safe' ? '#16a34a' :
                      h.status==='avoid' ? '#dc2626' :
                      '#a16207'
                    )}>
                      {h.status==='safe' ? 'Bezpečné' : h.status==='avoid' ? 'Vyhnúť sa' : 'Neisté'}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
          <div style={{marginTop:10}}>
            <button onClick={clearHistory} style={btn()}>Vymazať históriu</button>
          </div>
        </div>

        <div style={{textAlign:'center', fontSize:12, color:'#9aa5b4', paddingTop:12}}>Toto je pomocný nástroj. Pri nejasnostiach vždy skontroluj etiketu výrobku.</div>
      </div>
    </div>
  )
}

/* --- mini "design system" --- */
function card() {
  return { background:'#0b1830', border:'1px solid #223049', borderRadius:14, padding:12, marginBottom:12 }
}
function btn() {
  return { padding:'8px 12px', borderRadius:10, border:'1px solid #223049', background:'#0f1b31', color:'#e5e7eb' }
}
function btnPrimary(disabled=false) {
  return { padding:'10px 14px', borderRadius:10, border:'1px solid #223049', background: disabled ? '#334155' : '#2563eb', color:'#fff', fontWeight:600 }
}
function chip() {
  return { fontSize:12, background:'#0f1b31', padding:'4px 8px', borderRadius:999, border:'1px solid #223049' }
}
function badge(bg:string) {
  return { fontSize:12, padding:'4px 8px', borderRadius:999, background:bg, color:'#fff' }
}
