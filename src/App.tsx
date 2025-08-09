import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  BrowserMultiFormatReader,
  DecodeHintType,
  BarcodeFormat,
  NotFoundException,
  Result,
  Exception
} from '@zxing/library'

type EvalStatus = 'safe' | 'avoid' | 'maybe'

export default function App() {
  // Kamera / sken
  const [scanning, setScanning] = useState(false)
  const [hasCamPermission, setHasCamPermission] = useState<boolean | null>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [cameraId, setCameraId] = useState<string | undefined>(undefined)
  const [torchOn, setTorchOn] = useState(false)

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

  // Refs
  const videoRef = useRef<HTMLVideoElement | null>(null)   // náhľad kamery
  const probeRef = useRef<HTMLVideoElement | null>(null)   // skryté video na „prebudenie“ autoplay/povolení
  const readerRef = useRef<BrowserMultiFormatReader | null>(null)
  const lastScanRef = useRef<{ code: string; at: number } | null>(null)

  // Preferuj zadnú kameru
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices?.().then(devs => {
      const cams = devs.filter(d => d.kind === 'videoinput')
      if (cams.length) {
        const back = cams.find(c => /back|rear|environment/i.test(c.label))
        setCameraId(back?.deviceId || cams[0].deviceId)
      }
    }).catch(()=>{})
  }, [])

  // Tolerantné video constraints
  const constraints: MediaStreamConstraints = useMemo(() => ({
    video: {
      ...(cameraId ? { deviceId: { ideal: cameraId } as any } : {}),
      facingMode: { ideal: 'environment' } as any,
      focusMode: 'continuous' as any
    }
  }), [cameraId])

  // Stopni existujúci stream
  function stopVideoTracks() {
    const ms = videoRef.current?.srcObject as MediaStream | undefined
    ms?.getTracks().forEach(t => t.stop())
    if (videoRef.current) videoRef.current.srcObject = null
  }

  // Spusť/stopni kameru + reader podľa "scanning"
  useEffect(() => {
    if (!scanning) {
      readerRef.current?.reset()
      stopVideoTracks()
      return
    }
    ;(async () => {
      setCamError(null)
      try {
        // 1) explicitné povolenie (pre Android WebView autoplay)
        const test = await navigator.mediaDevices.getUserMedia({ video: constraints.video as MediaTrackConstraints })
        setHasCamPermission(true)
        if (probeRef.current) {
          probeRef.current.srcObject = test
          try { await probeRef.current.play() } catch {}
        }
        test.getTracks().forEach(t => t.stop())

        // 2) stream do náhľadu
        const stream = await navigator.mediaDevices.getUserMedia({ video: constraints.video as MediaTrackConstraints })
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.setAttribute('playsinline','')
          videoRef.current.setAttribute('autoplay','')
          videoRef.current.muted = true
          try { await videoRef.current.play() } catch {}
        }

        // 3) štart čítačky
        startReader()
      } catch (e: any) {
        setHasCamPermission(false)
        setScanning(false)
        setCamError(e?.name === 'NotAllowedError'
          ? 'Prístup ku kamere bol zamietnutý. Povoliť v Nastavenia > Aplikácie > Radka Scanner > Povolenia > Kamera.'
          : e?.message || 'Kameru sa nepodarilo spustiť.')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, cameraId])

  // Pri zmene kamery reštartni stream + reader
  useEffect(() => {
    if (!scanning) return
    ;(async () => {
      try {
        readerRef.current?.reset()
        stopVideoTracks()
        const stream = await navigator.mediaDevices.getUserMedia({ video: constraints.video as MediaTrackConstraints })
        if (videoRef.current) { videoRef.current.srcObject = stream; try { await videoRef.current.play() } catch {} }
        startReader()
      } catch (e:any) {
        setCamError(e?.message || 'Nepodarilo sa prepnúť kameru.')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId])

  // ZXing reader
  function startReader() {
    if (!videoRef.current) return

    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,  BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
      BarcodeFormat.QR_CODE
    ])
    hints.set(DecodeHintType.TRY_HARDER, true)

    const reader = new BrowserMultiFormatReader(hints as any)
    readerRef.current = reader

    reader.decodeFromVideoDevice(
      cameraId ?? null,          // <- TS: string | null
      videoRef.current,
      (result: Result | undefined, err: Exception | undefined) => {
        if (result) {
          const code = result.getText()
          const now = Date.now()
          // anti-duplikát na 2 sekundy
          if (lastScanRef.current && lastScanRef.current.code === code && (now - lastScanRef.current.at) < 2000) return
          lastScanRef.current = { code, at: now }
          try { navigator.vibrate?.(60) } catch {}
          setBarcode(code)
          setScanning(false)
          reader.reset()
          fetchProduct(code)
        } else if (err && !(err instanceof NotFoundException)) {
          // iné chyby ako "nenašiel v tomto frame" môžeme zalogovať, ale neriešime
        }
      }
    )
  }

  // Prepínanie kamery
  async function switchCamera() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      const cams = devs.filter(d => d.kind === 'videoinput')
      if (!cams.length) return
      const idx = cams.findIndex(c => c.deviceId === cameraId)
      const next = cams[(idx + 1) % cams.length]
      setCameraId(next.deviceId)
    } catch {}
  }

  // Torch (svetlo)
  async function toggleTorch() {
    try {
      const ms = videoRef.current?.srcObject as MediaStream | undefined
      const track = ms?.getVideoTracks?.()[0]
      if (!track) return
      const caps: any = track.getCapabilities?.()
      if (!caps || !('torch' in caps)) {
        setCamError('Svetlo nie je podporované na tejto kamere.')
        setTimeout(()=>setCamError(null), 2500)
        return
      }
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] } as any)
      setTorchOn(v => !v)
    } catch (e:any) {
      setCamError(e?.message || 'Torch sa nepodarilo zapnúť.')
      setTimeout(()=>setCamError(null), 2500)
    }
  }

  // História
  useEffect(() => {
    localStorage.setItem('radka_scan_history', JSON.stringify(history.slice(0,50)))
  }, [history])

  // Fetch produktu + vyhodnotenie
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

  return (
    <div className="container">
      <div className="header">
        <div className="h1">Radka Scanner</div>
        <div className="actions">
          <label className="switch">
            <input type="checkbox" checked={scanning} onChange={e=>setScanning(e.target.checked)} />
            <span>Kamera</span>
          </label>
          <button className="btn" onClick={switchCamera}>Prepnúť kameru</button>
          <button className="btn" onClick={toggleTorch}>{torchOn ? 'Svetlo: ON' : 'Svetlo: OFF'}</button>
        </div>
      </div>

      {camError && <div className="card alert-bad">{camError}</div>}

      {/* skryté video na „prebudenie“ autoplay/povolení */}
      <video ref={probeRef} playsInline autoPlay muted style={{display:'none'}} />

      {scanning && (
        <div className="card">
          <div className="video-wrap">
            <video ref={videoRef} playsInline autoPlay muted style={{width:'100%',height:'100%',objectFit:'cover'}} />
          </div>
        </div>
      )}

      <div className="card">
        <div style={{fontWeight:600, marginBottom:8}}>Vyhľadanie podľa kódu</div>
        <div className="grid grid-2">
          <input className="input" placeholder="Zadaj EAN/UPC kód"
            value={barcode}
            onChange={e=>setBarcode(e.target.value)}
            onKeyDown={e=>{ if (e.key==='Enter' && barcode) fetchProduct(barcode) }}
          />
        <button className="btn btn-primary" disabled={!barcode || loading} onClick={()=>barcode && fetchProduct(barcode)}>
            {loading ? 'Načítavam…' : 'Vyhľadať'}
          </button>
        </div>
        <div className="helper">Tip: ak skener nenačíta, prepíš kód ručne. Dáta čerpáme z Open Food Facts.</div>
      </div>

      {error && <div className="card alert-bad">{error}</div>}

      {product && (
        <div className="card">
          <div className="grid" style={{gap:10}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
              <div style={{fontWeight:700,fontSize:16}}>{product.product_name || product.generic_name || 'Neznámy produkt'}</div>
              <div>{statusLabel(evaluation)}</div>
            </div>
            <div className="helper">Kód: {product.code}</div>

            {notes.length>0 && (
              <ul style={{margin:'0 0 4px 18px', lineHeight:1.5}}>
                {notes.map((n,i)=><li key={i}>{n}</li>)}
              </ul>
            )}

            <div className="grid grid-50">
              <div>
                <div style={{fontWeight:600, marginBottom:6}}>Alergény (z databázy)</div>
                <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
                  {(product.allergens_hierarchy || []).length
                    ? (product.allergens_hierarchy || []).map((t:string)=>(
                      <span key={t} className="tag">{t.replace(/^.*:/,'')}</span>
                    ))
                    : <span className="helper">Neuvádzané</span>}
                </div>
              </div>
              <div>
                <div style={{fontWeight:600, marginBottom:6}}>Ingrediencie (sk/en)</div>
                <div style={{fontSize:13, maxHeight:140, overflow:'auto', padding:10, borderRadius:12, background:'#0b1a2c', border:'1px solid var(--border)'}}>
                  {product.ingredients_text_sk || product.ingredients_text_en || product.ingredients_text || 'Neuvádzané'}
                </div>
              </div>
            </div>

            <div className="helper">Zdroj: Open Food Facts • Posledná aktualizácia: {product.last_modified_t ? new Date(product.last_modified_t*1000).toLocaleDateString() : 'neuvedené'}</div>
          </div>
        </div>
      )}

      <div className="card">
        <div style={{fontWeight:600, marginBottom:8}}>Posledné skeny</div>
        {history.length===0 ? (
          <div className="helper">Zatiaľ prázdne</div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {history.map((h:any)=>(
              <button key={h.code} className="btn" style={{textAlign:'left', display:'block'}} onClick={()=>fetchProduct(h.code)}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
                  <div>
                    <div style={{fontWeight:600}}>{h.name}</div>
                    <div className="helper">{h.brand} • {h.code}</div>
                  </div>
                  <span className={
                    h.status==='safe' ? 'badge badge-ok' :
                    h.status==='avoid' ? 'badge badge-bad' :
                    'badge badge-warn'
                  }>
                    {h.status==='safe' ? 'Bezpečné' : h.status==='avoid' ? 'Vyhnúť sa' : 'Neisté'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
        <div style={{marginTop:10}}>
          <button className="btn" onClick={clearHistory}>Vymazať históriu</button>
        </div>
      </div>

      <div className="footer-note">Toto je pomocný nástroj. Pri nejasnostiach vždy skontroluj etiketu výrobku.</div>
    </div>
  )
}
