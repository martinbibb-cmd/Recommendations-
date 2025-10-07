export default async (req) => {
  try {
    const input = await req.json();

    // ---------- Allowed set ----------
    const ALLOWED = [
      "Regular (open vented)",
      "System + Unvented Cylinder",
      "System + Mixergy (unvented)",
      "Regular + Mixergy (vented)",
      "Combi"
    ];

    // ---------- Parse helpers ----------
    const num = (v, d=0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const str = (v) => String(v || "").toLowerCase();

    // Try to pull a pressure figure from "12 L/min @ 1.2 bar" style text
    const parseWorkingBar = (s) => {
      const m = String(s || "").match(/@?\s*([0-9]+(?:\.[0-9]+)?)\s*bar/i);
      return m ? Number(m[1]) : NaN;
    };

    // ---------- Inputs ----------
    const flow = num(input.flow_lpm);
    const standBar = num(input.standing_pressure_bar);
    const workBar = parseWorkingBar(input.working_pressure_desc);
    const workBarEff = Number.isFinite(workBar) ? workBar : (standBar ? Math.min(standBar, standBar - 0.3) : NaN);

    const sys = str(input.existing_system);                // 'regular' | 'system' | 'combi' | ...
    const hw  = str(input.hot_water);                      // 'vented' | 'unvented' | 'none'
    const baths = Math.max(0, num(input.bathrooms, 1));
    const occ = str(input.occupancy);                      // 'two_plus_guests' | 'family4plus' etc
    const dis = str(input.disruption_tolerance);           // 'low' | 'medium' | 'high'
    const space = str(input.space_for_cylinder);           // 'none' | 'tight' | 'ample'
    const has16A = str(input.electrics_16a) === 'yes';
    const persona = str(input.persona);
    const notes = String(input.additional_info || "");

    // ---------- Base scores (transparent rules) ----------
    const base = {
      "Regular (open vented)":            60,
      "System + Unvented Cylinder":       50,
      "System + Mixergy (unvented)":      55,
      "Regular + Mixergy (vented)":       55,
      "Combi":                            40
    };

    const goodPressure = (standBar >= 2.5 || workBarEff >= 2.0) && flow >= 18;
    const poorForMainsHW = (flow < 13) || (workBarEff && workBarEff < 1.5);

    // Pressure/flow effects
    if (goodPressure) {
      base["System + Unvented Cylinder"] += 20;
      base["System + Mixergy (unvented)"] += 20;
      base["Combi"] += 10;
      base["Regular (open vented)"] -= 3;
    }
    if (poorForMainsHW) {
      base["System + Unvented Cylinder"] -= 20;
      base["Combi"] -= 15;
    }

    // Occupancy & bathrooms → stored systems bias
    const storedDemand = baths >= 2 || /family|guests|two_to_three|two_plus_guests|family4plus/.test(occ);
    if (storedDemand) {
      base["System + Unvented Cylinder"] += 12;
      base["System + Mixergy (unvented)"] += 14; // Mixergy excels at demand smoothing
      base["Regular + Mixergy (vented)"] += 10;
      base["Combi"] -= 10;
      base["Regular (open vented)"] -= 4;
    }

    // Disruption tolerance
    if (dis === 'low' || /elderly/.test(persona)) {
      base["Regular (open vented)"] += 14;
      base["Regular + Mixergy (vented)"] += 10;
      base["System + Unvented Cylinder"] -= 12;
      base["System + Mixergy (unvented)"] -= 10;
    } else if (dis === 'high') {
      base["System + Unvented Cylinder"] += 5;
      base["System + Mixergy (unvented)"] += 6;
    }

    // Space constraints
    if (space === 'none') {
      base["System + Unvented Cylinder"] -= 100;
      base["System + Mixergy (unvented)"] -= 100;
      base["Regular + Mixergy (vented)"] -= 100;
    } else if (space === 'tight') {
      base["System + Unvented Cylinder"] -= 6;
    }

    // Existing system inertia
    if (sys === 'regular' || (sys === 'back_boiler' && hw === 'vented')) {
      base["Regular (open vented)"] += 12;
      base["Regular + Mixergy (vented)"] += 8;
      base["System + Unvented Cylinder"] -= 6;
    } else if (sys === 'system' || hw === 'unvented') {
      base["System + Unvented Cylinder"] += 10;
      base["System + Mixergy (unvented)"] += 8;
    } else if (sys === 'combi') {
      base["Combi"] += 6;
    }

    // Mixergy electrical requirement & cost signal
    if (has16A) {
      base["System + Mixergy (unvented)"] += 6;
      base["Regular + Mixergy (vented)"] += 4;
    } else {
      base["System + Mixergy (unvented)"] -= 15;
      base["Regular + Mixergy (vented)"] -= 5; // vented still possible but note cost if upgrading later
    }

    // Clamp 0..100
    const clamp01 = v => Math.max(0, Math.min(100, v));
    const initialScores = Object.fromEntries(
      Object.entries(base).map(([k,v]) => [k, clamp01(v)])
    );

    // ---------- Compose SYSTEM prompt for model ----------
    const SYSTEM = `
You are an experienced UK heating adviser. Choose ONLY from:
- Regular (open vented)
- System + Unvented Cylinder
- System + Mixergy (unvented)
- Regular + Mixergy (vented)
- Combi
Never propose heat pumps or electric-only.

You are given:
- Customer inputs
- Transparent initial scores (0–100) computed by rules

Task:
1) Optionally adjust any score by at most ±10 based on nuances in the inputs/notes.
2) Return the TOP FOUR options sorted by final score (desc).
3) Provide one concise, evidence-based sentence per option.
4) If any Mixergy option is included and electrics_16a != "yes", mention the 16 A RCD/MCB requirement and higher cost.

Return STRICT JSON ONLY:
{
  "recommendations":[
    {"title":"<allowed title>","reason":"...","match": <0-100 integer>},
    ...
  ]
}
No markdown or extra keys.
`;

    const USER = {
      inputs: {
        flow_lpm: flow,
        standing_pressure_bar: standBar,
        working_pressure_bar: Number.isFinite(workBarEff) ? workBarEff : null,
        bathrooms: baths,
        occupancy: occ,
        disruption_tolerance: dis,
        space_for_cylinder: space,
        existing_system: sys,
        hot_water: hw,
        electrics_16a: has16A ? "yes" : (str(input.electrics_16a) || "no"),
        persona,
        additional_info: notes
      },
      initial_scores: initialScores,
      allowed_titles: ALLOWED,
      adjust_limit: 10
    };

    // ---------- Call OpenAI ----------
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
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

    // ---------- Parse & enforce ----------
    const data = await resp.json();
    let out;
    try { out = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch { out = null; }
    if (!out || !Array.isArray(out.recommendations)) out = { recommendations: [] };

    const fixTitle = (t) => {
      if (ALLOWED.includes(t)) return t;
      if (/mixergy/i.test(t) && /regular/i.test(t)) return "Regular + Mixergy (vented)";
      if (/mixergy/i.test(t)) return "System + Mixergy (unvented)";
      if (/unvented|uv/i.test(t)) return "System + Unvented Cylinder";
      if (/regular/i.test(t)) return "Regular (open vented)";
      if (/combi/i.test(t)) return "Combi";
      return "Regular (open vented)";
    };

    const needs16A = !has16A;
    let recs = out.recommendations.map(r => {
      const title = fixTitle(String(r.title || ""));
      let reason = String(r.reason || "Evidence-based option.");
      let match = clamp01(num(r.match, initialScores[title] ?? 50));

      if (/mixergy/i.test(title) && needs16A) {
        if (!/16\s*A|RCD|MCB|cost/i.test(reason))
          reason += " Requires dedicated 16 A RCD/MCB; higher install cost.";
        match = clamp01(match - 10);
      }
      return { title, reason, match };
    });

    // If the model ignored some good candidates, add best remaining by our scores
    const have = new Set(recs.map(r => r.title));
    const sortedByBase = Object.entries(initialScores)
      .sort((a,b)=>b[1]-a[1])
      .map(([k,v])=>({ title:k, match:v, reason:"Included based on rule score." }));

    for (const c of sortedByBase) {
      if (recs.length >= 4) break;
      if (!have.has(c.title)) recs.push(c);
    }

    // Sort one last time by match desc, cap to 4
    recs.sort((a,b)=>b.match - a.match);
    recs = recs.slice(0,4);

    return new Response(JSON.stringify({ recommendations: recs }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};