// /api/eval.ts – Vercel serverless funkcia
// Prijme údaje o produkte a vráti {status:'safe'|'avoid'|'maybe', notes:string[]}
// Funguje 2 spôsobmi:
// 1) Ak je nastavený OPENAI_API_KEY, spýta sa AI a skombinuje s heuristikou.
// 2) Inak použije iba heuristiku (funguje aj bez AI).

import type { VercelRequest, VercelResponse } from '@vercel/node'

type EvalStatus = 'safe' | 'avoid' | 'maybe'

function localHeuristic(input: any): { status: EvalStatus; notes: string[] } {
  const notes: string[] = []
  const p = input || {}
  const allergenTags: string[] = p.allergens_tags || []
  const hasGlutenTag = allergenTags.some((t) => /(^|:)gluten$/i.test(t))
  const hasMilkTag = allergenTags.some((t) => /(^|:)milk$/i.test(t))

  const ingredientsText = (
    p.ingredients_text || p.ingredients_text_sk || p.ingredients_text_cs || p.ingredients_text_en || ''
  ).toLowerCase()

  const milkTerms = [
    'mlieko','mliecna bielkovina','mliečna bielkovina','srvátka','whey','casein','kazein','kazeín',
    'maslo','smotana','syr','tvaroh','mliečny'
  ]
  const glutenTerms = [
    'lepok','pšenica','psenica','wheat','jačmeň','jacmen','barley','raž','raz','rye','špalda','spelta','spelt','ovos'
  ]

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
    notes.push('Obsahuje lepok alebo obilniny s lepkom.')
  }
  if (!hasMilkTag && !hasMilkText && !hasGlutenTag && !hasGlutenText) {
    if (saysGlutenFree) {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS pre appku/Android
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' })
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const base = localHeuristic(body)

    // Ak nie je AI kľúč, vráť len heuristiku
    const key = process.env.OPENAI_API_KEY
    if (!key) {
      return res.status(200).json(base)
    }

    // AI prompt (krátky, SK/CZ kontext)
    const prompt = `
Vyhodnoť potravinu pre celiakiu a alergiu na mliečnu bielkovinu.
Vráť JSON presne v tvare: {"status":"safe|avoid|maybe","notes":["...","..."]}

Údaje:
- názov: ${body?.name || ''}
- značky: ${body?.brands || ''}
- štítky: ${body?.labels || ''}
- alergény tags: ${(body?.allergens_tags || []).join(', ')}
- potenciálne stopy: ${body?.traces || ''} ${(body?.traces_tags || []).join(', ')}
- ingrediencie: ${(body?.ingredients_text || '').slice(0, 1000)}
- lokálny odhad: ${base.status} (${base.notes.join(' | ')})
Preferuj slovenské/české pomenovania.
Ak si neistý/á, daj "maybe".
`

    // Volanie OpenAI Responses API
    const aiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: prompt,
        response_format: { type: 'json_object' }
      }),
    })

    if (!aiRes.ok) {
      return res.status(200).json({ ...base, notes: [...base.notes, 'AI neodpovedala.'] })
    }

    const data = await aiRes.json()
    let parsed: any = null
    try {
      parsed = JSON.parse(data.output_text || data.output?.[0]?.content?.[0]?.text || '{}')
    } catch {
      // nič
    }

    if (parsed && (parsed.status === 'safe' || parsed.status === 'avoid' || parsed.status === 'maybe')) {
      const mergedNotes = Array.isArray(parsed.notes) ? parsed.notes : []
      return res.status(200).json({
        status: parsed.status as EvalStatus,
        notes: mergedNotes.length ? mergedNotes : base.notes
      })
    }

    return res.status(200).json(base)
  } catch (e: any) {
    return res.status(200).json({ status: 'maybe', notes: ['AI chyba, používam heuristiku.'] })
  }
}
