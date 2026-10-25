// Geographic context labels for the published Munich–Venice reference track.
// Border positions are snapped to this reconstructed GPX, so the Rißtal point
// is intentionally identified as approximate in the UI.
export const mountainRegions = [
  { id: 'bavarian-prealps', name: 'Bayerische Voralpen', coordinates: [11.4666, 47.6577] },
  { id: 'karwendel', name: 'Karwendel', coordinates: [11.474, 47.414] },
  { id: 'tuxer-alps', name: 'Tuxer Alpen', coordinates: [11.6509, 47.1485] },
  { id: 'zillertal-alps', name: 'Zillertaler Alpen', coordinates: [11.6929, 47.047] },
  { id: 'pfunderer-mountains', name: 'Pfunderer Berge', coordinates: [11.746, 46.875] },
  { id: 'dolomites', name: 'Dolomiten', coordinates: [11.8194, 46.5882], subtitle: 'Puez · Sella' },
  { id: 'schiara-group', name: 'Schiara-Gruppe', coordinates: [12.1242, 46.2861], subtitle: 'Südliche Dolomiten' }
];

export const borderCrossings = [
  {
    id: 'germany-austria',
    from: 'DE',
    to: 'AT',
    place: 'Rißtal',
    coordinates: [11.46155, 47.4911],
    approximate: true
  },
  {
    id: 'austria-italy',
    from: 'AT',
    to: 'IT',
    place: 'Pfitscher Joch · 2.246 m',
    coordinates: [11.65752, 46.99185],
    approximate: false
  }
];
