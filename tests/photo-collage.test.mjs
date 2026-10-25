import test from 'node:test';
import assert from 'node:assert/strict';
import { PhotoCollage, decodePhotoNode } from '../app/js/photo-collage.js';
import { TourPlayer } from '../app/js/player.js';

const stop = { id: 'stop', title: 'Fotostopp', progress: .4 };
const photos = Array.from({ length: 7 }, (_, id) => ({ id: String(id) }));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(loadPhoto = async photo => photo.id) {
  const changes = [];
  const collage = new PhotoCollage({ loadPhoto, onChange: state => changes.push(state) });
  return { collage, changes, last: () => changes.at(-1) };
}

test('photos wait for camera arrival and paginate by three without advancing a paused stop', async () => {
  let loads = 0;
  const { collage, last } = fixture(async photo => { loads++; return photo.id; });
  const player = new TourPlayer([{ id: 'stage', durationSeconds: 10, stops: [stop] }]);
  player.openStop(stop); collage.queue(stop, photos);
  player.tick(20);
  assert.equal(loads, 0); assert.equal(last().phase, 'waiting'); assert.equal(player.state.progress, .4);
  await collage.arrive();
  assert.deepEqual(last().entries.map(entry => entry.node), ['0', '1', '2']);
  await collage.move(1); assert.equal(last().offset, 3);
  await collage.move(1); assert.deepEqual(last().entries.map(entry => entry.node), ['6']);
  assert.equal(last().hasNext, false);
  await collage.setPageSize(1); assert.equal(last().offset, 6);
  await collage.move(-1); assert.deepEqual(last().entries.map(entry => entry.node), ['5']);
  assert.equal(player.state.progress, .4);
});
test('a replaced stop aborts old loads and cannot display stale pictures', async () => {
  const old = deferred(); let oldSignal;
  const { collage, changes, last } = fixture((photo, { signal }) => {
    if (photo.id === 'old') { oldSignal = signal; return old.promise; }
    return Promise.resolve(photo.id);
  });
  collage.queue(stop, [{ id: 'old' }]); const loading = collage.arrive();
  collage.queue({ ...stop, id: 'new' }, [{ id: 'new' }]); await collage.arrive();
  old.resolve('old'); await loading;
  assert.equal(oldSignal.aborted, true);
  assert.equal(last().stop.id, 'new');
  assert.deepEqual(changes.filter(state => state.phase === 'visible').map(state => state.entries[0].node), ['new']);
});
test('hiding while decoding prevents late pictures, and a new stop starts at its first group', async () => {
  const pending = deferred();
  const { collage, last } = fixture(() => pending.promise);
  collage.queue(stop, photos); const loading = collage.arrive(); collage.hide();
  pending.resolve('late'); await loading;
  assert.equal(last().phase, 'hidden'); assert.equal(collage.active, false);
  collage.queue(stop, photos); assert.equal(collage.offset, 0);
});
test('quick page changes keep the most recently requested group', async () => {
  const slow = deferred();
  const { collage, last } = fixture(photo => photo.id === '0' ? slow.promise : Promise.resolve(photo.id));
  collage.queue(stop, photos); const old = collage.arrive();
  await collage.move(1); slow.resolve('old'); await old;
  assert.equal(last().offset, 3); assert.deepEqual(last().entries.map(entry => entry.node), ['3', '4', '5']);
});
test('image errors leave a stop dismissible instead of throwing into the player', async () => {
  const { collage, last } = fixture(async () => { throw new Error('missing image'); });
  collage.queue(stop, photos.slice(0, 1)); await collage.arrive();
  assert.equal(last().phase, 'error'); collage.hide(); assert.equal(collage.active, false);
});
test('an image is not revealed before decode, and cancellation remains effective during decode', async () => {
  const decoding = deferred();
  class TestImage extends EventTarget {
    tagName = 'IMG'; complete = true; naturalWidth = 200; removed = false;
    decode() { return decoding.promise; }
    removeAttribute() { this.removed = true; }
  }
  const image = new TestImage(), controller = new AbortController();
  const result = decodePhotoNode(image, { signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  controller.abort(); await rejected; decoding.resolve();
  assert.equal(image.removed, true);
  const ready = new TestImage(); assert.equal(await decodePhotoNode(ready), ready);
});

test('manual stop navigation announces a camera jump while automatic arrivals do not', () => {
  const events = [];
  const stage = { id: 'day', stops: [{ id: 'a', progress: .2 }, { id: 'b', progress: .6 }] };
  const player = new TourPlayer([stage], (_state, reason) => events.push(reason));
  player.next();
  assert.equal(events.at(-1), 'stop-jump');
  player.openStop(stage.stops[1]);
  assert.equal(events.at(-1), 'stop');
});
