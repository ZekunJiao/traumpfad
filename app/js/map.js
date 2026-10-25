import { bearing, clamp, destination, distance, feature, nearestProgress, pointAt, sliceRoute } from './route.js';
import { describeMapError } from './map-error.js';
import { createMapRequestGate } from './tile-request-gate.js';
import { interpolateCamera } from './camera-transition.js';
import { scenicPoint, scenicHeading, easeHeading } from './camera-follow.js';
import { overnightPlaces } from './overnight-places.js';
import { mountainRegions, borderCrossings } from './route-landmarks.js';
import { findRouteHit } from './route-hit-test.js';

const SVG = 'http://www.w3.org/2000/svg';
const LOOK_DEGREES_PER_PIXEL = 0.15;
const PAN_FRACTION = 0.15;
const PAN_METERS_PER_PIXEL = 30;
const HEIGHT_METERS_PER_PIXEL = 7;
const WHEEL_PIXELS_PER_ZOOM_STEP = 700;
const BUTTON_ZOOM_STEP = 0.35;
const EXPLORE_TRACKPAD_ZOOM_RATE = 0.0075;
const EXPLORE_WHEEL_ZOOM_RATE = 1 / 650;
export const routePosition = (route, progress) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: pointAt(route, progress) } });
function svgNode(tag, attributes, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

export class JourneyMap {
  constructor({ stages, routes, onStop, onRouteSeek = () => {}, onMapPoint = () => {}, onStatus, createStopPreview, onExplore = () => {}, onPitch = () => {}, onBearing = () => {}, onHeight = () => {}, onHeading = () => {} }) {
    Object.assign(this, { stages, routes, onStop, onRouteSeek, onMapPoint, onStatus, createStopPreview, onExplore, onPitch, onBearing, onHeight, onHeading });
    this.viewPitch = null; this.viewBearing = 0; this.viewDistance = 1; this.heightOffset = 0;
    this.map = null; this.ready = false; this.stageIndex = 0; this.progress = 0; this.markers = []; this.landmarkMarkers = []; this.exploring = false; this.editPlacement = null;
    this.container = document.getElementById('schematic');
    this.buildSchematic();
    this.container.addEventListener('click', event => this.handleSchematicRouteClick(event));
    this.resizeObserver = new ResizeObserver(() => this.buildSchematic());
    this.resizeObserver.observe(this.container);
  }
  buildSchematic() {
    this.container.replaceChildren(); this.schemaPreviewStage = null;
    const width = Math.max(320, this.container.clientWidth), height = Math.max(590, this.container.clientHeight);
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Schematischer Verlauf der geladenen Etappen. Keine Geländekarte.' });
    svg.append(svgNode('rect', { x: 0, y: 0, width, height, fill: 'transparent', 'pointer-events': 'all' }));
    const relief = svgNode('g', { transform: `translate(${width * .78} ${height * .65}) rotate(-29)`, fill: 'none', stroke: '#b6c598', 'stroke-width': '.9', opacity: '.12' });
    for (let i = 0; i < 24; i++) relief.append(svgNode('ellipse', { cx: Math.sin(i * .4) * 20, cy: i * 1.8, rx: 45 + i * 19, ry: 30 + i * 10 }));
    svg.append(relief);
    const relief2 = svgNode('g', { transform: `translate(${width * .4} ${height * .85}) rotate(25)`, fill: 'none', stroke: '#b6c598', 'stroke-width': '.7', opacity: '.08' });
    for (let i = 0; i < 15; i++) relief2.append(svgNode('ellipse', { cx: 0, cy: 0, rx: 60 + i * 19, ry: 30 + i * 12 }));
    svg.append(relief2);
    const points = this.routes.flatMap(r => r.points);
    const minLon = Math.min(...points.map(p => p[0])), maxLon = Math.max(...points.map(p => p[0]));
    const minLat = Math.min(...points.map(p => p[1])), maxLat = Math.max(...points.map(p => p[1]));
    this.project = p => [width * .54 + (p[0] - minLon) / Math.max(.01, maxLon - minLon) * width * .22, height * .15 + (maxLat - p[1]) / Math.max(.01, maxLat - minLat) * (height * .61 - 25)];
    this.schemaPaths = [];
    const line = points => points.map((p, i) => `${i ? 'L' : 'M'}${this.project(p).join(',')}`).join(' ');
    this.schemaLine = line;
    this.routes.forEach((route, i) => {
      const path = svgNode('path', { d: line(route.points), fill: 'none', stroke: '#e9ebce', 'stroke-width': '2', opacity: '.28', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      path.style.cursor = 'pointer';
      this.schemaPaths.push(path); svg.append(path);
      if (this.stages[i].isFullRoute && this.routes.length > 1) return;
      const p = this.project(route.points[0]);
      svg.append(svgNode('circle', { cx: p[0], cy: p[1], r: 4, fill: '#dcdcc0', opacity: '.7' }));
      svg.append(svgNode('text', { x: p[0] + 12, y: p[1] + 4, class: 'schema-label' }, this.stages[i].start));
    });
    const fullRouteIndex = this.stages.findIndex(stage => stage.isFullRoute);
    const finalIndex = fullRouteIndex >= 0 ? fullRouteIndex : this.routes.length - 1;
    const end = this.project(this.routes[finalIndex].points.at(-1));
    svg.append(svgNode('circle', { cx: end[0], cy: end[1], r: 4, fill: '#dcdcc0' }));
    svg.append(svgNode('text', { x: end[0] + 12, y: end[1] + 4, class: 'schema-label' }, this.stages[finalIndex].end));
    this.schemaTravelled = svgNode('path', { fill: 'none', stroke: '#e8c183', 'stroke-width': '3.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    this.schemaDot = svgNode('circle', { r: 6, fill: '#ffffff', stroke: '#314b3a', 'stroke-width': 2 });
    svg.append(this.schemaTravelled, this.schemaDot);
    this.container.append(svg); this.updateSchema();
  }
  handleSchematicRouteClick(event) {
    if (event.target?.closest?.('.map-photo-preview,[data-stop-id]')) return;
    const svg = this.container.querySelector('svg'), matrix = svg?.getScreenCTM?.();
    if (!svg || !matrix) return;
    const project = point => {
      const [x, y] = this.project(point);
      return [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f];
    };
    const hit = findRouteHit({ routes: this.routes, stages: this.stages, currentStageIndex: this.stageIndex, point: [event.clientX, event.clientY], project });
    if (hit && this.editPlacement) {
      if (hit.stageIndex === this.stageIndex) { event.preventDefault(); this.onMapPoint(pointAt(this.routes[this.stageIndex], hit.progress)); }
      return;
    }
    if (hit) { event.preventDefault(); this.onRouteSeek(hit.stageIndex, hit.progress); }
  }
  setEditPlacement(mode = null) {
    this.editPlacement = mode;
    this.container.classList.toggle('is-editing', Boolean(mode));
    const canvas = this.map?.getCanvas();
    if (canvas) canvas.style.cursor = mode ? 'crosshair' : '';
  }
  updateSchema() {
    this.schemaPaths.forEach((path, i) => { path.setAttribute('opacity', i === this.stageIndex ? '1' : '.2'); path.setAttribute('stroke', '#ef5350'); });
    const route = this.routes[this.stageIndex], p = this.project(pointAt(route, this.progress));
    this.schemaTravelled.setAttribute('d', this.schemaLine(sliceRoute(route, this.progress)));
    this.schemaDot.setAttribute('cx', p[0]); this.schemaDot.setAttribute('cy', p[1]);
    if (this.createStopPreview && this.schemaPreviewStage !== this.stageIndex) {
      this.container.querySelectorAll('.map-photo-preview').forEach(node => node.remove());
      this.schemaPreviewStage = this.stageIndex;
      for (const stop of this.stages[this.stageIndex].stops || []) {
        const button = this.createStopPreview(stop);
        const position = this.project(pointAt(route, stop.progress));
        button.style.left = `${position[0]}px`; button.style.top = `${position[1]}px`;
        button.addEventListener('click', event => {
          if (this.editPlacement) { event.preventDefault(); event.stopPropagation(); this.onMapPoint(pointAt(route, stop.progress)); }
          else this.onStop(stop);
        }); this.container.append(button);
      }
    }
  }
  setToken(token) {
    this.photoCamera = null;
    this.cancelCameraMotion();
    clearTimeout(this.loadTimer);
    this.markers.forEach(m => m.remove()); this.markers = [];
    this.overnightMarkers?.forEach(m => m.remove()); this.overnightMarkers = [];
    this.landmarkMarkers.forEach(({ marker }) => marker.remove()); this.landmarkMarkers = [];
    this.map?.remove(); this.map = null; this.ready = false; this.lastLoadError = null; this.waitingForTerrain = false; this.appliedExplore = null; this.container.hidden = false;
    if (!token) { this.onStatus('schematic'); return; }
    if (!window.mapboxgl?.supported()) { this.onStatus('error', '3D-Karten werden von diesem Browser nicht unterstützt. Die Vorschau und Galerien bleiben verfügbar.'); return; }
    this.onStatus('loading');
    try {
      // Keep satellite/DEM bursts small during camera moves on this local presentation.
      window.mapboxgl.maxParallelImageRequests = 4;
      const map = new window.mapboxgl.Map({ container: 'map', accessToken: token, style: 'mapbox://styles/mapbox/standard-satellite', center: [11.48, 47.7], zoom: 8, pitch: 55, minPitch: 0, maxPitch: 85, pitchWithRotate: true, bearing: 0, antialias: true, attributionControl: true, minTileCacheSize: 64, maxTileCacheSize: 1024, transformRequest: createMapRequestGate() });
      this.map = map;
      map.on('style.load', () => {
        if (map !== this.map) return;
        for (const [key, value] of Object.entries({ showPlaceLabels: true, showPointOfInterestLabels: false, showRoadLabels: false, showTransitLabels: false })) map.setConfigProperty('basemap', key, value);
      });
      this.bindLookControls(map);
      this.bindZoomControls(map);
      map.on('move', () => {
        if (map === this.map) this.onHeading(map.getBearing());
      });
      map.on('zoom', () => { if (map === this.map) this.updateLandmarkAltitudes(); });
      map.on('movestart', event => {
        if (map === this.map) this.handleUserNavigation(event);
      });
      map.on('pitch', () => {
        if (map === this.map) this.onPitch(map.getPitch());
      });
      map.addControl(new window.mapboxgl.NavigationControl({ showCompass: true, visualizePitch: true }), 'bottom-right');
      map.on('load', () => {
        if (map !== this.map) return;
        clearTimeout(this.loadTimer);
        try {
          map.addSource('journey-dem', { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 });
          map.setTerrain({ source: 'journey-dem', exaggeration: 1 });
          map.addSource('journey-all', { type: 'geojson', data: { type: 'FeatureCollection', features: this.routes.map((r, index) => feature(r.points, { stageIndex: index })) } });
          map.addLayer({ id: 'journey-all', type: 'line', slot: 'middle', source: 'journey-all', paint: { 'line-color': '#fff4d4', 'line-width': 3, 'line-opacity': .4 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
          map.addSource('journey-active', { type: 'geojson', data: feature(this.routes[this.stageIndex].points, { stageIndex: this.stageIndex }) });
          map.addLayer({ id: 'journey-active', type: 'line', slot: 'middle', source: 'journey-active', paint: { 'line-color': '#ef5350', 'line-width': 4, 'line-opacity': 1 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
          map.addSource('journey-travelled', { type: 'geojson', data: feature(sliceRoute(this.routes[this.stageIndex], this.progress)) });
          map.addLayer({ id: 'journey-travelled', type: 'line', slot: 'middle', source: 'journey-travelled', paint: { 'line-color': '#ffd990', 'line-width': 5 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
          map.addSource('journey-position', { type: 'geojson', data: routePosition(this.routes[this.stageIndex], this.progress) });
          map.addLayer({ id: 'journey-position', type: 'circle', slot: 'middle', source: 'journey-position', paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': '#183d35', 'circle-stroke-width': 2 } });
          this.bindRouteInteractions(map);
          this.overnightMarkers = overnightPlaces(this.stages, this.routes).map(place => {
            const label = document.createElement('div'); label.className = 'overnight-place';
            const dot = document.createElement('span'); dot.className = 'overnight-dot'; dot.textContent = String(place.day);
            const name = document.createElement('span'); name.className = 'overnight-name'; name.textContent = place.name;
            const description = `${place.confirmed ? 'Übernachtung' : 'Etappenziel'} ${place.day}: ${place.name}${place.confirmed ? '' : ' · Übernachtung noch abzugleichen'}`;
            label.title = description; label.setAttribute('aria-label', description); label.append(dot, name);
            return new window.mapboxgl.Marker({ element: label, anchor: 'left' }).setLngLat(place.coordinates).addTo(map);
          });
          this.landmarkMarkers = [
            ...mountainRegions.map(region => this.createLandmarkMarker(region, 'region', map)),
            ...borderCrossings.map(crossing => this.createLandmarkMarker(crossing, 'border', map))
          ];
          this.updateLandmarkAltitudes();
          const pendingStop = this.pendingStopProgress;
          this.ready = true; this.container.hidden = true; this.onStatus('ready'); this.setStage(this.stageIndex); this.setExplore(this.exploring);
          if (Number.isFinite(pendingStop)) this.focusStop(pendingStop);
        } catch (error) { this.fail('Die 3D-Karte konnte nicht aufgebaut werden. ' + error.message); }
      });
      map.on('error', event => {
        if (map !== this.map) return;
        const diagnostic = describeMapError(event.error);
        if (this.lastLoadError !== diagnostic.message) {
          let tokenMatches = null;
          try { const supplied = new URL(event.error.url).searchParams.get('access_token'); tokenMatches = supplied ? supplied === token : null; } catch { /* Some errors have no URL. */ }
          let sku = '';
          try { sku = new URL(event.error.url).searchParams.get('sku') || ''; } catch { /* No request URL. */ }
          this.lastFailedRequest = { resource: diagnostic.resource, sku };
          console.warn('Traumpfad-Karte:', JSON.stringify({ status: diagnostic.status, resource: diagnostic.resource, sku, tokenMatches, message: diagnostic.message }));
        }
        this.lastLoadError = diagnostic.message;
        if ([401, 402, 403, 429].includes(diagnostic.status)) this.fail(diagnostic.message);
        else if (!this.ready) this.onStatus('error', diagnostic.message);
      });
      this.loadTimer = setTimeout(() => { if (!this.ready && map === this.map && !this.lastLoadError) this.onStatus('loading', 'Die Karte lädt noch. Du kannst die lokale Vorschau und Galerien bereits verwenden.'); }, 12000);
    } catch (error) { this.fail('Die Karte konnte nicht gestartet werden. ' + error.message); }
  }
  fail(message) {
    this.cancelCameraMotion();
    clearTimeout(this.loadTimer);
    const failedMap = this.map;
    // Detach first: errors from requests already in flight must not replace the root cause.
    this.map = null; this.ready = false; this.waitingForTerrain = false; this.appliedExplore = null;
    this.markers.forEach(marker => marker.remove()); this.markers = [];
    this.overnightMarkers?.forEach(marker => marker.remove()); this.overnightMarkers = [];
    this.landmarkMarkers.forEach(({ marker }) => marker.remove()); this.landmarkMarkers = [];
    failedMap?.remove();
    this.container.hidden = false; this.onStatus('error', message);
  }
  createLandmarkMarker(place, kind, map) {
    const element = document.createElement('div');
    element.className = `map-landmark map-landmark-${kind}`;
    element.setAttribute('aria-label', kind === 'region'
      ? `${place.name}${place.subtitle ? ` · ${place.subtitle}` : ''}`
      : `Staatsgrenze ${place.from} nach ${place.to} · ${place.place}${place.approximate ? ' · ungefährer Punkt am Referenztrack' : ''}`);
    element.title = element.getAttribute('aria-label');
    element.style.setProperty('--landmark-float', kind === 'region' ? '76px' : '48px');
    const stem = document.createElement('span'); stem.className = 'map-landmark-stem';
    const label = document.createElement('span'); label.className = 'map-landmark-label';
    if (kind === 'region') {
      const symbol = document.createElement('span'); symbol.className = 'map-landmark-symbol'; symbol.textContent = '▲';
      const copy = document.createElement('span'); copy.className = 'map-landmark-copy';
      const name = document.createElement('strong'); name.textContent = place.name; copy.append(name);
      if (place.subtitle) { const subtitle = document.createElement('small'); subtitle.textContent = place.subtitle; copy.append(subtitle); }
      label.append(symbol, copy);
    } else {
      const copy = document.createElement('span'); copy.className = 'map-landmark-copy';
      const heading = document.createElement('strong'); heading.className = 'map-landmark-border-title';
      heading.textContent = `${place.from} → ${place.to}${place.approximate ? ' · ca.' : ''}`;
      const subtitle = document.createElement('small'); subtitle.textContent = place.place;
      copy.append(heading, subtitle); label.append(copy);
      const pin = document.createElement('span'); pin.className = 'map-landmark-border-pin'; pin.textContent = '↕'; label.append(pin);
    }
    element.append(stem, label);
    const marker = new window.mapboxgl.Marker({ element, anchor: 'center', pitchAlignment: 'viewport', rotationAlignment: 'viewport' })
      .setLngLat(place.coordinates)
      .addTo(map);
    marker.getElement().style.zIndex = kind === 'border' ? '7' : '6';
    return { marker, place };
  }
  bindRouteInteractions(map) {
    const layers = ['journey-active', 'journey-all'];
    const featureIndices = point => {
      const found = map.queryRenderedFeatures(point, { layers });
      return found.map(item => Number(item.properties?.stageIndex)).filter(Number.isInteger);
    };
    const project = point => {
      // Route strokes are draped over terrain; project their ground position, not GPX elevation metadata.
      const result = map.project([point[0], point[1]]);
      return [result.x, result.y];
    };
    map.on('click', event => {
      if (map !== this.map || !this.ready || event.originalEvent?.target?.closest?.('.map-photo-preview,[data-stop-id],.map-landmark,.overnight-place')) return;
      if (this.editPlacement) {
        event.preventDefault();
        const route = this.routes[this.stageIndex], progress = nearestProgress(route, [event.lngLat.lng, event.lngLat.lat]);
        this.onMapPoint(pointAt(route, progress));
        return;
      }
      const { x, y } = event.point;
      const candidates = featureIndices([[x - 15, y - 15], [x + 15, y + 15]]);
      const hit = findRouteHit({ routes: this.routes, stages: this.stages, currentStageIndex: this.stageIndex, candidateIndices: candidates, point: event.point, project });
      if (hit) this.onRouteSeek(hit.stageIndex, hit.progress);
    });
    map.on('mousemove', event => {
      if (!this.ready || map !== this.map) return;
      map.getCanvas().style.cursor = this.editPlacement ? 'crosshair' : featureIndices(event.point).length ? 'pointer' : '';
    });
    map.on('mouseout', () => { if (map === this.map) map.getCanvas().style.cursor = this.editPlacement ? 'crosshair' : ''; });
  }
  updateLandmarkAltitudes() {
    if (!this.map || !this.landmarkMarkers.length) return;
    const zoom = this.map.getZoom();
    for (const { marker, place } of this.landmarkMarkers) {
      // Keep labels hovering at a legible screen height as the camera zooms.
      const metersPerPixel = 40075016.686 * Math.cos(place.coordinates[1] * Math.PI / 180) / (512 * 2 ** zoom);
      marker.setAltitude(Math.max(.5, Math.min(25000, metersPerPixel * 26)));
    }
  }
  setStage(index) {
    this.photoCamera = null;
    this.pendingStopProgress = null;
    this.cancelCameraMotion();
    this.stageIndex = index; this.progress = 0; this.cameraPosition = null; this.cameraAltitude = null; this.followHeading = null; this.cameraTarget = null; this.pathHeading = null;
    this.schemaPreviewStage = null; this.updateSchema();
    if (!this.ready) return;
    this.map.getSource('journey-active').setData(feature(this.routes[index].points, { stageIndex: index }));
    this.renderStopMarkers(index);
    this.setProgress(0, false); this.flyToRoutePoint(0);
  }
  renderStopMarkers(index) {
    this.markers.forEach(m => m.remove());
    this.markers = (this.stages[index].stops || []).map((stop, i) => {
      const button = this.createStopPreview ? this.createStopPreview(stop) : document.createElement('button');
      if (!this.createStopPreview) { button.className = 'route-marker'; button.textContent = String(i + 1); }
      button.dataset.stopId = stop.id; button.setAttribute('aria-label', `${stop.title}${stop.approximate ? ', ungefährer Ort' : ''}`);
      button.addEventListener('click', event => {
        if (this.editPlacement) { event.preventDefault(); event.stopPropagation(); this.onMapPoint(pointAt(this.routes[index], stop.progress)); }
        else this.onStop(stop);
      });
      return new window.mapboxgl.Marker({ element: button }).setLngLat(pointAt(this.routes[index], stop.progress)).addTo(this.map);
    });
  }
  refreshStops() {
    this.schemaPreviewStage = null; this.updateSchema();
    if (this.ready) this.renderStopMarkers(this.stageIndex);
  }
  focusStop(progress) {
    this.cancelCameraMotion(); this.cameraPosition = null; this.cameraAltitude = null; this.cameraTarget = null; this.pathHeading = null;
    if (!this.ready) { this.pendingStopProgress = progress; this.setProgress(progress, false); return; }
    this.pendingStopProgress = null;
    if (this.exploring) { this.setProgress(progress, false); this.flyToRoutePoint(progress); }
    else this.setProgress(progress);
  }
  stopPreviewRect(id) {
    const root = this.ready ? document.getElementById('map') : this.container;
    return [...root.querySelectorAll('.map-photo-preview')].find(node => node.dataset.stopId === id)?.getBoundingClientRect();
  }
  beginPhotoFocus(stop) {
    if (!this.ready || this.photoCamera?.id === stop.id) return;
    const pose = this.map.getFreeCameraOptions();
    this.photoCamera = { id: stop.id, stageIndex: this.stageIndex, pose };
    const center = pointAt(this.routes[this.stageIndex], stop.progress);
    const saved = this.photoCamera, heading = this.map.getBearing();
    // Load detailed terrain first, then descend using absolute terrain elevation.
    this.animateNavigation(() => this.map.flyTo({ center, zoom: Math.min(19, this.map.getMaxZoom?.() ?? 19), pitch: 25, bearing: heading, duration: this.reducedMotion() ? 0 : 3000 }), () => {
      if (this.photoCamera !== saved || this.exploring) return;
      const ground = this.map.queryTerrainElevation(center, { exaggerated: false });
      if (!Number.isFinite(ground)) return; // Keep the safe Mapbox approach if heights are unavailable.
      const close = this.map.getFreeCameraOptions();
      close.position = window.mapboxgl.MercatorCoordinate.fromLngLat(center, ground + 10);
      close.setPitchBearing(25, heading);
      this.beginEntry(close, { lockView: true });
      if (this.entry) { this.entry.duration = 1800; this.entry.groundClearance = 10; }
    });
  }
  endPhotoFocus() {
    const saved = this.photoCamera; this.photoCamera = null;
    if (!saved || !this.ready || this.exploring || saved.stageIndex !== this.stageIndex) return;
    this.cancelCameraMotion(); this.beginEntry(saved.pose, { lockView: true });
    if (this.entry) this.entry.duration = 900;
  }
  cancelCameraMotion(stopMap = true) {
    this.motionVersion = (this.motionVersion || 0) + 1;
    if (this.nativeMotion) this.map?.off?.('moveend', this.nativeMotion);
    this.nativeMotion = null; this.entry = null; this.followRequested = false;
    this.routeFramed = false; this.nativeMotionStarted = null; this.terrainRetryAt = null;
    this.pendingStopProgress = null;
    this.preparingFollow = false; this.waitingForTerrain = false; this.following = false;
    if (stopMap) this.map?.stop();
  }
  pauseCamera() {
    this.followRequested = false;
    if (this.entry || this.nativeMotion || this.preparingFollow || Number.isFinite(this.pendingStopProgress)) this.cancelCameraMotion();
  }
  animateNavigation(action, onComplete) {
    this.cancelCameraMotion();
    const currentMap = this.map, version = this.motionVersion;
    const complete = () => {
      if (this.map !== currentMap || version !== this.motionVersion || this.nativeMotion !== complete) return;
      currentMap.off('moveend', complete);
      this.nativeMotion = null; this.nativeMotionStarted = null;
      onComplete?.();
      if (this.followRequested) this.setProgress(this.progress);
    };
    this.nativeMotion = complete;
    this.nativeMotionStarted = performance.now();
    currentMap.on('moveend', complete);
    action();
  }
  flyToRoutePoint(progress) {
    if (!this.ready) return;
    const route = this.routes[this.stageIndex], offset = this.viewOffset ?? [0, 0];
    const center = pointAt(route, progress).map((v, i) => v + offset[i]);
    const heading = bearing(pointAt(route, clamp(progress - 300 / route.length)), pointAt(route, clamp(progress + 450 / route.length)));
    this.animateNavigation(() => {
      // A zero-duration flight can fire moveend before flyTo returns.
      this.routeFramed = true;
      this.map.flyTo({ center, zoom: 12.4, pitch: 50, bearing: heading, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: this.reducedMotion() ? 0 : 2600, curve: 1.4 });
    });
  }
  beginEntry(target, { lockView = false } = {}) {
    const start = this.map.getFreeCameraOptions();
    if (this.reducedMotion() || !start.position || !start.orientation || !target.orientation) {
      if (!lockView) this.applyFollowView(target);
      this.map.setFreeCameraOptions(target); this.following = true; return;
    }
    this.map.stop();
    const snapshot = pose => ({ position: { x: pose.position.x, y: pose.position.y, z: pose.position.z }, orientation: [...pose.orientation] });
    this.entry = { from: snapshot(start), to: snapshot(target), startedAt: performance.now(), duration: 2200, lockView };
  }
  advanceCamera(now) {
    // A gesture or SDK interruption may finish a flight without its expected moveend.
    if (this.nativeMotion && Number.isFinite(this.nativeMotionStarted) && now - this.nativeMotionStarted > 3000) this.nativeMotion();
    // Terrain may finish loading without an idle event during continued interaction.
    if (this.preparingFollow && this.followRequested && now >= (this.terrainRetryAt ?? 0)) {
      this.terrainRetryAt = now + 250;
      this.setProgress(this.progress, true, .1);
    }
    if (this.entry && this.ready) {
      const entry = this.entry, t = clamp((now - entry.startedAt) / entry.duration);
      const pose = interpolateCamera(entry.from, entry.to, t);
      const camera = this.map.getFreeCameraOptions();
      camera.position = new window.mapboxgl.MercatorCoordinate(pose.position.x, pose.position.y, pose.position.z);
      if (entry.groundClearance) {
        const location = camera.position.toLngLat();
        const ground = this.map.queryTerrainElevation(location, { exaggerated: false });
        if (!Number.isFinite(ground)) { this.entry = null; return false; }
        const floor = window.mapboxgl.MercatorCoordinate.fromLngLat(location, ground + entry.groundClearance);
        camera.position.z = Math.max(camera.position.z, floor.z);
      }
      camera.orientation = pose.orientation;
      if (!entry.lockView) this.applyFollowView(camera);
      this.map.setFreeCameraOptions(camera);
      if (t >= 1) { this.entry = null; this.following = true; }
    }
    return Boolean(this.map && (!this.ready || this.nativeMotion || this.entry || this.preparingFollow));
  }
  fitStage() {
    if (!this.ready) return;
    const points = this.routes[this.stageIndex].points;
    const bounds = points.reduce((b, p) => b.extend(p), new window.mapboxgl.LngLatBounds(points[0], points[0]));
    const padding = this.map.getContainer().clientWidth > 650 ? { top: 100, bottom: 200, left: 350, right: 65 } : { top: 100, bottom: 170, left: 35, right: 35 };
    this.animateNavigation(() => this.map.fitBounds(bounds, { padding, pitch: 50, duration: this.reducedMotion() ? 0 : 2600, maxZoom: 13 }));
  }
  overview() {
    this.photoCamera = null;
    if (!this.ready) return;
    const points = this.routes.flatMap(r => r.points);
    const bounds = points.reduce((b, p) => b.extend(p), new window.mapboxgl.LngLatBounds(points[0], points[0]));
    this.animateNavigation(() => this.map.fitBounds(bounds, { padding: { top: 80, bottom: 190, left: 50, right: 50 }, pitch: 35, duration: this.reducedMotion() ? 0 : 2600 }));
  }
  routeHeading() {
    const route = this.routes[this.stageIndex];
    return bearing(pointAt(route, clamp(this.progress - 300 / route.length)), pointAt(route, clamp(this.progress + 450 / route.length)));
  }
  applyFollowView(camera) {
    if (this.viewPitch == null && !this.viewBearing) return;
    const q = camera.orientation;
    const pitch = this.viewPitch ?? (2 * Math.atan2(Math.hypot(q[0], q[1]), Math.hypot(q[2], q[3])) * 180 / Math.PI);
    camera.setPitchBearing(pitch, (this.followHeading ?? this.routeHeading()) + (this.viewBearing || 0));
  }
  refreshView() {
    if (!this.ready || !this.map) return;
    const camera = this.map.getFreeCameraOptions();
    // Keep the physical camera position; only its orientation changes.
    camera.setPitchBearing(this.viewPitch ?? this.map.getPitch(), (this.followHeading ?? this.routeHeading()) + (this.viewBearing || 0));
    this.map.setFreeCameraOptions(camera);
  }
  setPitch(value) {
    if (!this.ready || !this.map || !Number.isFinite(value)) return;
    this.viewPitch = clamp(value, 0, 85);
    if (this.exploring) {
      this.cancelCameraMotion();
      this.map.setPitch(this.viewPitch);
    } else this.refreshView();
  }
  setBearing(value) {
    if (!this.ready || !this.map || !Number.isFinite(value)) return;
    this.viewBearing = ((value + 180) % 360 + 360) % 360 - 180;
    this.onBearing(this.viewBearing);
    if (this.exploring) {
      this.cancelCameraMotion();
      this.map.setBearing(this.routeHeading() + this.viewBearing);
    } else this.refreshView();
  }
  recenter(progress = this.progress) {
    if (!this.ready || !this.map) return;
    this.setExplore(false);
    this.cancelCameraMotion();
    this.viewOffset = [0, 0]; this.viewDistance = 1;
    this.viewPitch = null; this.viewBearing = 0; this.heightOffset = 0;
    this.cameraPosition = null; this.cameraAltitude = null; this.cameraTarget = null;
    this.followHeading = null; this.pathHeading = null; this.terrainFloor = null;
    this.onBearing(0); this.onHeight(0);
    this.setProgress(progress, true);
  }
  resetView() {
    if (!this.ready || !this.map) return;
    this.viewPitch = null; this.viewBearing = 0;
    this.onBearing(0);
    if (this.exploring) {
      this.cancelCameraMotion();
      this.map.jumpTo({ pitch: 55, bearing: this.routeHeading() });
    } else if (this.followRequested) this.setProgress(this.progress, true, .1);
    else {
      const camera = this.map.getFreeCameraOptions();
      camera.setPitchBearing(55, this.routeHeading());
      this.map.setFreeCameraOptions(camera);
    }
  }
  setHeight(value) {
    if (!this.ready || !this.map || !Number.isFinite(value)) return;
    const next = clamp(Math.round(value), -1200, 6000), change = next - (this.heightOffset || 0);
    this.heightOffset = next;
    this.onHeight(next);
    if (!change) return;
    if (!this.exploring && this.cameraPosition && this.cameraAltitude != null) {
      this.cameraAltitude = Math.max((this.terrainFloor ?? 0) + 500, this.cameraAltitude + change);
      const position = window.mapboxgl.MercatorCoordinate.fromLngLat(this.cameraPosition, this.cameraAltitude);
      if (this.entry) this.entry.to.position.z = position.z;
      else if (!this.nativeMotion) {
        const camera = this.map.getFreeCameraOptions();
        camera.position = position;
        this.map.setFreeCameraOptions(camera);
      }
    } else {
      const camera = this.map.getFreeCameraOptions(), position = camera.position;
      if (!position?.toAltitude || !position?.toLngLat) return;
      const terrain = this.map.queryTerrainElevation(position.toLngLat(), { exaggerated: false });
      if (!Number.isFinite(terrain)) return;
      const altitude = Math.max(terrain + 500, position.toAltitude() + change);
      this.cancelCameraMotion();
      camera.position = window.mapboxgl.MercatorCoordinate.fromLngLat(position.toLngLat(), altitude);
      this.map.setFreeCameraOptions(camera);
    }
  }
  raiseBy(vertical) { this.setHeight((this.heightOffset || 0) - vertical * HEIGHT_METERS_PER_PIXEL); }
  lookBy(horizontal, vertical) {
    if (!this.ready || !this.map) return;
    if (this.exploring) {
      const camera = this.map.getFreeCameraOptions();
      const pitch = clamp(this.map.getPitch() - vertical * LOOK_DEGREES_PER_PIXEL, 0, 85);
      const heading = this.map.getBearing() + horizontal * LOOK_DEGREES_PER_PIXEL;
      // Rotate at the observer's position, rather than orbiting Mapbox's ground centre.
      camera.setPitchBearing(pitch, heading);
      this.map.setFreeCameraOptions(camera);
      this.viewPitch = pitch;
      this.viewBearing = ((heading - (this.followHeading ?? this.routeHeading()) + 540) % 360 + 360) % 360 - 180;
      return;
    }
    this.viewPitch = clamp((this.viewPitch ?? this.map.getPitch()) - vertical * LOOK_DEGREES_PER_PIXEL, 0, 85);
    this.setBearing((this.viewBearing || 0) + horizontal * LOOK_DEGREES_PER_PIXEL);
  }
  bindLookControls(map) {
    const surface = map.getCanvasContainer();
    let pointer;
    const canLook = event => map === this.map && this.ready && [0, 2].includes(event.button) && !event.target?.closest?.('button,a,input,select');
    surface.addEventListener('pointerdown', event => {
      if (!canLook(event)) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.button === 0 && !event.ctrlKey && !event.shiftKey, height: event.shiftKey, started: false };
      this.lookingWithRightButton = event.button === 2;
      surface.setPointerCapture(event.pointerId);
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    surface.addEventListener('pointermove', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (pointer.pan && !pointer.started && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 4) return;
      pointer.started = true;
      if (pointer.height || event.shiftKey) this.raiseBy(event.clientY - pointer.y);
      else if (pointer.pan) this.panBy(event.clientX - pointer.x, event.clientY - pointer.y);
      else this.lookBy(pointer.x - event.clientX, pointer.y - event.clientY);
      pointer.x = event.clientX; pointer.y = event.clientY;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) surface.addEventListener(type, event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      pointer = null;
      this.lookingWithRightButton = false;
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      event.stopImmediatePropagation();
    }, true);
    surface.addEventListener('mousedown', event => {
      if (canLook(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    surface.addEventListener('contextmenu', event => {
      if (map === this.map && this.ready) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
  }
  panBy(x, y) {
    if (!this.ready || !this.map || !Number.isFinite(x) || !Number.isFinite(y) || (!x && !y)) return;
    const surface = this.map.getCanvasContainer(), center = [surface.clientWidth / 2, surface.clientHeight / 2];
    const from = this.map.unproject(center), to = this.map.unproject([center[0] - x, center[1] - y]);
    if (![from.lng, from.lat, to.lng, to.lat].every(Number.isFinite)) return;
    if (!this.exploring) { this.setExplore(true); this.onExplore(); }
    const a = [from.lng, from.lat], b = [to.lng, to.lat], current = this.map.getCenter();
    // Damped panning, capped at 30 ground metres per pixel even near the horizon.
    const meters = Math.min(distance(a, b) * PAN_FRACTION, Math.hypot(x, y) * PAN_METERS_PER_PIXEL);
    this.map.setCenter(destination([current.lng, current.lat], meters, bearing(a, b)));
  }
  zoomBy(steps, around) {
    if (!this.ready || !this.map || !Number.isFinite(steps)) return;
    if (this.exploring) {
      const options = { duration: this.reducedMotion() ? 0 : 300 };
      if (around) options.around = around;
      this.map.zoomTo(this.map.getZoom() + steps, options);
      return;
    }
    const previous = this.viewDistance ?? 1;
    this.viewDistance = clamp(previous * Math.pow(2, -steps), .3, 4);
    if (this.viewDistance === previous) return;
    if (this.entry || this.nativeMotion || this.preparingFollow || !this.following) {
      // Do not adopt an intermediate flight pose as a completed route camera.
      this.cancelCameraMotion();
      this.cameraPosition = null; this.cameraAltitude = null; this.cameraTarget = null;
      this.followHeading = null; this.pathHeading = null;
      this.setProgress(this.progress, true, .1);
      return;
    }
    const anchorHeight = around && this.map.queryTerrainElevation(around, { exaggerated: false });
    if (!around || ![around.lng, around.lat, anchorHeight].every(Number.isFinite) || !this.cameraTarget) {
      this.setProgress(this.progress, true, .1);
      return;
    }
    // Scale the camera and its existing route target together around the cursor.
    // Keeping one camera owner and the same orientation avoids an SDK zoom followed
    // by a competing lookAtPoint towards Mapbox's different ground centre.
    const Coordinate = window.mapboxgl.MercatorCoordinate;
    const camera = this.map.getFreeCameraOptions(), position = camera.position;
    if (!position) return;
    const anchor = Coordinate.fromLngLat(around, anchorHeight);
    const focus = Coordinate.fromLngLat(this.cameraTarget, anchorHeight);
    const scale = this.viewDistance / previous;
    const scaled = point => new Coordinate(anchor.x + (point.x - anchor.x) * scale, anchor.y + (point.y - anchor.y) * scale, anchor.z + (point.z - anchor.z) * scale);
    const nextPosition = scaled(position), location = nextPosition.toLngLat();
    const target = scaled(focus).toLngLat();
    const nextTarget = [target.lng, target.lat], nextLocation = [location.lng, location.lat];
    const elevations = Array.from({ length: 13 }, (_, i) => {
      const t = i / 12;
      return this.map.queryTerrainElevation(nextLocation.map((v, axis) => v * (1 - t) + nextTarget[axis] * t), { exaggerated: false });
    });
    if (!elevations.every(Number.isFinite)) {
      this.setProgress(this.progress, true, .1);
      return;
    }
    this.terrainFloor = Math.max(...elevations);
    this.cameraAltitude = Math.max(this.terrainFloor + 500, nextPosition.toAltitude());
    const offset = this.viewOffset ?? [0, 0];
    this.viewOffset = offset.map((value, axis) => value + nextTarget[axis] - this.cameraTarget[axis]);
    this.cameraPosition = nextLocation; this.cameraTarget = nextTarget;
    this.followHeading = bearing(nextLocation, nextTarget);
    camera.position = Coordinate.fromLngLat(nextLocation, this.cameraAltitude);
    if (this.cameraAltitude > nextPosition.toAltitude() + .01) {
      // Terrain clearance can lift the camera; keep its route target in view.
      camera.lookAtPoint({ lng: target.lng, lat: target.lat });
      this.applyFollowView(camera);
    }
    this.map.setFreeCameraOptions(camera);
  }
  bindZoomControls(map) {
    const surface = map.getCanvasContainer();
    const active = () => map === this.map && this.ready;
    const cursorPoint = event => {
      if (this.lookingWithRightButton || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      const rect = surface.getBoundingClientRect();
      return map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
    };
    const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    surface.addEventListener('wheel', event => {
      if (!active() || this.exploring) return;
      consume(event);
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1);
      this.zoomBy(clamp(-pixels / WHEEL_PIXELS_PER_ZOOM_STEP, -1, 1), cursorPoint(event));
    }, { capture: true, passive: false });
    surface.addEventListener('dblclick', event => {
      if (!active()) return;
      consume(event); this.zoomBy(event.shiftKey ? -BUTTON_ZOOM_STEP : BUTTON_ZOOM_STEP, cursorPoint(event));
    }, true);
    map.getContainer().addEventListener('click', event => {
      const button = event.target.closest?.('.mapboxgl-ctrl-zoom-in,.mapboxgl-ctrl-zoom-out');
      if (!button || !active()) return;
      consume(event); this.zoomBy(button.classList.contains('mapboxgl-ctrl-zoom-in') ? BUTTON_ZOOM_STEP : -BUTTON_ZOOM_STEP);
    }, true);
  }
  handleUserNavigation(event) {
    if (!this.ready || this.exploring || !event.originalEvent) return;
    this.setExplore(true, { userGesture: true }); this.onExplore();
  }
  setExplore(exploring, { userGesture = false } = {}) {
    this.exploring = exploring;
    if (!this.map || this.appliedExplore === exploring) return;
    // Mapbox already interrupts its animation on a gesture. stop() here would
    // also reset the wheel/drag gesture that is taking control.
    if (this.appliedExplore !== null) this.cancelCameraMotion(!userGesture);
    this.appliedExplore = exploring;
    // Keep gestures available during the tour so the first gesture can take over.
    for (const key of ['scrollZoom', 'boxZoom', 'dragRotate', 'dragPan', 'doubleClickZoom', 'touchZoomRotate', 'touchPitch']) this.map[key]?.enable();
    this.map.scrollZoom?.setZoomRate?.(EXPLORE_TRACKPAD_ZOOM_RATE);
    this.map.scrollZoom?.setWheelZoomRate?.(EXPLORE_WHEEL_ZOOM_RATE);
    this.map.dragRotate?.enablePitch?.();
    // Presentation shortcuts use arrow keys; let Mapbox use them only in explore mode.
    this.map.keyboard?.[exploring ? 'enable' : 'disable']();
  }
  reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  setProgress(progress, follow = true, delta = 1 / 60) {
    this.progress = progress; this.updateSchema();
    if (!this.ready) return;
    const route = this.routes[this.stageIndex];
    this.map.getSource('journey-travelled').setData(feature(sliceRoute(route, progress)));
    this.map.getSource('journey-position').setData(routePosition(route, progress));
    if (!follow || this.exploring) return;
    this.followRequested = true;
    if (this.nativeMotion || this.entry) return;
    const offset = this.viewOffset ?? [0, 0];
    const desiredTarget = scenicPoint(route, clamp(progress + 650 / route.length)).map((v, i) => v + offset[i]);
    const targetBlend = this.following ? 1 - Math.exp(-Math.min(delta, .1) * 1.2) : 1;
    this.cameraTarget = this.cameraTarget ? this.cameraTarget.map((v, i) => v + (desiredTarget[i] - v) * targetBlend) : desiredTarget;
    const target = this.cameraTarget;
    if (!this.following && !this.routeFramed && this.map.getBounds && !this.map.getBounds().contains(target)) {
      this.flyToRoutePoint(progress); this.followRequested = true; return;
    }
    const heading = easeHeading(this.following ? this.pathHeading : null, scenicHeading(route, progress), delta);
    this.pathHeading = heading;
    const distance = this.viewDistance ?? 1;
    const desired = destination(scenicPoint(route, progress).map((v, i) => v + offset[i]), 1800 * distance, heading + 180);
    const blend = this.following && this.cameraPosition ? 1 - Math.exp(-Math.min(delta, .1) * 1.2) : 1;
    this.cameraPosition = this.cameraPosition ? this.cameraPosition.map((v, i) => v + (desired[i] - v) * blend) : desired;
    // Probe the camera-to-target corridor, not only the ground under the camera.
    const samples = Array.from({ length: 13 }, (_, i) => {
      const t = i / 12;
      const p = [this.cameraPosition[0] * (1 - t) + target[0] * t, this.cameraPosition[1] * (1 - t) + target[1] * t];
      return this.map.queryTerrainElevation(p, { exaggerated: false });
    });
    if (samples.some(v => v === null)) {
      this.preparingFollow = !this.following;
      // Retry once tiles settle, even if a photo stop has paused the timeline meanwhile.
      if (!this.waitingForTerrain) {
        this.waitingForTerrain = true;
        const currentMap = this.map, version = this.motionVersion;
        currentMap.once('idle', () => {
          if (currentMap !== this.map || version !== this.motionVersion) return;
          this.waitingForTerrain = false;
          if (this.ready && !this.exploring && this.followRequested) this.setProgress(this.progress, true, .1);
        });
      }
      return;
    }
    this.preparingFollow = false;
    this.terrainFloor = Math.max(...samples);
    const desiredAltitude = this.terrainFloor + Math.max(500, 1700 * distance + (this.heightOffset || 0));
    this.cameraAltitude = this.cameraAltitude === null ? desiredAltitude : Math.max(desiredAltitude, this.cameraAltitude + (desiredAltitude - this.cameraAltitude) * blend);
    const camera = this.map.getFreeCameraOptions();
    camera.position = window.mapboxgl.MercatorCoordinate.fromLngLat(this.cameraPosition, this.cameraAltitude);
    camera.lookAtPoint({ lng: target[0], lat: target[1] });
    this.followHeading = bearing(this.cameraPosition, target);
    if (!this.following) this.beginEntry(camera);
    else {
      this.applyFollowView(camera);
      this.map.setFreeCameraOptions(camera);
    }
  }
}
