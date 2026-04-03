import { WebSocketServer, WebSocket } from 'ws';
import { Database } from 'bun:sqlite';
import * as http from 'http';
import * as net from 'net';

export interface WsServerHandle {
  wss: WebSocketServer;
  shutdown(): Promise<void>;
}

export function startWsServer(port: number, db: Database): Promise<WsServerHandle> {
  return new Promise((resolve, reject) => {
    // Create an HTTP server explicitly so we can track and destroy its sockets
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    const connections = new Set<WebSocket>();
    const sockets = new Set<net.Socket>();
    let shutdownStarted = false;

    // Track all raw TCP sockets so we can destroy them on shutdown
    httpServer.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });

    httpServer.on('error', reject);
    wss.on('error', reject);

    httpServer.listen(port, () => {
      wss.on('connection', (ws: WebSocket) => {
        connections.add(ws);

        let authed = false;
        let messageHandled = false;

        const authTimer = setTimeout(() => {
          if (!authed) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'AUTH_TIMEOUT', message: 'no auth frame received within 5 seconds' }));
            } catch (_) { /* ignore */ }
            ws.close(1008, 'auth timeout');
          }
        }, 5000);

        ws.on('message', (data) => {
          if (messageHandled) return;
          messageHandled = true;
          clearTimeout(authTimer);

          let parsed: unknown;
          try {
            parsed = JSON.parse(data.toString());
          } catch (_) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED', message: 'first frame must be auth' }));
            } catch (_) { /* ignore */ }
            ws.close(1008, 'auth required');
            return;
          }

          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            (parsed as Record<string, unknown>).type !== 'auth'
          ) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED', message: 'first frame must be auth' }));
            } catch (_) { /* ignore */ }
            ws.close(1008, 'auth required');
            return;
          }

          authed = true;
          try {
            ws.send(JSON.stringify({ type: 'error', code: 'NOT_IMPLEMENTED', message: 'agent registration not implemented until sprint 4' }));
          } catch (_) { /* ignore */ }
          ws.close(1011, 'not implemented');
        });

        ws.on('close', () => {
          clearTimeout(authTimer);
          connections.delete(ws);
        });
      });

      const handle: WsServerHandle = {
        wss,
        shutdown(): Promise<void> {
          if (shutdownStarted) {
            return Promise.resolve();
          }
          shutdownStarted = true;

          return new Promise((res) => {
            // Send close code 1001 to all connected WebSocket clients
            for (const ws of connections) {
              try {
                ws.close(1001, 'Going Away');
              } catch (_) { /* ignore */ }
            }

            // After 5-second window: force-terminate any remaining
            const forceTimeout = setTimeout(() => {
              for (const ws of connections) {
                try { ws.terminate(); } catch (_) { /* ignore */ }
              }
              for (const sock of sockets) {
                try { sock.destroy(); } catch (_) { /* ignore */ }
              }
            }, 5000);

            // Stop accepting new connections, then destroy all underlying TCP sockets
            // so httpServer.close() resolves promptly
            wss.close(() => {
              // wss (http server) closed
            });

            // Give 100ms for close frames to flush, then destroy TCP sockets
            // so the HTTP server can close
            setTimeout(() => {
              clearTimeout(forceTimeout);
              for (const ws of connections) {
                try { ws.terminate(); } catch (_) { /* ignore */ }
              }
              for (const sock of sockets) {
                try { sock.destroy(); } catch (_) { /* ignore */ }
              }
              httpServer.close(() => res());
              // Safety: resolve even if httpServer.close hangs
              setTimeout(res, 500);
            }, 100);
          });
        },
      };

      resolve(handle);
    });
  });
}
