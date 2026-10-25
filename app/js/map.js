import { bearing, clamp, destination, distance, feature, pointAt, sliceRoute } from './route.js';
import { describeMapError } from './map-error.js';
import { createTileRequestGate } from './tile-request-gate.js';
import { interpolateCamera } from './camera-transition.js';
import { scenicPoint, scenicHeading, easeHeading } from './camera-follow.js';

const SVG = 'http://www.w3.org/2000/svg';
function svgNode(tag, attributes, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

export class JourneyMap {
  constructor({ stages, routes, onStop, onStatus, onExplore = () => {}, onPitch = () => {}, onBearing = () => {} }) {
    Object.assign(this, { stages, routes, onStop, onStatus, onExplore, onPitch, onBearing });
    this.viewPitch = null; this.viewBearing = 0; this.viewDistance = 1;
    this.map = null; this.ready = false; this.stageIndex = 0; this.progress = 0; this.markers = []; this.exploring = false;
    this.container = document.getElementById('schematic');
    this.buildSchematic();
    this.resizeObserver = new ResizeObserver(() => this.buildSchematic());
    this.resizeObserver.observe(this.container);
  }
  buildSchematic() {
    this.container.replaceChildren();
    const width = Math.max(320, this.container.clientWidth), height = Math.max(590, this.container.clientHeight);
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Schematischer Verlauf der geladenen Etappen. Keine Geländekarte.' });
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
    this.schemaDot = svgNode('circle', { r: 6, fill: '#f2d89b', stroke: '#314b3a', 'stroke-width': 3 });
    svg.append(this.schemaTravelled, this.schemaDot);
    this.container.append(svg); this.updateSchema();
  }
  updateSchema() {
    this.schemaPaths.forEach((path, i) => path.setAttribute('opacity', i === this.stageIndex ? '.7' : '.2'));
    const route = this.routes[this.stageIndex], p = this.project(pointAt(route, this.progress));
    this.schemaTravelled.setAttribute('d', this.schemaLine(sliceRoute(route, this.progress)));
    this.schemaDot.setAttribute('cx', p[0]); this.schemaDot.setAttribute('cy', p[1]);
  }
  setToken(token) {
    this.cancelCameraMotion();
    clearTimeout(this.loadTimer);
    this.markers.forEach(m => m.remove()); this.markers = [];
    this.map?.remove(); this.map = null; this.ready = false; this.lastLoadError = null; this.waitingForTerrain = false; this.appliedExplore = null; this.container.hidden = false;
    if (!token) { this.onStatus('schematic'); return; }
    if (!window.mapboxgl?.supported()) { this.onStatus('error', '3D-Karten werden von diesem Browser nicht unterstützt. Die Vorschau und Galerien bleiben verfügbar.'); return; }
    this.onStatus('loading');
    try {
      // Keep satellite/DEM bursts small during camera moves on this local presentation.
      window.mapboxgl.maxParallelImageRequests = 4;
      const map = new window.mapboxgl.Map({ container: 'map', accessToken: token, style: 'mapbox://styles/mapbox/standard-satellite', center: [11.48, 47.7], zoom: 8, pitch: 55, minPitch: 0, maxPitch: 85, pitchWithRotate: true, bearing: 0, antialias: true, attributionControl: true, minTileCacheSize: 64, maxTileCacheSize: 256, transformRequest: createTileRequestGate() });
      this.map = map;
      this.bindLookControls(map);
      this.bindZoomControls(map);
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
          map.addSource('journey-all', { type: 'geojson', data: { type: 'FeatureCollection', features: this.routes.map(r => feature(r.points)) } });
          map.addLayer({ id: 'journey-all', type: 'line', slot: 'middle', source: 'journey-all', paint: { 'line-color': '#fff4d4', 'line-width': 3, 'line-opacity': .4 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
          map.addSource('journey-active', { type: 'geojson', data: feature(this.routes[this.stageIndex].points) });
          map.addLayer({ id: 'journey-active', type: 'line', slot: 'middle', source: 'journey-active', paint: { 'line-color': '#f2c578', 'line-width': 4, 'line-opacity': .45 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
          map.addSource('journey-travelled', { type: 'geojson', data: feature(sliceRoute(this.routes[this.stageIndex], this.progress)) });
          map.addLayer({ id: 'journey-travelled', type: 'line', slot: 'middle', source: 'journey-travelled', paint: { 'line-color': '#ffd990', 'line-width': 5 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
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
    failedMap?.remove();
    this.container.hidden = false; this.onStatus('error', message);
  }
  setStage(index) {
    this.pendingStopProgress = null;
    this.cancelCameraMotion();
    this.stageIndex = index; this.progress = 0; this.cameraPosition = null; this.cameraAltitude = null; this.followHeading = null; this.cameraTarget = null; this.pathHeading = null;
    this.updateSchema();
    if (!this.ready) return;
    this.map.getSource('journey-active').setData(feature(this.routes[index].points));
    this.markers.forEach(m => m.remove());
    this.markers = (this.stages[index].stops || []).map((stop, i) => {
      const button = document.createElement('button'); button.className = 'route-marker'; button.textContent = String(i + 1); button.setAttribute('aria-label', `${stop.title}${stop.approximate ? ', ungefährer Ort' : ''}`);
      button.addEventListener('click', () => this.onStop(stop));
      return new window.mapboxgl.Marker({ element: button }).setLngLat(pointAt(this.routes[index], stop.progress)).addTo(this.map);
    });
    this.setProgress(0, false); this.flyToRoutePoint(0);
  }
  focusStop(progress) {
    this.cancelCameraMotion(); this.cameraPosition = null; this.cameraAltitude = null; this.cameraTarget = null; this.pathHeading = null;
    if (!this.ready) { this.pendingStopProgress = progress; this.setProgress(progress, false); return; }
    this.pendingStopProgress = null;
    if (this.exploring) { this.setProgress(progress, false); this.flyToRoutePoint(progress); }
    else this.setProgress(progress);
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
  animateNavigation(action) {
    this.cancelCameraMotion();
    const currentMap = this.map, version = this.motionVersion;
    const complete = () => {
      if (this.map !== currentMap || version !== this.motionVersion) return;
      currentMap.off('moveend', complete);
      this.nativeMotion = null;
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
    this.animateNavigation(() => this.map.flyTo({ center, zoom: 12.4, pitch: 50, bearing: heading, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: this.reducedMotion() ? 0 : 2600, curve: 1.4 }));
    this.routeFramed = true;
  }
  beginEntry(target) {
    const start = this.map.getFreeCameraOptions();
    if (this.reducedMotion() || !start.position || !start.orientation || !target.orientation) {
      this.applyFollowView(target);
      this.map.setFreeCameraOptions(target); this.following = true; return;
    }
    this.map.stop();
    const snapshot = pose => ({ position: { x: pose.position.x, y: pose.position.y, z: pose.position.z }, orientation: [...pose.orientation] });
    this.entry = { from: snapshot(start), to: snapshot(target), startedAt: performance.now(), duration: 2200 };
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
      camera.orientation = pose.orientation;
      this.applyFollowView(camera);
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
  lookBy(horizontal, vertical) {
    if (!this.ready || !this.map || this.exploring) return;
    this.viewPitch = clamp((this.viewPitch ?? this.map.getPitch()) - vertical * .25, 0, 85);
    this.setBearing((this.viewBearing || 0) + horizontal * .25);
  }
  bindLookControls(map) {
    const surface = map.getCanvasContainer();
    let pointer;
    const canLook = event => map === this.map && this.ready && ((event.button === 0 && !event.ctrlKey) || (!this.exploring && (event.button === 2 || (event.button === 0 && event.ctrlKey))));
    surface.addEventListener('pointerdown', event => {
      if (!canLook(event)) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.button === 0 && !event.ctrlKey, started: false };
      surface.setPointerCapture(event.pointerId);
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    surface.addEventListener('pointermove', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (pointer.pan && !pointer.started && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 4) return;
      pointer.started = true;
      if (pointer.pan) this.panBy(event.clientX - pointer.x, event.clientY - pointer.y);
      else this.lookBy(event.clientX - pointer.x, event.clientY - pointer.y);
      pointer.x = event.clientX; pointer.y = event.clientY;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) surface.addEventListener(type, event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      pointer = null;
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      event.stopImmediatePropagation();
    }, true);
    surface.addEventListener('mousedown', event => {
      if (canLook(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    surface.addEventListener('contextmenu', event => {
      if (map === this.map && !this.exploring) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
  }
  panBy(x, y) {
    if (!this.ready || !this.map || !Number.isFinite(x) || !Number.isFinite(y) || (!x && !y)) return;
    const surface = this.map.getCanvasContainer(), center = [surface.clientWidth / 2, surface.clientHeight / 2];
    const from = this.map.unproject(center), to = this.map.unproject([center[0] - x, center[1] - y]);
    if (![from.lng, from.lat, to.lng, to.lat].every(Number.isFinite)) return;
    if (!this.exploring) { this.setExplore(true); this.onExplore(); }
    const a = [from.lng, from.lat], b = [to.lng, to.lat], current = this.map.getCenter();
    // Quarter sensitivity, capped at 50 ground metres per pixel even near the horizon.
    const meters = Math.min(distance(a, b) * .25, Math.hypot(x, y) * 50);
    this.map.setCenter(destination([current.lng, current.lat], meters, bearing(a, b)));
  }
  zoomBy(steps) {
    if (!this.ready || !this.map || !Number.isFinite(steps) || this.exploring) return;
    this.viewDistance = clamp((this.viewDistance ?? 1) * Math.pow(2, -steps), .3, 4);
    if (!this.entry && !this.nativeMotion) this.setProgress(this.progress, true, .1);
  }
  bindZoomControls(map) {
    const surface = map.getCanvasContainer();
    const active = () => map === this.map && this.ready && !this.exploring;
    const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    surface.addEventListener('wheel', event => {
      if (!active()) return;
      consume(event);
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1);
      this.zoomBy(clamp(-pixels / 500, -1, 1));
    }, { capture: true, passive: false });
    surface.addEventListener('dblclick', event => {
      if (!active()) return;
      consume(event); this.zoomBy(event.shiftKey ? -.5 : .5);
    }, true);
    map.getContainer().addEventListener('click', event => {
      const button = event.target.closest?.('.mapboxgl-ctrl-zoom-in,.mapboxgl-ctrl-zoom-out');
      if (!button || !active()) return;
      consume(event); this.zoomBy(button.classList.contains('mapboxgl-ctrl-zoom-in') ? .5 : -.5);
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
    const desiredAltitude = Math.max(...samples) + 1700 * distance;
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
