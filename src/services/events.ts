// In-process events: the web page's live updates and the bridge listen here.
import { EventEmitter } from 'node:events';
import type { Message } from '../store/schema.ts';

const bus = new EventEmitter();
bus.setMaxListeners(0);

export const events = {
  /** Something in this pair changed (message, action, board, feed): the pair room refreshes. */
  pairChanged(pairId: number) {
    bus.emit('pair', pairId);
  },
  onPairChanged(listener: (pairId: number) => void) {
    bus.on('pair', listener);
    return () => bus.off('pair', listener);
  },
  /** A message became visible to its recipient (stored, or approved). The bridge decides whether to push it. */
  messageVisible(message: Message) {
    bus.emit('message', message);
  },
  onMessageVisible(listener: (message: Message) => void) {
    bus.on('message', listener);
    return () => bus.off('message', listener);
  },
  /** A pair was requested; the bridge pushes it to the teammate's sessions. */
  pairRequested(pairId: number) {
    bus.emit('request', pairId);
  },
  onPairRequested(listener: (pairId: number) => void) {
    bus.on('request', listener);
    return () => bus.off('request', listener);
  },
};
