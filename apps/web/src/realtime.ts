import { io, type Socket } from 'socket.io-client';

/**
 * One Socket.IO connection per signed-in browser tab. The server checks the
 * session cookie; if the socket is down the app keeps working through normal
 * requests and periodic refreshes.
 */
let socket: Socket | null = null;

export function connectRealtime(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'], withCredentials: true, reconnectionDelayMax: 10_000 });
  }
  return socket;
}

export function disconnectRealtime(): void {
  socket?.close();
  socket = null;
}

export function getSocket(): Socket | null {
  return socket;
}
