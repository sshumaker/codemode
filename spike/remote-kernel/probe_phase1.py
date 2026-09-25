"""Phase 1 Daytona capability probe. Every sandbox created is deleted in finally."""
import asyncio, json, statistics, time, sys
import websockets
from daytona import CreateSandboxFromSnapshotParams, SessionExecuteRequest
from dt_common import client, LABELS

created = []
R = {}


def params(**kw):
    return CreateSandboxFromSnapshotParams(labels=dict(LABELS), auto_stop_interval=15,
                                           auto_delete_interval=30, **kw)


async def timed(coro):
    t = time.perf_counter(); r = await coro; return r, time.perf_counter() - t


async def create(d, **kw):
    sb, dt = await timed(d.create(params(**kw), timeout=180))
    created.append(sb)
    return sb, dt


async def ex(sb, cmd, timeout=60):
    r = await sb.process.exec(cmd, timeout=timeout)
    return r.exit_code, r.result.strip()


WS_SERVER = r'''
import asyncio, websockets
async def h(ws):
    async for m in ws:
        await ws.send(m)
async def main():
    async with websockets.serve(h, "0.0.0.0", 8765, max_size=None):
        await asyncio.Future()
asyncio.run(main())
'''


async def ws_rtt(url, headers, n=30, payload="x"):
    t0 = time.perf_counter()
    async with websockets.connect(url, additional_headers=headers, max_size=None, open_timeout=30) as ws:
        connect = time.perf_counter() - t0
        rtts = []
        for _ in range(n):
            t = time.perf_counter(); await ws.send(payload); await ws.recv(); rtts.append(time.perf_counter() - t)
    return connect, rtts


def ms(xs):
    xs = sorted(xs)
    return {"p50_ms": round(statistics.median(xs) * 1000, 1), "p90_ms": round(xs[int(len(xs) * .9) - 1] * 1000, 1),
            "min_ms": round(xs[0] * 1000, 1), "n": len(xs)}


