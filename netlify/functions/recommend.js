export default async (req) => {
  try {
    const input = await req.json();

    const ALLOWED = [
      "Regular (open vented)",
      "System + Unvented Cylinder",
      "System + Mixergy (unvented)",
      "Regular + Mixergy (vented)",
      "Combi"
    ];

    const SYSTEM = `
You are an evidence-based UK gas boiler recommender.
Choose ONLY from this list:
- Regular (open vented)
- System + Unvented Cylinder
- System + Mixergy (unvented)
- Regular + Mixergy (vented)
- Combi
Never propose heat pumps or electric-only.

Return JSON exactly:
{
  "recommendations":[
    {"title":"<one of the allowed>","reason":"one concise evidence-based sentence"},
    {"title":"<one of the allowed>","reason":"one concise evidence-based sentence"}
  ]
}
JSON only, no markdown.
`;

    // Minimal features passed to the model (already sanitized)
    const USER = {
      flow_lpm: Number(input.flow_lpm || 0),
      mains_pressure_bar: Number(input.mains_pressure_bar || 0),
      pressure_test_method: String(input.pressure_test_method || ""),
      mains_drop_bar: Number(input.mains_drop_bar || 0),
      existing_system: String(input.existing_system || ""),
      hot_water: String(input.hot_water || ""),
      bathrooms: Number(input.bathrooms || 0),
      disruption_tolerance: String(input.disruption_tolerance || ""),
      space_for_cylinder: String(input.space_for_cylinder || ""),
      electrics_16a: String(input.electrics_16a || ""),
      persona: String(input.persona || "")
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
    const fixTitle = (t) => {
      if (ALLOWED.includes(t)) return t;
      if (/mixergy/i.test(t) && /regular/i.test(t)) return "Regular + Mixergy (vented)";
      if (/mixergy/i.test(t)) return "System + Mixergy (unvented)";
      if (/unvented|uv/i.test(t)) return "System + Unvented Cylinder";
      if (/regular/i.test(t)) return "Regular (open vented)";
      if (/combi/i.test(t)) return "Combi";
      return "Regular (open vented)";
    };

    if (!out?.recommendations || !Array.isArray(out.recommendations)) {
      out = { recommendations: [] };
    }
    out.recommendations = out.recommendations.slice(0,2).map(r => ({
      title: fixTitle(String(r.title || "")),
      reason: String(r.reason || "Evidence-based choice for inputs provided.")
    }));
    while (out.recommendations.length < 2) {
      const have = out.recommendations.map(r=>r.title);
      const fallback = ALLOWED.find(t => !have.includes(t)) || "Combi";
      out.recommendations.push({ title: fallback, reason: "Included as contrasting alternative." });
    }

    return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};