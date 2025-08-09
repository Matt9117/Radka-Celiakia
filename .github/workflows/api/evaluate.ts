// api/eval.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'

// Povolené originy (ak chceš, môžeš dať '*' – bez cookies to stačí)
const ALLOW_ORIGINS = [
  'capacitor://localhost',
  'http://localhost',
  'http://127.0.0.1',
  'https://radka-celiakia.vercel.app',
]

function setCors(res: VercelResponse, origin: string | undefined) {
  const allowed = origin && ALLOW_ORIGINS.includes(origin) ? origin : '*'
  res.setHeader('Access-Control-Allow-Origin', allowed)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res, req.headers.origin)

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST is allowed' })
  }

  try {
    const { code, name, ingredients, allergens, lang } = req.body || {}

    // --- Jednoduché lokálne pravidlá (dočasný "AI" stub), aby si videl, že to tečie ---
    const text = `${name} ${ingredients || ''} ${allergens || ''}`.toLowerCase()

    const hasMilk =
      /(mlieko|mliecna|mliečna|srvátka|whey|casein|kazein|kazeín|maslo|smotana|syr|tvaroh)/i.test(
        text
      )
    const hasGluten =
      /(lepok|pšenica|psenica|wheat|jačmeň|jacmen|barley|raž|raz|rye|špalda|spelta|spelt|ovos)/i.test(
        text
      )
    const saysGF = /(gluten[- ]?free|bez lepku|bezlepkov)/i.test(text)

    let status: 'safe' | 'avoid' | 'maybe' = 'maybe'
    const notes: string[] = []

    if (hasMilk) {
      status = 'avoid'
      notes.push('AI: rozpoznané mliečne zložky.')
    }
    if (hasGluten) {
      status = 'avoid'
      notes.push('AI: rozpoznané obilniny/lepkové zložky.')
    }
    if (!hasMilk && !hasGluten) {
      if (saysGF) {
        status = 'safe'
        notes.push('AI: deklarované ako bezlepkové.')
      } else {
        notes.push('AI: nejednoznačné, odporúčam skontrolovať etiketu.')
      }
    }

    return res.status(200).json({ status, notes, debug: { code, name, lang } })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
}
