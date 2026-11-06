/**
 * Timers for the process-side modules (`herdr/client.ts`, `herdr/ssh.ts`,
 * `bridge/terminalSession.ts`), which also run under plain node in the unit
 * tests, where there is no `window` to time on. They are Node's own timers,
 * which the desktop app has as well; nothing here touches the DOM, so popout
 * windows do not come into it.
 *
 * View code keeps using `window.setTimeout` directly: that is what the Obsidian
 * guideline about popout windows asks for.
 */

import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from 'node:timers';

export function setTimer(handler: () => void, ms?: number): ReturnType<typeof nodeSetTimeout> {
	return nodeSetTimeout(handler, ms);
}

export function clearTimer(timer: ReturnType<typeof nodeSetTimeout> | null | undefined): void {
	nodeClearTimeout(timer ?? undefined);
}
