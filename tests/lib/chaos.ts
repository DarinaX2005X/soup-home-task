import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface ChaosStats {
  requests: number;
  /** Requests destroyed before they reached the server. */
  droppedRequests: number;
  /** Requests the server handled whose answer was then thrown away. */
  droppedResponses: number;
  delayed: number;
  /** Open event streams severed between two chunks. */
  streamCuts: number;
  /** Open event streams severed in the middle of a chunk. */
  streamCutsMidChunk: number;
  refusedWhileDown: number;
}

export interface Faults {
  /** Applies only to requests this returns true for. */
  match: (method: string, url: string) => boolean;
  dropRequest: number;
  dropResponse: number;
  maxDelayMs: number;
}

/**
 * A reverse proxy that misbehaves on purpose. It stands in for the unreliable
 * network between a client and the system: it loses requests, loses answers
 * to requests that did go through, delays, and cuts live streams.
 */
export class ChaosProxy {
  readonly stats: ChaosStats = {
    requests: 0,
    droppedRequests: 0,
    droppedResponses: 0,
    delayed: 0,
    streamCuts: 0,
    streamCutsMidChunk: 0,
    refusedWhileDown: 0,
  };
  /** While true every connection is destroyed on arrival, as if the network were gone. */
  down = false;
  faults: Faults | null = null;
  private cutNextChunk = false;
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly streams = new Set<http.ServerResponse>();
  private readonly target: URL;
  private readonly random: () => number;

  constructor(target: string, random: () => number = Math.random) {
    this.target = new URL(target);
    this.random = random;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      if (this.down) socket.destroy();
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  get openStreams(): number {
    return this.streams.size;
  }

  /** Severs every open event stream at a chunk boundary. */
  cutStreams(): number {
    const cut = this.streams.size;
    for (const res of [...this.streams]) res.socket?.destroy();
    this.stats.streamCuts += cut;
    return cut;
  }

  /** The next stream chunk is forwarded only in part, then the connection dies. */
  cutNextStreamChunkInHalf(): void {
    this.cutNextChunk = true;
  }

  /** Takes the network away: open connections die and new ones are refused. */
  goDown(): void {
    this.down = true;
    this.stats.streamCuts += this.streams.size;
    for (const socket of this.sockets) socket.destroy();
  }

  comeBack(): void {
    this.down = false;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.down) {
      this.stats.refusedWhileDown++;
      req.socket.destroy();
      return;
    }
    this.stats.requests++;
    const faulty = this.faults?.match(req.method ?? 'GET', req.url ?? '') ? this.faults : null;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (faulty && this.random() < faulty.dropRequest) {
        this.stats.droppedRequests++;
        req.socket.destroy();
        return;
      }
      const upstream = http.request(
        {
          host: this.target.hostname,
          port: this.target.port || 80,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: this.target.host },
        },
        (answer) => this.relay(answer, res, faulty),
      );
      upstream.on('error', () => res.socket?.destroy());
      res.on('close', () => upstream.destroy());
      upstream.end(Buffer.concat(chunks));
    });
  }

  private relay(answer: http.IncomingMessage, res: http.ServerResponse, faulty: Faults | null): void {
    const isStream = String(answer.headers['content-type'] ?? '').includes('text/event-stream');
    if (isStream) {
      this.streams.add(res);
      res.on('close', () => this.streams.delete(res));
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      res.flushHeaders();
      answer.on('data', (chunk: Buffer) => {
        if (this.cutNextChunk && chunk.length > 8) {
          this.cutNextChunk = false;
          this.stats.streamCutsMidChunk++;
          res.write(chunk.subarray(0, Math.floor(chunk.length / 2)), () => res.socket?.destroy());
          return;
        }
        res.write(chunk);
      });
      answer.on('end', () => res.end());
      return;
    }
    const body: Buffer[] = [];
    answer.on('data', (chunk: Buffer) => body.push(chunk));
    answer.on('end', () => {
      // The server has fully handled the request by now. Losing the answer
      // here is the case a retrying client has to survive.
      if (faulty && this.random() < faulty.dropResponse) {
        this.stats.droppedResponses++;
        res.socket?.destroy();
        return;
      }
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        res.end(Buffer.concat(body));
      };
      const delay = faulty ? Math.floor(this.random() * faulty.maxDelayMs) : 0;
      if (delay > 0) {
        this.stats.delayed++;
        setTimeout(send, delay);
      } else send();
    });
  }
}
