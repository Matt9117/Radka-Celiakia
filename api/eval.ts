// CommonJS verzia /api/eval – funguje bez "type":"module"
const ALLOW_ORIGINS = [
  'capacitor://localhost',
  'http://localhost',
  'http://127.0.0.1',
  'https://radka-celiakia.vercel.app',
];

function setCors(req, res) {
  const origin = String(req.headers.origin || '');
  const allowed = ALLOW_ORIGINS.find(o => origin.startsWith(o));
  res.setHeader('Access-Control-Allow-Origin', allowed || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function readJson(req) {
  try {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** @type {(req: import('@vercel/node').VercelRequest, res: import('@vercel/node').VercelResponse) => Promise<void>} */
module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'GET') {
    res.status(200).json({ ok: true, msg: 'eval ready', hasKey: !!process.env.OPENAI_API_KEY });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  const body = await readJson(req); // { code, name, ingredients, allergens, lang }
  const apiKey = process.env.OPENAI_API_KEY;

  // Ak chýba kľúč, vráť echo, nech appka má odpoveď (nepadne 500).
  if (!apiKey) {
    res.status(200).json({
      ok: true,
      ai: null,
      status: 'maybe',
      notes: ['AI nie je zapnuté (chýba OPENAI_API_KEY).'],
      echo: body,
    });
    return;
  }

  try {
    // Postav krátky prompt
    const user = {
      code: body.code || '',
      name: body.name || '',
      ingredients: body.ingredients || '',
      allergens: body.allergens || '',
      lang: body.lang || 'sk',
    };

    const systemMsg =
      'Si asistent pre celiakiu a alergiu na mliečnu bielkovinu. ' +
      'Z dostupných údajov rozhodni: "safe" (bezpečné), "avoid" (vyhnúť sa) alebo "maybe" (neisté). ' +
      'Vysvetli stručne prečo. Ak sú stopy mlieka/gluténu, skôr "maybe". Odpovedz v jednom jazyku podľa "lang".';

    // Volanie OpenAI (chat completions) – Node 18 má global fetch
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemMsg },
          {
            role: 'user',
            content:
              `lang=${user.lang}\n` +
              `name=${user.name}\n` +
              `code=${user.code}\n` +
              `allergens=${user.allergens}\n` +
              `ingredients=${user.ingredients}\n` +
              'Vráť JSON: {"status":"safe|avoid|maybe","notes":["...","..."]}',
          },
        ],
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${r.status}: ${txt}`);
    }

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content || '';

    // Skús parsovať JSON z odpovede
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // ak to nie je čistý JSON, skús vytiahnuť {...}
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch {}
      }
    }

    const status = (parsed && parsed.status) || 'maybe';
    const notes = (parsed && Array.isArray(parsed.notes) && parsed.notes) || [text.trim() || 'Bez detailov'];

    res.status(200).json({
      ok: true,
      status,  // "safe" | "avoid" | "maybe"
      notes,
    });
  } catch (err) {
    res.status(200).json({
      ok: true,
      status: 'maybe',
      notes: ['AI požiadavka zlyhala.', String(err?.message || err)],
    });
  }
};
