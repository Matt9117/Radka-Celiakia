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

// bezpečné načítanie JSON tela aj keď príde zlý Content-Type
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

  // Health-check v prehliadači
  if (req.method === 'GET') {
    const key = process.env.OPENAI_API_KEY
    // akceptujeme aj sk-proj-*
    const hasKey = !!(key && key.startsWith('sk'))
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

    console.log('AI req:', {
      code, name,
      hasIngredients: Boolean(ingredients),
      hasAllergens: Boolean(allergens),
      lang
    })

    if (!code) {
      return res.status(400).json({ error: 'Missing code' })
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.error('OPENAI_API_KEY missing!')
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY' })
    }

    // Prompt – žiadame čistý JSON v presnom tvare
    const system = `Si asistent pre hodnotenie potravín pre celiakiu a alergiu na mliečnu bielkovinu.
Vráť presne 1 JSON objekt v tvare:
{"status":"safe|avoid|maybe","title":"krátke odôvodnenie","notes":["..."]}.
Bez komentárov, bez formátovania navyše.`

    const user = `EAN: ${code}
Názov: ${name || '-'}
Alergény: ${allergens || '-'}
Ingrediencie: ${ingredients || '-'}
Jazyk: ${lang || 'sk'}`

    // Chat Completions – stabilné a nevyžaduje beta headre
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' }, // vynúti validný JSON
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.2,
        max_tokens: 250
      })
    })

    if (!resp.ok) {
      const text = await resp.text()
      console.error('OpenAI upstream error:', resp.status, text)
      return res.status(502).json({ error: 'OpenAI upstream error', status: resp.status, details: text })
    }

    const data: any = await resp.json()
    const text = data?.choices?.[0]?.message?.content || ''
    console.log('AI raw:', text)

    // content je už JSON string (response_format=json_object)
    let parsed: any = null
    try { parsed = JSON.parse(text) } catch (e) { /* fallback nižšie */ }

    if (!parsed || !parsed.status) {
      return res.status(200).json({
        status: 'maybe',
        title: 'Neisté',
        notes: ['AI nevrátila očakávaný JSON.'],
        raw: text
      })
    }

    return res.status(200).json(parsed)
  } catch (e: any) {
    console.error('Handler fatal error:', e?.stack || e?.message || e)
    return res.status(500).json({ error: 'Server error', details: e?.message || String(e) })
  }
}
