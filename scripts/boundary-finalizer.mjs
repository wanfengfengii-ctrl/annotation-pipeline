// Switch only between complete operations. Live exports keep their original
// module and task ownership; unrelated project work need not become idle.
export class BoundaryFinalizer {
  constructor({ load, create, adopted = () => {} }) {
    Object.assign(this, { load, create, adopted });
    this.queue = null;
    this.revision = null;
    this.empty = new Map();
  }
  get active() {
    return this.queue?.active || this.empty;
  }
  async adopt() {
    if (this.active.size) return false;
    const selected = await this.load();
    const revision = selected.commit || selected.root;
    if (this.queue && this.revision === revision) return false;
    const candidate = this.create(selected);
    // Construction must succeed before detaching the previous service.
    if (!candidate?.active || typeof candidate.enqueue !== 'function')
      throw Error('归档模块接口不兼容，保留原版本');
    const previous = this.queue;
    if (previous) candidate.completed = new Map(previous.completed);
    this.queue = candidate;
    this.revision = revision;
    this.selected = selected;
    previous?.runtime.detach();
    this.adopted(selected);
    return true;
  }
  enqueue(tasks, busy) {
    this.queue?.enqueue(tasks, busy);
  }
  detach() {
    this.queue?.runtime.detach();
  }
}
