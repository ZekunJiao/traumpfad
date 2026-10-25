import { clamp } from './route.js';

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
  stages.forEach((stage, stageIndex) => {
    if (stage.isFullRoute) return;
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
      const localProgress = clamp(stop.progress);
      const progress = (startDistance + length * localProgress) / fullRoute.length;
      markers.push({
        kind: 'photo', id: stop.id, progress, day: stage.day,
        title: stop.title || `Fotopunkt · Tag ${stage.day}`,
        description: stop.caption || '',
        stageTitle: stage.title,
        stop
      });
    }
  });

  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  return { fullRouteIndex, routeLength: fullRoute.length, segments, markers: groupMarkers(markers, fullRoute.length) };
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
    const min = Math.min(...positions), max = Math.max(...positions);
    const needsChoice = max - min > 1 / timeline.routeLength;
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
