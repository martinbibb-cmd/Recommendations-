export default async (req) => {
  try {
    const input = await req.json();

    // ---------- Allowed ----------
    const ALLOWED = [
      "Regular (open vented)",
      "System + Unvented Cylinder",
      "System + Mixergy (unvented)",
      "Regular + Mixergy (vented)",
      "Combi"
    ];

    // ---------- Helpers ----------
    const num = (v, d=0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    const str = (v) => String(v || "").toLowerCase();
    const clamp01 = v => Math.max(0, Math.min(100, v));
    const parseWorkingBar = (s) => {
      const m = String(s || "").match(/@?\s*([0-9]+(?:\.[0-9]+)?)\s*bar/i);
      return m ? Number(m[1]) : NaN;
    };

    // ---------- Inputs ----------
    const flowRaw = num(input.flow_lpm);
    const standBar = num(input.standing_pressure_bar);
    let workBar = parseWorkingBar(input.working_pressure_desc);
    if (workBar === 0) workBar = NaN; // 0 means unknown, don't penalise
    const method = str(input.pressure_test_method); // single_tap | two_tap | outside_tap
    const sys  = str(input.existing_system);
    const hw   = str(input.hot_water);
    const baths = Math.max(0, num(input.bathrooms, 1));
    const occ  = str(input.occupancy);
    const dis  = str(input.disruption_tolerance);
    const space = str(input.space_for_cylinder);
    const has16A = str(input.electrics_16a) === 'yes';
    const persona = str(input.persona);
    const notes = String(input.additional_info || "");

    // Flow-cup correction for combi (basic test)
    const flowEffectiveForCombi = method === 'single_tap' ? Math.max(0, flowRaw - 2) : flowRaw;

    // Flags
    const workingOK1 = Number.isFinite(workBar) ? (workBar >= 1.0) : (standBar >= 1.5);
    const workingOK2 = Number.isFinite(workBar) ? (workBar >= 2.0) : (standBar >= 2.0);

    // Suitability gates from your rules of thumb
    const COMBI_OK    = (flowEffectiveForCombi >= 10) && workingOK1;
    const UNVENTED_OK = (flowRaw >= 30) && workingOK2;   // 25 mm main recommended (mentioned in reason)
    const UNVENTED_NEAR = (flowRaw >= 25) && (Number.isFinite(workBar) ? workBar >= 1.8 : standBar >= 1.8);

    // Stored systems benefit with more concurrent use
    const storedDemand = baths >= 2 || /family|guests|two_to_three|two_plus_guests|family4plus/.test(occ);

    // ---------- Base scores ----------
    const base = {
      "Regular (open vented)":            60,
      "System + Unvented Cylinder":       50,
      "System + Mixergy (unvented)":      55,
      "Regular + Mixergy (vented)":       55,
      "Combi":                            40
    };

    // Pressure/flow — stored systems
    if (UNVENTED_OK) {
      base["System + Unvented Cylinder"] += 22;
      base["System + Mixergy (unvented)"] += 22;
      base["Regular (open vented)"] -= 4;
    } else if (UNVENTED_NEAR) {
      base["System + Unvented Cylinder"] += 10;
      base["System + Mixergy (unvented)"] += 12;
    }

    // Combi suitability
    if (COMBI_OK) {
      base["Combi"] += 18;
      // Small household + tight space + not low disruption → combi makes lots of sense
      const smallHousehold = baths <= 1 && /^(single|two_always)$/.test(occ);
      const tightSpace = (space === 'tight' || space === 'none');
      if (smallHousehold) base["Combi"] += 10;
      if (tightSpace) base["Combi"] += 8;
      if (dis === 'medium' || dis === 'high') base["Combi"] += 6;
    } else {
      // If we know it's below 10 L/min@1 bar, avoid combi
      if (flowEffectiveForCombi < 10 && Number.isFinite(workBar) && workBar < 1.0) {
        base["Combi"] -= 18;
      }
    }

    // Concurrency favours stored
    if (storedDemand) {
      base["System + Unvented Cylinder"] += 12;
      base["System + Mixergy (unvented)"] += 14; // demand smoothing
      base["Regular + Mixergy (vented)"] += 10;
      base["Combi"] -= 10;
      base["Regular (open vented)"] -= 4;
    }

    // Test method trust / “gold standard”
    if (method === 'two_tap') {
      base["System + Unvented Cylinder"] += 4;
      base["System + Mixergy (unvented)"] += 5;
      base["Regular + Mixergy (vented)"] += 4;
    } else if (method === 'outside_tap') {
      base["System + Unvented Cylinder"] += 2;
      base["System + Mixergy (unvented)"] += 3;
    }

    // Disruption tolerance — like-for-like only when LOW
    if (dis === 'low') {
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

    // Persona: post_retirement → gentle nudge to lower disruption (doesn't override)
    if (/post_retirement/.test(persona)) {
      if (sys === 'regular' || sys === 'back_boiler') {
        base["Regular (open vented)"] += 4;
        base["Regular + Mixergy (vented)"] += 3;
      } else {
        base["Combi"] -= 3;
      }
    }

    // Space constraints
    if (space === 'none') {
      base["System + Unvented Cylinder"] -= 100;
      base["System + Mixergy (unvented)"] -= 100;
      base["Regular + Mixergy (vented)"] -= 100;
    } else if (space === 'tight') {
      base["System + Unvented Cylinder"] -= 10; // stronger than before
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

    // Customer preference nudge
    if (/\bwants?\s+a?\s*combi\b/i.test(notes)) base["Combi"] += 6;

    // Mixergy electrics & cost
    if (has16A) {
      base["System + Mixergy (unvented)"] += 6;
      base["Regular + Mixergy (vented)"] += 4;
    } else {
      base["System + Mixergy (unvented)"] -= 15;
      base["Regular + Mixergy (vented)"] -= 5;
    }

    const initialScores = Object.fromEntries(
      Object.entries(base).map(([k,v])=>[k, clamp01(v)])
    );

    // ---------- Model prompt (kept tight) ----------
    const SYSTEM = `
You are an experienced UK heating adviser. Choose ONLY from:
- Regular (open vented)
- System + Unvented Cylinder
- System + Mixergy (unvented)
- Regular + Mixergy (vented)
- Combi
Never propose heat pumps or electric-only.

Rules that must hold:
- Flow-cup overestimates combi: when test_method="single_tap", treat flow for combi as flow-2 L/min.
- COMBI rule-of-thumb: >=10 L/min @ >=1.0 bar (or standing >=1.5 bar if working unknown).
- UNVENTED rule-of-thumb: >=30 L/min @ >=2.0 bar; 25 mm cold main recommended (mention in reason).
- Mixergy works at any pressure; if pressure/flow poor prefer Regular+Mixergy (vented), if strong prefer System+Mixergy (unvented).
- If disruption_tolerance="low": strong bias to KEEP THE SAME SYSTEM TYPE (like-for-like).
- "post_retirement" persona gently favors lower-disruption, but does not override like-for-like.
- If electrics_16a != "yes" and Mixergy is recommended, mention dedicated 16 A RCD/MCB and higher cost.

You are given inputs + initial scores (0-100). You may adjust any score by ±10 max for nuance.
Return TOP FOUR as STRICT JSON:
{
  "recommendations":[
    {"title":"<allowed>","reason":"one concise evidence-based sentence","match": <0-100>},
    ...
  ]
}
`;

    const USER = {
      inputs: {
        flow_lpm: flowRaw,
        flow_effective_for_combi: flowEffectiveForCombi,
        standing_pressure_bar: standBar,
        working_pressure_bar: Number.isFinite(workBar) ? workBar : null,
        bathrooms: baths,
        occupancy: occ,
        disruption_tolerance: dis,
        space_for_cylinder: space,
        existing_system: sys,
        hot_water: hw,
        electrics_16a: has16A ? "yes" : (str(input.electrics_16a) || "no"),
        persona,
        test_method: method,
        additional_info: notes
      },
      initial_scores: initialScores,
      allowed_titles: ALLOWED,
      adjust_limit: 10
    };

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
      // Mention 25 mm main for unvented where appropriate
      if (title === "System + Unvented Cylinder") {
        if (!/25\s*mm/i.test(reason)) reason += " 25 mm cold main recommended.";
      }
      return { title, reason, match };
    });

    // Backfill to 4 using base scores if needed
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
    return new Response(JSON.stringify({ error