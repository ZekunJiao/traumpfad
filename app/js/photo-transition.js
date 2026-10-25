export class PhotoTransition {
  constructor() { this.animations = new Set(); this.version = 0; }
  cancel() { this.version++; for (const animation of this.animations) animation.cancel(); this.animations.clear(); }
  async move(node, from, to, { reverse = false, reduced = false } = {}) {
    if (reduced) return true;
    const version = this.version;
    const small = { opacity: .65, transform: `translate(${from.left + from.width / 2 - to.left - to.width / 2}px, ${from.top + from.height / 2 - to.top - to.height / 2}px) scale(${Math.min(from.width / Math.max(1, to.width), from.height / Math.max(1, to.height))})` };
    const large = { opacity: 1, transform: 'translate(0,0) scale(1)' };
    const animation = node.animate(reverse ? [large, small] : [small, large], { duration: reverse ? 650 : 4800, easing: 'cubic-bezier(.22,.7,.2,1)', fill: reverse ? 'forwards' : 'none' });
    this.animations.add(animation);
    try { await animation.finished; return version === this.version; }
    catch { return false; }
    finally { this.animations.delete(animation); }
  }
}
