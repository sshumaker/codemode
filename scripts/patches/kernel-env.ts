// Sandbox boundary (docs/CLOUD-HARNESS-DESIGN.md): the brain holds the real
// credentials; the kernel must not. Two postures, checked in this order:
//
//   HARNESS_KERNEL_ENV_ALLOW  allow-list. The kernel's environment is BUILT,
//                             not inherited: only names matching this list
//                             survive from the loop's environment, and a
//                             trailing `*` matches by prefix ("HARNESS_*").
//                             Fails CLOSED — a credential that appears in the
//                             loop's environment tomorrow is absent from the
//                             kernel without anyone editing a list.
//   HARNESS_KERNEL_ENV_SCRUB  deny-list: names to delete. Fails OPEN, which is
//                             why it is no longer the posture the eval runs
//                             under; kept because container runners stage the
//                             whole brain inside the sandbox and name exactly
//                             the variables they withhold.
//
// Neither set: inherit, byte-identical to upstream, so every benchmark that
// passes neither is untouched.
//
// `overrides` is KernelOptions.env — the loop's own per-kernel configuration,
// not inherited environment — so it is applied AFTER filtering and always wins.
function kernelSpawnEnv(base: NodeJS.ProcessEnv, overrides?: Record<string, string>): NodeJS.ProcessEnv {
	const parse = (v: string | undefined) =>
		(v ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	const allow = parse(process.env.HARNESS_KERNEL_ENV_ALLOW);
	let env: NodeJS.ProcessEnv;
	if (allow.length > 0) {
		const permitted = (name: string) =>
			allow.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
		env = {};
		for (const [name, value] of Object.entries(base)) {
			if (value !== undefined && permitted(name)) env[name] = value;
		}
	} else {
		const scrub = parse(process.env.HARNESS_KERNEL_ENV_SCRUB);
		// Copy before deleting, or a scrub run would mutate the loop's own env.
		env = scrub.length > 0 ? { ...base } : base;
		for (const name of scrub) delete env[name];
	}
	return overrides ? { ...env, ...overrides } : env;
}
