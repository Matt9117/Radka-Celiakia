import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useZxing } from 'react-zxing'

type EvalStatus = 'safe' | 'avoid' | 'maybe'

export default function App() {
  const [scanning, setScanning] = useState(false)
  const [hasCamPermission, setHasCamPermission] = useState<boolean | null>(null)
  const [camError, setCamError] = useState<string | null>(null)

  const [barcode, setBarcode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [product, setProduct] = useState<any>(null)
  const [evaluation, setEvaluation] = useState<EvalStatus | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [cameraId, setCameraId] = useState<string | undefined>(undefined)
  const [history, setHistory] = useState<any[]>(() => {
    try { return JSON.parse(localStorage.getItem('radka_scan_history')||'[]') } catch { return [] }
  })

  // refs na videá
  const videoRef = useRef<HTMLVideoElement | null>(null)       // hlavný náhľad (ZXing)
  const probeRef = useRef<HTMLVideoElement | null>(null)       // skrytý – len na vyvolanie povolenia

  // zisti dostupné kamery (preferuj zadnú)
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices?.().then(devs => {
      const cams = devs.filter(d => d.kind === 'videoinput')
      if (cams.length) {
        const back = cams.find(c => /back|rear|environment/i.test(c.label))
        setCameraId(back?.deviceId || cams[0].deviceId)
      }
    }).catch(()=>{})
  }, [])

  const constraints: MediaStreamConstraints = useMemo(() => ({
    video: cameraId ? { deviceId: { exact: cameraId } as any } : { facingMode: 'environment' }
  }), [cameraId])

  // React-ZXing – číta z <video>, ktoré mu dáme (videoRef)
  const { ref: zxingAttach } = useZxing({
    onDecodeResult: (result) => {
      const code = result.getText()
      setBarcode(code)
      setScanning(false)
      fetchProduct(code)
    },
    timeBetweenDecodingAttempts: 250,
    constraints
  })

  // prepojenie našej ref s hookom (a nastavenie autoplay atribútov)
  const attachBothRefs = (el: HTMLVideoElement | null) => {
    videoRef.current = el
    zxingAttach(el)
    if (el) {
      // kritické pre WebView: autoplay bez zvuku
      el.setAttribute('playsinline', '')
      el.setAttribute('autoplay', '')
      el.muted = true
    }
  }

  // ukladanie histórie
  useEffect(() => {
    localStorage.setItem('radka_scan_history', JSON.stringify(history.slice(0,50)))
  }, [history])

  // keď zapneš „Kamera“, najprv si explicitne vypýtaj prístup (Android WebView to potrebuje)
  useEffect(() => {
    if (!scanning) return
    (async () => {
      setCamError(null)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: constraints.video as MediaTrackConstraints })
        setHasCamPermission(true)

        // priraď stream do skrytého videa, rozbehni ho (vyvolá povolenie/autoplay)
        if (probeRef.current) {
          probeRef.current.srcObject = stream
          try { await probeRef.current.play() } catch {}
        }
        // stream hneď stopneme – zxing si otvorí vlastný, ale už máme povolenie
        stream.getTracks().forEach(t => t.stop())

        // ak je už rendernuté hlavné video, skús ho explicitne "prebudiť"
        setTimeout(() => {
          try { videoRef.current?.play() } catch {}
        }, 50)
      } catch (e: any) {
        setHasCamPermission(false)
        setScanning(false)
        setCamError(e?.name === 'NotAllowedError'
          ? 'Prístup ku kamere bol zamietnutý. Povoliť v Nastavenia > Aplikácie > Radka Scanner > Povolenia > Kamera.'
          : e?.message || 'Kameru sa nepodarilo spustiť.')
      }
    })()
  }, [scanning, constraints])

  // ručné prepínanie kamery (ak by zobral prednú)
  async function switchCamera() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      const cams = devs.filter(d=>d.kind==='videoinput')
      if (!cams.length) return
      const idx = cams.findIndex(c=>c.deviceId===cameraId)
      const next = cams[(idx+1)%cams.length]
      setCameraId(next.deviceId)
      // jemne reštartni prehrávanie
      setTimeout(()=>{ try { videoRef.current?.play() } catch {} }, 100)
    } catch {}
  }

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
    } finally {
      setLoading(false)
    }
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
    if (hasMilkTag || hasMilkText) { status='avoid'; notes.push('Obsahuje mliečnu bielkovinu (napr. srvátka/kazeín).') }
    if (hasGlutenTag || hasGlutenText) { status='avoid'; notes.push('Obsahuje lepok alebo obilniny s lepkovými bielkovinami.') }
    if (!hasMilkTag && !hasMilkText && !hasGlutenTag && !hasGlutenText) {
      if (saysGlutenFree && !maybeGluten) { status='safe'; notes.push('Deklarované ako bezlepkové a bez mlieka v ingredienciách.') }
      else { status='maybe'; notes.push('Nenašli sa rizikové alergény, ale deklarácia nie je jasná. Skontroluj etiketu.') }
    }
    const tracesText = (p.traces || (p.traces_tags||[]).join(', ') || '').toLowerCase()
    if (/milk/.test(tracesText)) { notes.push('Upozornenie: môže obsahovať stopy mlieka.'); if (status==='safe') status='maybe' }
    if (/gluten|wheat|barley|rye/.test(tracesText)) { notes.push('Upozornenie: môže obsahovať stopy lepku.'); if (status==='safe') status='maybe' }
    return { status, notes }
  }

  function statusLabel(s: EvalStatus | null) {
    if (s === 'safe') return (<span style={{color:'#15803d', fontWeight:600}}>Bezpečné</span>)
    if (s === 'avoid') return (<span style={{color:'#b91c1c', fontWeight:600}}>Vyhnúť sa</span>)
    if (s === 'maybe') return (<span style={{color:'#a16207', fontWeight:600}}>Neisté</span>)
    return (<span style={{color:'#6b7280'}}>Zatiaľ nič</span>)
  }

  function clearHistory() {
    localStorage.removeItem('radka_scan_history')
    setHistory([])
  }

  return (
    <div style={{minHeight:'100vh', background:'#f8fafc', padding:'16px'}}>
      <div style={{maxWidth:'760px', margin:'0 auto'}}>
        <header style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'12px'}}>
          <h1 style={{fontSize:'22px', fontWeight:600}}>Radka Scanner</h1>
          <div style={{display:'flex', gap:8, alignItems:'center'}}>
            <button onClick={switchCamera} style={{padding:'6px 10px', border:'1px solid #e5e7eb', borderRadius:8}}>Prepnúť kameru</button>
            <label style={{display:'flex', alignItems:'center', gap:'8px', fontSize:'14px'}}>
              <input type="checkbox" checked={scanning} onChange={e=>setScanning(e.target.checked)} />
              <span>Kamera</span>
            </label>
          </div>
        </header>

        {/* skryté video – len na vyvolanie povolenia */}
        <video ref={probeRef} playsInline autoPlay muted style={{display:'none'}} />

        <div style={{background:'#fff', border:'1px solid #e5e7eb', borderRadius:'14px', padding:'12px', marginBottom:'12px'}}>
          <div style={{fontWeight:600, marginBottom:'8px'}}>Skenovanie čiarového kódu</div>

          {camError && (
            <div style={{padding:'10px', borderRadius:'10px', border:'1px solid #fecaca', background:'#fee2e2', color:'#991b1b', marginBottom:'8px'}}>
              {camError}
            </div>
          )}

          {scanning && hasCamPermission !== false && (
            <div style={{borderRadius:'12px', overflow:'hidden', border:'1px solid #e5e7eb', background:'#000', aspectRatio:'16/9', marginBottom:'8px'}}>
              <video
                ref={attachBothRefs as any}
                playsInline
                autoPlay
                muted
                style={{width:'100%', height:'100%', objectFit:'cover'}}
              />
            </div>
          )}

          <div style={{display:'grid', gridTemplateColumns:'1fr auto', gap:'8px'}}>
            <input
              placeholder="Zadaj EAN/UPC kód"
              value={barcode}
              onChange={e=>setBarcode(e.target.value)}
              onKeyDown={e=>{ if (e.key==='Enter' && barcode) fetchProduct(barcode) }}
              style={{padding:'10px', border:'1px solid #e5e7eb', borderRadius:'10px'}}
            />
            <button onClick={()=>barcode && fetchProduct(barcode)} disabled={!barcode || loading}
              style={{padding:'10px 14px', borderRadius:'10px', border:'1px solid #e5e7eb', background: loading ? '#f3f4f6' : '#111827', color: loading ? '#111827' : '#fff'}}>
              {loading ? 'Načítavam…' : 'Vyhľadať'}
            </button>
          </div>
          <div style={{fontSize:'12px', color:'#6b7280', marginTop:'8px'}}>Tip: ak skener nenačíta, prepíš kód ručne. Dáta čerpáme z Open Food Facts.</div>
        </div>

        {error && (<div style={{padding:'10px', borderRadius:'10px', border:'1px solid #fecaca', background:'#fee2e2', color:'#991b1b', marginBottom:'12px'}}>{error}</div>)}

        {product && (
          <div style={{background:'#fff', border:'1px solid #e5e7eb', borderRadius:'14px', padding:'12px', marginBottom:'12px'}}>
            <div style={{display:'flex', flexDirection:'column', gap:'8px'}}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:'10px', flexWrap:'wrap'}}>
                <div style={{fontWeight:600}}>{product.product_name || product.generic_name || 'Neznámy produkt'}</div>
                <div>{statusLabel(evaluation)}</div>
              </div>
              <div style={{fontSize:'13px', color:'#6b7280'}}>Kód: {product.code}</div>
              {notes.length>0 && (
                <ul style={{marginLeft:'18px', lineHeight:1.4}}>
                  {notes.map((n,i)=><li key={i} style={{fontSize:'14px'}}>{n}</li>)}
                </ul>
              )}
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px'}}>
                <div>
                  <div style={{fontWeight:600, marginBottom:'4px'}}>Alergény (z databázy)</div>
                  <div style={{display:'flex', gap:'6px', flexWrap:'wrap'}}>
                    {(product.allergens_hierarchy || []).length
                      ? (product.allergens_hierarchy || []).map((t:string)=>(
                        <span key={t} style={{fontSize:'12px', background:'#f3f4f6', padding:'4px 8px', borderRadius:'999px', border:'1px solid #e5e7eb'}}>{t.replace(/^.*:/,'')}</span>
                      ))
                      : <span style={{fontSize:'13px', color:'#6b7280'}}>Neuvádzané</span>}
                  </div>
                </div>
                <div>
                  <div style={{fontWeight:600, marginBottom:'4px'}}>Ingrediencie (sk/en)</div>
                  <div style={{fontSize:'13px', maxHeight:'110px', overflow:'auto', padding:'8px', borderRadius:'10px', background:'#f9fafb', border:'1px solid #e5e7eb'}}>
                    {product.ingredients_text_sk || product.ingredients_text_en || product.ingredients_text || 'Neuvádzané'}
                  </div>
                </div>
              </div>
              <div style={{fontSize:'12px', color:'#6b7280'}}>Zdroj: Open Food Facts • Posledná aktualizácia: {product.last_modified_t ? new Date(product.last_modified_t*1000).toLocaleDateString() : 'neuvedené'}</div>
            </div>
          </div>
        )}

        <div style={{background:'#fff', border:'1px solid #e5e7eb', borderRadius:'14px', padding:'12px'}}>
          <div style={{fontWeight:600, display:'flex', alignItems:'center', gap:'8px'}}>Posledné skeny</div>
          {history.length === 0 ? (
            <div style={{fontSize:'13px', color:'#6b7280'}}>Zatiaľ prázdne</div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:'8px', marginTop:'8px'}}>
              {history.map((h:any)=>(
                <button key={h.code} onClick={()=>fetchProduct(h.code)} style={{textAlign:'left', border:'1px solid #e5e7eb', borderRadius:'12px', padding:'10px', background:'#fff'}}>
                  <div style={{display:'flex', justifyContent:'space-between'}}>
                    <div>
                      <div style={{fontWeight:600}}>{h.name}</div>
                      <div style={{fontSize:'12px', color:'#6b7280'}}>{h.brand} • {h.code}</div>
                    </div>
                    <div style={{fontSize:'12px', padding:'4px 8px', borderRadius:'999px', border:'1px solid #e5e7eb', background:
                      h.status==='safe' ? '#dcfce7' : h.status==='avoid' ? '#fee2e2' : '#fef3c7'
                    }}>
                      {h.status==='safe' ? 'Bezpečné' : h.status==='avoid' ? 'Vyhnúť sa' : 'Neisté'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          <div style={{marginTop:'10px'}}>
            <button onClick={clearHistory} style={{padding:'8px 12px', borderRadius:'10px', border:'1px solid #e5e7eb'}}>Vymazať históriu</button>
          </div>
        </div>

        <div style={{textAlign:'center', fontSize:'12px', color:'#6b7280', paddingTop:'12px'}}>
          Toto je pomocný nástroj. Pri nejasnostiach vždy skontroluj etiketu výrobku.
        </div>
      </div>
    </div>
  )
}
