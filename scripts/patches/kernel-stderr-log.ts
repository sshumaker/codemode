			// HARNESS_KERNEL_STDERR_LOG: also persist kernel stderr. Upstream keeps
			// it in memory and shows it only when the kernel dies, so a warning on
			// a HEALTHY kernel is discarded — IPython's "IPYTHONDIR is not a
			// writable location, using a temp directory" went unseen for two days
			// (2026-09-03..05) while every startup hook was dead in both arms.
			// Touched at spawn so an absent file means "bundle lacks this patch",
			// not "the kernel was quiet"; appended, never buffered, so the lines
			// survive a SIGKILL of this process.
			const stderrLog = process.env.HARNESS_KERNEL_STDERR_LOG;
			if (stderrLog) {
				try {
					appendFileSync(stderrLog, "");
				} catch {
					// a full disk must not take the kernel down with it
				}
			}
			kernel.stderr?.on("data", (buf: Buffer) => {
				const s = buf.toString();
				this.kernelStderr += s;
				if (stderrLog) {
					try {
						appendFileSync(stderrLog, s);
					} catch {
						// see above
					}
				}
			});
