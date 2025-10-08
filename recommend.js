// Cloudflare Worker API endpoint
const CONFIG = {
  PROXY_URL: 'https://survey-brain-api.martinbibb.workers.dev/api/recommend'
};

// Helpers
const val = id => (document.getElementById(id)?.value ?? '');
const num = (id, d=0) => {
  const n = Number(val(id));
  return Number.isFinite(n) ? n : d;
};
const pct = n => Math.max(0, Math.min(100, Math.round(Number(n || 0))));

// Collect form values (IDs match index.html exactly)
function readForm(){
  return {
    // demand
    bathrooms:               num('bathrooms', 1),
    simultaneous_use:        val('simultaneous_use'),

    // water
    standing_pressure_bar:   num('standing_pressure', 0),
    working_pressure_desc:   val('working_pf'),
    pressure_test_method:    val('test_method'),
    flow_lpm:                num('flow_lpm', 0),

    // existing
    existing_system:         val('existing_system'),
    hot_water:               val('hot_water'),
    space_for_cylinder:      val('cyl_space'),
    disruption_tolerance:    val('disruption'),
    electrics_16a:           val('electrics_16a'),
    property_condition:      val('property_condition'),

    // people & priorities
    occupancy:               val('occupancy'),
    future_plans:            val('future_plans'),
    budget_priority:         val('budget_priority'),
    reliability_priority:    val('reliability_priority'),

    // notes
    additional_info:         val('notes')
  };
}
// --- Toast-style ping for success or error ---
function showPing(message, color = '#0b7a0b') {
  const div = document.createElement('div');
  div.textContent = message;
  Object.assign(div.style, {
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: color,
    color: 'white',
    padding: '8px 16px',
    borderRadius: '6px',
    zIndex: 9999,
    fontSize: '0.9rem',
    boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
    opacity: '0',
    transition: 'opacity 0.3s'
  });
  document.body.appendChild(div);
  requestAnimationFrame(() => (div.style.opacity = '1'));
  setTimeout(() => {
    div.style.opacity = '0';
    setTimeout(() => div.remove(), 300);
  }, 1500);
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
        <p>${x.reason || x.desc || ''}</p>
        ${steps ? `<details><summary>Next steps</summary><ul>${steps}</ul></details>` : ''}
      </article>
    `;
  }).join('');
}

async function run(){
  const status  = document.getElementById('status');
  const results = document.getElementById('results');
  results.innerHTML = '';
  renderOverview('');
  if (status) status.textContent = 'Scoring…';

  try{
    const payload = readForm();
    const res = await fetch(CONFIG.PROXY_URL, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!res.ok) throw new Error(await res.text());
    const data = await res.json();

renderOverview(data.overview || data.summary || '');
renderRecs((data.recommendations || []).slice(0,4));
if (status) status.textContent = 'Done.';
showPing('Results updated ✅', '#0b7a0b');
  }catch(err){
    console.error(err);
    if (status) status.textContent = 'Model call failed';
    results.innerHTML =
      `<article class="card"><pre class="muted" style="white-space:pre-wrap">${(err && err.message)||String(err)}</pre></article>`;
  }
}

// Expose for inline fallbacks (works even if event binding is flaky)
window.SB = {
  run,
  print: () => window.print()
};

// Primary event binding
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('go')?.addEventListener('click', run);
  document.getElementById('print')?.addEventListener('click', () => window.print());
  const s = document.getElementById('status');
  if (s) s.textContent = 'Ready.';  // proves JS loaded
});