// api/eval.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'

const ALLOW_ORIGINS = [
  'capacitor://localhost',
  'http://localhost',
  'http://127.0.0.1',
  'https://radka-celiakia.vercel.app',
]

function setCors(req: VercelRequest, res: VercelResponse) {
  const origin = String(req.headers.origin || '')
  const allowed = ALLOW_ORIGINS.find(o => origin.startsWith(o))
  res.setHeader('Access-Control-Allow-Origin', allowed || '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST is allowed' })

  try {
    const { code, name, ingredients, allergens, lang } = req.body || {}
    if (!code) return res.status(400).json({ error: 'Missing code' })

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' })

    // jednoduchý prompt – môžeš časom upraviť
    const system = `Si asistent na hodnotenie potravín pre celiakiu a alergiu na mliečnu bielkovinu. 
Vráť JSON: { "status":"safe|avoid|maybe", "notes":[...], "title": "krátke odôvodnenie" }.`
    const user = `EAN: ${code}
Názov: ${name || '-'}
Alergény: ${allergens || '-'}
Ingrediencie: ${ingredients || '-'}
Jazyk: ${lang || 'sk'}`

    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    })

    if (!resp.ok) {
      const text = await resp.text()
      return res.status(502).json({ error: 'Upstream error', details: text })
    }

    const data = await resp.json() as any
    const text = data?.output_text || ''
    // skús parsovať JSON z výstupu
    let parsed: any = null
    try { parsed = JSON.parse(text) } catch { /* ignore */ }

    if (!parsed || !parsed.status) {
      return res.status(200).json({
        status: 'maybe',
        title: 'Neisté',
        notes: ['AI nevrátila jasný JSON.'],
        raw: text
      })
    }

    return res.status(200).json(parsed)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
}
