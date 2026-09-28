def _harness_rlm_refusal() -> str | None:
    """Why `rlm.run` may not start a child here, or None when the harness opted in.

    harness: prime's recursive call is not this harness's subagent path. Its child
    runs prime's default model rather than the parent's, its activity is invisible to
    the host, and it has no budget. `spawn()` is the
    one real path; HARNESS_RLM=1 restores rlm.run for benchmark reproducibility.
    """
    import os

    if os.environ.get("HARNESS_RLM") == "1":
        return None
    if os.environ.get("HARNESS_SUBAGENTS") == "1":
        return (
            "rlm.run is disabled in this harness. To delegate a self-contained subtask, "
            "use spawn(prompt, name=...) instead: it is already in your namespace, and "
            "help(spawn) shows how to collect the child's result."
        )
    return "rlm.run is disabled in this harness, and this session has no subagents. Do the work here, in this kernel."


async def run(prompt: str, **kwargs: Any) -> RLMSpawnHandle:
    """Not available unless the harness enables it."""
    refusal = _harness_rlm_refusal()
    if refusal:
        raise RuntimeError(refusal)
