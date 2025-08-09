// api/evaluate.ts — Vercel serverless API (AI hodnotenie)
import type { VercelRequest, VercelResponse } from "vercel";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const { name, brand, ingredients, labels, traces } = req.body || {};
    const prompt = `
NÁZOV: ${name || ""}
ZNAČKA: ${brand || ""}
ŠTÍTKY: ${labels || ""}
TRACES: ${traces || ""}
INGREDIENCIE: ${ingredients || ""}

ÚLOHA: Vyhodnoť, či produkt je vhodný pre človeka, ktorý sa vyhýba mliečnej bielkovine a lepku.
Vráť LEN čistý JSON tvaru: {"status":"safe|avoid|maybe","notes":["stručné dôvody"]}.
Buď prísny pri mlieku a lepku. Ak je jasný "gluten-free" a nie je mlieko ani stopa lepku, daj "safe".
`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: "Si prísny potravinový hodnotič. Odpovedz LEN JSON-om." },
          { role: "user", content: prompt },
        ],
      }),
    });

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || "";
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return res.status(200).json({ status: "maybe", notes: ["AI nevrátilo validný JSON."] });
    }
    const parsed = JSON.parse(content.slice(start, end + 1));
    return res.status(200).json(parsed);
  } catch (e: any) {
    return res.status(200).json({ status: "maybe", notes: ["Chyba AI: " + (e?.message || "neznáma")] });
  }
}
