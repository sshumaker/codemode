"""Correction-on-the-real-error: the fs-guard's steering, moved onto the OS's
own denial. Loads as an IPython startup file (IPYTHONDIR profile startup/) in
the sandboxed kernel.

The sandbox (srt) already enforces the boundary exactly; what it cannot do is
teach. A bare `PermissionError: Operation not permitted` reads as a broken
machine, and the measured response (2026-09-01 invalid blocks) is flailing:
env scans, machinery probes, raw HTTP. This hook appends the correction the
old regex guard carried — in the error channel, where corrections are adopted
on the next cell (L1) — attached to a TRUE denial instead of a text match.
"""

CORRECTION = (
    "\n[harness] This path is outside the job's world, and the denial is the "
    "sandbox working, not a malfunction. This machine is not part of the job. "
    "Your tools are Python packages under ./api (see api/INDEX.md). "
    "Deliver the outcome with the tools you have."
)


def _chain_custom_exc(ip, exc_types, handler):
    """Register `handler` for `exc_types` WITHOUT unregistering earlier hooks.

    IPython's set_custom_exc REPLACES: `self.custom_exceptions = exc_tuple`
    (verified in 9.16.1). Startup hooks that each called it directly left only
    the last one installed -- eperm_correction was silently gone whenever a
    later hook loaded. Dispatch on type, falling through to whatever was there.
    """
    prev_types = tuple(ip.custom_exceptions or ())
    prev = ip.CustomTB

    def _dispatch(shell, etype, value, tb, tb_offset=None):
        if issubclass(etype, exc_types):
            return handler(shell, etype, value, tb, tb_offset=tb_offset)
        if prev is not None and issubclass(etype, prev_types):
            return prev(etype, value, tb, tb_offset=tb_offset)
        shell.showtraceback((etype, value, tb), tb_offset=tb_offset)
        return []

    ip.set_custom_exc(prev_types + tuple(exc_types), _dispatch)


def _install():
    ip = get_ipython()  # noqa: F821 - defined in IPython startup context
    if ip is None:
        return

    def _handler(shell, etype, value, tb, tb_offset=None):
        shell.showtraceback((etype, value, tb), tb_offset=tb_offset)
        try:
            import errno
            if getattr(value, "errno", None) in (errno.EPERM, errno.EACCES):
                print(CORRECTION)
        except Exception:
            pass
        return []

    _chain_custom_exc(ip, (PermissionError,), _handler)


_install()
del _install, _chain_custom_exc
