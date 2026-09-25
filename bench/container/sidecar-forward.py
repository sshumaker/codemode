#!/usr/bin/env python3
"""Dual-homed TCP forwarder: the one component that makes full egress denial work.

The runtime container sits on an `--internal` docker network, which has no NAT
rule and therefore no route anywhere — including to the host. That denies
outbound, and it also kills the tool hop, because on colima `host.docker.internal`
is a macOS-side address reachable only through the default bridge.

This process runs in a container attached to BOTH networks. The runtime reaches
it by container name over the internal network; it reaches the harness's
forwarder over the default bridge. The runtime never gets a route out — the
forwarder is the route, and it goes exactly one place.

Deliberately dumb: it moves bytes and does not read them. Policy belongs in the
thing on the other end (proxy/egress), which already audits and holds the
credentials. See docs/CONTAINER-RUNTIME-DESIGN.md §Network posture.

Usage: sidecar-forward.py --listen-port 9000 --upstream host.docker.internal:PORT
"""
import argparse
import socket
import sys
import threading


def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()


def serve(listen_port, upstream_host, upstream_port):
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", listen_port))
    server.listen(64)
    print(f"sidecar: :{listen_port} -> {upstream_host}:{upstream_port}", flush=True)
    while True:
        client, _ = server.accept()
        try:
            upstream = socket.create_connection((upstream_host, upstream_port), 10)
        except OSError as exc:
            print(f"sidecar: upstream unreachable: {exc}", file=sys.stderr, flush=True)
            client.close()
            continue
        threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pump, args=(upstream, client), daemon=True).start()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen-port", type=int, default=9000)
    parser.add_argument("--upstream", required=True, help="host:port")
    args = parser.parse_args()
    host, _, port = args.upstream.rpartition(":")
    serve(args.listen_port, host, int(port))


if __name__ == "__main__":
    main()
