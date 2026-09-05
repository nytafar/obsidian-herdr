/**
 * Runtime stub for the `obsidian` module (vitest only).
 *
 * `obsidian` ships types but no runtime entry point, so importing a plugin file
 * that pulls in `ItemView` or `setIcon` explodes under node. Tests only exercise
 * the pure helpers next to those classes, so the stub just has to be loadable:
 * it is aliased in `vitest.config.ts` and never used by the bundle.
 *
 * Type checking still happens against the real `obsidian.d.ts`, because `tsc`
 * does not see this alias.
 */

export class Component {
	load(): void {}
	unload(): void {}
}

export class View extends Component {}

export class ItemView extends View {
	constructor(public leaf: unknown) {
		super();
	}
}

export class Modal {
	constructor(public app: unknown) {}
}

export class Notice {
	constructor(public message: string) {}
}

export class Plugin extends Component {}

export class PluginSettingTab {}

export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class FileSystemAdapter {}
export class Menu {}
export class Setting {}

export function setIcon(): void {}
export function setTooltip(): void {}
