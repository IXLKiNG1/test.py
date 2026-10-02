#!/usr/bin/env python3
"""chat BOT launcher: install dependencies, verify local browser, start server, open UI."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 7005
HOST = "127.0.0.1"
URL = f"http://{HOST}:{PORT}"
REQUIRED = ["express", "multer", "qrcode", "whatsapp-web.js", "libphonenumber-js"]
EXPECTED_WWEB_VERSION = "1.34.6"


def run(cmd: list[str], env: dict[str, str] | None = None) -> int:
    return subprocess.run(cmd, cwd=ROOT, env=env or os.environ.copy()).returncode


def node_executable() -> str | None:
    return shutil.which("node")


def npm_executable() -> str | None:
    return shutil.which("npm.cmd" if os.name == "nt" else "npm") or shutil.which("npm")


def missing_dependencies() -> list[str]:
    return [name for name in REQUIRED if not (ROOT / "node_modules" / name / "package.json").exists()]


def browser_path() -> Path | None:
    explicit = os.environ.get("PUPPETEER_EXECUTABLE_PATH", "").strip()
    if explicit and Path(explicit).is_file():
        return Path(explicit)
    candidates: list[Path] = []
    if os.name == "nt":
        local = Path(os.environ.get("LOCALAPPDATA", ""))
        pf = Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
        pfx = Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"))
        candidates += [
            local / "Google/Chrome/Application/chrome.exe",
            pf / "Google/Chrome/Application/chrome.exe",
            pfx / "Google/Chrome/Application/chrome.exe",
            local / "Microsoft/Edge/Application/msedge.exe",
            pf / "Microsoft/Edge/Application/msedge.exe",
            pfx / "Microsoft/Edge/Application/msedge.exe",
        ]
    elif sys.platform == "darwin":
        candidates += [
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ]
    else:
        candidates += [Path("/usr/bin/google-chrome"), Path("/usr/bin/google-chrome-stable"), Path("/usr/bin/chromium"), Path("/usr/bin/chromium-browser"), Path("/usr/bin/microsoft-edge")]
    return next((p for p in candidates if p.is_file()), None)


def ping() -> bool:
    try:
        with urllib.request.urlopen(f"{URL}/control/ping", timeout=2) as response:
            return response.status == 200
    except Exception:
        return False


def remove_node_modules() -> bool:
    target = ROOT / "node_modules"
    if not target.exists():
        return True
    print("Removing node_modules (WhatsApp session data is kept)...")
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            shutil.rmtree(target)
            return True
        except Exception as exc:
            last_error = exc
            time.sleep(1.0 + attempt)
    print(f"Could not remove node_modules: {last_error}")
    print("Close any running chat BOT/Chrome process, then run this launcher again with --reset.")
    return False


def install(reset: bool) -> int:
    npm = npm_executable()
    if not npm:
        print("npm was not found. Install Node.js 20+ first.")
        return 1
    if reset and not remove_node_modules():
        return 1
    env = os.environ.copy()
    env["PUPPETEER_SKIP_DOWNLOAD"] = "1"
    print("Installing dependencies without downloading a bundled Chrome...")
    result = run([npm, "install", "--no-audit", "--no-fund"], env)
    return result


def installed_whatsapp_version(node: str) -> str | None:
    probe = (
        "try { "
        "console.log(require('./node_modules/whatsapp-web.js/package.json').version)"
        " } catch (e) { process.exit(2) }"
    )
    result = subprocess.run([node, "-e", probe], cwd=ROOT, text=True, capture_output=True)
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def patch_and_verify(node: str) -> int:
    env = {**os.environ, "PUPPETEER_SKIP_DOWNLOAD": "1"}
    return run([node, "scripts/patch-whatsapp.js"], env=env)


def ensure() -> int:
    node = node_executable()
    if not node:
        print("Node.js 20+ is required.")
        return 1
    result = subprocess.run([node, "--version"], cwd=ROOT, text=True, capture_output=True)
    node_version = result.stdout.strip()
    print(f"Node.js: {node_version}")
    match = __import__("re").match(r"v(\d+)", node_version)
    if not match or int(match.group(1)) < 20:
        print("Node.js 20+ is required.")
        return 1

    if missing_dependencies():
        if install(False) != 0:
            print("Initial dependency install failed; retrying with a clean node_modules repair...")
            if install(True) != 0:
                return 1

    version = installed_whatsapp_version(node)
    if version != EXPECTED_WWEB_VERSION:
        print(f"whatsapp-web.js version mismatch: found {version or 'missing'}, expected {EXPECTED_WWEB_VERSION}.")
        print("Repairing npm dependencies while preserving data/ and WhatsApp sessions...")
        if install(True) != 0:
            return 1

    # Re-run and strictly verify the compatibility patch every time.
    patch = patch_and_verify(node)
    if patch == 0:
        return 0

    print("Compatibility patch failed; performing one clean dependency repair...")
    if install(True) != 0:
        return 1
    return patch_and_verify(node)


def main() -> int:
    parser = argparse.ArgumentParser(description="chat BOT local launcher")
    parser.add_argument("--reset", action="store_true", help="reinstall npm dependencies; keep WhatsApp sessions")
    parser.add_argument("--no-open", action="store_true", help="do not open the browser automatically")
    args = parser.parse_args()

    print("=" * 54)
    print("chat BOT — LOCAL LAUNCHER")
    print(f"Control panel: {URL}")
    print("=" * 54)

    if ensure() != 0:
        return 1

    browser = browser_path()
    if not browser:
        print("Google Chrome or Microsoft Edge was not found.")
        print("Install one of them, then run this launcher again.")
        return 1

    env = os.environ.copy()
    env["PORT"] = str(PORT)
    env["HOST"] = HOST
    env["PUPPETEER_SKIP_DOWNLOAD"] = "1"
    env["PUPPETEER_EXECUTABLE_PATH"] = str(browser)

    node = node_executable()
    print(f"Browser: {browser}")
    print("Starting chat BOT server...")
    child = subprocess.Popen([node, "server.js"], cwd=ROOT, env=env)
    try:
        for _ in range(60):
            if child.poll() is not None:
                return child.returncode or 1
            if ping():
                print(f"Server ready: {URL}")
                if not args.no_open:
                    webbrowser.open(URL)
                print("Press Ctrl+C to stop the bot.")
                return child.wait()
            time.sleep(0.5)
        print("The local server did not become ready.")
        print("Check the server output above for the exact error.")
        child.terminate()
        return 1
    except KeyboardInterrupt:
        print("Stopping chat BOT...")
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
