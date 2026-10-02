import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { SESSION_COOKIE, verifySession } from "../session";
import { log } from "../telemetry/log";
import type { UserRepository } from "../store/userRepository";
import type { DeviceRepository } from "../store/deviceRepository";
import type { ControlHub } from "../control/hub";
import type { DevicePolicy } from '../editions/policy';
import {SessionGrace} from '../editions/sessionGrace';

export interface ControlUpgradeDeps {
  policy?:DevicePolicy;
  now?: () => number;
  userRepo: UserRepository;
  deviceRepo: DeviceRepository;
  /** The same HMAC key that signs the dashboard session cookie. */
  sessionSecret: string;
  hub: ControlHub;
}

const CONTROL_PATH = /^\/api\/devices\/([^/]+)\/control$/;

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/**
 * Refuses an upgrade with a real HTTP response rather than destroying the
 * socket. A bare destroy gives the browser no status at all, which makes "you
 * are not an admin" indistinguishable from "the farm is down" - and the
 * dashboard has to tell those apart to say anything useful.
 */
function refuse(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * The live-view socket: admin-only, authenticated from the session cookie
 * BEFORE the WebSocket exists. A same-origin handshake sends the httpOnly
 * cookie automatically, so no token ever reaches page JavaScript.
 */
export function createControlUpgrade(deps: ControlUpgradeDeps) {
  const wss = new WebSocketServer({ noServer: true });

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
      const match = CONTROL_PATH.exec((req.url ?? "").split("?")[0]);
      if (!match) {
        refuse(socket, 404, "Not Found");
        return;
      }
      const deviceId = decodeURIComponent(match[1]);

      const userId = verifySession(
        readCookie(req.headers.cookie, SESSION_COOKIE),
        deps.sessionSecret,
        Date.now(),
        (id) => deps.userRepo.sessionVersion(id)
      );
      const user = userId === undefined ? undefined : deps.userRepo.getById(userId);
      if (!user || user.deactivatedAt !== null) {
        refuse(socket, 401, "Unauthorized");
        return;
      }
      if (!user.isAdmin) {
        refuse(socket, 403, "Forbidden");
        return;
      }
      // Deliberately after authentication: answering 404 to an anonymous
      // caller would let them probe which device ids exist.
      if (!deps.deviceRepo.get(deviceId)) {
        refuse(socket, 404, "Not Found");
        return;
      }
      if (deps.policy && !deps.policy.canUse(deviceId)) {refuse(socket,409,'Pro Required');return;}

      wss.handleUpgrade(req, socket, head, (ws) => {
        const grace=new SessionGrace(deps.now);
        const checkPolicy=():boolean=>{
          const state=grace.check(!deps.policy || deps.policy.canUse(deviceId));
          if(state==='warn') {
            if(ws.readyState===ws.OPEN) ws.send(JSON.stringify({type:'edition-warning',message:'Device access ends in five minutes. Renew Pro or select a Community device.'}));
          }
          if(state==='close') {ws.terminate();return false;}
          return true;
        };
        const policyTimer=setInterval(checkPolicy,1000);policyTimer.unref();
        ws.on('close',()=>clearInterval(policyTimer));
        log.info("control socket opened", { deviceId, userId: user.id });

        // A socket with no 'error' listener throws on the EventEmitter instead
        // of emitting, which takes the whole process down. This fires for
        // something as ordinary as a frame written while the viewer's tab is
        // closing, so it is a routine event, not an exceptional one: log it
        // and let the 'close' handler do the cleanup.
        ws.on("error", (err) => {
          log.error("control socket error", { deviceId, err: String(err) });
        });
        const viewer = {
          userId: user.id,
          username: user.username,
          send: (data: string | Buffer) => ws.send(data),
          close: () => ws.close(),
          on: (_event: "close", cb: () => void) => ws.on("close", cb),
          onMessage: (cb: (text: string) => void) =>
            ws.on("message", (data, isBinary) => {
              // Control messages are JSON text. Binary from a browser is never
              // valid input and is ignored rather than parsed.
              if (!isBinary && checkPolicy()) cb(data.toString());
            }),
        };

        // Spec D-4: the socket is the heartbeat. A pong proves the connection
        // is alive even when the admin is only watching; a half-open socket
        // stops ponging and the 30s lease TTL releases the device.
        const ping = setInterval(() => {
          if (ws.readyState === ws.OPEN) ws.ping();
        }, 10_000);
        ping.unref();
        ws.on("pong", () => deps.hub.heartbeat(deviceId, user.id, Date.now()));
        ws.on("close", () => clearInterval(ping));

        deps.hub.attach(deviceId, viewer);
      });
    },

    close(): void {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
