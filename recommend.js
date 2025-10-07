// Cloudflare Worker API endpoint
const CONFIG = {
  PROXY_URL: 'https://survey-brain-api.martinbibb.workers.dev/api/recommend'
};

const $ = id => document.getElementById(id);
const pct = n => Math.max(0, Math.min(100, Math.round(Number(n||0))));

function readForm(){
  return {
    // demand
    bathrooms: Number($('bathrooms').value || 1),
    simultaneous_use: $('simultaneous_use').value, // yes|no
    // water
    standing_pressure_bar: Number($('standing_pressure').value || 0),
    working_pressure_desc: $('working_pf').value,   // "12 L/min @ 1.2 bar"
    pressure_test_method: $('test_method').value,   // single_tap|outside_tap|three_tap
    flow_lpm: Number($('flow_lpm').value || 0),
    // existing
    existing_system: $('existing_system').value,
    hot_water: $('hot_water').value,
    space_for_cylinder: $('cyl_space').value,       // none|tight|ample
    disruption_tolerance: $('disruption').value,    // low|medium|high
    electrics_16a: $('electrics_16a').value,        // yes|no|unknown
    property_condition: $('property_condition').value, // gravity_old|modern_pressurised|unknown
    // people & priorities
    occupancy: $('occupancy').value,
    future_plans: $('future_plans').value,          // yes|no|unsure
    budget_priority: $('budget_priority').value,    // install_cost|running_costs|long_term_value|future_flex
    reliability_priority: $('reliability_priority').value, // yes|no
    // notes
    additional_info: $('notes').value
  };
}

function renderOverview(text){
  const wrap = $('overviewWrap');
  const p = $('overview');
  if (text && String(text).trim().length){
    p.textContent = text;
    wrap.style.display = '';
  } else {
    wrap.style.display = 'none';
  }
}

function renderRecs(items){
  const host = $('results');
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
  const status = $('status');
  const results = $('results');
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

document.getElementById('go').addEventListener('click', run);