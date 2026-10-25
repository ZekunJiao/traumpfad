// Stage ends are provisional until the traveler's actual sleeping places are supplied.
export function overnightPlaces(stages, routes) {
  return stages.flatMap((stage, index) => {
    if (stage.isFullRoute) return [];
    const coordinates = routes[index]?.points.at(-1);
    if (!coordinates) return [];
    const confirmed = typeof stage.overnight === 'string' && Boolean(stage.overnight.trim());
    return [{ stageIndex: index, day: stage.day, name: confirmed ? stage.overnight.trim() : stage.end, confirmed, coordinates: coordinates.slice(0, 2) }];
  });
}
