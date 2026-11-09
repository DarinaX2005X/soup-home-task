export interface SseEvent {
  id: string | undefined;
  event: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser. An event is only handed out once its
 * terminating blank line has arrived, so a connection cut in the middle of an
 * event leaves nothing half-applied.
 */
export class SseParser {
  private buffer = '';
  private id: string | undefined;
  private event = '';
  private data: string[] = [];

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.data.length > 0 || this.event !== '') {
          events.push({ id: this.id, event: this.event || 'message', data: this.data.join('\n') });
        }
        this.id = undefined;
        this.event = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') this.id = value;
      else if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
    }
    return events;
  }
}
