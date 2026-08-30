#!/usr/bin/env python3
"""Konny Image Exporter — 로컬 저장 헬퍼 (macOS / Linux / Windows 공용)

Figma 플러그인은 파일을 디스크에 직접 쓸 수 없다. 이 스크립트를 켜두면
플러그인이 127.0.0.1 로 이미지를 보내고, 여기서 지정한 폴더에 바로 저장한다.
저장 창이 뜨지 않고 개수 제한도 없다.

표준 라이브러리만 쓴다. 설치할 패키지가 없다.

    python3 konny-export-server.py                 # 폴더를 물어본다
    python3 konny-export-server.py --folder ~/out  # 폴더를 지정한다

Windows에서는 같은 일을 하는 konny-export-server.ps1 을 쓰면 파이썬 없이 돌아간다.
"""

import argparse
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

PORT = 8787

# 이 확장자만 저장한다. 로컬 서버는 아무 웹페이지나 접근할 수 있으므로
# 실행 파일 등이 떨어지지 않도록 막아 둔다.
ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".svg", ".pdf", ".zip"}

MAX_BYTES = 200 * 1024 * 1024  # 한 파일 상한

folder = ""
saved = 0


# ------------------------------------------------------------------ 폴더 선택

def config_path():
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support/konny-export-server")
    elif os.name == "nt":
        base = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "konny-export-server")
    else:
        base = os.path.expanduser("~/.config/konny-export-server")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "folder.txt")


def load_last_folder():
    try:
        with open(config_path(), encoding="utf-8") as f:
            last = f.read().strip()
        return last if last and os.path.isdir(last) else ""
    except OSError:
        return ""


def save_last_folder(path):
    try:
        with open(config_path(), "w", encoding="utf-8") as f:
            f.write(path)
    except OSError:
        pass


def ask_folder():
    """OS 기본 폴더 선택창을 띄운다. 실패하면 콘솔에서 입력받는다."""
    last = load_last_folder()

    if sys.platform == "darwin":
        # macOS 내장 osascript — 추가 설치 없이 네이티브 폴더 선택창이 뜬다.
        default = 'default location POSIX file "%s"' % last if last else ""
        script = 'POSIX path of (choose folder with prompt "내보낸 이미지를 저장할 폴더를 선택하세요" %s)' % default
        try:
            out = subprocess.run(["osascript", "-e", script],
                                 capture_output=True, text=True, check=True)
            return out.stdout.strip().rstrip("/")
        except (subprocess.CalledProcessError, FileNotFoundError):
            return ""

    try:
        import tkinter
        from tkinter import filedialog
        root = tkinter.Tk()
        root.withdraw()
        picked = filedialog.askdirectory(title="내보낸 이미지를 저장할 폴더를 선택하세요",
                                         initialdir=last or os.path.expanduser("~"))
        root.destroy()
        return picked
    except Exception:
        pass

    try:
        return input("저장할 폴더 경로를 입력하세요%s: " % (" [%s]" % last if last else "")).strip() or last
    except EOFError:
        return last


# -------------------------------------------------------------------- 유틸

def safe_file_name(raw):
    """경로 요소를 떼어내고 허용 확장자인지 확인한다."""
    if not raw:
        return ""
    name = os.path.basename(raw.replace("\\", "/"))
    if not name or name in (".", ".."):
        return ""
    for ch in '<>:"|?*\0':
        name = name.replace(ch, "_")
    if os.path.splitext(name)[1].lower() not in ALLOWED_EXT:
        return ""
    return name


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "konny-export-server"

    def log_message(self, *args):
        pass  # 기본 접근 로그는 끄고 저장한 파일만 직접 출력한다.

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(200, {"ok": True})

    def do_GET(self):
        if urlparse(self.path).path == "/ping":
            self._send(200, {"ok": True, "name": "konny-export-server", "folder": folder})
        else:
            self._send(404, {"ok": False, "error": "알 수 없는 경로입니다"})

    def do_POST(self):
        global saved
        parsed = urlparse(self.path)
        if parsed.path != "/save":
            self._send(404, {"ok": False, "error": "알 수 없는 경로입니다"})
            return

        query = parse_qs(parsed.query)
        name = safe_file_name(unquote(query.get("name", [""])[0]))
        if not name:
            self._send(400, {"ok": False, "error": "허용되지 않는 파일 이름입니다"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._send(400, {"ok": False, "error": "내용이 비어 있습니다"})
            return
        if length > MAX_BYTES:
            self._send(413, {"ok": False, "error": "파일이 너무 큽니다"})
            return

        data = self.rfile.read(length)
        if len(data) != length:
            self._send(400, {"ok": False, "error": "전송이 중간에 끊겼습니다"})
            return

        with open(os.path.join(folder, name), "wb") as f:
            f.write(data)

        saved += 1
        print("  [%3d] %s  (%s bytes)" % (saved, name, format(len(data), ",")), flush=True)
        self._send(200, {"ok": True, "name": name, "folder": folder})


def main():
    global folder

    # Windows 콘솔 기본 인코딩(cp949 등)에서 한글·기호 출력이 죽지 않도록 한다.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--folder", default="")
    args = parser.parse_args()

    folder = args.folder or ask_folder()
    if not folder:
        print("폴더를 선택하지 않아 종료합니다.")
        return 1

    folder = os.path.abspath(os.path.expanduser(folder))
    os.makedirs(folder, exist_ok=True)
    save_last_folder(folder)

    try:
        # 127.0.0.1 에만 바인딩한다 — 같은 네트워크의 다른 기기는 접근할 수 없다.
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as e:
        print("\n  포트 %d 를 열지 못했습니다. 이미 서버가 켜져 있는지 확인해 주세요." % args.port)
        print("  %s\n" % e)
        return 1

    print("")
    print("  Konny Image Exporter — 로컬 저장 서버")
    print("  ------------------------------------------------")
    print("  저장 폴더 : %s" % folder)
    print("  주소      : http://localhost:%d" % args.port)
    print("")
    print("  이 창을 열어 둔 채로 Figma 플러그인에서 [로컬 폴더] 를 쓰세요.")
    print("  끄려면 이 창을 닫거나 Ctrl+C 를 누르세요.")
    print("", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("\n  서버를 종료했습니다. 저장한 파일 %d 개" % saved)
    return 0


if __name__ == "__main__":
    sys.exit(main())
