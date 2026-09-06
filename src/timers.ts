/**
 * Timers taken from `globalThis`, bound.
 *
 * The process-side modules (`herdr/client.ts`, `herdr/ssh.ts`,
 * `bridge/terminalSession.ts`) also run under plain node in the unit tests,
 * where there is no `window` to time on. Bound because a DOM `setTimeout` called
 * detached from its global throws "Illegal invocation".
 *
 * View code keeps using `window.setTimeout` directly: that is what the Obsidian
 * guideline about popout windows asks for.
 */

export const setTimer = globalThis.setTimeout.bind(globalThis);
export const clearTimer = globalThis.clearTimeout.bind(globalThis);
