#!/usr/bin/env python3
"""
直连 115 的批量备份（绕开 OpenList）。

为什么不用 OpenList：其 v4.2.9 的 115 驱动在上传 GB 级文件时会在
hybrid_cache 里段错误崩溃，且 WebDAV PUT 不可续传，大文件永远传不完。
这里直接用 p115client 的分片上传接口。

与应用共享 upload-state.json（键为本地绝对路径），所以两边不会重复传。

用法：
  python3 scripts/backup-p115.py --dry-run
  python3 scripts/backup-p115.py
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

for _k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(_k, None)

from p115client import P115Client

STATE_DEFAULT = os.path.expanduser(
    "~/Library/Application Support/直播自动录制/upload-state.json"
)
COOKIE_DEFAULT = os.path.expanduser("~/.config/115/backup-cookie.txt")
FILE_SUFFIXES = (".mp4", ".srt", ".txt", ".md")


def load_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def child_id(client, pid, name):
    """返回 pid 下名为 name 的子目录 id，没有则 None"""
    offset = 0
    while True:
        resp = client.fs_files({"cid": pid, "limit": 1000, "offset": offset, "show_dir": 1})
        items = (resp or {}).get("data") or []
        for item in items:
            if item.get("n") == name and item.get("cid"):
                return int(item["cid"])
        if len(items) < 1000:
            return None
        offset += 1000


def ensure_dir(client, pid, name):
    found = child_id(client, pid, name)
    if found:
        return found
    resp = client.fs_mkdir(name, pid)
    cid = (resp or {}).get("cid") or (resp or {}).get("data", {}).get("cid")
    if cid:
        return int(cid)
    again = child_id(client, pid, name)
    if again:
        return again
    raise RuntimeError(f"建目录失败: {name} -> {resp}")


def collect(root):
    out = []
    for entry in sorted(os.listdir(root)):
        folder = os.path.join(root, entry)
        if not os.path.isdir(folder):
            continue
        for name in os.listdir(folder):
            if name.startswith(".") or not name.lower().endswith(FILE_SUFFIXES):
                continue
            if "_纯享版" not in name:
                continue
            path = os.path.join(folder, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            out.append({"path": path, "size": st.st_size, "mtime": st.st_mtime, "folder": entry, "name": name})
    return sorted(out, key=lambda x: -x["mtime"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="/Volumes/DATA/抖音录制")
    ap.add_argument("--root", default="直播录制备份")
    ap.add_argument("--state", default=STATE_DEFAULT)
    ap.add_argument("--cookie", default=COOKIE_DEFAULT)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--keep-days", type=int, default=7,
                    help="本地保留天数（默认 7；0=不删）。只删已确认上传且大小/时间戳一致的文件")
    args = ap.parse_args()

    cookie = Path(args.cookie).read_text(encoding="utf-8").strip()
    client = P115Client(cookie)
    state = load_state(args.state)

    files = collect(args.dir)
    todo = [f for f in files if not (state.get(f["path"]) or {}).get("size") == f["size"]]
    total = sum(f["size"] for f in todo)
    print(f"共 {len(files)} 个文件，已传 {len(files) - len(todo)} 个，"
          f"待传 {len(todo)} 个（{total / 1073741824:.2f} GB）", flush=True)

    if args.dry_run:
        for f in todo:
            print(f"  {f['size'] / 1048576:9.1f} MB  {f['folder']}/{f['name']}")
        return
    if not todo:
        print("全部已上传")

    root_id = ensure_dir(client, 0, args.root) if todo else None
    folder_ids = {}
    remote_index = {}   # folder -> {name: size}，用于跳过"已传但状态漏记"的文件

    def remote_sizes(folder, pid):
        if folder in remote_index:
            return remote_index[folder]
        idx = {}
        offset = 0
        while True:
            resp = client.fs_files({"cid": pid, "limit": 1000, "offset": offset, "show_dir": 1})
            items = (resp or {}).get("data") or []
            for it in items:
                if it.get("n") and not it.get("cid"):
                    idx[it["n"]] = int(it.get("s") or 0)
            if len(items) < 1000:
                break
            offset += 1000
        remote_index[folder] = idx
        return idx

    t0 = time.time()
    done_bytes = 0
    for i, f in enumerate(todo if todo else [], 1):
        folder = f["folder"]
        if folder not in folder_ids:
            folder_ids[folder] = ensure_dir(client, root_id, folder)
        pid = folder_ids[folder]
        # 远端已有同名同大小文件：说明传过了，只补状态，不重复上传
        if remote_sizes(folder, pid).get(f["name"]) == f["size"]:
            state[f["path"]] = {
                "size": f["size"], "mtimeMs": int(f["mtime"] * 1000),
                "remote": f"115:/{args.root}/{folder}/{f['name']}", "at": int(time.time() * 1000),
            }
            save_state(args.state, state)
            done_bytes += f["size"]
            print(f"[{i}/{len(todo)}] 跳过（远端已存在）{f['name'][:40]}", flush=True)
            continue
        started = time.time()
        try:
            resp = None
            for attempt in range(1, 4):
                resp = client.upload_file(f["path"], pid=pid, filename=f["name"])
                if (resp or {}).get("state") or (resp or {}).get("data", {}).get("state"):
                    break
                print(f"    第 {attempt} 次上传未成功，重试…", flush=True)
                time.sleep(5 * attempt)
            ok = (resp or {}).get("state") or (resp or {}).get("data", {}).get("state")
            if not ok:
                raise RuntimeError(str(resp)[:200])
            secs = time.time() - started
            state[f["path"]] = {
                "size": f["size"],
                "mtimeMs": int(f["mtime"] * 1000),
                "remote": f"115:/{args.root}/{folder}/{f['name']}",
                "at": int(time.time() * 1000),
            }
            save_state(args.state, state)
            done_bytes += f["size"]
            rate = f["size"] / 1048576 / max(secs, 1)          # MB/s
            eta = (total - done_bytes) / 1048576 / max(rate, 0.01) / 60  # 分钟
            print(f"[{i}/{len(todo)}] 完成 {f['name'][:40]} "
                  f"({f['size'] / 1048576:.0f}MB, {secs:.0f}s, {rate:.1f}MB/s) "
                  f"已传 {done_bytes / 1073741824:.2f}GB 剩余约 {eta:.0f} 分钟", flush=True)
        except Exception as e:
            print(f"[{i}/{len(todo)}] 失败 {f['name'][:40]}: {e}", flush=True)

    # ---- 本地保留清理 ----
    # 只删「已上传且现场与记账一致」的文件；任何对不上的都留着，宁可占空间也不丢数据。
    if args.keep_days and args.keep_days > 0:
        cutoff = time.time() - args.keep_days * 86400
        removed = freed = 0
        for path_str, rec in list(state.items()):
            if not os.path.exists(path_str):
                continue
            if rec.get("at", 0) / 1000 > cutoff:
                continue                                    # 未过保留期
            try:
                st = os.stat(path_str)
            except OSError:
                continue
            if st.st_size != rec.get("size"):
                print(f"  跳过（大小与记账不符，不删）{os.path.basename(path_str)}", flush=True)
                continue
            if rec.get("mtimeMs") and int(st.st_mtime * 1000) != rec["mtimeMs"]:
                print(f"  跳过（修改时间已变，不删）{os.path.basename(path_str)}", flush=True)
                continue
            try:
                os.remove(path_str)
                removed += 1
                freed += st.st_size
                del state[path_str]
                print(f"  已清理（超过 {args.keep_days} 天）{os.path.basename(path_str)}", flush=True)
            except OSError as e:
                print(f"  删除失败 {os.path.basename(path_str)}: {e}", flush=True)
        if removed:
            save_state(args.state, state)
            print(f"本地清理：删除 {removed} 个文件，释放 {freed / 1073741824:.2f} GB", flush=True)

    print(f"结束，用时 {(time.time() - t0) / 60:.0f} 分钟", flush=True)


if __name__ == "__main__":
    sys.exit(main())
