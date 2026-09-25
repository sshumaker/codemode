"""Stretch: one real prime print-mode turn whose ipython tool runs in a Daytona sandbox."""
import asyncio, json, os, secrets, subprocess, time
from daytona import CreateSandboxFromSnapshotParams
from dt_common import client, LABELS
from run_remote import HOME, HERE, ex, pkg_tar, start_server

CLI = os.path.join(HERE, "../../vendor/prime-agent/packages/coding-agent/dist/cli.js")
ENV_FILE = os.path.expanduser("~/src/goals/web/.env.local")
PROMPT = ("Use the ipython tool for every step. 1) Report the output of `import platform, socket; print(platform.node(), socket.gethostname())`. "
          "2) Compute the sum of squares of 1..100 and store it in a variable named total. "
          "3) In a separate tool call, draw a 96x96 PNG with PIL that is solid blue with a yellow square in the middle, "
          "save it to /tmp/probe.png, and load it into your context with attach_image. "
          "4) Tell me the value of total and describe the colors you can see in the image.")


async def main():
    d = client(); sb = None; R = {}
    app_token = secrets.token_urlsafe(24)
    try:
        sb = await d.create(CreateSandboxFromSnapshotParams(labels=dict(LABELS), auto_stop_interval=30, auto_delete_interval=60), timeout=180)
        print("sandbox", sb.id, flush=True)
        await sb.fs.upload_file(pkg_tar(), f"{HOME}/kpkg.tgz")
        print(await ex(sb, f"cd {HOME} && tar xzf kpkg.tgz && npm install --no-save --no-audit --no-fund zeromq@6.5.0 >/dev/null 2>&1 && pip install -q --user uv 2>/dev/null; echo setup-ok"))
        await start_server(sb, app_token)
        link = await sb.get_preview_link(8765)
        env = {k: v for k, v in os.environ.items() if not k.startswith("DAYTONA_")}
        env.update({"HARNESS_REMOTE_KERNEL_URL": link.url.replace("https://", "wss://"),
                    "HARNESS_REMOTE_KERNEL_PREVIEW_TOKEN": link.token, "HARNESS_REMOTE_KERNEL_TOKEN": app_token,
                    "HARNESS_REMOTE_KERNEL_CWD": f"{HOME}/work", "HARNESS_KERNEL_SANDBOX": "off"})
        run_dir = "/tmp/rk-prime-turn"; os.makedirs(run_dir, exist_ok=True)
        args = [CLI, "-p", "--mode", "json", "--model", "anthropic/claude-haiku-4-5", "--tools", "ipython",
                "--cwd", run_dir, "--no-context-files", "--no-prompt-templates", "--no-extensions", PROMPT]
        t = time.perf_counter()
        p = subprocess.run(["bash", "-c", 'set -a; . "$1"; set +a; shift; exec node "$@"', "_", ENV_FILE, *args],
                           env=env, cwd=run_dir, capture_output=True, text=True, timeout=600)
        R["wall_s"] = round(time.perf_counter() - t, 1); R["exit"] = p.returncode
        open(os.path.join(HERE, "prime_turn.jsonl"), "w").write(p.stdout)
        R["stderr_tail"] = p.stderr[-1500:]
        R["sandbox_kernel_procs"] = (await ex(sb, "ps -eo pid,args | grep -c '[i]pykernel' ; tail -5 ~/ks.log"))[1]
    finally:
        if sb is not None:
            await d.delete(sb); print("deleted", sb.id, flush=True)
        await d.close()
        print(json.dumps(R, indent=1))

asyncio.run(main())
