// Stage ends are provisional until the traveler's actual sleeping places are supplied.
export function overnightPlaces(stages, route) {
  if (!route?.points || !route?.cumulative || !(route.length > 0)) return [];
  return stages.flatMap(stage => {
    if (stage.isFullRoute || stage.isPointStage) return [];
    const index = stage.routeProvenance?.endPointIndex;
    if (!Number.isInteger(index) || index < 0 || index >= route.points.length) return [];
    const confirmed = typeof stage.overnight === 'string' && Boolean(stage.overnight.trim());
    return [{
      stageId: stage.id,
      day: stage.day,
      name: confirmed ? stage.overnight.trim() : stage.end,
      confirmed,
      progress: route.cumulative[index] / route.length,
      coordinates: route.points[index].slice(0, 2)
    }];
  });
}
