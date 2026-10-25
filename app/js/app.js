import { initDiskCache } from './disk-cache-ui.js';
import { clamp, nearestProgress, prepareRoute, validateJourney } from './route.js';
import { TourPlayer } from './player.js';
import { JourneyMap } from './map.js';
import { checkMapboxConnection } from './token-check.js';
import { readBrowserMapCache, describeBrowserMapCache } from './browser-cache.js';
import { PhotoCollage, decodePhotoNode } from './photo-collage.js';
import { PhotoTransition } from './photo-transition.js';
import { buildJourneyTimeline, timelineSegmentAt, visibleTimelineMarkerGroups } from './timeline.js';
const photoMotion = new PhotoTransition();
let photoExitPending = false;
const playbackSpeeds = [.5, 1, 2, 3, 4, 5, 10, 20, 50];
const speedLabel = speed => `${speed === .5 ? '0,5' : speed}×`;

const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value ?? ''; };
const formatDay = stage => stage.isFullRoute ? 'GESAMTSTRECKE' : `TAG ${String(stage.day).padStart(2, '0')}`;
const formatDate = value => value ? new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', timeZone: 'Europe/Berlin' }).format(new Date(value + 'T12:00:00')) : 'Datum noch offen';
const dialogs = [...document.querySelectorAll('dialog')];
let journey, player, map, routes, collage, journeyTimeline, currentPhotoIds = [], currentPhotoIndex = 0, lastStage = -1, renderStatus = '', lastFrame = 0, noticeTimer, collageHideTimer, collageRevision = 0, selectedEditorStopId = null, editorBusy = false;

