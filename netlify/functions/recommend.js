export default async (req) => {
  try {
    const input = await req.json();

    // Allowed options (the only titles we’ll accept)
    const ALLOWED = [
      "Regular (open vented)",
      "System + Unvented Cylinder",
      "System + Mixergy (unvented)",
      "Regular + Mixergy (vented)",
      "Combi"
    ];

    // Strict system prompt + allowed list
    const SYSTEM = `
You are an evidence-based heating recommender for UK gas boiler replacements.
Choose ONLY from this list of options:
- Regular (open vented)
- System + Unvented Cylinder
- System + Mixergy (unvented)
- Regular + Mixergy (vented)
- Combi

Do NOT propose heat pumps, electric-only, or any option not in the list.

Return EXACTLY TWO items as strict JSON in this schema:
{
  "recommendations":[
    {"title":"<one of the allowed titles>","reason":"one concise evidence-based sentence"},
    {"title":"<one of the allowed titles>","reason":"one concise evidence-based sentence"}
  ]
}
JSON ONLY. No markdown, no extra keys.
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
    let out;
    try { out = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch { out = null; }

    // --- Sanity check: force titles to the allowed list ---
    const fixTitle = (t) => {
      if (ALLOWED.includes(t)) return t;
      // crude mapping for "heat pump" or other strays
      if (/mixergy/i.test(t)) return "System + Mixergy (unvented)";
      if (/regular/i.test(t)) return "Regular (open vented)";
      if (/unvented/i.test(t)) return "System + Unvented Cylinder";
      if (/combi/i.test(t)) return "Combi";
      return "Regular (open vented)";
    };

    if (!out?.recommendations || !Array.isArray(out.recommendations)) {
      out = { recommendations: [] };
    }
    out.recommendations = (out.recommendations || [])
      .slice(0,2)
      .map(r => ({
        title: fixTitle(String(r.title || "")),
        reason: String(r.reason || "Evidence-based choice for the measured water and property.")
      }));

    // If the model returned less than 2, pad with a sensible alternative
    while (out.recommendations.length < 2) {
      const have = out.recommendations.map(r=>r.title);
      const fallback = ALLOWED.find(t => !have.includes(t)) || "Combi";
      out.recommendations.push({
        title: fallback,
        reason: "Included as a contrasting alternative from the allowed list."
      });
    }

    return new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};