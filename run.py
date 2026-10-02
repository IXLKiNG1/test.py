from __future__ import annotations
import os, shutil, subprocess, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent

def run(cmd):
    try:
        return subprocess.call(cmd,cwd=ROOT)
    except FileNotFoundError:
        return 127

if __name__=='__main__':
    os.environ.setdefault('PORT','7005')
    npm=shutil.which('npm') or shutil.which('npm.cmd')
    if not npm:
        print('لم يتم العثور على npm. ثبّت Node.js ثم شغّل run.py مرة أخرى.')
        raise SystemExit(127)
    if not (ROOT/'node_modules').exists():
        print('جارٍ تثبيت الاعتمادات…')
        code=run([npm,'install','--no-audit','--no-fund'])
        if code!=0:
            print('فشل تثبيت الاعتمادات. يمكنك تشغيل npm install يدويًا لرؤية الخطأ كاملًا.')
            raise SystemExit(code)
    raise SystemExit(run([npm,'start']))
