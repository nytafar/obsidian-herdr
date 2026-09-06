// Read-only audit reproductions. Run from the repository root with:
// node docs/reviews/2026-09-06/lifecycle-repros.mjs
// Bundles in memory, substitutes discovery/API/Obsidian, never reaches herdr.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const discoveries = [];
const clients = [];
const result = await build({
  stdin: {
    contents: "export { default as HerdrPlugin } from './src/main'; export { DEFAULT_SETTINGS } from './src/settings'; export { parseTerminalState, stateMatchesPane } from './src/views/terminalView';",
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'audit-fakes', setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'audit' }));
    b.onLoad({ filter: /.*/, namespace: 'audit' }, () => ({ contents: `
      export class Plugin {} export class PluginSettingTab {} export class ItemView {}
      export class Notice {} export class Menu {} export class Setting {} export class App {}
      export class TAbstractFile {} export class TFile {} export class TFolder {}
      export class FileSystemAdapter {} export function addIcon() {} export function setIcon() {}
      export function setTooltip() {}
    ` }));
    b.onLoad({ filter: /\/herdr\/binary\.ts$/ }, () => ({ contents: `
      export function discoverHerdr() { return globalThis.auditDiscover(); }
    ` }));
    b.onLoad({ filter: /\/herdr\/client\.ts$/ }, () => ({ contents: `
      export class HerdrError extends Error {}
      export class HerdrClient {
        disposed = false; handlers = new Map();
        constructor(options) { this.options = options; globalThis.auditClients.push(this); }
        on(event, handler) { this.handlers.set(event, handler); }
        async ping() {} subscribe() {} dispose() { this.disposed = true; }
      }
    ` }));
    b.onLoad({ filter: /\/renderer\/create\.ts$/ }, () => ({ contents: 'export function createRenderer() {}' }));
  }}],
});
const module = { exports: {} };
const context = vm.createContext({
  module, exports: module.exports, require: createRequire(import.meta.url), console,
  process, Buffer, setTimeout, clearTimeout, window: { setTimeout, clearTimeout },
  auditDiscover: () => { const d = deferred(); discoveries.push(d); return d.promise; },
  auditClients: clients,
});
vm.runInContext(result.outputFiles[0].text, context);
const { HerdrPlugin, DEFAULT_SETTINGS, parseTerminalState, stateMatchesPane } = module.exports;
function plugin() {
  const p = new HerdrPlugin();
  p.settings = structuredClone(DEFAULT_SETTINGS);
  p.explorerButtons = { disable() {} };
  p.vaultPath = () => '/audit/vault';
  p.notifier = { onChanged() {}, forget() {}, reset() {} };
  return p;
}
const discovery = { binary: { path: '/audit/herdr' }, socketPath: '/audit/api.sock' };

const unloaded = plugin();
const connecting = unloaded.connect();
unloaded.onunload();
discoveries.shift().resolve(discovery);
await connecting;
assert.ok(unloaded.client, 'Current defect: connect publishes a client after unload');
assert.equal(unloaded.client.disposed, false);
console.log('CONFIRMED: connect finishing after unload installs an undisposed client');
unloaded.onunload();

const overlapping = plugin();
const first = overlapping.connect();
const second = overlapping.reconnect();
await Promise.resolve();
const oldDiscovery = discoveries.shift();
const newDiscovery = discoveries.shift();
newDiscovery.resolve(discovery);
await second;
const newClient = overlapping.client;
oldDiscovery.resolve(discovery);
await first;
assert.notEqual(overlapping.client, newClient);
assert.equal(newClient.disposed, false);
console.log('CONFIRMED: older connect overwrites newer connection and leaves newer client undisposed');
overlapping.onunload();
newClient.dispose();

const priming = plugin();
const oldSnapshot = deferred();
let newSnapshotCalls = 0;
const scope = () => ({ setAgentNames() {}, prime() {} });
priming.client = { snapshot: () => oldSnapshot.promise };
priming.scope = scope();
const oldPrime = priming.primeScope();
priming.client = { snapshot: async () => { newSnapshotCalls++; return { workspaces: [], panes: [] }; } };
priming.scope = scope();
await priming.primeScope();
oldSnapshot.resolve({ workspaces: [], panes: [] });
await oldPrime;
assert.equal(newSnapshotCalls, 0);
console.log('CONFIRMED: shared priming flag skips new connection snapshot without a retry');

const persisted = parseTerminalState({ paneId: 'w1:p1', mode: 'control', profile: 'local' });
assert.equal(persisted.profile, undefined);
assert.equal(stateMatchesPane(persisted, 'w1:p1'), true);
console.log('CONFIRMED: terminal persisted identity drops profile; lookup only compares pane ID');
