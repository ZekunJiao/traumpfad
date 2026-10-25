const bytes = value => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format(value / (value < 1e9 ? 1e6 : 1e9)) + (value < 1e9 ? ' MB' : ' GB');
const number = value => new Intl.NumberFormat('de-DE').format(value || 0);
export function initDiskCache({ getToken }) {
  const $ = id => document.getElementById(id);
  let state, busy = false, verifiedAt = 0;
  const api = async (action, body) => {
    const response = await fetch('/api/tile-cache/' + action, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Mapbox-Token': getToken() || '', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Lokaler Cache ist nicht erreichbar.');
    return data;
  };
  function render() {
    if (!state) return;
    $('disk-cache-summary').textContent = `${bytes(state.diskBytes)} / ${bytes(state.limitBytes)} · ${number(state.fresh)} gültige, ${number(state.expired)} abgelaufene Kacheln · ${number(state.counters.hits)} lokale Treffer · ${number(state.counters['prefetch-attempts'])} Vorab-Anfragen insgesamt`;
    const job = state.job;
    $('disk-cache-progress').hidden = !job;
    if (job) {
      $('disk-cache-progress').max = Math.max(1, job.planned); $('disk-cache-progress').value = job.fresh;
      const minutes = Math.ceil(job.estimatedSeconds / 60);
      $('disk-cache-plan').textContent = `${number(job.fresh)} / ${number(job.planned)} Kacheln aktuell gültig${job.unavailable ? ` · ${number(job.unavailable)} vom Anbieter nicht verfügbar (404)` : ''} · Paket geschätzt ${bytes(job.estimatedBytes)} (${job.estimateBasedOnCache ? 'aus vorhandenen Kacheln' : 'teils angenommene Dateigrößen'}) · verbleibend mindestens ca. ${number(minutes)} Minuten, abhängig von Verbindung und Wartezeiten · übertragen ${bytes(job.transferred)} · ${number(job.attempts)} Vorab-Anfragen. ${job.message || ''}${job.retryAt > Date.now() ? ' Frühestes Fortsetzen: ' + new Date(job.retryAt).toLocaleTimeString('de-DE') + '.' : ''}`;
      if (!job.variantsReady) $('disk-cache-plan').textContent += ' Bitte zuerst Satellitenkarte und Gelände laden, danach neu planen.';
    }
    const fields = ['satellite', 'terrain', 'combined'].map(name => $('disk-quota-' + name).value.trim());
    const budgets = fields.map(value => value === '' ? NaN : Number(value));
    const remaining = job?.remaining || {}, satellite = remaining['mapbox.satellite'] || 0, terrain = remaining['mapbox.mapbox-terrain-dem-v1'] || 0;
    const sufficient = budgets.every(value => Number.isSafeInteger(value) && value >= 0) && Math.floor(budgets[0] * .8) >= satellite && Math.floor(budgets[1] * .8) >= terrain && Math.floor(budgets[2] * .8) >= satellite + terrain;
    const running = job?.state === 'running';
    $('disk-cache-prepare').disabled = busy || running;
    $('disk-cache-start').disabled = busy || !job || running || !job.variantsReady || !sufficient || !$('disk-quota-verified').checked || Date.now() - verifiedAt > 15 * 60000 || job.retryAt > Date.now() || job.estimatedBytes > state.limitBytes;
    $('disk-cache-start').textContent = job?.attempts ? 'Fortsetzen / abgelaufene Kacheln aktualisieren' : 'Vorabdownload starten';
    $('disk-cache-pause').disabled = busy || !running;
    $('disk-cache-clear').disabled = busy || running;
    $('disk-cache-budget').textContent = (!$('disk-quota-verified').checked || Date.now() - verifiedAt > 15 * 60000) ? 'Vorladen gesperrt: Kostenloses Restkontingent noch nicht aktuell bestätigt.' : !sufficient ? 'Vorladen gesperrt: Restkontingent unbekannt oder mit 20 % Reserve zu klein.' : 'Restkontingent bestätigt. Es werden höchstens die freigegebenen Anfragen gestartet; andere Kontonutzung muss pausiert bleiben.';
  }
  async function refresh() { try { state = await api('status'); render(); } catch (error) { $('disk-cache-error').textContent = error.message; } }
  async function action(name, body = {}) {
    if (busy) return;
    busy = true; $('disk-cache-error').textContent = ''; render();
    try { await api(name, body); if (name === 'start') { verifiedAt = 0; $('disk-quota-verified').checked = false; } await refresh(); }
    catch (error) { $('disk-cache-error').textContent = error.message; }
    finally { busy = false; render(); }
  }
  $('disk-cache-prepare').addEventListener('click', () => action('plan'));
  $('disk-cache-check').addEventListener('click', refresh);
  $('disk-cache-pause').addEventListener('click', () => action('pause'));
  $('disk-cache-clear').addEventListener('click', () => action('clear'));
  $('disk-cache-start').addEventListener('click', () => action('start', { satellite: Number($('disk-quota-satellite').value), terrain: Number($('disk-quota-terrain').value), combined: Number($('disk-quota-combined').value), verified: $('disk-quota-verified').checked, checkedAt: verifiedAt }));
  for (const id of ['disk-quota-satellite', 'disk-quota-terrain', 'disk-quota-combined']) $(id).addEventListener('input', () => { verifiedAt = 0; $('disk-quota-verified').checked = false; render(); });
  $('disk-quota-verified').addEventListener('input', () => { verifiedAt = $('disk-quota-verified').checked ? Date.now() : 0; render(); });
  // Poll only while the settings are visible. No planning or downloading on a timer.
  const timer = setInterval(() => { if ($('settings-dialog').open && !document.hidden && !busy) refresh(); }, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  $('settings-button').addEventListener('click', refresh);
  $('connect-button').addEventListener('click', refresh);
  return { refresh };
}
