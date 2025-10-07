// CommonJS Netlify Function
async function handler(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return json({ error: 'Use POST' }, 405);
    }

    const input = JSON.parse(event.body || '{}');

    // ---------------- Allowed options ----------------
    const ALLOWED = [
      'Regular (open vented)',
      'System + Unvented Cylinder',
      'System + Mixergy (unvented)',
      'Regular + Mixergy (vented)',
      'Combi'
    ];

    // ---------------- Helpers ----------------
    const num = (v, d = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const str = (v) => String(v || '').toLowerCase();
    const clamp01 = (v) => Math.max(0, Math.min(100, v));

    // Parse "12 L/min @ 1.2 bar" (we only care about the "@ <bar>")
    const parseWorkingBar = (s) => {
      const m = String(s || '').match(/@?\s*([0-9]+(?:\.[0-9]+)?)\s*bar/i);
      return m ? Number(m[1]) : NaN;
    };

    // ---------------- Inputs ----------------
    const flow = num(input.flow_lpm);
    const standBar = num(input.standing_pressure_bar);
    const testMethod = str(input.pressure_test_method); // 'single_tap' | 'two_tap' | 'outside_tap'
    const sys = str(input.existing_system);             // 'regular' | 'system' | 'combi' | 'back_boiler' | ...
    const hw = str(input.hot_water);                    // 'vented' | 'unvented' | 'none'
    const baths = Math.max(0, num(input.bathrooms, 1));
    const occ = str(input.occupancy);                   // 'single' | 'two_always' | 'two_plus_guests' | ...
    const dis = str(input.disruption_tolerance);        // 'low' | 'medium' | 'high'
    const space = str(input.space_for_cylinder);        // 'none' | 'tight' | 'ample'
    const has16A = str(input.electrics_16a) === 'yes';
    const persona = str(input.persona);                 // includes 'post_retirement'
    const notes = String(input.additional_info || '');

    // Working pressure
    let workBar = parseWorkingBar(input.working_pressure_desc);
    // Treat 0 or missing as UNKNOWN (do not penalise)
    let workBarEff = Number.isFinite(workBar) ? workBar : NaN;
    if (workBarEff === 0) workBarEff = NaN;

    // Flow-cup only? Deduct 2–3 L/min for real combi performance
    const flowCupOnly = testMethod === 'single_tap';
    const combiFlowEff = Math.max(0, flow - (flowCupOnly ? 2.5 : 0));

    // Confidence by test method (small effect)
    let confAdj = 0;
    if (testMethod === 'outside_tap') confAdj += 5;
    if (testMethod === 'two_tap') confAdj += 7;
    if (testMethod === 'single_tap') confAdj -= 4;

    // Textbook suitability flags
    const goodForCombi =
      combiFlowEff >= 10 &&
      ((Number.isFinite(workBarEff) && workBarEff >= 1.0) || standBar >= 2.0);
    const strongForCombi =
      combiFlowEff >= 14 &&
      ((Number.isFinite(workBarEff) && workBarEff >= 1.5) || standBar >= 2.5);

    const unventedAcceptable =
      flow >= 25 &&
      ((Number.isFinite(workBarEff) && workBarEff >= 1.5) || standBar >= 2.0);
    const unventedIdeal =
      flow >= 30 &&
      ((Number.isFinite(workBarEff) && workBarEff >= 2.0) || standBar >= 2.5);

    // ---------------- Base scores ----------------
    const base = {
      'Regular (open vented)': 60,
      'System + Unvented Cylinder': 50,
      'System + Mixergy (unvented)': 55,
      'Regular + Mixergy (vented)': 55,
      'Combi': 40
    };

    // Pressure/flow effects (stored systems)
    if (unventedIdeal) {
      base['System + Unvented Cylinder'] += 22;
      base['System + Mixergy (unvented)'] += 22;
      base['Regular (open vented)'] -= 3;
    } else if (unventedAcceptable) {
      base['System + Unvented Cylinder'] += 12;
      base['System + Mixergy (unvented)'] += 12;
    } else {
      // Known poor mains → penalise combi/unvented
      if (flow < 13) base['Combi'] -= 12;
      if (Number.isFinite(workBarEff) && workBarEff < 1.5) {
        base['Combi'] -= 8;
        base['System + Unvented Cylinder'] -= 16;
      }
    }

    // Combi suitability
    if (goodForCombi) {
      base['Combi'] += 10;
      if (strongForCombi) base['Combi'] += 8;
    }

    // Occupancy / bathrooms (stored bias)
    const smallHousehold = baths <= 1 && /^(single|two_always)$/.test(occ);
    const storedDemand =
      baths >= 2 || /family|guests|two_to_three|two_plus_guests|family4plus/.test(occ);

    if (storedDemand) {
      base['System + Unvented Cylinder'] += 12;
      base['System + Mixergy (unvented)'] += 14;
      base['Regular + Mixergy (vented)'] += 10;
      base['Combi'] -= 10;
      base['Regular (open vented)'] -= 4;
    } else if (smallHousehold) {
      // textbook combi if mains okay
      if (goodForCombi) base['Combi'] += 15;
    }

    // Tight space favours combi / penalises big cylinders
    const tightSpace = space === 'tight' || space === 'none';
    if (tightSpace) {
      base['Combi'] += 8;
      if (space === 'none') {
        base['System + Unvented Cylinder'] -= 100;
        base['System + Mixergy (unvented)'] -= 100;
        base['Regular + Mixergy (vented)'] -= 100;
      } else {
        base['System + Unvented Cylinder'] -= 10; // was -6
      }
    }

    // Disruption tolerance — like-for-like when LOW (regardless of age)
    if (dis === 'low') {
      if (sys === 'regular' || (sys === 'back_boiler' && hw === 'vented')) {
        base['Regular (open vented)'] += 20;
        base['Regular + Mixergy (vented)'] += 12;
        base['System + Unvented Cylinder'] -= 8;
        base['System + Mixergy (unvented)'] -= 8;
      } else if (sys === 'system' || hw === 'unvented') {
        base['System + Unvented Cylinder'] += 18;
        base['System + Mixergy (unvented)'] += 14;
        base['Regular (open vented)'] -= 6;
        base['Combi'] -= 8;
      } else if (sys === 'combi') {
        base['Combi'] += 16;
        base['System + Unvented Cylinder'] -= 6;
        base['Regular (open vented)'] -= 6;
      }
    } else if (dis === 'high') {
      base['System + Unvented Cylinder'] += 5;
      base['System + Mixergy (unvented)'] += 6;
    }

    // Persona: post_retirement → gentle lower-disruption nudge
    if (/post_retirement/.test(persona)) {
      if (sys === 'regular' || sys === 'back_boiler') {
        base['Regular (open vented)'] += 4;
        base['Regular + Mixergy (vented)'] += 3;
      } else {
        base['Combi'] -= 3;
      }
    }

    // Existing system inertia (mild; low disruption already handled)
    if (sys === 'regular' || (sys === 'back_boiler' && hw === 'vented')) {
      base['Regular (open vented)'] += 8;
      base['Regular + Mixergy (vented)'] += 6;
    } else if (sys === 'system' || hw === 'unvented') {
      base['System + Unvented Cylinder'] += 6;
      base['System + Mixergy (unvented)'] += 5;
    } else if (sys === 'combi') {
      base['Combi'] += 5;
    }

    // Mixergy electrics & cost
    if (has16A) {
      base['System + Mixergy (unvented)'] += 6;
      base['Regular + Mixergy (vented)'] += 4;
    } else {
      base['System + Mixergy (unvented)'] -= 15;
      base['Regular + Mixergy (vented)'] -= 5;
    }

    // Customer intent nudge
    if (/\bwants?\s+a?\s*combi\b/i.test(notes)) base['Combi'] += 6;

    // Confidence tweak from test method
    Object.keys(base).forEach(k => (base[k] += confAdj * 0.5));

    // Clamp 0..100 and build initial scores
    const initialScores = Object.fromEntries(
      Object.entries(base).map(([k, v]) => [k, clamp01(v)])
    );

    // --------------- Ask model for fine-tune (±10 only) ---------------
    const systemPrompt = `
You are an experienced UK heating adviser. Choose ONLY from:
- Regular (open vented)
- System + Unvented Cylinder
- System + Mixergy (unvented)
- Regular + Mixergy (vented)
- Combi
Never propose heat pumps or electric-only.

Water-test rules:
- Flow cup only: subtract ~2–3 L/min when judging combi performance.
- Combi: acceptable >= 10 L/min @ >= 1 bar (better >= 14 @ 1.5). If working pressure unknown, use standing pressure as context only.
- Unvented: acceptable >= 25 L/min @ >= 1.5 bar; ideal >= 30 @ >= 2.0 bar. If cold main size unknown, don't assume 25 mm.
- Mixergy (vented): works with any pressure/flow; performance varies (state that if chosen on weak mains).
- Mixergy (unvented): same as unvented, plus requires 16 A RCD/MCB (state this and higher cost).

Other rules:
- If disruption_tolerance = "low" → strong bias to KEEP THE SAME SYSTEM TYPE (like-for-like).
- "post_retirement" persona suggests lower disruption but must not override the like-for-like rule.
- Tight/no space favours combi over stored systems.

You are given inputs and transparent initial scores (0–100). Adjust any score by at most ±10, then return the TOP FOUR with one concise evidence-based sentence each. Return STRICT JSON ONLY:
{
  "recommendations":[
    {"title":"<allowed title>","reason":"...","match": <0-100 integer>},
    ...
  ]
}
`;

    const USER = {
      inputs: {
        flow_lpm: flow,
        flow_for_combi_eff_lpm: combiFlowEff,
        standing_pressure_bar: standBar,
        working_pressure_bar: Number.isFinite(workBarEff) ? workBarEff : null,
        pressure_test_method: testMethod,
        bathrooms: baths,
        occupancy: occ,
        disruption_tolerance: dis,
        space_for_cylinder: space,
        existing_system: sys,
        hot_water: hw,
        electrics_16a: has16A ? 'yes' : (str(input.electrics_16a) || 'no'),
        persona,
        additional_info: notes
      },
      initial_scores: initialScores,
      allowed_titles: ALLOWED,
      adjust_limit: 10
    };

    // Call OpenAI
    const apiKey = process.env.OPENAI_API_KEY || process.env.GPT_KEY;
    if (!apiKey) return json({ error: 'Missing OPENAI_API_KEY' }, 500);

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(USER) }
        ]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json({ error: errText }, 500);
    }

    const data = await resp.json();
    let out;
    try {
      out = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    } catch {
      out = null;
    }
    if (!out || !Array.isArray(out.recommendations)) out = { recommendations: [] };

    // Enforce allow-list & normalise & 16A warning
    const fixTitle = (t) => {
      if (ALLOWED.includes(t)) return t;
      if (/mixergy/i.test(t) && /regular/i.test(t)) return 'Regular + Mixergy (vented)';
      if (/mixergy/i.test(t)) return 'System + Mixergy (unvented)';
      if (/unvented|uv/i.test(t)) return 'System + Unvented Cylinder';
      if (/regular/i.test(t)) return 'Regular (open vented)';
      if (/combi/i.test(t)) return 'Combi';
      return 'Regular (open vented)';
    };

    const needs16A = !has16A;
    let recs = out.recommendations.map((r) => {
      const title = fixTitle(String(r.title || ''));
      let reason = String(r.reason || 'Evidence-based option.');
      let match = clamp01(num(r.match, initialScores[title] ?? 50));

      if (/mixergy/i.test(title) && needs16A) {
        if (!/16\s*A|RCD|MCB|cost/i.test(reason)) {
          reason += ' Requires dedicated 16 A RCD/MCB; higher install cost.';
        }
        match = clamp01(match - 10);
      }
      // If Mixergy (vented) on poor mains, mention performance variability
      if (/regular \+ mixergy/i.test(title) && (flow < 10 || (!Number.isFinite(workBarEff)))) {
        if (!/performance/i.test(reason)) {
          reason += ' Performance depends on available mains; vented setup remains reliable.';
        }
      }
      return { title, reason, match };
    });

    // If fewer than 4, top-up from our base scores
    const have = new Set(recs.map((r) => r.title));
    const sortedByBase = Object.entries(initialScores)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ title: k, match: v, reason: 'Included based on rule score.' }));

    for (const c of sortedByBase) {
      if (recs.length >= 4) break;
      if (!have.has(c.title)) recs.push(c);
    }

    recs.sort((a, b) => b.match - a.match);
    recs = recs.slice(0, 4);

    return json({ recommendations: recs }, 200);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// --------------- helpers ---------------
function json(payload, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

module.exports = { handler };