#!/usr/bin/env node
/**
 * The plugin's half of a pty, as a process the reaping test can SIGKILL
 * (ADR-0007's D2): spawns the argv in PTY_ARGV (JSON) the way
 * `defaultPtySpawn` does — four pipes, fd 3 never written, its own process
 * group — prints the watchdog's pid, and waits for ever.
 */
import { spawn } from 'node:child_process';

const [command, ...args] = JSON.parse(process.env.PTY_ARGV ?? '[]');
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true });
process.stdout.write(`${child.pid}\n`);
setInterval(() => undefined, 60_000);
