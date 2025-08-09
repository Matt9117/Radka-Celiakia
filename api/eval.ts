// api/eval.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOW_ORIGINS = [
  "capacitor://localhost",
  "http://localhost",
  "http://127.0.0.1",
  "http://localhost:5173",
  "https://radka-celiakia.vercel.app"
];

function setCors(res: VercelResponse, origin?: string) {
  const allowed = origin && ALLOW_ORIGINS.some(o => origin.startsWith(o));
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : ALLOW_ORIGINS[ALLOW_ORIGINS.length - 1]);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res, req.headers.origin);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const { code, name, ingredients, allergens, lang } = req.body ?? {};
    if (!code) return res.status(400).json({ ok: false, error: "Missing code" });

    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return res.status(200).json({
        ok: true,
        status: "maybe",
        notes: ["AI kľúč nie je nastavený na serveri. Použité boli iba dáta z OFF."]
      });
    }

    const system = (l: "sk" | "cs") =>
      l === "cs"
        ? "Jsi asistent pro celiakii a alergii na mléčnou bílkovinu. Odpovídej stručně. Vrať JSON se status: 'safe' | 'avoid' | 'maybe' a pole notes (krátké věty)."
        : "Si asistent pre celiakiu a alergiu na mliečnu bielkovinu. Odpovedaj stručne. Vráť JSON so status: 'safe' | 'avoid' | 'maybe' a pole notes (krátke vety).";

    const user = `
EAN: ${code}
Názov: ${name}
Ingrediencie: ${ingredients || "-"}
Alergény: ${allergens || "-"}
Rozhodni bezpečnosť pre celiakiu (bez lepku) a APLV (bez mliečnej bielkoviny).
`;

    // Použijeme chat.completions (ľahko dostupné)
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system(lang || "sk") },
          { role: "user", content: user }
        ],
        temperature: 0.2
      })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return res.status(200).json({
        ok: true,
        status: "maybe",
        notes: ["AI požiadavka zlyhala.", `${resp.status} ${txt}`.trim()]
      });
    }

    const data = await resp.json();
    const content: string = data.choices?.[0]?.message?.content || "";
    // pokus o JSON
    let parsed: any = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      // skúsiť vytiahnuť JSON z textu
      const m = content.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }

    const status = (parsed?.status === "safe" || parsed?.status === "avoid" || parsed?.status === "maybe")
      ? parsed.status as EvalStatus
      : "maybe";

    const notes: string[] = Array.isArray(parsed?.notes) ? parsed.notes : [content];

    return res.status(200).json({ ok: true, status, notes });
  } catch (e: any) {
    return res.status(200).json({
      ok: true,
      status: "maybe",
      notes: ["AI výnimka na serveri.", e?.message || "Unknown error"]
    });
  }
}
