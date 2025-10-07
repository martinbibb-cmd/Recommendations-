export default async (req) => {
  try {
    const input = await req.json();

    // --------- Allowed output set (enforced) ----------
    const ALLOWED = [
      "Regular (open vented)",
      "System + Unvented Cylinder",
      "System + Mixergy (unvented)",
      "Regular + Mixergy (vented)",
      "Combi"
    ];

    // --------- System prompt with domain rules ----------
    const SYSTEM = `
You are an experienced UK heating adviser recommending boiler and cylinder configurations.
Choose ONLY from:
- Regular (open vented)
- System + Unvented Cylinder
- System + Mixergy (unvented)
- Regular + Mixergy (vented)
- Combi
Never propose heat pumps or electric-only.

Scoring rules (weight these strongly):
- If flow < 13 L/min OR working pressure < 1.5 bar → Unvented and Combi are weak choices.
- If disruption_tolerance = "low" OR persona includes "elderly" → Prefer Regular or Regular + Mixergy (vented).
- If ample cylinder space AND standing pressure ≥ 2.0 bar → Allow System + Unvented Cylinder or Mixergy (unvented).
- If occupancy ≥ 3 or includes "family" → Lean towards stored systems (unvented or Mixergy).
- MIXERGY: Requires a dedicated 16 A circuit on an RCD/MCB and adds significant cost.
  - If electrics_16a != "yes", avoid Mixergy unless a clear benefit outweighs it.
  - If you do pick Mixergy, mention the 16 A RCD/MCB requirement and higher cost in the reason.
- Existing system has inertia: regular → regular unless strong, well-evidenced gains exist.

Output strict JSON ONLY:
{
  "recommendations":[
    {"title":"<allowed option>","reason":"one concise evidence-based sentence"},
    {"title":"<allowed option>","reason":"one concise evidence-based sentence"}
  ]
}
`;

    // --------- Call OpenAI (key from Netlify env) ----------
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.15,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: JSON.stringify(input) }
        ]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(JSON.stringify({ error: errText }), { status: 500 });
    }

    // --------- Parse + guard the model output ----------
    const data = await resp.json();
    let out;
    try { out = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch { out = null; }
    if (!out || !Array.isArray(out.recommendations)) out = { recommendations: [] };

    // Title normaliser to the allowed set
    const fixTitle = (t) => {
      if (ALLOWED.includes(t)) return t;
      if (/mixergy/i.test(t) && /regular/i.test(t)) return "Regular + Mixergy (vented)";
      if (/mixergy/i.test(t)) return "System + Mixergy (unvented)";
      if (/unvented|uv/i.test(t)) return "System + Unvented Cylinder";
      if (/regular/i.test(t)) return "Regular (open vented)";
      if (/combi/i.test(t)) return "Combi";
      return "Regular (open vented)";
    };

    out.recommendations = out.recommendations.slice(0, 2).map(r => ({
      title: fixTitle(String(r.title || "")),
      reason: String(r.reason || "Evidence-based choice for the provided flow/pressure and household.")
    }));

    // Ensure there are exactly 2 items
    while (out.recommendations.length < 2) {
      const have = out.recommendations.map(r => r.title);
      const fallback = ALLOWED.find(t => !have.includes(t)) || "Combi";
      out.recommendations.push({
        title: fallback,
        reason: "Included as a contrasting option from the allowed list."
      });
    }

    // --------- Mixergy 16 A / cost warning post-processor ----------
    const needs16A = String(input?.electrics_16a || "").toLowerCase() !== "yes";
    out.recommendations = out.recommendations.map(r => {
      const isMix = /mixergy/i.test(r.title || "");
      if (isMix && needs16A) {
        const note = " Requires dedicated 16 A RCD/MCB; higher install cost.";
        if (!/16\s*A|RCD|MCB|cost/i.test(r.reason)) r.reason += note;
      }
      return r;
    });

    return new Response(JSON.stringify(out), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};