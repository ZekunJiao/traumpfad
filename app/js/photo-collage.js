export class PhotoCollage {
  constructor({ loadPhoto, onChange, pageSize = 3 }) {
    Object.assign(this, { loadPhoto, onChange, pageSize });
    this.phase = 'hidden'; this.stop = null; this.photos = []; this.offset = 0; this.generation = 0;
  }
  get active() { return this.stop !== null; }
  get hasNext() { return this.offset + this.pageSize < this.photos.length; }
  snapshot(entries = []) {
    return { phase: this.phase, stop: this.stop, entries, offset: this.offset, total: this.photos.length, pageSize: this.pageSize, hasPrevious: this.offset > 0, hasNext: this.hasNext };
  }
  cancelLoad() { this.generation++; this.abortController?.abort(); }
  queue(stop, photos) {
    this.cancelLoad(); this.stop = stop; this.photos = [...photos]; this.offset = 0; this.phase = 'waiting';
    this.onChange(this.snapshot());
  }
  arrive() { if (this.phase === 'waiting') return this.loadPage(); }
  async loadPage() {
    this.cancelLoad();
    const generation = this.generation, controller = new AbortController();
    this.abortController = controller; this.phase = 'loading';
    this.onChange(this.snapshot());
    try {
      const entries = await Promise.all(this.photos.slice(this.offset, this.offset + this.pageSize).map(async photo => ({ photo, node: await this.loadPhoto(photo, { signal: controller.signal }) })));
      if (generation !== this.generation || !this.active) return;
      this.phase = 'visible'; this.onChange(this.snapshot(entries));
    } catch {
      if (generation !== this.generation || !this.active) return;
      this.phase = 'error'; this.onChange(this.snapshot());
    }
  }
  move(direction) {
    if (!this.active) return;
    const last = Math.max(0, Math.floor((this.photos.length - 1) / this.pageSize) * this.pageSize);
    const offset = Math.max(0, Math.min(last, this.offset + direction * this.pageSize));
    if (offset === this.offset) return;
    this.offset = offset;
    if (this.phase !== 'waiting') return this.loadPage();
  }
  setPageSize(size) {
    if (size === this.pageSize) return;
    this.pageSize = size; this.offset = Math.floor(this.offset / size) * size;
    if (this.active && this.phase !== 'waiting') return this.loadPage();
  }
  hide() {
    if (!this.active) return;
    this.cancelLoad(); this.phase = 'hidden'; this.stop = null; this.photos = []; this.offset = 0;
    this.onChange(this.snapshot());
  }
}

export function decodePhotoNode(node, { signal, timeoutMs = 12000 } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('Bildaufbau abgebrochen', 'AbortError'));
  if (node.tagName !== 'IMG') return Promise.resolve(node);
  return new Promise((resolve, reject) => {
    let finished = false, decoding = false;
    const cleanup = () => { clearTimeout(timer); node.removeEventListener('load', loaded); node.removeEventListener('error', failed); signal?.removeEventListener('abort', aborted); };
    const finish = error => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve(node); };
    const failed = () => finish(new Error('Bild konnte nicht geladen werden'));
    const aborted = () => { node.removeAttribute('src'); finish(new DOMException('Bildaufbau abgebrochen', 'AbortError')); };
    const loaded = async () => {
      if (decoding || finished) return;
      decoding = true;
      try { await node.decode(); if (!finished) finish(); } catch { failed(); }
    };
    const timer = setTimeout(() => { node.removeAttribute('src'); finish(new Error('Bildladezeit überschritten')); }, timeoutMs);
    node.addEventListener('load', loaded); node.addEventListener('error', failed); signal?.addEventListener('abort', aborted, { once: true });
    if (node.complete) node.naturalWidth ? loaded() : failed();
  });
}
