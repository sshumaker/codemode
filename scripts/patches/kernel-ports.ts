/**
 * Harness: the kernel's ZMQ ports from HARNESS_KERNEL_PORT_RANGE ("lo-hi"), when set, so
 * a sandbox that allows loopback only on ports it can name (a kernel on the user's own
 * computer, where other local services listen) can name them. Five per kernel, handed out
 * in turn and wrapping round the range; a port something else holds fails that kernel's
 * start, and the next start takes the next five. Unset: 0, and ipykernel picks, as upstream.
 */
let harnessKernelPortCursor = 0;
function harnessKernelPorts(): Pick<ConnectionInfo, "shell_port" | "iopub_port" | "stdin_port" | "control_port" | "hb_port"> {
	const range = /^(\d+)-(\d+)$/.exec(process.env.HARNESS_KERNEL_PORT_RANGE ?? "");
	const lo = range ? Number(range[1]) : 0;
	const size = range ? Number(range[2]) - lo + 1 : 0;
	if (!range || size < 5) return { shell_port: 0, iopub_port: 0, stdin_port: 0, control_port: 0, hb_port: 0 };
	const at = (i: number) => lo + ((harnessKernelPortCursor + i) % size);
	const ports = { shell_port: at(0), iopub_port: at(1), stdin_port: at(2), control_port: at(3), hb_port: at(4) };
	harnessKernelPortCursor = (harnessKernelPortCursor + 5) % size;
	return ports;
}

/**
 * With pinned ports the connection file has its ports before ipykernel has bound them,
 * so "the ports resolved" no longer means "the kernel is up". Connecting then raced the
 * kernel's startup and lost its first replies: measured, about one start in three hung
 * for good with the ports pinned, none with them unpinned. So wait until each is listening.
 */
async function harnessKernelPortsBound(info: ConnectionInfo): Promise<boolean> {
	if (!process.env.HARNESS_KERNEL_PORT_RANGE) return true;
	const { connect } = await import("node:net");
	const up = (port: number) =>
		new Promise<boolean>((resolve) => {
			const s = connect({ host: info.ip, port });
			const done = (ok: boolean) => {
				s.destroy();
				resolve(ok);
			};
			s.once("connect", () => done(true));
			s.once("error", () => done(false));
			s.setTimeout(500, () => done(false));
		});
	const ports = [info.shell_port, info.iopub_port, info.stdin_port, info.control_port, info.hb_port];
	return (await Promise.all(ports.map(up))).every(Boolean);
}
