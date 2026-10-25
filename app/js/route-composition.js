import { distance } from './route.js';

function samePlace(a, b) {
  return distance(a, b) < 0.05;
}

/** Join ordered day lines and return their inclusive point bounds on one route. */
export function composeRouteCoordinates(dayRoutes) {
  const coordinates = [];
  const stageRanges = [];
  const connectors = [];

  for (const { stage, coordinates: points } of dayRoutes) {
    if (!Array.isArray(points) || points.length < 2) throw new Error(`${stage.title}: Die Tagesroute braucht mindestens zwei Koordinaten.`);
    const start = coordinates.length && samePlace(coordinates.at(-1), points[0])
      ? coordinates.length - 1
      : coordinates.length;
    if (coordinates.length && start === coordinates.length) {
      connectors.push({ from: coordinates.length - 1, to: coordinates.length, distanceMeters: distance(coordinates.at(-1), points[0]) });
    }
    coordinates.push(...points.slice(start === coordinates.length ? 0 : 1));
    const end = coordinates.length - 1;
    stageRanges.push({ stageId: stage.id, startPointIndex: start, endPointIndex: end });
  }

  return { coordinates, stageRanges, connectors };
}
