// --- config ---
const CONFIG = {
  PROXY_URL: 'https://survey-brain-api.martinbibb.workers.dev/api/recommend'
};

// --- helpers ---
const el = id => document.getElementById(id);
const val = id => el(id).value;
const pct = n => Math.max(0, Math.min(100, Math.round(Number(n || 0))));

// Build payload from form
function readForm() {
  return {
    flow_lpm: Number(val('flow')),
    standing_pressure_bar: Number(val('standing_pressure')),
    working_pressure_desc: val('working_pressure'),
    pressure_test_method: val('test_method'),
    existing_system: val('system'),
    hot_water: val('hot_water'),
    bathrooms: Number(val('bathrooms')),
    occupancy: val('occupancy'),
    disruption_tolerance: val('disruption'),
    space_for_cylinder: val('cyl_space'),
    electrics_16a: val('electrics_16a'),
    persona: val('persona'),
    additional_info: val('notes')
  };
}

// Render cards
function render(items) {
  const wrap = el('results');
  if (!items || !items.length) {
    wrap.innerHTML = '<p class="muted">No recommendations returned.</p>';
    return;
  }
  wrap.innerHTML = items.map(x => {
    const m = pct(x.match);
    return `
      <article class="card">
        <header style="display:flex;justify-content:space-between;align-items:center">
          <strong>${x.title}</strong>
          <span class="muted">${m}% match</span>
        </header>
        <div class="progress"><div class="progress-bar" style="width:${m}%;height:6px;background:#0d6efd;border-radius:3px"></div></div>
        <p style="margin-top:8px">${x.reason || ''}</p>
        ${x.next_steps ? `<ul>${x.next_steps.map(s=>`<li>${s}</li>`).join('')}</ul>` : ''}
      </article>
    `;
  }).join('');
}

// --- main action ---
async function run() {
  const status = el('status');
  const results = el('results');
  results.innerHTML = '';
  status.textContent = 'Calling model…';

  try {
    const payload = readForm();

    const res = await fetch(CONFIG.PROXY_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const items = (data.recommendations || []).slice(0, 4);
    render(items);
    status.textContent = 'Done.';
  } catch (err) {
    console.error(err);
    status.textContent = 'Model call failed';
    el('results').innerHTML = `<pre class="muted" style="white-space:pre-wrap">${(err && err.message) || String(err)}</pre>`;
  }
}

// Make run() available to onclick="run()"
window.run = run;