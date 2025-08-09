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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
}

async function readJsonBody(req: VercelRequest) {
  try {
    if ((req as any).body && typeof (req as any).body === 'object') {
      return (req as any).body
    }
    const chunks: Uint8Array[] = []
    for await (const ch of req) chunks.push(ch as Uint8Array)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw) return {}
    return JSON.parse(raw)
  } catch (e) {
    console.error('Body parse error:', e)
    return {}
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(req, res)

  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method === 'GET') {
    // Ľahký health-check v prehliadači
    const hasKey = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY!.startsWith('sk-'))
    return res.status(200).json({
      ok: true,
      message: 'Eval endpoint OK. Use POST with JSON.',
      openai_key_present: hasKey
    })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST is allowed' })
  }

  try {
    const body = await readJsonBody(req)
    const { code, name, ingredients, allergens, lang } = body || {}

    console.log('AI req body:', { code, name, hasIngredients: Boolean(ingredients), hasAllergens: Boolean(allergens), lang })

    if (!code) {
      console.warn('Missing code in request body')
      return res.status(400).json({ error: 'Missing code' })
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.error('OPENAI_API_KEY is missing in environment!')
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY in Vercel env' })
    }

    const system = `Si asistent na hodnotenie potravín pre celiakiu a alergiu na mliečnu bielkovinu.
Vráť iba JSON v tvare:
{"status":"safe|avoid|maybe","title":"krátke odôvodnenie","notes":["..."]}`

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
      console.error('OpenAI upstream error:', resp.status, text)
      return res.status(502).json({ error: 'OpenAI upstream error', status: resp.status, details: text })
    }

    const data = await resp.json() as any
    const text = data?.output_text || ''
    console.log('AI raw output_text:', text)

    let parsed: any = null
    try { parsed = JSON.parse(text) } catch (e) {
      console.warn('AI JSON parse failed:', e)
    }

    if (!parsed || !parsed.status) {
      return res.status(200).json({
        status: 'maybe',
        title: 'Neisté',
        notes: ['AI nevrátila jednoznačný JSON.'],
        raw: text
      })
    }

    return res.status(200).json(parsed)
  } catch (e: any) {
    console.error('Handler fatal error:', e?.stack || e?.message || e)
    return res.status(500).json({ error: 'Server error', details: e?.message || String(e) })
  }
}