function announce(message) { text('live-region', message); }
function notify(message) {
  if (!message) return;
  text('notice', message); $('notice').hidden = false; clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 7500);
}
function closeDialogs() { for (const d of dialogs) if (d.open) d.close(); }
function openDialog(id) { if (!$(id).open) $(id).showModal(); }
function element(tag, className, content) { const el = document.createElement(tag); if (className) el.className = className; if (content !== undefined) el.textContent = content; return el; }
function timelineDayLabel(day) { return `Tag ${day}`; }
function hideTimelineTooltip() { $('timeline-tooltip').hidden = true; }
function maybeHideTimelineTooltip(event) {
  const tooltip = $('timeline-tooltip');
  if (tooltip.contains(event?.relatedTarget) || tooltip.matches(':hover') || tooltip.contains(document.activeElement)) return;
  if ($('timeline-markers').contains(document.activeElement) || document.activeElement === $('route-progress')) return;
  if ($('timeline-markers').querySelector(':hover')) return;
  hideTimelineTooltip();
}
function positionTimelineTooltip(clientX, progress) {
  const root = $('route-timeline'), tooltip = $('timeline-tooltip'), bounds = root.getBoundingClientRect();
  const inset = 7;
  const pointerX = Number.isFinite(clientX) ? clientX - bounds.left : inset + clamp(progress) * Math.max(0, bounds.width - inset * 2);
  const half = tooltip.offsetWidth / 2;
  const x = Math.max(Math.min(half, bounds.width / 2), Math.min(pointerX, Math.max(bounds.width - half, bounds.width / 2)));
  tooltip.style.left = `${x}px`;
}
function showTimelineTooltip(items, clientX, progress, { interactive = false } = {}) {
  const tooltip = $('timeline-tooltip');
  tooltip.replaceChildren();
  for (const item of items) {
    const entry = element('div', 'timeline-tooltip-entry');
    if (item.kind === 'day') {
      const segment = item.segment;
      entry.append(element('span', 'timeline-tooltip-kicker', `${timelineDayLabel(segment.day)} · ETAPPE`));
      entry.append(element('strong', 'timeline-tooltip-title', segment.title));
      entry.append(element('span', 'timeline-tooltip-route', `${segment.startPlace} → ${segment.endPlace}`));
      if (segment.description) entry.append(element('p', 'timeline-tooltip-copy', segment.description));
      if (segment.sleepPlace) entry.append(element('span', 'timeline-tooltip-sleep', `${segment.confirmedSleepPlace ? 'Übernachtung' : 'Etappenziel · Schlafplatz offen'}: ${segment.sleepPlace}`));
    } else {
      entry.append(element('span', 'timeline-tooltip-kicker', `FOTOPUNKT · ${timelineDayLabel(item.day)}`));
      entry.append(element('strong', 'timeline-tooltip-title', item.title));
      if (item.stageTitle) entry.append(element('span', 'timeline-tooltip-route', item.stageTitle));
      if (item.description) entry.append(element('p', 'timeline-tooltip-copy', item.description));
    }
    if (interactive) {
      const jump = element('button', 'timeline-tooltip-jump', 'Zu diesem Punkt springen');
      jump.type = 'button';
      jump.addEventListener('click', () => {
        const target = Number.isFinite(item.progress) ? item.progress : item.segment?.end;
        if (!Number.isFinite(target)) return;
        closeDialogs(); player.seek(target); announce(timelineItemSummary(item));
      });
      entry.append(jump);
    }
    tooltip.append(entry);
  }
  tooltip.hidden = !items.length;
  tooltip.classList.toggle('is-interactive', interactive);
  tooltip.setAttribute('role', interactive ? 'group' : 'tooltip');
  if (interactive) tooltip.setAttribute('aria-label', 'Nahe Routenpunkte und Sprungziele');
  else tooltip.removeAttribute('aria-label');
  if (!tooltip.hidden) positionTimelineTooltip(clientX, progress);
}
function timelineItemSummary(item) {
  if (item.kind === 'day') {
    const segment = item.segment;
    return `${timelineDayLabel(segment.day)}: ${segment.title}, ${segment.startPlace} bis ${segment.endPlace}. ${segment.description}${segment.sleepPlace ? ` ${segment.confirmedSleepPlace ? 'Übernachtung' : 'Schlafplatz offen, Etappenziel'}: ${segment.sleepPlace}.` : ''}`;
  }
  return `Fotopunkt ${timelineDayLabel(item.day)}: ${item.title}. ${item.description}`;
}
function renderTimelineMarkers(model) {
  const markers = $('timeline-markers');
  const width = markers.clientWidth || Math.max(0, $('route-timeline').clientWidth - 14);
  const spacing = matchMedia('(pointer: coarse)').matches ? 44 : 24;
  const groups = visibleTimelineMarkerGroups(model, width, spacing);
  const signature = groups.map(group => group.key).join('||');
  if (markers.dataset.layoutSignature === signature) return;
  const activeKey = markers.querySelector('.timeline-marker:focus')?.dataset.markerKeys?.split('|')[0];
  markers.replaceChildren();
  markers.dataset.layoutSignature = signature;
  for (const group of groups) {
    const hasDay = group.items.some(item => item.kind === 'day');
    const hasPhoto = group.items.some(item => item.kind === 'photo');
    const button = element('button', `timeline-marker${hasDay ? ' is-day' : ''}${hasPhoto ? ' has-photo' : ''}${group.items.length > 1 ? ' is-cluster' : ''}${group.needsChoice ? ' needs-choice' : ''}`);
    button.type = 'button';
    button.style.left = `${group.progress * 100}%`;
    button.dataset.markerKeys = group.key;
    button.setAttribute('aria-label', group.items.length > 1
      ? `${group.items.length} nahe Routenmarken: ${group.items.map(timelineItemSummary).join(' ')}. Fokus oder Antippen zeigt die einzelnen Sprungziele.`
      : group.items.map(timelineItemSummary).join(' '));
    button.setAttribute('aria-describedby', 'timeline-tooltip');
    if (group.items.length > 1) button.append(element('span', 'timeline-marker-count', String(group.items.length)));
    const show = clientX => showTimelineTooltip(group.items, clientX, group.progress, { interactive: group.needsChoice });
    button.addEventListener('pointerenter', event => show(event.clientX));
    button.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') maybeHideTimelineTooltip(event); });
    button.addEventListener('focus', () => show(button.getBoundingClientRect().left + button.offsetWidth / 2));
    button.addEventListener('blur', event => maybeHideTimelineTooltip(event));
    button.addEventListener('click', () => {
      closeDialogs();
      if (group.needsChoice) {
        show(button.getBoundingClientRect().left + button.offsetWidth / 2);
        announce(`${group.items.length} nahe Routenmarken. Wähle im Hinweis den gewünschten Punkt.`);
        return;
      }
      player.seek(group.progress);
      show(button.getBoundingClientRect().left + button.offsetWidth / 2);
      announce(group.items.map(timelineItemSummary).join(' '));
    });
    markers.append(button);
    if (activeKey && group.key.split('|').includes(activeKey)) button.focus({ preventScroll: true });
  }
}
function setupTimeline(model) {
  const track = $('timeline-track');
  track.replaceChildren();
  model.segments.forEach((segment, index) => {
    const band = element('span', `timeline-day${index % 2 ? ' is-alternate' : ''}`);
    band.style.left = `${segment.start * 100}%`;
    band.style.width = `${(segment.end - segment.start) * 100}%`;
    band.setAttribute('aria-hidden', 'true');
    track.append(band);
  });
  track.append(element('span', 'timeline-progress-fill'));
  renderTimelineMarkers(model);
  requestAnimationFrame(() => renderTimelineMarkers(model));
}
function updateTimeline(state) {
  const fullRoute = Boolean(player.stage.isFullRoute), progress = clamp(state.progress);
  const root = $('route-timeline'), track = $('timeline-track'), markers = $('timeline-markers');
  root.dataset.fullRoute = String(fullRoute);
  track.hidden = !fullRoute; markers.hidden = !fullRoute;
  $('route-progress-label').textContent = fullRoute ? 'Fortschritt der Gesamtstrecke München bis Venedig' : 'Fortschritt der Etappe';
  const fill = track.querySelector('.timeline-progress-fill');
  if (fill) fill.style.width = `${progress * 100}%`;
  if (!fullRoute) {
    $('route-progress').removeAttribute('aria-describedby');
    $('route-progress').setAttribute('aria-valuetext', `${Math.round(progress * 100)} Prozent der Etappe`);
    hideTimelineTooltip(); return;
  }

  $('route-progress').setAttribute('aria-describedby', 'timeline-tooltip');
  let valueText = `${Math.round(progress * 100)} Prozent der Gesamtstrecke`;
  const segment = timelineSegmentAt(journeyTimeline.segments, progress);
  if (segment) valueText = `${timelineDayLabel(segment.day)} · ${Math.round(progress * 100)} Prozent der Gesamtstrecke`;
  else valueText += ' · Etappenzuordnung folgt';
  $('route-progress').setAttribute('aria-valuetext', valueText);
  if (document.activeElement === $('route-progress')) showTimelineTooltip(segment ? [{ kind: 'day', segment }] : [], undefined, progress);
}
function placeholder(photo) {
  const box = element('div', 'sample-image');
  box.append(element('span', 'sample-symbol', '↟'), element('p', 'eyebrow', 'PLATZ FÜR DEINE ERINNERUNG'), element('h3', '', photo?.title || 'Dein Foto'), element('p', '', 'Hier erscheint später dein persönliches Foto.'));
  return box;
}
function photoNode(photo, thumb = false) {
  if (!photo || photo.placeholder || !photo.file) return placeholder(photo);
  const isVideo = photo.mediaType === 'video' || /\.(mp4|webm|mov)$/i.test(photo.file);
  if (isVideo) {
    if (thumb && photo.thumbnail) { const image = document.createElement('img'); image.src = '/' + photo.thumbnail; image.alt = photo.title || 'Vorschaubild eines Videos'; image.loading = 'lazy'; return image; }
    if (thumb) return placeholder(photo);
    const video = document.createElement('video'); video.src = '/' + photo.file; video.controls = true; video.playsInline = true; video.preload = 'metadata';
    if (photo.thumbnail) video.poster = '/' + photo.thumbnail;
    video.setAttribute('aria-label', photo.title || 'Reisevideo');
    return video;
  }
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
function collagePageSize() { return 1; }
function layoutCollage() {
  const root = $('photo-collage'), main = $('main'), height = main.clientHeight;
  root.dataset.compact = String(main.clientWidth < 1000 || height < 760);
  main.style.setProperty('--map-height', `${height}px`);
  const controlsBottom = height - $('player-controls-anchor').offsetTop + 12;
  root.style.setProperty('--collage-controls-bottom', `${controlsBottom}px`);
  const controlsTop = height - controlsBottom - ($('collage-controls').offsetHeight || 76);
  const photoTop = 76;
  root.style.setProperty('--collage-photo-top', `${photoTop}px`);
  root.style.setProperty('--collage-small-height', `${Math.max(32, controlsTop - photoTop - 72)}px`);
  root.style.setProperty('--collage-left-height', `${Math.max(80, Math.min(height * .23, controlsTop - photoTop - 72))}px`);
  root.style.setProperty('--collage-lower-bottom', `${height - controlsTop + 18}px`);
}
function renderCollage(state) {
  const root = $('photo-collage'), images = $('collage-images'), revision = ++collageRevision;
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 400;
  clearTimeout(collageHideTimer);
  photoMotion.cancel(); photoExitPending = false;
  if (state.phase === 'hidden' || state.phase === 'waiting') {
    if (state.phase === 'hidden') map?.endPhotoFocus();
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
    map.beginPhotoFocus(state.stop);
    const from = photoPreviewRect(state.stop.id);
    cards.forEach(card => photoMotion.move(card, from, card.getBoundingClientRect(), { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }));
    setTimeout(() => oldCards.forEach(card => card.remove()), duration);
    announce(`Fotostopp: ${state.stop.title}. ${$('collage-count').textContent}. Mit Leertaste den Flug fortsetzen.`);
  } else { root.classList.add('is-visible'); layoutCollage(); }
}
function stopPreview(stop) {
  const button = element('button', 'map-photo-preview'); button.type = 'button'; button.dataset.stopId = stop.id;
  button.setAttribute('aria-label', `${stop.title} · Foto öffnen`);
  const photo = journey.photos.find(photo => photo.id === stop.photoIds[0]);
  const visual = element('span', 'map-photo-thumb');
  if (photo?.file && !photo.placeholder) { const image = photoNode(photo, true); image.draggable = false; visual.append(image); }
  else visual.append(element('span', 'map-photo-placeholder', '↟'));
  button.append(visual, element('span', 'map-photo-name', stop.title));
  button.title = `${stop.title}${stop.approximate ? ' · ungefährer Fotoort' : ''}`;
  return button;
}
function photoPreviewRect(id) {
  const rect = map.stopPreviewRect(id);
  if (rect?.width && rect?.height) return rect;
  const main = $('main').getBoundingClientRect();
  return { left: main.left + main.width / 2 - 40, top: main.top + main.height / 2 - 30, width: 80, height: 60 };
}
async function finishPhoto(play = true) {
  if (photoExitPending) return;
  if (!collage.active) { if (play) player.play(); return; }
  photoExitPending = true;
  const revision = collageRevision, id = collage.stop.id;
  const card = $('collage-images').querySelector('.is-shown');
  const completed = card ? await photoMotion.move(card, photoPreviewRect(id), card.getBoundingClientRect(), { reverse: true, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }) : true;
  if (!completed || revision !== collageRevision || collage.stop?.id !== id) return;
  map.endPhotoFocus();
  collage.hide();
  if (play) player.play(); else player.closeStop();
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
    text('player-time', stage.isFullRoute ? 'Gesamtstrecke' : `${String(stage.day).padStart(2, '0')} / ${String(journey.totalDays).padStart(2, '0')} Tage`);
    text('route-caption', stage.routeProvenance?.kind === 'schematic' ? 'Schematischer Beispielverlauf · keine tatsächliche Wanderaufzeichnung' : stage.routeProvenance?.kind === 'recorded' ? 'Route aus bereitgestellter GPS-Aufzeichnung' : stage.referenceSection ? 'GPX: Björn Mußmann / Outdooractive · Referenzvariante' : 'Rekonstruierter Verlauf · anhand deiner Etappen abzugleichen');
    preloadNext();
  }
  $('route-progress').value = String(Math.round(state.progress * 1000));
  updateTimeline(state);
  const speedIndex = playbackSpeeds.indexOf(state.speed);
  $('speed-range').value = String(speedIndex < 0 ? 1 : speedIndex);
  $('speed-range').setAttribute('aria-valuetext', speedLabel(state.speed));
  $('speed-value').value = speedLabel(state.speed);
  if (reason === 'pause') map.pauseCamera();
  if (reason === 'stop-jump' || reason === 'seek' || reason === 'route-seek') map.focusStop(state.progress);
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
  $('recenter-button').disabled = status !== 'ready';
  $('camera-compass').hidden = status !== 'ready';
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

function editorStageIndex() { return Number($('editor-stage').value || player.state.stageIndex); }
function editorStop() { return journey.stages[editorStageIndex()]?.stops?.find(stop => stop.id === selectedEditorStopId) || null; }
function renderEditor() {
  if (!journey || !$('editor-stage')) return;
  const stageIndex = editorStageIndex(), stage = journey.stages[stageIndex];
  $('editor-stop').replaceChildren();
  const empty = element('option', '', stage.stops.length ? 'Fotopunkt auswählen' : 'Noch keine Fotopunkte'); empty.value = ''; $('editor-stop').append(empty);
  for (const stop of stage.stops) { const option = element('option', '', `${stop.title || 'Fotopunkt'} · ${stop.photoIds?.length || 0} Medien`); option.value = stop.id; $('editor-stop').append(option); }
  if (!stage.stops.some(stop => stop.id === selectedEditorStopId)) selectedEditorStopId = stage.stops[0]?.id || null;
  $('editor-stop').value = selectedEditorStopId || '';
  const stop = editorStop();
  $('editor-stop-title').value = stop?.title || '';
  $('editor-stop-caption').value = stop?.caption || '';
  $('editor-move-stop').disabled = !stop;
  $('editor-media-list').replaceChildren();
  for (const photo of (stop?.photoIds || []).map(id => journey.photos.find(item => item.id === id)).filter(Boolean)) {
    const label = element('li', '', `${photo.mediaType === 'video' ? 'Video' : 'Bild'} · ${photo.title || photo.originalName || 'Erinnerung'}`);
    $('editor-media-list').append(label);
  }
  document.querySelectorAll('.map-photo-preview').forEach(button => button.classList.toggle('is-selected', button.dataset.stopId === selectedEditorStopId));
}
function openEditor() {
  player.pause(); player.closeStop(); collage.hide();
  $('editor-stage').value = String(player.state.stageIndex);
  selectedEditorStopId = player.stage.stops[0]?.id || null;
  renderEditor(); openDialog('editor-dialog');
}
function beginMapPlacement(mode) {
  if (mode === 'move' && !editorStop()) return;
  map.setEditPlacement(mode);
  $('editor-dialog').close();
  notify(mode === 'new' ? 'Klicke auf die gewünschte Stelle an der Route, um einen Fotopunkt anzulegen.' : 'Klicke auf die gewünschte Stelle an der Route, um den ausgewählten Fotopunkt zu verschieben.');
}
function finishMapPlacement(coordinates) {
  const mode = map?.editPlacement;
  if (!mode || !Array.isArray(coordinates)) return;
  const stageIndex = player.state.stageIndex, stage = journey.stages[stageIndex], progress = nearestProgress(routes[stageIndex], coordinates);
  if (mode === 'new') {
    const stop = { id: `stopp-${crypto.randomUUID()}`, progress, title: 'Neuer Fotopunkt', approximate: true, caption: '', photoIds: [] };
    stage.stops.push(stop); selectedEditorStopId = stop.id;
  } else {
    const stop = stage.stops.find(item => item.id === selectedEditorStopId);
    if (!stop) { map.setEditPlacement(null); return; }
    stop.progress = progress;
  }
  map.setEditPlacement(null); player.pause(); player.closeStop(); map.refreshStops(); renderEditor();
  text('editor-message', `Position auf etwa ${Math.round(progress * 100)} % der Etappe gesetzt. Speichere deine Änderungen.`);
  openDialog('editor-dialog');
}
function mediaTypeFor(file) {
  const extension = file.name.split('.').at(-1).toLowerCase();
  const known = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
  const reported = file.type.toLowerCase();
  return Object.values(known).includes(reported) ? reported : known[extension] || reported;
}
async function makeMediaThumbnail(file, videoFile) {
  let source, release = () => {};
  try {
    if (videoFile) {
      const url = URL.createObjectURL(file), video = document.createElement('video'); release = () => { URL.revokeObjectURL(url); video.removeAttribute('src'); };
      video.src = url; video.muted = true; video.playsInline = true; video.preload = 'auto';
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Video-Vorschaubild konnte nicht geladen werden.')), 12000);
        const ready = () => { clearTimeout(timer); resolve(); };
        video.addEventListener('loadedmetadata', () => { video.currentTime = Number.isFinite(video.duration) ? Math.min(.5, video.duration / 3) : 0; }, { once: true });
        video.addEventListener('loadeddata', ready, { once: true }); video.addEventListener('seeked', ready, { once: true });
        video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Video konnte nicht gelesen werden.')); }, { once: true });
      });
      source = video;
    } else {
      const bitmap = await createImageBitmap(file); source = bitmap; release = () => bitmap.close?.();
    }
    const width = source.videoWidth || source.width, height = source.videoHeight || source.height;
    if (!width || !height) return null;
    const scale = Math.min(1, 560 / Math.max(width, height)), canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .86));
  } finally { release(); }
}
async function uploadFile(file, stage, stop) {
  const mime = mediaTypeFor(file), isVideo = mime.startsWith('video/');
  const assetId = crypto.randomUUID(), photoId = `upload-${assetId}`;
  const send = async (blob, variant, contentType) => {
    const response = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': contentType, 'X-Asset-Id': assetId, 'X-Asset-Variant': variant }, body: blob });
    const data = await readApiResponse(response);
    if (!response.ok || !data.file) throw new Error(data.error || `Upload fehlgeschlagen (HTTP ${response.status}). Prüfe, ob der lokale Traumpfad-Server läuft.`);
    return data.file;
  };
  const filePath = await send(file, 'original', mime);
  let thumbnail;
  try { const preview = await makeMediaThumbnail(file, isVideo); if (preview) thumbnail = await send(preview, 'thumbnail', 'image/jpeg'); } catch { /* The original remains usable when this browser cannot decode its preview. */ }
  const title = file.name.replace(/\.[^.]+$/, '');
  journey.photos.push({ id: photoId, mediaType: isVideo ? 'video' : 'image', originalName: file.name, file: filePath, ...(thumbnail ? { thumbnail } : {}), stageId: stage.id, assignment: 'manual', title, caption: '', placeholder: false });
  if (stop) {
    stop.photoIds = (stop.photoIds || []).filter(id => !journey.photos.find(photo => photo.id === id)?.placeholder);
    stop.photoIds.push(photoId);
  }
}
async function readApiResponse(response) {
  const body = await response.text();
  if (!body.trim()) return { error: `Der lokale Server hat leer geantwortet (HTTP ${response.status}). Stoppe Traumpfad mit Ctrl+C und starte npm start neu, damit die aktuelle Upload-Funktion geladen wird.` };
  try { return JSON.parse(body); }
  catch { return { error: `Unerwartete Serverantwort (HTTP ${response.status}): ${body.slice(0, 220)}` }; }
}
async function saveEditorChanges() {
  if (editorBusy) return;
  const stop = editorStop();
  if (stop) { stop.title = $('editor-stop-title').value.trim() || 'Fotopunkt'; stop.caption = $('editor-stop-caption').value.trim(); }
  const errors = validateJourney(journey);
  if (errors.length) { text('editor-message', errors[0]); $('editor-message').dataset.error = 'true'; return; }
  editorBusy = true; $('editor-save').disabled = true; text('editor-message', 'Änderungen werden auf diesem Mac gespeichert …');
  try {
    const response = await fetch('/api/journey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(journey) });
    const data = await readApiResponse(response); if (!response.ok || !data.saved) throw new Error(data.error || `Speichern fehlgeschlagen (HTTP ${response.status}).`);
    $('editor-message').dataset.error = 'false'; text('editor-message', 'Gespeichert. Bilder, Videos und Fotopunkte bleiben lokal auf diesem Mac.');
    $('demo-label').hidden = !journey.demo; map.refreshStops(); renderEditor();
  } catch (error) { $('editor-message').dataset.error = 'true'; text('editor-message', error.message); }
  finally { editorBusy = false; $('editor-save').disabled = false; }
}
function initEditor() {
  journey.stages.forEach((stage, index) => { const option = element('option', '', `${formatDay(stage)} · ${stage.title}`); option.value = String(index); $('editor-stage').append(option); });
  $('editor-stage').addEventListener('change', () => {
    const index = editorStageIndex(); player.selectStage(index); selectedEditorStopId = journey.stages[index].stops[0]?.id || null; renderEditor();
  });
  $('editor-stop').addEventListener('change', () => { selectedEditorStopId = $('editor-stop').value || null; renderEditor(); });
  $('editor-stop-title').addEventListener('input', () => {
    const stop = editorStop(); if (!stop) return;
    stop.title = $('editor-stop-title').value.trim() || 'Fotopunkt';
    const option = [...$('editor-stop').options].find(item => item.value === stop.id);
    if (option) option.textContent = `${stop.title} · ${stop.photoIds?.length || 0} Medien`;
  });
  $('editor-stop-caption').addEventListener('input', () => { const stop = editorStop(); if (stop) stop.caption = $('editor-stop-caption').value; });
  $('editor-add-stop').addEventListener('click', () => beginMapPlacement('new'));
  $('editor-move-stop').addEventListener('click', () => beginMapPlacement('move'));
  async function uploadEditorFiles(files) {
    const stage = journey.stages[editorStageIndex()], stop = editorStop();
    if (!files.length || editorBusy) return;
    editorBusy = true; $('editor-save').disabled = true; $('editor-files').disabled = true; $('editor-stage').disabled = true; $('editor-stop').disabled = true;
    try {
      for (const [index, file] of files.entries()) {
        text('editor-message', `Speichere Datei ${index + 1} von ${files.length}: ${file.name}`);
        await uploadFile(file, stage, stop);
      }
      $('editor-message').dataset.error = 'false'; text('editor-message', `${files.length} Datei${files.length === 1 ? '' : 'en'} hinzugefügt. Änderungen noch speichern.`); renderEditor();
    } catch (error) { $('editor-message').dataset.error = 'true'; text('editor-message', error.message); renderEditor(); }
    finally { editorBusy = false; $('editor-save').disabled = false; $('editor-files').disabled = false; $('editor-stage').disabled = false; $('editor-stop').disabled = false; }
  }
  const uploadZone = document.querySelector('.editor-upload');
  $('editor-files').addEventListener('change', event => {
    const files = [...event.target.files]; event.target.value = ''; uploadEditorFiles(files);
  });
  uploadZone.addEventListener('dragover', event => { event.preventDefault(); if (!editorBusy) uploadZone.classList.add('is-dragover'); });
  uploadZone.addEventListener('dragenter', event => { event.preventDefault(); if (!editorBusy) uploadZone.classList.add('is-dragover'); });
  uploadZone.addEventListener('dragleave', event => {
    event.preventDefault();
    if (!uploadZone.contains(event.relatedTarget)) uploadZone.classList.remove('is-dragover');
  });
  uploadZone.addEventListener('drop', event => {
    event.preventDefault(); uploadZone.classList.remove('is-dragover');
    if (!editorBusy) uploadEditorFiles([...event.dataTransfer.files]);
  });
  $('editor-save').addEventListener('click', saveEditorChanges);
}

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
  const layoutObserver = new ResizeObserver(() => { collage.setPageSize(collagePageSize()); layoutCollage(); if (journeyTimeline) renderTimelineMarkers(journeyTimeline); });
  layoutObserver.observe($('main')); layoutObserver.observe($('route-timeline'));
  map = new JourneyMap({ stages: journey.stages, routes, onStop: stop => player.openStop(stop, { manual: true }), onRouteSeek: (stageIndex, progress) => player.seekTo(stageIndex, progress), onMapPoint: finishMapPlacement, onStatus: mapStatus, createStopPreview: stopPreview, onHeading: bearing => {
    if (!Number.isFinite(bearing)) return;
    const degrees = ((bearing % 360) + 360) % 360;
    const direction = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'][Math.round(degrees / 45) % 8];
    text('compass-heading', `${direction} · ${Math.round(degrees) % 360}°`);
    $('camera-compass').style.setProperty('--compass-bearing', `${degrees}deg`);
    $('camera-compass').setAttribute('aria-label', `Kamerarichtung ${direction}, ${Math.round(degrees) % 360} Grad`);
  }, onExplore: () => {
    player.setMode('explore');
    announce('Frei erkunden. Der Flug pausiert. Mit Präsentieren zur geführten Kamera zurückkehren.');
  } });
  player = new TourPlayer(journey.stages, render);
  initEditor();
  journeyTimeline = buildJourneyTimeline(journey.stages, routes);
  setupTimeline(journeyTimeline);
  buildNavigation();
  $('demo-label').hidden = !journey.demo;
  $('cover-note').textContent = journey.routeDownload ? '27 Tagesetappen in vier Wochen · Referenztrack mit Fotobeispielen.' : journey.demo ? 'Beispiele für Etappen und Bilder · deine Erinnerungen folgen.' : 'Deine Etappen. Deine Bilder. Dein Tempo.';
  text('cover-title', journey.title); $('cover-title').style.whiteSpace = 'pre-line'; $('cover-title').textContent = journey.title.replace(' Ein ', '\nEin ');
  const total = document.querySelector('.trip-total-number'); total.textContent = journey.totalDays;
  const config = configResponse.ok ? await configResponse.json() : {};
  hasServerToken = Boolean(config.mapboxToken);
  updateTokenStorageStatus();
  initDiskCache({ getToken: () => storageGet() || config.mapboxToken || '' });
  // A diagnostic tab must not start a full tile load before its single-request check.
  map.setToken(new URLSearchParams(window.location.search).get('diagnose') === '1' ? '' : storageGet() || config.mapboxToken || '');
  render(player.state, 'initial');

  $('start-button').addEventListener('click', () => player.play());
  $('play-button').addEventListener('click', () => { closeDialogs(); collage.active ? finishPhoto() : player.toggle(); });
  $('route-progress').addEventListener('input', e => { closeDialogs(); player.seek(Number(e.target.value) / 1000); });
  $('route-progress').addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || !player.stage.isFullRoute) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const inset = 7;
    const progress = clamp((event.clientX - bounds.left - inset) / Math.max(1, bounds.width - inset * 2));
    const segment = timelineSegmentAt(journeyTimeline.segments, progress);
    if (segment) showTimelineTooltip([{ kind: 'day', segment }], event.clientX, progress);
    else hideTimelineTooltip();
  });
  $('route-progress').addEventListener('pointerleave', event => { if (event.pointerType !== 'touch' && document.activeElement !== event.currentTarget) maybeHideTimelineTooltip(event); });
  $('route-progress').addEventListener('focus', () => updateTimeline(player.state));
  $('route-progress').addEventListener('blur', event => maybeHideTimelineTooltip(event));
  $('route-timeline').addEventListener('keydown', event => { if (event.key === 'Escape') hideTimelineTooltip(); });
  $('timeline-tooltip').addEventListener('pointerleave', event => maybeHideTimelineTooltip(event));
  $('speed-range').addEventListener('input', e => {
    player.state.speed = playbackSpeeds[Number(e.target.value)];
    const label = speedLabel(player.state.speed);
    e.target.setAttribute('aria-valuetext', label); $('speed-value').value = label;
  });
  $('recenter-button').addEventListener('click', () => {
    closeDialogs();
    if (player.state.mode === 'explore') player.setMode('presentation');
    map.recenter(player.state.progress);
    announce('Kamera kehrt zur aktuellen Routenposition zurück.');
  });
  $('gallery-button').addEventListener('click', openGallery);
  $('editor-button').addEventListener('click', openEditor);
  $('settings-button').addEventListener('click', () => { player.pause(); openDialog('settings-dialog'); refreshBrowserCache(); });
  $('connect-button').addEventListener('click', () => { player.pause(); openDialog('settings-dialog'); refreshBrowserCache(); });
  $('check-cache').addEventListener('click', refreshBrowserCache);
  $('preparation-button').addEventListener('click', () => story('preparation'));
  $('conclusion-button').addEventListener('click', () => story('conclusion'));
  $('photo-next').addEventListener('click', () => { currentPhotoIndex = Math.min(currentPhotoIds.length - 1, currentPhotoIndex + 1); renderPhoto(); });
  $('photo-previous').addEventListener('click', () => { currentPhotoIndex = Math.max(0, currentPhotoIndex - 1); renderPhoto(); });
  $('continue-button').addEventListener('click', () => $('photo-dialog').close());
  $('collage-continue').addEventListener('click', () => finishPhoto());
  $('collage-hide').addEventListener('click', () => finishPhoto(false));
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
    if (event.key === 'Escape' && map.editPlacement) { map.setEditPlacement(null); notify('Platzierung abgebrochen.'); return; }
    if ($('photo-dialog').open) {
      if (event.code === 'Space') { event.preventDefault(); $('continue-button').click(); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); $('photo-next').click(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); $('photo-previous').click(); }
      return;
    }
    if (dialogs.some(d => d.open)) return;
    if (collage.active) {
      if (event.key === 'Escape') { event.preventDefault(); finishPhoto(false); return; }
      if (event.code === 'Space') { event.preventDefault(); event.stopPropagation(); finishPhoto(); return; }
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
