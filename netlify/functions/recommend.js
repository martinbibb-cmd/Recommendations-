export default async (req) => {
  try {
    const input = await req.json();

    // --- STRICT system prompt with schema ---
    const SYSTEM = `
You are an evidence-based heating recommender.
Return EXACTLY TWO items in VALID JSON matching this schema:

{
  "recommendations":[
    {
      "title": "max 6 words",
      "reason": "one concise sentence"
    },
    {
      "title": "max 6 words",
      "reason": "one concise sentence"
    }
  ]
}

No prose, no markdown, no extra keys. JSON ONLY.
`;

    const USER = {
      flow_lpm: Number(input.flow),
      existing_system: String(input.system),
      persona: String(input.persona)
    };

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: JSON.stringify(USER) }
        ]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(JSON.stringify({ error: errText }), { status: 500 });
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || "{}";

    // Validate it looks like our schema; otherwise build a tiny fallback
    let out;
    try { out = JSON.parse(content); } catch { out = null; }
    if (!out?.recommendations || !Array.isArray(out.recommendations)) {
      out = {
        recommendations: [
          { title: "Regular (open vented)", reason: "Tolerates low/variable flow and matches existing layout." },
          { title: "Combi (compact)", reason: "Space saving where cylinder removal is desired; check flow is adequate." }
        ]
      };
    }

    return new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};