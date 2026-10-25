import { clamp } from './route.js';

export class TourPlayer {
  constructor(stages, onChange = () => {}) {
    this.stages = stages;
    this.onChange = onChange;
    this.state = { mode: 'presentation', stageIndex: 0, progress: 0, status: 'ready', stopId: null, speed: 1, started: false, shownStartStop: false };
    this.savedPresentation = null;
  }
  get stage() { return this.stages[this.state.stageIndex]; }
  get stops() { return [...(this.stage.stops || [])].sort((a, b) => a.progress - b.progress); }
  emit(reason) { this.onChange({ ...this.state }, reason); }
  selectStage(index, { play = false } = {}) {
    this.state.stageIndex = clamp(index, 0, this.stages.length - 1);
    Object.assign(this.state, { progress: 0, status: 'paused', stopId: null, started: true, shownStartStop: false });
    this.emit('stage');
    if (play && this.state.mode === 'presentation') this.play();
  }
  home() {
    this.savedPresentation = null;
    Object.assign(this.state, { mode: 'presentation', stageIndex: 0, progress: 0, status: 'ready', stopId: null, started: false, shownStartStop: false });
    this.emit('home');
  }
  setMode(mode) {
    if (mode === this.state.mode) return;
    if (mode === 'explore') {
      this.savedPresentation = { ...this.state, status: this.state.status === 'playing' ? 'paused' : this.state.status };
      Object.assign(this.state, { mode, status: 'paused', stopId: null, started: true });
    } else {
      Object.assign(this.state, this.savedPresentation || { mode, status: 'paused' }, { mode });
    }
    this.emit('mode');
  }
  play() {
    if (this.state.mode === 'explore') this.setMode('presentation');
    if (this.state.status === 'stage-end') {
      if (this.state.stageIndex < this.stages.length - 1) return this.selectStage(this.state.stageIndex + 1, { play: true });
      return this.selectStage(0, { play: true });
    }
    const initialStop = this.stops.find(s => s.progress === 0);
    if (this.state.progress === 0 && !this.state.shownStartStop && initialStop) return this.openStop(initialStop);
    Object.assign(this.state, { status: 'playing', stopId: null, started: true });
    this.emit('play');
  }
  pause() { if (this.state.status === 'playing') { this.state.status = 'paused'; this.emit('pause'); } }
  toggle() { this.state.status === 'playing' ? this.pause() : this.play(); }
  seek(progress) {
    Object.assign(this.state, { progress: clamp(progress), status: 'paused', stopId: null, started: true });
    if (this.state.progress === 0) this.state.shownStartStop = false;
    this.emit('seek');
  }
  openStop(stop, { manual = false } = {}) {
    Object.assign(this.state, { progress: stop.progress, stopId: stop.id, status: 'stop', started: true });
    if (stop.progress === 0) this.state.shownStartStop = true;
    this.emit(manual ? 'stop-jump' : 'stop');
  }
  closeStop() { if (this.state.status === 'stop') { Object.assign(this.state, { status: 'paused', stopId: null }); this.emit('pause'); } }
  next() {
    const stop = this.stops.find(s => s.progress > this.state.progress + 1e-7);
    if (stop) return this.openStop(stop, { manual: true });
    if (this.state.stageIndex < this.stages.length - 1) return this.selectStage(this.state.stageIndex + 1);
    Object.assign(this.state, { progress: 1, status: 'stage-end', stopId: null }); this.emit('end');
  }
  previous() {
    const stop = this.stops.filter(s => s.progress < this.state.progress - 1e-7).at(-1);
    if (stop) return this.openStop(stop, { manual: true });
    if (this.state.stageIndex > 0) {
      this.selectStage(this.state.stageIndex - 1);
      const last = this.stops.at(-1);
      return last ? this.openStop(last, { manual: true }) : this.seek(1);
    }
    this.seek(0);
  }
  tick(seconds) {
    if (this.state.mode !== 'presentation' || this.state.status !== 'playing' || seconds <= 0) return;
    const next = clamp(this.state.progress + seconds * this.state.speed / this.stage.durationSeconds);
    const stop = this.stops.find(s => s.progress > this.state.progress + 1e-7 && s.progress <= next + 1e-7);
    if (stop) return this.openStop(stop);
    this.state.progress = next;
    if (next >= 1) { this.state.status = 'stage-end'; this.emit('end'); } else this.emit('tick');
  }
}
