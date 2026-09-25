"""Stand up kernel-server in a Daytona sandbox, run drive.mjs against it three ways, delete the sandbox."""
import asyncio, io, json, os, secrets, subprocess, tarfile, time
from daytona import CreateSandboxFromSnapshotParams, SessionExecuteRequest
from dt_common import client, LABELS

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = "/home/daytona"
R = {}


def pkg_tar() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name in ("package.json", "dist"):
            tf.add(os.path.join(HERE, "pkg", name), arcname=f"kpkg/{name}")
    return buf.getvalue()


async def ex(sb, cmd, timeout=600):
    t = time.perf_counter()
    r = await sb.process.exec(cmd, timeout=timeout)
    return r.exit_code, r.result.strip()[-1500:], round(time.perf_counter() - t, 2)


async def start_server(sb, app_token):
    await sb.process.create_session("ks")
    env = f"HARNESS_KERNEL_SANDBOX=off PRIME_AGENT_INSTALL_UV=1 KERNEL_SERVER_TOKEN={app_token} KERNEL_SERVER_CWD={HOME}/work PATH={HOME}/.local/bin:$PATH"
    await sb.process.execute_session_command("ks", SessionExecuteRequest(
        command=f"mkdir -p {HOME}/work && cd {HOME} && {env} node kpkg/dist/kernel-server.mjs > {HOME}/ks.log 2>&1", run_async=True))
    for _ in range(40):
        code, out, _ = await ex(sb, f"grep -c listening {HOME}/ks.log 2>/dev/null || true")
        if out.strip() == "1":
            return
        await asyncio.sleep(0.5)
    raise RuntimeError("server did not start: " + (await ex(sb, f"cat {HOME}/ks.log"))[1])


def drive(link, app_token, tag):
    env = {**{k: v for k, v in os.environ.items() if not k.startswith("DAYTONA_")},
           "RK_URL": link.url.replace("https://", "wss://"), "RK_PREVIEW_TOKEN": link.token,
           "RK_APP_TOKEN": app_token, "RK_REMOTE_CWD": f"{HOME}/work"}
    t = time.perf_counter()
    p = subprocess.run(["node", os.path.join(HERE, "drive.mjs")], env=env, capture_output=True, text=True, timeout=1200)
    print(f"--- drive [{tag}] {time.perf_counter() - t:.1f}s\n{p.stdout[-4000:]}\n{p.stderr[-2000:]}", flush=True)
    res = json.load(open(os.path.join(HERE, "drive_results.json")))
    R[f"drive_{tag}"] = res
    os.replace(os.path.join(HERE, "drive_results.json"), os.path.join(HERE, f"drive_results_{tag}.json"))


async def main():
    d = client()
    sb = None
    app_token = secrets.token_urlsafe(24)
    try:
        t = time.perf_counter()
        sb = await d.create(CreateSandboxFromSnapshotParams(labels=dict(LABELS), auto_stop_interval=30, auto_delete_interval=60), timeout=180)
        R["create_s"] = round(time.perf_counter() - t, 2)
        print("sandbox", sb.id, R["create_s"], flush=True)
        t = time.perf_counter()
        await sb.fs.upload_file(pkg_tar(), f"{HOME}/kpkg.tgz")
        R["upload_s"] = round(time.perf_counter() - t, 2)
        R["extract"] = await ex(sb, f"cd {HOME} && tar xzf kpkg.tgz && du -sh kpkg")
        R["npm_zeromq"] = await ex(sb, f"cd {HOME} && npm install --no-save --no-audit --no-fund zeromq@6.5.0 2>&1 | tail -3 && node -e \"import('zeromq').then(z=>console.log('zeromq ok', typeof z.Dealer))\"")
        R["uv"] = await ex(sb, "pip install -q --user uv 2>&1 | tail -1; ~/.local/bin/uv --version")
        print(json.dumps({k: R[k] for k in ("upload_s", "extract", "npm_zeromq", "uv")}), flush=True)
        await start_server(sb, app_token)
        link = await sb.get_preview_link(8765)

        drive(link, app_token, "cold")  # includes kernel venv bootstrap (uv + ipykernel + runtime + skill)

        await sb.update_network_settings(network_block_all=True)
        R["egress_after_lock"] = (await ex(sb, "curl -s -o /dev/null -m 5 -w '%{http_code}' https://pypi.org || echo BLOCKED"))[1]
        drive(link, app_token, "warm_egress_blocked")

        t = time.perf_counter(); await sb.stop(); R["stop_s"] = round(time.perf_counter() - t, 2)
        t = time.perf_counter(); await sb.start(); R["start_s"] = round(time.perf_counter() - t, 2)
        t = time.perf_counter(); await start_server(sb, app_token); R["server_restart_s"] = round(time.perf_counter() - t, 2)
        link = await sb.get_preview_link(8765)
        drive(link, app_token, "after_stop_start")
        R["server_log_tail"] = (await ex(sb, f"tail -20 {HOME}/ks.log"))[1]
        R["sandbox_resources"] = {"cpu": sb.cpu, "memory_gb": sb.memory, "disk_gb": sb.disk}
    finally:
        if sb is not None:
            await d.delete(sb)
            print("deleted", sb.id, flush=True)
        await d.close()
        json.dump(R, open(os.path.join(HERE, "remote_results.json"), "w"), indent=1)

if __name__ == "__main__":
    asyncio.run(main())
