import { clamp, nearestProgress } from './route.js';

function groupMarkers(markers, routeLength) {
  const tolerance = 1 / routeLength;
  const groups = [];
  for (const marker of markers.sort((a, b) => a.progress - b.progress || (a.kind === b.kind ? 0 : a.kind === 'day' ? -1 : 1))) {
    const group = groups.at(-1);
    if (group && marker.progress - group.progress <= tolerance) {
      group.items.push(marker);
    } else {
      groups.push({ progress: marker.progress, items: [marker] });
    }
  }
  return groups;
}

/** Derives full-route chapters and photo markers from the stage data. */
export function buildJourneyTimeline(stages, routes) {
  const fullRouteIndex = stages.findIndex(stage => stage.isFullRoute);
  const fullRoute = routes[fullRouteIndex];
  if (fullRouteIndex < 0 || !fullRoute) return { fullRouteIndex, routeLength: 0, segments: [], markers: [] };

  const segments = [], markers = [];
  const addPhotoMarker = (stage, stop, progress) => markers.push({
    kind: 'photo', id: stop.id, progress, day: stage.day ?? null,
    title: stop.title || `Fotopunkt · Tag ${stage.day}`,
    description: stop.caption || '',
    stageTitle: stage.title,
    stop
  });
  stages.forEach(stage => {
    if (stage.isFullRoute) {
      for (const stop of stage.stops || []) addPhotoMarker(stage, stop, stopRouteProgress(stop, stage, null, fullRoute));
      return;
    }
    if (stage.isPointStage) return;
    const { startPointIndex, endPointIndex } = stage.routeProvenance || {};
    if (!Number.isInteger(startPointIndex) || !Number.isInteger(endPointIndex)
      || startPointIndex < 0 || endPointIndex <= startPointIndex || endPointIndex >= fullRoute.points.length) return;

    const startDistance = fullRoute.cumulative[startPointIndex];
    const endDistance = fullRoute.cumulative[endPointIndex];
    const length = endDistance - startDistance;
    if (!(length > 0)) return;
    const start = startDistance / fullRoute.length;
    const end = endDistance / fullRoute.length;
    const overnight = typeof stage.overnight === 'string' && stage.overnight.trim();
    const segment = {
      id: stage.id,
      day: stage.day,
      start,
      end,
      title: stage.title,
      description: stage.description || '',
      startPlace: stage.start || '',
      endPlace: stage.end || '',
      sleepPlace: overnight || stage.end || '',
      confirmedSleepPlace: Boolean(overnight),
      stage
    };
    segments.push(segment);
    markers.push({ kind: 'day', id: stage.id, progress: end, segment });

    for (const stop of stage.stops || []) {
      const progress = stopRouteProgress(stop, stage, { segments }, fullRoute);
      addPhotoMarker(stage, stop, progress);
    }
  });

  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  return { fullRouteIndex, routeLength: fullRoute.length, segments, markers: groupMarkers(markers, fullRoute.length) };
}

/** Copies local photo-stop positions onto the single route used by playback and map markers. */
export function stopRouteProgress(stop, stage, timeline, fullRoute) {
  if (Array.isArray(stop.coordinates) && fullRoute) return nearestProgress(fullRoute, stop.coordinates);
  const segment = stage.isFullRoute ? null : timeline?.segments?.find(item => item.id === stage.id);
  const localProgress = clamp(stop.progress);
  return segment ? segment.start + (segment.end - segment.start) * localProgress : localProgress;
}

export function projectPlaybackStops(stages, timeline, fullRoute) {
  const segments = timeline?.segments || [];
  return stages.filter(stage => !stage.isPointStage).flatMap(stage => (stage.stops || []).map(stop => {
    const progress = stopRouteProgress(stop, stage, timeline, fullRoute);
    const segment = timelineSegmentAt(segments, progress)
      || segments.find(item => item.start >= progress)
      || segments.at(-1);
    return {
      ...stop,
      stageId: stage.id,
      day: segment?.day ?? stage.day ?? null,
      stageTitle: segment?.title ?? stage.title,
      progress
    };
  })).sort((a, b) => a.progress - b.progress);
}

export function timelineSegmentAt(segments, progress) {
  const value = clamp(progress);
  const last = segments.at(-1);
  return segments.find(segment => value >= segment.start && value < segment.end)
    || (value === 1 && Math.abs((last?.end ?? 0) - 1) < 1e-12 ? last : null)
    || null;
}

/** Combines marks whose hit targets would overlap at the current bar width. */
export function visibleTimelineMarkerGroups(timeline, width, minSpacing = 24) {
  const makeGroup = group => {
    const positions = group.items.map(item => item.progress).filter(Number.isFinite);
    if (!positions.length) return { ...group, needsChoice: false, key: group.items.map(item => `${item.kind}:${item.id}`).join('|') };
    const needsChoice = group.items.length > 1;
    return {
      ...group,
      needsChoice,
      progress: needsChoice ? positions.reduce((sum, value) => sum + value, 0) / positions.length : positions[0],
      key: group.items.map(item => `${item.kind}:${item.id}`).join('|')
    };
  };
  if (!width) return timeline.markers.map(group => makeGroup({ ...group, items: [...group.items] }));

  const groups = [];
  for (const source of timeline.markers) {
    const group = groups.at(-1);
    if (group && (source.progress - group.firstProgress) * width < minSpacing) group.items.push(...source.items);
    else groups.push({ firstProgress: source.progress, items: [...source.items] });
  }
  return groups.map(makeGroup);
}
