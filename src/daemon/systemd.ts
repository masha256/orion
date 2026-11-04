import { spawn as nodeSpawn } from 'node:child_process';

/**
 * systemd's notify protocol (unit `Type=notify`, `NotifyAccess=all`, `WatchdogSec=120`): READY once start-up checks
 * pass, WATCHDOG every 30 s, STOPPING on SIGTERM. Node cannot send on a Unix datagram socket, so each message runs
 * `systemd-notify --pid=<this process>`. Outside systemd (`NOTIFY_SOCKET` unset: dev, tests) every call is a no-op.
 */
export interface SystemdNotifier {
  ready(): void;
  watchdog(): void;
  stopping(): void;
}

export type Spawn = (cmd: string, args: string[]) => void;

/** Runs the command detached from this process's stdio; a failure to start it (no systemd-notify) is ignored. */
export const realSpawn: Spawn = (cmd, args) => {
  const child = nodeSpawn(cmd, args, { stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
};

export function systemdNotifier(spawn: Spawn, env: Record<string, string | undefined> = process.env): SystemdNotifier {
  const send = (message: string): void => {
    if (!env.NOTIFY_SOCKET) return;
    spawn('systemd-notify', [`--pid=${process.pid}`, message]);
  };
  return {
    ready: () => send('READY=1'),
    watchdog: () => send('WATCHDOG=1'),
    stopping: () => send('STOPPING=1'),
  };
}
