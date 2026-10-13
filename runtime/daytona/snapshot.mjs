/**
 * The prebuilt snapshot: node, zeromq, uv, ripgrep/fd, the kernel Python venv with
 * the bundled skills already installed, and the kernel-server bundle — so a new
 * conversation's first cell pays for a kernel boot, not a venv build.
 *
 *   node runtime/daytona/snapshot.mjs            build (or report) the snapshot for
 *                                                the current bundle version
 *   node runtime/daytona/snapshot.mjs --list     list harness-assistant-kernel-* snapshots
 *
 * Name: harness-assistant-kernel-<bundle version>. It is a persistent resource in the
 * Daytona organisation; provider.mjs falls back to uploading the runtime into a stock
 * sandbox when it is missing.
 */
import { Daytona, Image } from "@daytonaio/sdk";
import { buildKernelServerBundle, ZEROMQ_VERSION } from "./bundle.mjs";

export const SNAPSHOT_PREFIX = "harness-assistant-kernel-";
/** Where the runtime lives in the image; the fallback path uses the same layout under $HOME. */
export const IMAGE_RUNTIME_ROOT = "/opt/harness";

/**
 * Bump when kernelImage() changes: the bundle version alone does not see the image recipe,
 * so without this an org keeps reusing a snapshot built from the old recipe.
 */
export const IMAGE_REVISION = "r2";

export function snapshotName(version) {
	return `${SNAPSHOT_PREFIX}${version}-${IMAGE_REVISION}`;
}

/** Env shared by the image build, the prebake, and the running server. */
export function runtimeEnv(root) {
	return {
		PATH: `${root}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
		UV_PYTHON_INSTALL_DIR: `${root}/uv-python`,
		UV_CACHE_DIR: `${root}/uv-cache`,
		PRIME_AGENT_KERNEL_VENV: `${root}/kernel-venv`,
		KERNEL_SERVER_STATE_DIR: `${root}/state`,
	};
}

export function kernelImage(bundleDir, root = IMAGE_RUNTIME_ROOT) {
	return Image.base("node:22-bookworm-slim")
		.runCommands(
			"apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ripgrep fd-find tar gzip procps " +
				"&& ln -sf /usr/bin/fdfind /usr/local/bin/fd && rm -rf /var/lib/apt/lists/*",
			`mkdir -p ${root}/bin && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=${root}/bin UV_NO_MODIFY_PATH=1 sh`,
		)
		.env(runtimeEnv(root))
		.addLocalDir(bundleDir, `${root}/kpkg`)
		.runCommands(
			`cd ${root}/kpkg && npm install --omit=dev --no-audit --no-fund --no-package-lock zeromq@${ZEROMQ_VERSION}`,
			`cd ${root}/kpkg && PRIME_AGENT_INSTALL_UV=1 node dist/kernel-server.mjs --prebake`,
			`chmod -R a+rwX ${root}`,
			// Run as `daytona`, as Daytona's stock images do: the kernel backend predicts the
			// sandbox's work dir as /home/daytona/work before the sandbox exists
			// (runtime/kernel/daytona.mjs), and the provider derives it from the user's home.
			// Built as root, home was /root and the two disagreed.
			"id -u daytona >/dev/null 2>&1 || useradd --create-home --uid 1001 --shell /bin/bash daytona",
		)
		.dockerfileCommands(["USER daytona"])
		.workdir("/home/daytona");
}

async function findSnapshot(daytona, name) {
	try {
		return await daytona.snapshot.get(name);
	} catch {
		return undefined;
	}
}

export async function listKernelSnapshots(daytona) {
	const out = [];
	for (let page = 1; ; page++) {
		const res = await daytona.snapshot.list(page, 100);
		out.push(...res.items.filter((s) => s.name.startsWith(SNAPSHOT_PREFIX)));
		if (page >= (res.totalPages ?? 1)) break;
	}
	return out;
}

/** Build the snapshot for the current bundle unless it already exists. */
export async function ensureSnapshot({ daytona = new Daytona(), onLogs = (l) => process.stdout.write(`${l}\n`) } = {}) {
	const { dir, version } = await buildKernelServerBundle();
	const name = snapshotName(version);
	const existing = await findSnapshot(daytona, name);
	if (existing) return { name, version, state: existing.state, built: false };
	const t0 = Date.now();
	const snap = await daytona.snapshot.create(
		{ name, image: kernelImage(dir), resources: { cpu: 1, memory: 2, disk: 5 } },
		{ onLogs, timeout: 0 },
	);
	return { name, version, state: snap.state, built: true, buildSeconds: Math.round((Date.now() - t0) / 1000) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const daytona = new Daytona();
	if (process.argv.includes("--list")) {
		for (const s of await listKernelSnapshots(daytona)) console.log(s.name, s.state, s.createdAt);
	} else {
		console.log(JSON.stringify(await ensureSnapshot({ daytona })));
	}
}
