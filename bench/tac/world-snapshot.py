"""
Dump the service state the graders are about to inspect.

Run inside the task container after the agent finishes and before eval.py, so a
disputed verdict can be re-examined later. Scoped to the task's own
dependencies.yml, because a full dump of four services per run is neither cheap
nor useful.

Why: only /workspace was being copied out. Every rule-based checkpoint reads the
*services* — chat history, GitLab issues, ownCloud files — and the next task's
reset.sh destroys all of it. So a contested rule-based verdict was exactly as
unreproducible as the LLM one, for the same reason. One disputed checkpoint in
this project is now permanently undiagnosable because its deciding input was
service state nobody wrote down.

Credentials come from /utils/config.py, the same place the graders get them.
"""

import json
import os
import sys

sys.path.insert(0, "/utils")

import requests  # noqa: E402
import yaml  # noqa: E402

import config  # noqa: E402

OUT = os.environ.get("HARNESS_WORLD_OUT", "/tmp/world-before-grading.json")
TIMEOUT = 20
# Bodies here are evidence, not archives; keep any single blob bounded.
MAX_ITEMS = 200


def deps():
    try:
        with open("/utils/dependencies.yml") as fh:
            return yaml.safe_load(fh) or []
    except Exception:
        return []


def rocketchat():
    """Every channel and DM the agent could have touched, with full history."""
    out = {"channels": [], "ims": [], "users": []}
    try:
        r = requests.post(
            f"{config.ROCKETCHAT_URL}/api/v1/login",
            json={"user": "theagentcompany", "password": "theagentcompany"},
            timeout=TIMEOUT,
        ).json()
        h = {"X-Auth-Token": r["data"]["authToken"], "X-User-Id": r["data"]["userId"]}
    except Exception as e:
        return {"error": f"login failed: {e}"}

    def get(path, **params):
        return requests.get(f"{config.ROCKETCHAT_URL}/api/v1/{path}", headers=h, params=params, timeout=TIMEOUT).json()

    try:
        for c in get("channels.list", count=MAX_ITEMS).get("channels", []):
            hist = get("channels.history", roomId=c["_id"], count=MAX_ITEMS).get("messages", [])
            out["channels"].append({
                "name": c.get("name"),
                "members": c.get("usernames"),
                # Reversed so it reads oldest-first, as a transcript should.
                "messages": [{"u": m.get("u", {}).get("username"), "msg": m.get("msg"), "ts": m.get("ts")}
                             for m in reversed(hist)],
            })
        for im in get("im.list", count=MAX_ITEMS).get("ims", []):
            hist = get("im.history", roomId=im["_id"], count=MAX_ITEMS).get("messages", [])
            out["ims"].append({
                "usernames": im.get("usernames"),
                "messages": [{"u": m.get("u", {}).get("username"), "msg": m.get("msg"), "ts": m.get("ts")}
                             for m in reversed(hist)],
            })
        out["users"] = [u.get("username") for u in get("users.list", count=MAX_ITEMS).get("users", [])]
    except Exception as e:
        out["error"] = str(e)
    return out


def gitlab():
    out = {"projects": []}
    try:
        projects = requests.get(
            f"{config.GITLAB_BASEURL}/api/v4/projects",
            headers=config.GITLAB_HEADERS, params={"per_page": 100}, timeout=TIMEOUT,
        ).json()
        if isinstance(projects, dict):  # an error document, not a list
            return {"error": projects}
        for p in projects[:MAX_ITEMS]:
            pid = p["id"]

            def sub(kind, **extra):
                try:
                    return requests.get(
                        f"{config.GITLAB_BASEURL}/api/v4/projects/{pid}/{kind}",
                        headers=config.GITLAB_HEADERS, params={"per_page": 100, **extra}, timeout=TIMEOUT,
                    ).json()
                except Exception as e:
                    return {"error": str(e)}

            out["projects"].append({
                "path": p.get("path_with_namespace"),
                "issues": [{"iid": i.get("iid"), "title": i.get("title"), "state": i.get("state"),
                            "labels": i.get("labels"), "assignees": [a.get("username") for a in i.get("assignees", [])]}
                           for i in (sub("issues") if isinstance(sub("issues"), list) else [])],
                "merge_requests": [{"iid": m.get("iid"), "title": m.get("title"), "state": m.get("state")}
                                   for m in (sub("merge_requests") if isinstance(sub("merge_requests"), list) else [])],
                "milestones": [{"title": m.get("title"), "state": m.get("state")}
                               for m in (sub("milestones") if isinstance(sub("milestones"), list) else [])],
                "branches": [b.get("name") for b in (sub("repository/branches") if isinstance(sub("repository/branches"), list) else [])],
            })
    except Exception as e:
        out["error"] = str(e)
    return out


def owncloud():
    """A recursive WebDAV listing — names and sizes, not contents."""
    body = (
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
        "<d:getlastmodified/><d:getcontentlength/><d:resourcetype/>"
        "</d:prop></d:propfind>"
    )
    try:
        r = requests.request(
            "PROPFIND",
            f"{config.OWNCLOUD_URL}/remote.php/dav/files/{config.OWNCLOUD_USERNAME}/",
            auth=(config.OWNCLOUD_USERNAME, config.OWNCLOUD_PASSWORD),
            headers={"Depth": "infinity"}, data=body, timeout=TIMEOUT,
        )
        import re
        hrefs = re.findall(r"<d:href>([^<]+)</d:href>", r.text)
        sizes = re.findall(r"<d:getcontentlength>(\d+)</d:getcontentlength>", r.text)
        return {"status": r.status_code, "paths": hrefs[:1000], "sizes": sizes[:1000]}
    except Exception as e:
        return {"error": str(e)}


def plane():
    try:
        r = requests.get(
            f"{config.PLANE_BASEURL}/api/v1/workspaces/{config.PLANE_WORKSPACE_SLUG}/projects/",
            headers=config.PLANE_HEADERS, timeout=TIMEOUT,
        )
        return {"status": r.status_code, "projects": r.json() if r.ok else r.text[:2000]}
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    d = deps()
    snapshot = {"dependencies": d}
    if "rocketchat" in d:
        snapshot["rocketchat"] = rocketchat()
    if "gitlab" in d:
        snapshot["gitlab"] = gitlab()
    if "owncloud" in d:
        snapshot["owncloud"] = owncloud()
    if "plane" in d:
        snapshot["plane"] = plane()
    with open(OUT, "w") as fh:
        json.dump(snapshot, fh, indent=1)
    print(f"world snapshot: {OUT} ({os.path.getsize(OUT)} bytes, deps={d})")
