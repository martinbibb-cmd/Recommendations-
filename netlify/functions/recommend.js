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
You are an experienced UK heating adviser.
Recommend up to four options ONLY from:
- Regular (open vented)
- System + Unvented Cylinder
- System + Mixergy (unvented)
- Regular + Mixergy (vented)
- Combi
Never propose heat pumps or electric-only.

Weighting rules:
- If flow < 13 L/min OR working pressure < 1.5 bar → unvented and combi weak.
- Low disruption or elderly persona → prefer Regular / Regular + Mixergy (vented).
- Ample space and standing pressure ≥ 2.0 bar → allow unvented / Mixergy unvented.
- Occupancy ≥ 3 or 'family' → bias to stored systems.
- MIXERGY needs a dedicated 16 A RCD/MCB and is higher cost; if electrics_16a != "yes", de-prioritise. If you still pick it, mention the 16 A/cost note.
- Existing system inertia: regular → regular unless strong gains.

Return STRICT JSON ONLY:
{
  "recommendations":[
    {"title":"<allowed option>","reason":"one concise evidence-based sentence","match": 0-100},
    ...
  ]
}
The match is your confidence the option fits inputs and constraints.
`;

    // Call OpenAI
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

    // Parse output
    const data = await resp.json();
    let out;
    try { out = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch { out = null; }
    if (!out || !Array.isArray(out.recommendations)) out = { recommendations: [] };

    // Enforce allow-list + normalise + 16A warning
    const fixTitle = (t) => {
      if (ALLOWED.includes(t)) return t;
      if (/mixergy/i.test(t) && /regular/i.test(t)) return "Regular + Mixergy (vented)";
      if (/mixergy/i.test(t)) return "System + Mixergy (unvented)";
      if (/unvented|uv/i.test(t)) return "System + Unvented Cylinder";
      if (/regular/i.test(t)) return "Regular (open vented)";
      if (/combi/i.test(t)) return "Combi";
      return "Regular (open vented)";
    };

    const needs16A = String(input?.electrics_16a || "").toLowerCase() !== "yes";
    const norm = out.recommendations.slice(0,4).map(r => {
      const title = fixTitle(String(r.title || ""));
      let reason = String(r.reason || "Evidence-based option.");
      let match = Math.max(0, Math.min(100, Number(r.match ?? 0)));

      if (/mixergy/i.test(title) && needs16A) {
        if (!/16\s*A|RCD|MCB|cost/i.test(reason))
          reason += " Requires dedicated 16 A RCD/MCB; higher install cost.";
        // slightly penalise match if 16A missing
        match = Math.max(0, match - 10);
      }
      return { title, reason, match };
    });

    // Pad if fewer than 4 come back
    const ALTS = ALLOWED.filter(a => !norm.find(n => n.title === a));
    while (norm.length < 4 && ALTS.length) {
      const next = ALTS.shift();
      norm.push({
        title: next,
        reason: "Included as a contrasting option from the allowed list.",
        match: 40
      });
    }

    return new Response(JSON.stringify({ recommendations: norm }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};