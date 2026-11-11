/** Dropdown options in the order of a value list, labelled from its label map. */
export function optionsOf<V extends string>(values: readonly V[], labels: Readonly<Record<V, string>>): Record<string, string> {
	const options: Record<string, string> = {};
	for (const value of values) options[value] = labels[value];
	return options;
}
