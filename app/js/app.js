import { prepareRoute, validateJourney } from './route.js';
import { TourPlayer } from './player.js';
import { JourneyMap } from './map.js';
import { checkMapboxConnection } from './token-check.js';
import { readBrowserMapCache, describeBrowserMapCache } from './browser-cache.js';
import { PhotoCollage, decodePhotoNode } from './photo-collage.js';

const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value ?? ''; };
const formatDay = stage => stage.isFullRoute ? 'GESAMTSTRECKE' : `${stage.referenceSection ? 'ABSCHNITT' : 'TAG'} ${String(stage.day).padStart(2, '0')}`;
const formatDate = value => value ? new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', timeZone: 'Europe/Berlin' }).format(new Date(value + 'T12:00:00')) : 'Datum noch offen';
const dialogs = [...document.querySelectorAll('dialog')];
let journey, player, map, routes, collage, currentPhotoIds = [], currentPhotoIndex = 0, lastStage = -1, renderStatus = '', lastFrame = 0, noticeTimer, collageHideTimer, collageRevision = 0;

function announce(message) { text('live-region', message); }
function notify(message) {
  if (!message) return;
  text('notice', message); $('notice').hidden = false; clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 7500);
}
function closeDialogs() { for (const d of dialogs) if (d.open) d.close(); }
function openDialog(id) { if (!$(id).open) $(id).showModal(); }
function element(tag, className, content) { const el = document.createElement(tag); if (className) el.className = className; if (content !== undefined) el.textContent = content; return el; }
function placeholder(photo) {
  const box = element('div', 'sample-image');
  box.append(element('span', 'sample-symbol', '↟'), element('p', 'eyebrow', 'PLATZ FÜR DEINE ERINNERUNG'), element('h3', '', photo?.title || 'Dein Foto'), element('p', '', 'Hier erscheint später dein persönliches Foto.'));
  return box;
}
function photoNode(photo, thumb = false) {
  if (!photo || photo.placeholder || !photo.file) return placeholder(photo);
  const img = document.createElement('img');
  img.src = '/' + (thumb ? photo.thumbnail || photo.file : photo.file);
  img.alt = photo.alt || photo.title || photo.caption || 'Foto von der Reise'; img.decoding = 'async';
  if (thumb) img.loading = 'lazy';
  img.addEventListener('error', () => { if (img.isConnected) { const box = placeholder({ title: 'Bild nicht verfügbar' }); box.querySelector('p:last-child').textContent = 'Bitte Bilddatei und Import prüfen.'; img.replaceWith(box); } }, { once: true });
  return img;
}
async function loadCollagePhoto(photo, options) {
  try { return await decodePhotoNode(photoNode(photo), options); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    const node = placeholder({ title: 'Bild nicht verfügbar' });
    node.querySelector('p:last-child').textContent = 'Bitte Bilddatei und Import prüfen.';
    return node;
  }
}
function collagePageSize() { return $('main').clientWidth < 1000 || $('main').clientHeight < 760 ? 1 : 3; }
function layoutCollage() {
  const root = $('photo-collage'), main = $('main'), height = main.clientHeight;
  root.dataset.compact = String(collagePageSize() === 1);
  main.style.setProperty('--map-height', `${height}px`);
  const controlsBottom = height - $('player-controls-anchor').offsetTop + 12;
  root.style.setProperty('--collage-controls-bottom', `${controlsBottom}px`);
  const controlsTop = height - controlsBottom - ($('collage-controls').offsetHeight || 76);
  const photoTop = $('stage-card').offsetTop + $('stage-card').offsetHeight + 18;
  root.style.setProperty('--collage-photo-top', `${photoTop}px`);
  root.style.setProperty('--collage-small-height', `${Math.max(32, controlsTop - photoTop - 72)}px`);
  root.style.setProperty('--collage-left-height', `${Math.max(80, Math.min(height * .23, controlsTop - photoTop - 72))}px`);
  root.style.setProperty('--collage-lower-bottom', `${height - controlsTop + 18}px`);
}
function renderCollage(state) {
  const root = $('photo-collage'), images = $('collage-images'), revision = ++collageRevision;
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 400;
  clearTimeout(collageHideTimer);
  if (state.phase === 'hidden' || state.phase === 'waiting') {
    if (root.contains(document.activeElement)) $('play-button').focus({ preventScroll: true });
    for (const card of images.children) { card.classList.remove('is-shown'); card.setAttribute('aria-hidden', 'true'); }
    root.classList.remove('is-visible'); root.inert = true; root.setAttribute('aria-hidden', 'true');
    collageHideTimer = setTimeout(() => {
      if (revision !== collageRevision) return;
      root.hidden = true; images.replaceChildren(); $('main').classList.remove('has-collage');
    }, duration);
    return;
  }
  root.hidden = false; root.inert = false; root.setAttribute('aria-hidden', 'false');
  root.setAttribute('aria-busy', String(state.phase === 'loading'));
  $('main').classList.add('has-collage');
  text('collage-kicker', `${formatDay(player.stage)} · FOTOSTOPP`);
  text('collage-title', state.stop.title);
  text('collage-location', state.stop.approximate ? '◌ Ungefährer Aufnahmeort' : '● Zugeordneter Aufnahmeort');
  text('collage-count', state.phase === 'loading' ? 'Bilder werden geladen …' : state.phase === 'error' ? 'Bilder konnten nicht geladen werden.' : state.total ? `Bilder ${state.offset + 1}–${Math.min(state.total, state.offset + state.pageSize)} von ${state.total}` : 'Noch keine Bilder zugeordnet.');
  $('collage-pages').hidden = state.total <= state.pageSize;
  $('collage-previous').disabled = !state.hasPrevious; $('collage-next').disabled = !state.hasNext;
  if (state.phase === 'visible') {
    const oldCards = [...images.children];
    for (const card of oldCards) { card.classList.remove('is-shown'); card.setAttribute('aria-hidden', 'true'); }
    const cards = state.entries.map(({ photo, node }, index) => {
      const card = element('figure', `collage-card collage-slot-${index}`);
      card.style.setProperty('--photo-delay', `${index * 150}ms`);
      const visual = element('div', 'collage-visual'); visual.append(node);
      const caption = element('figcaption');
      caption.append(element('strong', '', photo?.title || state.stop.title));
      const copy = photo?.caption || state.stop.caption;
      if (copy) caption.append(element('span', '', copy));
      card.append(visual, caption); images.append(card); return card;
    });
    layoutCollage();
    // Establish the start styles once; CSS handles stagger and interrupted fades.
    void images.offsetWidth;
    root.classList.add('is-visible'); cards.forEach(card => card.classList.add('is-shown'));
    setTimeout(() => oldCards.forEach(card => card.remove()), duration);
    announce(`Fotostopp: ${state.stop.title}. ${$('collage-count').textContent}. Mit Leertaste den Flug fortsetzen.`);
  } else { root.classList.add('is-visible'); layoutCollage(); }
}
function sortedPhotos(stageId) {
  const actual = journey.photos.filter(p => p.stageId === stageId && !p.placeholder);
  return (actual.length ? actual : journey.photos.filter(p => p.stageId === stageId)).sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || '') || a.id.localeCompare(b.id));
}
function preloadNext() {
  const stop = player.stops.find(s => s.progress > player.state.progress + 1e-7);
  for (const id of stop?.photoIds || []) { const p = journey.photos.find(p => p.id === id); if (p?.file) { const image = new Image(); image.src = '/' + p.file; } }
}
function buildNavigation() {
  const select = $('chapter-select');
  const all = element('option', '', 'Alle Etappen'); all.value = 'all'; select.append(all);
  for (const chapter of journey.chapters) { const option = element('option', '', chapter.title); option.value = chapter.id; select.append(option); }
  if (journey.chapters.length === 1) select.value = journey.chapters[0].id;
  select.addEventListener('change', buildStageList); buildStageList();
}
function buildStageList() {
  const chapter = journey.chapters.find(c => c.id === $('chapter-select').value);
  $('stage-list').replaceChildren();
  journey.stages.forEach((stage, index) => {
    if (chapter && !chapter.stageIds.includes(stage.id)) return;
    const button = element('button', 'stage-button'); button.dataset.stage = index;
    const label = element('span');
    label.append(element('span', 'stage-name', stage.end), element('span', 'stage-sub', `${stage.date ? formatDate(stage.date) : stage.referenceSection ? 'GPX-Referenz' : 'Etappenbeispiel'} · ${stage.start}`));
    button.append(element('span', 'stage-number', stage.isFullRoute ? '∞' : String(stage.day).padStart(2, '0')), label);
    button.setAttribute('aria-current', String(index === player?.state.stageIndex));
    button.addEventListener('click', () => { closeDialogs(); player.selectStage(index); if (matchMedia('(max-width: 760px)').matches) $('main').scrollIntoView({ behavior: 'smooth' }); });
    $('stage-list').append(button);
  });
}
function render(state, reason) {
  const stage = player.stage;
  if (lastStage !== state.stageIndex || reason === 'stage') {
    lastStage = state.stageIndex; map.setStage(state.stageIndex);
    text('stage-kicker', `${formatDay(stage)} · ${stage.date ? formatDate(stage.date) : stage.referenceSection ? 'GPX-REFERENZ' : 'BEISPIELETAPPE'}`);
    text('stage-title', stage.title); text('stage-description', stage.description);
    $('stage-facts').replaceChildren(...(stage.isFullRoute
      ? [element('span', '', `${(routes[state.stageIndex].length / 1000).toFixed(1).replace('.', ',')} km`), element('span', '', `${routes[state.stageIndex].points.length.toLocaleString('de-DE')} Trackpunkte`)]
      : [element('span', '', stage.overnight ? `Übernachtung: ${stage.overnight}` : 'Schlafplatz noch ergänzen'), element('span', '', `${sortedPhotos(stage.id).filter(p => !p.placeholder).length} eigene Fotos`)]));
    $('gallery-button').hidden = Boolean(stage.isFullRoute);
    text('player-kicker', `${formatDay(stage)} · ${stage.start.toLocaleUpperCase('de')}`);
    text('player-title', stage.title);
    text('player-time', `${String(state.stageIndex + 1).padStart(2, '0')} / ${String(journey.stages.length).padStart(2, '0')}`);
    text('route-caption', stage.routeProvenance?.kind === 'schematic' ? 'Schematischer Beispielverlauf · keine tatsächliche Wanderaufzeichnung' : stage.routeProvenance?.kind === 'recorded' ? 'Route aus bereitgestellter GPS-Aufzeichnung' : stage.referenceSection ? 'GPX: Björn Mußmann / Outdooractive · Referenzvariante' : 'Rekonstruierter Verlauf · anhand deiner Etappen abzugleichen');
    preloadNext();
  }
  $('route-progress').value = String(Math.round(state.progress * 1000));
  $('route-progress').setAttribute('aria-valuetext', `${Math.round(state.progress * 100)} Prozent der Etappe`);
  if (reason === 'pause') map.pauseCamera();
  if (reason === 'stop-jump') map.focusStop(state.progress);
  else map.setProgress(state.progress, state.started && state.mode === 'presentation' && (state.status === 'playing' || reason === 'seek' || reason === 'stop'), Math.max(.016, (performance.now() - lastFrame) / 1000));
  if (reason === 'tick') return;
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
  for (const button of document.querySelectorAll('[data-stage]')) button.setAttribute('aria-current', String(Number(button.dataset.stage) === state.stageIndex));
  $('cover').hidden = state.started;
  $('stage-card').hidden = !state.started;
  $('play-button').textContent = state.status === 'playing' ? 'Ⅱ' : '▶';
  $('play-button').setAttribute('aria-label', state.status === 'playing' ? 'Flug pausieren' : state.status === 'stage-end' ? 'Nächste Etappe starten' : 'Flug starten');
  const status = { ready: 'Bereit zum Aufbruch', playing: 'Unterwegs …', paused: 'Du bestimmst das Tempo', stop: 'Zeit für eine Geschichte', 'stage-end': state.stageIndex === journey.stages.length - 1 ? 'Kapitel beendet · nochmal starten?' : 'Etappe geschafft · weiter mit ▶' }[state.status];
  text('player-status', state.mode === 'explore' ? 'Frei erkunden' : status);
  map.setExplore(state.mode === 'explore');
  if (reason === 'mode' && state.mode === 'presentation') map.setProgress(state.progress, state.started, .1);
  if (state.stopId && ['stop', 'stop-jump', 'mode'].includes(reason)) {
    const stop = player.stops.find(s => s.id === state.stopId);
    if (stop) showStop(stop);
  } else if (!state.stopId || state.status !== 'stop') collage.hide();
  if (renderStatus !== state.status || ['stage', 'mode'].includes(reason)) { announce(`${stage.title}. ${status}`); renderStatus = state.status; }
  if (reason !== 'tick') preloadNext();
}
function showStop(stop) {
  collage.queue(stop, stop.photoIds.map(id => journey.photos.find(photo => photo.id === id)).filter(Boolean));
}
function renderPhoto() {
  const photo = journey.photos.find(p => p.id === currentPhotoIds[currentPhotoIndex]);
  $('photo-visual').replaceChildren(photoNode(photo));
  text('photo-title', photo?.title || 'Dein Foto');
  text('photo-caption', photo?.caption || '');
  text('photo-credit', photo?.credit || (photo?.placeholder ? 'Demonstration · deine Bilder folgen nach dem Import.' : photo?.capturedAt ? `Aufgenommen: ${photo.capturedAt.replace('T', ' ').slice(0, 16)}` : ''));
  text('photo-count', `${currentPhotoIndex + 1} / ${currentPhotoIds.length}`);
  $('photo-previous').disabled = currentPhotoIndex === 0; $('photo-next').disabled = currentPhotoIndex === currentPhotoIds.length - 1;
  $('continue-button').textContent = 'Zurück zur Tagesgalerie ↗';
}
function openGallery() {
  player.pause(); player.closeStop(); collage.hide();
  text('gallery-kicker', `${formatDay(player.stage)} · ${formatDate(player.stage.date)}`);
  text('gallery-title', player.stage.title);
  text('gallery-description', 'Alle Bilder dieses Tages. Nur ausgewählte Fotostopps sind auf der Route verortet.');
  const photos = sortedPhotos(player.stage.id); $('gallery-grid').replaceChildren();
  if (!photos.length) $('gallery-grid').append(element('p', 'empty-state', 'Für diesen Tag sind noch keine Fotos importiert. Ergänze das Etappendatum und starte den Fotoimport.'));
  for (const photo of photos) {
    const button = element('button', 'gallery-item'), frame = element('div', 'gallery-thumb'); frame.append(photoNode(photo, true));
    button.append(frame, element('strong', '', photo.title || 'Erinnerung unterwegs'), element('span', '', photo.placeholder ? 'Beispiel · dein Foto folgt' : photo.capturedAt ? photo.capturedAt.slice(11, 16) + ' Uhr' : 'Zeit noch offen'));
    button.addEventListener('click', () => {
      currentPhotoIds = photos.map(p => p.id); currentPhotoIndex = currentPhotoIds.indexOf(photo.id);
      text('photo-kicker', `${formatDay(player.stage)} · TAGESGALERIE`); text('photo-location', 'Der Tagesetappe zugeordnet · kein einzelner Standort'); renderPhoto(); openDialog('photo-dialog');
    });
    $('gallery-grid').append(button);
  }
  openDialog('gallery-dialog');
}
function story(type) {
  player.pause(); const item = journey.stories[type];
  text('story-kicker', item.kicker); text('story-title', item.title); $('story-content').replaceChildren();
  for (const section of item.sections) {
    const el = element('section', 'story-section'); el.append(element('h3', '', section.title), element('p', '', section.text));
    if (section.photoId) { const photo = journey.photos.find(p => p.id === section.photoId); const image = photoNode(photo); image.style.maxWidth = '100%'; el.append(image); }
    $('story-content').append(el);
  }
  openDialog('story-dialog');
}
function mapStatus(status, message) {
  const titles = { schematic: 'Schematische Vorschau', loading: 'Satellitenkarte wird geladen …', ready: 'Satellit · 3D-Gelände', error: 'Lokale Vorschau · Karte nicht verfügbar' };
  const span = element('span', 'status-dot'); $('map-status').replaceChildren(span, document.createTextNode(titles[status]));
  $('connect-button').hidden = status === 'ready';
  if (status === 'error' && message) text('token-message', message);
  else if (status === 'ready' || status === 'schematic') text('token-message', '');
  if (message) notify(message);
}
let hasServerToken = false;
function updateTokenStorageStatus() {
  const saved = Boolean(storageGet());
  text('token-storage-status', saved ? `Schlüssel für ${location.host} im Browser gespeichert. Er wird beim Öffnen automatisch verwendet. Das leere Eingabefeld dient nur zum Ersetzen.` : hasServerToken ? 'Der Schlüssel des lokalen Servers wird automatisch verwendet.' : `Für ${location.host} ist noch kein Schlüssel im Browser gespeichert.`);
  $('mapbox-token').placeholder = saved ? 'Gespeichert · zum Ersetzen pk.… eingeben' : 'pk.…';
  text('save-token', saved ? 'Schlüssel ersetzen und aktivieren ↗' : 'Schlüssel speichern und aktivieren ↗');
}
function storageGet() { try { return localStorage.getItem('traumpfad.mapbox-token') || ''; } catch { return ''; } }
function storageSet(value) { try { if (value) localStorage.setItem('traumpfad.mapbox-token', value); else localStorage.removeItem('traumpfad.mapbox-token'); updateTokenStorageStatus(); } catch { notify('Der Browser erlaubt keine Speicherung. Der Schlüssel gilt für diese Sitzung.'); } }

