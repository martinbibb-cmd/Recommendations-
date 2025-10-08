// Cloudflare Worker API endpoint
const CONFIG = {
  PROXY_URL: 'https://survey-brain-api.martinbibb.workers.dev/api/recommend'
};

// Safe getters
const val = id => (document.getElementById(id)?.value ?? '');
const num = (id, fallback=0) => {
  const n = Number(val(id));
  return Number.isFinite(n) && n !== 0 ? n : fallback;
};

// Keep pct helper
const pct = n => Math.max(0, Math.min(100, Math.round(Number(n || 0))));

function readForm(){
  return {
    // demand
    bathrooms: num('bathrooms', 1),
    simultaneous_use: val('simultaneous_use'),                 // yes|no
    // water
    standing_pressure_bar: num('standing_pressure', 0),
    working_pressure_desc: val('working_pf'),                  // "12 L/min @ 1.2 bar"
    pressure_test_method: val('test_method'),                  // single_tap|outside_tap|three_tap
    flow_lpm: num('flow_lpm', 0),
    // existing
    existing_system: val('existing_system'),
    hot_water: val('hot_water'),
    space_for_cylinder: val('cyl_space'),                      // none|tight|ample
    disruption_tolerance: val('disruption'),                   // low|medium|high
    electrics_16a: val('electrics_16a'),                       // yes|no|unknown
    property_condition: val('property_condition'),             // gravity_old|modern_pressurised|unknown
    // people & priorities
    occupancy: val('occupancy'),
    future_plans: val('future_plans'),                         // yes|no|unsure
    budget_priority: val('budget_priority'),                   // install_cost|running_costs|long_term_value|future_flex
    reliability_priority: val('reliability_priority'),         // yes|no
    // notes
    additional_info: val('notes')
  };
}

function renderOverview(text){
  const wrap = document.getElementById('overviewWrap');
  const p = document.getElementById('overview');
  if (text && String(text).trim().length){
    p.textContent = text;
    wrap.style.display = '';
  } else {
    wrap.style.display = 'none';
  }
}

function renderRecs(items){
  const host = document.getElementById('results');
  if (!items || !items.length){
    host.innerHTML = '<article class="card"><p class="muted">No recommendations returned.</p></article>';
    return;
  }
  host.innerHTML = items.map(x=>{
    const m = pct(x.match);
    const steps = (x.next_steps||[]).map(s=>`<li>${s}</li>`).join('');
    return `
      <article class="card">
        <header style="display:flex;justify-content:space-between;align-items:center">
          <strong>${x.title}</strong>
          <span class="muted">${m}% match</span>
        </header>
        <div class="progress" style="margin:.5rem 0"><span style="width:${m}%"></span></div>
        <p>${x.reason||''}</p>
        ${steps?`<details><summary>Next steps</summary><ul>${steps}</ul></details>`:''}
      </article>
    `;
  }).join('');
}

async function run(){
  const status = document.getElementById('status');
  const results = document.getElementById('results');
  results.innerHTML = '';
  renderOverview('');
  status.textContent = 'Scoring…';

  try{
    const payload = readForm();
    const res = await fetch(CONFIG.PROXY_URL, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!res.ok) throw new Error(await res.text());
    const data = await res.json();

    renderOverview(data.overview || '');
    renderRecs((data.recommendations||[]).slice(0,4));
    status.textContent = 'Done.';
  }catch(err){
    console.error(err);
    status.textContent = 'Model call failed';
    results.innerHTML = `<article class="card"><pre class="muted" style="white-space:pre-wrap">${(err && err.message)||String(err)}</pre></article>`;
  }
}

// Bind after DOM is ready (important on iPhone/Safari)
function auditIds(){
  const ids = [
    'bathrooms','simultaneous_use',
    'standing_pressure','working_pf','test_method','flow_lpm',
    'existing_system','hot_water','cyl_space','disruption','electrics_16a','property_condition',
    'occupancy','future_plans','budget_priority','reliability_priority',
    'notes','go','status','results','overviewWrap','overview'
  ];
  const missing = ids.filter(id => !document.getElementById(id));
  alert("Missing IDs: " + (missing.length ? missing.join(", ") : "none"));
}

document.addEventListener('DOMContentLoaded', () => {
  auditIds(); // <— runs once when the page loads
  document.getElementById('go')?.addEventListener('click', run);
});
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('go')?.addEventListener('click', run);
});