'use strict';

/** A small synchronous publish/subscribe bus used by the UI widgets. */
class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  /** Subscribes; returns a function that unsubscribes. */
  on(event, listener) {
    if (!this.listeners.has(event)) { this.listeners.set(event, []); }
    this.listeners.get(event).push(listener);
    return () => this.off(event, listener);
  }

  off(event, listener) {
    const list = this.listeners.get(event);
    if (!list) { return; }
    const i = list.indexOf(listener);
    if (i >= 0) { list.splice(i, 1); }
  }

  /** Calls every listener of the event in subscription order; returns how many were called. */
  emit(event, ...args) {
    const list = [...(this.listeners.get(event) ?? [])];
    for (const l of list) { l(...args); }
    return list.length;
  }
}

module.exports = { EventBus };
