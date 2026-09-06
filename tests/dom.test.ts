/**
 * Cross-window-safe DOM guards (issue #61). A pop-out window has its own
 * `Element`/`HTMLElement` constructors, so a fake element from a different
 * "window" stands in for one here rather than a real `WorkspaceWindow`.
 */

import { describe, expect, it } from 'vitest';
import { asElement, isHTMLElement } from '../src/views/dom';

describe('asElement', () => {
	it('returns the target when it looks like an Element', () => {
		const target = { closest: () => null } as unknown as EventTarget;
		expect(asElement(target)).toBe(target);
	});

	it('rejects null and non-element targets', () => {
		expect(asElement(null)).toBeNull();
		expect(asElement({} as EventTarget)).toBeNull();
	});
});

describe('isHTMLElement', () => {
	function fakeHTMLElementFrom(view: { HTMLElement: new () => object }): object {
		const el = new view.HTMLElement() as { ownerDocument?: unknown };
		el.ownerDocument = { defaultView: view };
		return el;
	}

	it('accepts an element built against the current window realm', () => {
		class ThisHTMLElement {}
		const thisWindow = { HTMLElement: ThisHTMLElement };
		const el = fakeHTMLElementFrom(thisWindow);
		expect(isHTMLElement(el)).toBe(true);
	});

	it('accepts an element built against another window realm', () => {
		class OtherHTMLElement {}
		const otherWindow = { HTMLElement: OtherHTMLElement };
		const el = fakeHTMLElementFrom(otherWindow);
		expect(isHTMLElement(el)).toBe(true);
	});

	it('rejects values with no owner document / defaultView', () => {
		expect(isHTMLElement(null)).toBe(false);
		expect(isHTMLElement({})).toBe(false);
		expect(isHTMLElement({ ownerDocument: {} })).toBe(false);
	});

	it('rejects an object that is not actually an HTMLElement in its own realm', () => {
		class OtherHTMLElement {}
		const otherWindow = { HTMLElement: OtherHTMLElement };
		const notAnElement = { ownerDocument: { defaultView: otherWindow } };
		expect(isHTMLElement(notAnElement)).toBe(false);
	});
});
