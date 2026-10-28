"""
센서 없이 Apps Script 연결만 시험합니다(최소 시험판 1단계).
가짜 값 3행을 src='TEST(가짜값)'으로 보내고, 곧바로 latest 를 읽어 확인합니다.
시험이 끝나면 live 시트에서 TEST 행을 지우세요.

  python test_post.py --gas "https://script.google.com/macros/s/…/exec" --token abcd1234
"""
import argparse
import json
import urllib.request
from datetime import datetime, timedelta

ap = argparse.ArgumentParser()
ap.add_argument("--gas", required=True)
ap.add_argument("--token", required=True)
a = ap.parse_args()

now = datetime.now()
rows = [{"ts": (now - timedelta(minutes=2 * i)).strftime("%Y-%m-%d %H:%M:%S"),
         "ta": 18.0, "rh": 60.0, "p": 1012.0 + 0.1 * i, "ws": 1.0, "wd": 180, "src": "TEST(가짜값)"}
        for i in (2, 1, 0)]

req = urllib.request.Request(a.gas, data=json.dumps({"kind": "live", "token": a.token, "rows": rows}).encode(),
                             headers={"Content-Type": "text/plain;charset=utf-8"})
with urllib.request.urlopen(req, timeout=30) as r:
    print("POST 응답:", r.read().decode())

with urllib.request.urlopen(a.gas + "?action=latest", timeout=30) as r:
    res = json.loads(r.read().decode())
print("GET latest:", json.dumps(res.get("latest"), ensure_ascii=False))
print("계열 길이:", len(res.get("series", [])))
