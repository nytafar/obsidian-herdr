/**
 * The herdr kind's status lines for the settings tab (issue #185): tunnel,
 * binary, socket, server, mismatches, workspace and errors, worded here and
 * nowhere else. The herdr adapter fills {@link HerdrStatus} from its own
 * connection (`runtime/herdrKind.ts`); pure, so `tests/herdrStatus.test.ts`
 * asserts the text line by line.
 *
 * The settings tab also shows this layout for a runtime of another kind
 * before its first connection (`connectionDetails` in `settings.ts`), as it
 * always has: those kinds only word a live connection.
 */

import type { DiscoveryResult } from './binary';
import type { ProtocolMismatch } from './client';
import { issueSentence, type RuntimeConfig } from '../runtimes';
import type { StatusLine } from '../runtime/kind';

/** What herdr's status lines describe. */
export interface HerdrStatus {
	runtime: Readonly<RuntimeConfig>;
	/** Binary and socket discovery, or null before the first connect attempt. */
	discovery: DiscoveryResult | null;
	/** Socket the client actually uses; the tunnel's local end over SSH. */
	socketPath: string;
	/** SSH forward state, or null when no tunnel was started. */
	tunnel: { text: string; connected: boolean } | null;
	mismatch: ProtocolMismatch | null;
	/** Scoped workspace, or null when none matches this vault. */
	workspace: { id: string; label: string | null; method: string; agentCount: number } | null;
	/** Last connect or prime failure. */
	error: string | null;
}

export function herdrStatusLines(status: HerdrStatus): Required<StatusLine>[] {
	const lines: Required<StatusLine>[] = [];
	const line = (text: string, warning = false): void => {
		lines.push({ text, warning });
	};
	const { discovery, runtime } = status;
	if (!discovery) {
		line(status.error ? issueSentence(status.error) : 'Not connected yet.', status.error !== null);
		return lines;
	}
	const remote = runtime.target === 'ssh';
	if (status.tunnel) {
		line(status.tunnel.text, !status.tunnel.connected);
	} else if (remote) {
		line('SSH tunnel: not started.', true);
	}
	if (discovery.binary) {
		line(`Binary: ${discovery.binary.path} (${discovery.binary.source})`);
	} else {
		// An SSH runtime only needs `ssh` locally, so this is not fatal there.
		line(discovery.error ?? 'Herdr binary not found.', !remote);
		if (!remote) return lines;
	}
	if (remote) {
		const remoteBinary = runtime.binary.trim();
		line(
			remoteBinary
				? `Remote terminals: ssh -T ${runtime.host} ${remoteBinary}`
				: `Remote terminals: ssh -T ${runtime.host}, herdr searched for on the remote host`,
		);
	}
	line(`Socket: ${status.socketPath}`);
	// `discovery.status` describes the *local* server. Over SSH that is the
	// wrong machine, so the tunnel line above stands in for it.
	if (!remote) {
		const server = discovery.status;
		line(
			server
				? `Server: ${server.status}, version ${server.version ?? 'unknown'}, protocol ${server.protocol ?? 'unknown'}`
				: `Server: not reachable (${discovery.error ?? 'unknown error'})`,
			!server,
		);
	}
	if (status.mismatch) {
		line(
			`Protocol mismatch: herdr speaks ${status.mismatch.server}, this plugin was built against ${status.mismatch.expected}. Everything still works unless a method is missing.`,
			true,
		);
	}
	// The binary runs every terminal session, so an old one beside a newer
	// server is worth saying out loud (issue #87). Over SSH the local server is
	// the wrong machine to compare against, as above.
	const binaryProtocol = discovery.identity?.protocol ?? null;
	const serverProtocol = discovery.status?.protocol ?? null;
	const binaryProtocolDiffers =
		binaryProtocol !== null && serverProtocol !== null && binaryProtocol !== serverProtocol;
	if (!remote && binaryProtocolDiffers) {
		line(
			`Binary protocol mismatch: ${discovery.binary?.path ?? 'the herdr binary'} speaks protocol ${binaryProtocol} (version ${discovery.identity?.version ?? 'unknown'}), the server speaks ${serverProtocol}. Terminal sessions run through this binary; point the binary path at the server's herdr.`,
			true,
		);
	}
	if (status.workspace) {
		const { id, label, method, agentCount } = status.workspace;
		line(`Workspace: ${label ?? id} (${id}, matched by ${method}), ${agentCount} agent panes`);
	} else {
		line('Workspace: no herdr workspace matches this vault yet.', true);
	}
	if (status.error) line(status.error, true);
	return lines;
}
