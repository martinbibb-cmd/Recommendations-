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

    // ---------- Helpers ----------
    const num = (v, d=0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const str = (v) => String(v || "").toLowerCase();
    const clamp01 = v => Math.max(0, Math.min(100, v));

    // Parse “12 @ 1.2 bar”
    const parseWorkingBar = (s) => {
      const m = String(s || "").match(/@?\s*([0-9]+(?:\.[0-9]+)?)\s*bar/i);
      return m ? Number(m[1]) : NaN;
    };

    // ---------- Inputs ----------
    const flow = num(input.flow_lpm);
    const standBar = num(input.standing_pressure_bar);
    const workBar = parseWorkingBar(input.working_pressure_desc);
    const workBarEff = Number.isFinite(workBar) ? workBar : (standBar ? Math.max(0, standBar - 0.3) : NaN);

    const sys = str(input.existing_system);          // regular | system | combi | back_boiler...
    const hw  = str(input.hot_water);                // vented | unvented | none
    const baths = Math.max(0, num(input.bathrooms, 1));
    const occ = str(input.occupancy);                // two_plus_guests | family4plus ...
    const dis = str(input.disruption_tolerance);     // low | medium | high
    const space = str(input.space_for_cylinder);     // none | tight | ample
    const has16A = str(input.electrics_16a) === 'yes';
    const persona = str(input.persona);              // post_retirement, etc.
    const notes = String(input.additional_info || "");

    // ---------- Base scores ----------
    const base = {
      "Regular (open vented)":            60,
      "System + Unvented Cylinder":       50,
      "System + Mixergy (unvented)":      55,
      "Regular + Mixergy (vented)":       55,
      "Combi":                            40
    };

    const goodPressure = (standBar >= 2.5 || workBarEff >= 2.0) && flow >= 18;
    const poorForMainsHW = (flow < 13) || (workBarEff && workBarEff < 1.5);

    // Pressure/flow
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

    // Occupancy / bathrooms (stored systems bias)
    const storedDemand = baths >= 2 || /family|guests|two_to_three|two_plus_guests|family4plus/.test(occ);
    if (storedDemand) {
      base["System + Unvented Cylinder"] += 12;
      base["System + Mixergy (unvented)"] += 14;
      base["Regular + Mixergy (vented)"] += 10;
      base["Combi"] -= 10;
      base["Regular (open vented)"] -= 4;
    }

    // -------- Disruption tolerance (UPDATED) --------
    if (dis === 'low') {
      // KEEP THE SAME SYSTEM TYPE regardless of age/persona
      if (sys === 'regular' || (sys === 'back_boiler' && hw === 'vented')) {
        base["Regular (open vented)"] += 20;
        base["Regular + Mixergy (vented)"] += 12;
        base["System + Unvented Cylinder"] -= 8;
        base["System + Mixergy (unvented)"] -= 8;
      } else if (sys === 'system' || hw === 'unvented') {
        base["System + Unvented Cylinder"] += 18;
        base["System + Mixergy (unvented)"] += 14;
        base["Regular (open vented)"] -= 6;
        base["Combi"] -= 8;
      } else if (sys === 'combi') {
        base["Combi"] += 16;
        base["System + Unvented Cylinder"] -= 6;
        base["Regular (open vented)"] -= 6;
      }
    }

    // Persona: post_retirement → gentle nudge to lower disruption, but weaker than rule above
    if (/post_retirement/.test(persona)) {
      if (sys === 'regular' || sys === 'back_boiler') {
        base["Regular (open vented)"] += 4;
        base["Regular + Mixergy (vented)"] += 3;
      } else {
        base["Combi"] -= 3;
      }
    }

    // High disruption → more freedom to reconfigure
    if (dis === 'high') {
      base["System + Unvented Cylinder"] += 5;
      base["System + Mixergy (unvented)"] += 6;
    }

    // Space
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

    // Mixergy electrics & cost
    if (has16A) {
      base["System + Mixergy (unvented)"] += 6;
      base["Regular + Mixergy (vented)"] += 4;
    } else {
      base["System + Mixergy (unvented)"] -= 15;
      base["Regular + Mixergy (vented)"] -= 5;
    }

    const initialScores = Object.fromEntries(Object.entries(base).map(([k,v])=>[k,clamp01(v)]));

    // ---------- Model prompt ----------
    const SYSTEM = `
You are an experienced UK heating adviser. Choose ONLY from:
- Regular (open vented)
- System + Unvented Cylinder
- System + Mixergy (unvented)
- Regular + Mixergy (vented)
- Combi
Never propose heat pumps or electric-only.

Rules to honour:
- If disruption_tolerance = "low" → strong bias to KEEP THE SAME SYSTEM TYPE (like-for-like).
- "post_retirement" persona suggests lower disruption, but do NOT override the like-for-like rule above.
- Pressure/flow, occupancy, and space constraints as provided.
- Mixergy requires a dedicated 16 A RCD/MCB and has higher cost; mention this if selected when electrics_16a != "yes".

You are given inputs and transparent initial scores (0–100). 
Adjust scores by at most ±10 based on nuance, then return the TOP FOUR.
Return STRICT JSON ONLY:
{
  "recommendations":[
    {"title":"<allowed title>","reason":"one concise evidence-based sentence","match": <0-100 integer>},
    ...
  ]
}
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

    // Add best remaining by our base scores if fewer than 4
    const have = new Set(recs.map(r => r.title));
    const sortedByBase = Object.entries(initialScores)
      .sort((a,b)=>b[1]-a[1])
      .map(([k,v])=>({ title:k, match:v, reason:"Included based on rule score." }));

    for (const c of sortedByBase) {
      if (recs.length >= 4) break;
      if (!have.has(c.title)) recs.push(c);
    }

    recs.sort((a,b)=>b.match - a.match);
    recs = recs.slice(0,4);

    return new Response(JSON.stringify({ recommendations: recs }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};