async def main():
    d = client()
    try:
        # Q1: create latency (3 samples, default snapshot, minimal size)
        sb, dt = await create(d)
        R["create_s"] = [round(dt, 2)]
        for _ in range(2):
            s2, dt2 = await create(d)
            R["create_s"].append(round(dt2, 2))
            await d.delete(s2); created.remove(s2)
        print("create", R["create_s"], flush=True)
        R["image"] = {k: (await ex(sb, c))[1] for k, c in {
            "os": "cat /etc/os-release | head -1", "python": "python3 --version", "node": "node --version || echo none",
            "uname": "uname -m", "nproc": "nproc", "mem": "free -m | sed -n 2p", "whoami": "whoami; pwd",
            "pkgs": "python3 -c 'import zmq,ipykernel;print(zmq.__version__, ipykernel.__version__)' 2>&1 | tail -1"}.items()}
        print(json.dumps(R["image"], indent=1), flush=True)

        # Q5: exec latency
        lat = []
        for _ in range(15):
            _, t = await timed(sb.process.exec("true")); lat.append(t)
        R["exec_true"] = ms(lat)
        print("exec", R["exec_true"], flush=True)

        # Q2: port reachability over WebSocket via preview URL
        print(await ex(sb, "pip install -q websockets 2>&1 | tail -2; python3 -c 'import websockets;print(websockets.__version__)'", 180), flush=True)
        await sb.fs.upload_file(WS_SERVER.encode(), "/tmp/ws_echo.py")
        await sb.process.create_session("ws")
        await sb.process.execute_session_command("ws", SessionExecuteRequest(command="python3 /tmp/ws_echo.py", run_async=True))
        await asyncio.sleep(2)
        link = await sb.get_preview_link(8765)
        url = link.url.replace("https://", "wss://").replace("http://", "ws://")
        R["preview_url_shape"] = link.url.replace(sb.id, "<id>")
        try:
            await ws_rtt(url, {}, n=1)
            R["ws_no_token"] = "CONNECTED (no auth!)"
        except Exception as e:
            R["ws_no_token"] = f"rejected: {type(e).__name__}: {str(e)[:120]}"
        c, rtts = await ws_rtt(url, {"x-daytona-preview-token": link.token}, n=40)
        R["ws_connect_s"] = round(c, 3); R["ws_rtt_small"] = ms(rtts)
        c, rtts = await ws_rtt(url, {"x-daytona-preview-token": link.token}, n=10, payload="y" * 1_000_000)
        R["ws_rtt_1MB_echo"] = ms(rtts)
        signed = await sb.create_signed_preview_url(8765, expires_in_seconds=300)
        surl = signed.url.replace("https://", "wss://")
        try:
            c, rtts = await ws_rtt(surl, {}, n=10); R["ws_signed_url"] = {"connect_s": round(c, 3), **ms(rtts)}
        except Exception as e:
            R["ws_signed_url"] = f"failed: {type(e).__name__}: {str(e)[:160]}"
        print(json.dumps({k: R[k] for k in R if k.startswith("ws") or k.startswith("preview")}, indent=1), flush=True)
        # idle-connection survival: hold 70s then echo
        async with websockets.connect(url, additional_headers={"x-daytona-preview-token": link.token}) as ws:
            await asyncio.sleep(70); await ws.send("alive?"); R["ws_after_70s_idle"] = await ws.recv()
        print("idle", R["ws_after_70s_idle"], flush=True)

        # Q4: stop -> start persistence
        await ex(sb, "echo persisted-$RANDOM > /home/daytona/marker.txt; cat /home/daytona/marker.txt; echo tmp > /tmp/tmpmarker")
        before = (await ex(sb, "cat /home/daytona/marker.txt"))[1]
        _, R["stop_s"] = await timed(sb.stop())
        starts = []
        _, t = await timed(sb.start()); starts.append(round(t, 2))
        after = (await ex(sb, "cat /home/daytona/marker.txt"))[1]
        R["persist_home"] = before == after; R["persist_tmp"] = (await ex(sb, "cat /tmp/tmpmarker 2>&1"))[1]
        R["ws_server_after_restart"] = (await ex(sb, "pgrep -f ws_echo.py || echo not-running"))[1]
        for _ in range(2):
            await sb.stop(); _, t = await timed(sb.start()); starts.append(round(t, 2))
        R["start_from_stopped_s"] = starts; R["stop_s"] = round(R["stop_s"], 2)
        print(json.dumps({k: R[k] for k in ("stop_s", "start_from_stopped_s", "persist_home", "persist_tmp", "ws_server_after_restart")}), flush=True)

        # Q3: egress restriction
        CURL = "curl -s -o /dev/null -m 8 -w '%{http_code}' https://{h} || echo FAIL"
        async def egress(box):
            return {h: (await ex(box, CURL.replace("{h}", h)))[1] for h in ("pypi.org", "example.com", "api.anthropic.com")}
        R["egress_default"] = await egress(sb)
        for label, kw in (("domain_allow_pypi", {"domain_allow_list": "pypi.org"}), ("block_all", {"network_block_all": True})):
            try:
                box, t = await create(d, **kw)
                R[f"egress_{label}"] = await egress(box)
                # inbound preview still works when egress is restricted?
                await box.process.create_session("h")
                await box.process.execute_session_command("h", SessionExecuteRequest(command="cd /tmp && python3 -m http.server 8080", run_async=True))
                await asyncio.sleep(2)
                lk = await box.get_preview_link(8080)
                import urllib.request
                req = urllib.request.Request(lk.url, headers={"x-daytona-preview-token": lk.token})
                R[f"inbound_{label}"] = urllib.request.urlopen(req, timeout=20).status
            except Exception as e:
                R[f"egress_{label}"] = f"error {type(e).__name__}: {str(e)[:200]}"
            print(label, R.get(f"egress_{label}"), R.get(f"inbound_{label}"), flush=True)
        try:
            await sb.update_network_settings(domain_allow_list="pypi.org")
            R["egress_after_update_domain"] = await egress(sb)
        except Exception as e:
            R["egress_after_update_domain"] = f"error {type(e).__name__}: {str(e)[:200]}"
        print("update", R["egress_after_update_domain"], flush=True)
    finally:
        for s in created:
            try:
                await d.delete(s); print("deleted", s.id)
            except Exception as e:
                print("DELETE FAILED", s.id, e)
        await d.close()
        json.dump(R, open("phase1_results.json", "w"), indent=1)
        print(json.dumps(R, indent=1))

asyncio.run(main())