async function refreshBrowserCache() {
  const button = $('check-cache');
  if (button.disabled) return;
  button.disabled = true;
  text('cache-message', 'Gespeicherte Kartenkacheln werden lokal geprüft …');
  try { text('cache-message', describeBrowserMapCache(await readBrowserMapCache())); }
  finally { button.disabled = false; }
}

async function init() {
  const [response, configResponse] = await Promise.all([fetch('/data/journey.json', { cache: 'no-store' }), fetch('/api/config')]);
  if (!response.ok) throw new Error('Die Reisedaten konnten nicht geladen werden.');
  journey = await response.json(); const errors = validateJourney(journey);
  if (errors.length) throw new Error(errors.join(' '));
  const routeResults = await Promise.all(journey.stages.map(async stage => {
    const response = await fetch('/data/' + stage.routeFile);
    if (!response.ok) throw new Error(`Routendatei für ${stage.title} fehlt.`);
    const geo = await response.json();
    const geometry = geo.type === 'Feature' ? geo.geometry : geo;
    if (geometry.type !== 'LineString') throw new Error(`${stage.title}: Die Route muss ein zusammenhängender LineString sein.`);
    return prepareRoute(geometry.coordinates);
  }));
  routes = routeResults;
  collage = new PhotoCollage({ loadPhoto: loadCollagePhoto, onChange: renderCollage, pageSize: collagePageSize() });
  new ResizeObserver(() => { collage.setPageSize(collagePageSize()); layoutCollage(); }).observe($('main'));
  map = new JourneyMap({ stages: journey.stages, routes, onStop: stop => player.openStop(stop, { manual: true }), onStatus: mapStatus, onExplore: () => {
    player.setMode('explore');
    announce('Frei erkunden. Der Flug pausiert. Mit Präsentieren zur geführten Kamera zurückkehren.');
  } });
  player = new TourPlayer(journey.stages, render);
  buildNavigation();
  $('demo-label').hidden = !journey.demo;
  $('cover-note').textContent = journey.routeDownload ? 'GPX-Gesamtstrecke geladen · deine 27 Tagesetappen und Bilder folgen.' : journey.demo ? 'Beispieletappen und Bildplätze · deine Erinnerungen folgen.' : 'Deine Etappen. Deine Bilder. Dein Tempo.';
  text('cover-title', journey.title); $('cover-title').style.whiteSpace = 'pre-line'; $('cover-title').textContent = journey.title.replace(' Ein ', '\nEin ');
  const total = document.querySelector('.trip-total-number'); total.textContent = journey.totalDays;
  const config = configResponse.ok ? await configResponse.json() : {};
  hasServerToken = Boolean(config.mapboxToken);
  updateTokenStorageStatus();
  // A diagnostic tab must not start a full tile load before its single-request check.
  map.setToken(new URLSearchParams(window.location.search).get('diagnose') === '1' ? '' : storageGet() || config.mapboxToken || '');
  render(player.state, 'initial');

  $('start-button').addEventListener('click', () => player.play());
  $('play-button').addEventListener('click', () => { closeDialogs(); player.toggle(); });
  $('route-progress').addEventListener('input', e => { closeDialogs(); player.seek(Number(e.target.value) / 1000); });
  $('speed-select').addEventListener('change', e => { player.state.speed = Number(e.target.value); });
  $('gallery-button').addEventListener('click', openGallery);
  $('settings-button').addEventListener('click', () => { player.pause(); openDialog('settings-dialog'); refreshBrowserCache(); });
  $('connect-button').addEventListener('click', () => { player.pause(); openDialog('settings-dialog'); refreshBrowserCache(); });
  $('check-cache').addEventListener('click', refreshBrowserCache);
  $('preparation-button').addEventListener('click', () => story('preparation'));
  $('conclusion-button').addEventListener('click', () => story('conclusion'));
  $('photo-next').addEventListener('click', () => { currentPhotoIndex = Math.min(currentPhotoIds.length - 1, currentPhotoIndex + 1); renderPhoto(); });
  $('photo-previous').addEventListener('click', () => { currentPhotoIndex = Math.max(0, currentPhotoIndex - 1); renderPhoto(); });
  $('continue-button').addEventListener('click', () => $('photo-dialog').close());
  $('collage-continue').addEventListener('click', () => player.play());
  $('collage-hide').addEventListener('click', () => { collage.hide(); player.closeStop(); });
  $('collage-previous').addEventListener('click', () => collage.move(-1));
  $('collage-next').addEventListener('click', () => collage.move(1));
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
  for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => { closeDialogs(); player.setMode(button.dataset.mode); });
  document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); closeDialogs(); player.home(); map.overview(); });
  $('fullscreen-button').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { notify('Vollbild ist hier nicht verfügbar. Nutze die Vollbildfunktion deines Browsers.'); } });
  $('token-form').addEventListener('submit', e => { e.preventDefault(); const token = $('mapbox-token').value.trim(); if (!/^pk\.[A-Za-z0-9._-]+$/.test(token)) { text('token-message', 'Bitte einen gültigen öffentlichen Schlüssel mit pk. am Anfang eingeben.'); return; } storageSet(token); map.setToken(token); $('mapbox-token').value = ''; $('settings-dialog').close(); });
  $('check-token').addEventListener('click', async () => {
    const button = $('check-token'); button.disabled = true;
    text('token-message', 'Der eingegebene oder gespeicherte Schlüssel wird direkt bei Mapbox geprüft …');
    try {
      const result = await checkMapboxConnection($('mapbox-token').value || storageGet() || config.mapboxToken || '', fetch, map.lastFailedRequest);
      text('token-message', result.message); announce(result.message);
    } finally { button.disabled = false; }
  });
  $('remove-token').addEventListener('click', () => { storageSet(''); $('mapbox-token').value = ''; map.setToken(config.mapboxToken || ''); text('token-message', config.mapboxToken ? 'Browser-Schlüssel entfernt. Der Schlüssel des lokalen Servers wird verwendet.' : 'Browser-Schlüssel entfernt. Die Vorschau bleibt verfügbar.'); });
  document.addEventListener('keydown', event => {
    if (event.altKey || event.metaKey || event.ctrlKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    if ($('photo-dialog').open) {
      if (event.code === 'Space') { event.preventDefault(); $('continue-button').click(); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); $('photo-next').click(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); $('photo-previous').click(); }
      return;
    }
    if (dialogs.some(d => d.open)) return;
    if (collage.active) {
      if (event.key === 'Escape') { event.preventDefault(); collage.hide(); player.closeStop(); return; }
      if (event.code === 'Space') { event.preventDefault(); event.stopPropagation(); player.play(); return; }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); collage.move(event.key === 'ArrowRight' ? 1 : -1); return; }
    }
    if (player.state.mode === 'explore' && event.target.closest('#map') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(event.key)) return;
    if (['BUTTON', 'A'].includes(event.target.tagName) && event.code === 'Space') return;
    if (event.code === 'Space') { event.preventDefault(); player.toggle(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); player.next(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); player.previous(); }
    else if (event.key.toLowerCase() === 'f') $('fullscreen-button').click();
    else if (event.key.toLowerCase() === 'g') openGallery();
  }, { capture: true });
  document.addEventListener('visibilitychange', () => { lastFrame = 0; if (document.hidden) player.pause(); });
  // Exactly one animation loop for the lifetime of the app; controls only update state.
  function frame(now) {
    const cameraBusy = !document.hidden && map.advanceCamera(now);
    if (!document.hidden && !cameraBusy) collage.arrive();
    if (lastFrame && !document.hidden && !cameraBusy) player.tick(Math.min((now - lastFrame) / 1000, .1));
    if (player.state.status === 'playing' && player.state.mode === 'presentation') {
      const label = cameraBusy ? 'Kamera fliegt zur Route …' : 'Unterwegs …';
      if ($('player-status').textContent !== label) text('player-status', label);
    }
    if (player.state.status === 'stop' && cameraBusy) text('player-status', 'Kamera fliegt zum Fotostopp …');
    else if (player.state.status === 'stop' && $('player-status').textContent === 'Kamera fliegt zum Fotostopp …') text('player-status', 'Zeit für eine Geschichte');
    lastFrame = now; requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

init().catch(error => { text('cover-title', 'Ein Schritt fehlt.'); document.querySelector('.cover-description').textContent = error.message; $('start-button').hidden = true; $('cover-note').textContent = 'Prüfe die Reisedaten mit npm run validate. Hinweise findest du in der README.'; announce(error.message); console.error(error); });
