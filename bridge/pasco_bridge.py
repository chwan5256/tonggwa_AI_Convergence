"""
PASCO 무선 날씨센서 → Google Apps Script(시트) 실시간 브리지
================================================================
교사 PC 한 대에서 실행합니다. 센서 값을 일정 간격으로 읽어
  ① 로컬 CSV(백업)에 항상 기록하고
  ② Apps Script 웹앱으로 묶어서 보냅니다(전송 실패분은 다음 번에 다시 보냄).

필요: Python 3.11 이상(pasco 0.3.65 기준; PyPI 최신 0.3.66은 3.14 이상으로 표기 — 새로 설치하면 3.14 권장), 블루투스 4.0 이상(BLE)
설치: pip install pasco

사용 예
  python pasco_bridge.py --list                          # 주변 센서와 측정 항목 확인
  python pasco_bridge.py --weather 123-456 --dry-run     # 시트 전송 없이 읽기만
  python pasco_bridge.py --weather 123-456 --gas "https://script.google.com/macros/s/…/exec" --token abcd1234

※ SPARKvue와 같은 센서를 동시에 연결할 수 없습니다(센서 1개 = 기기 1대).
   브리지를 돌리는 동안 날씨센서는 SPARKvue에서 연결을 끊어 두세요.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

try:
    from pasco.pasco_ble_device import PASCOBLEDevice
except ImportError:  # 라이브러리가 없어도 --help 는 보이게
    PASCOBLEDevice = None

VERSION = "0.1.0"

# 공식 라이브러리 문서에 나온 날씨센서 측정 이름
WANTED = {
    "ta": "Temperature",
    "rh": "RelativeHumidity",
    "p": "BarometricPressure",
    "ws": "WindSpeed",
}

# 단위 → 시트 저장 단위(hPa, m/s)로 바꾸는 배수
P_TO_HPA = {"hpa": 1.0, "mbar": 1.0, "kpa": 10.0, "pa": 0.01, "mmhg": 1.333224, "inhg": 33.8639, "atm": 1013.25}
WS_TO_MS = {"m/s": 1.0, "mps": 1.0, "km/h": 1 / 3.6, "km/hr": 1 / 3.6, "mph": 0.44704, "knots": 0.514444, "kn": 0.514444}


def norm_unit(u: str | None) -> str:
    return (u or "").strip().lower().replace(" ", "")


def convert(key: str, value, unit: str | None):
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    u = norm_unit(unit)
    if key == "p":
        if u not in P_TO_HPA:
            raise ValueError(f"기압 단위를 알 수 없습니다: {unit!r} — P_TO_HPA 에 추가하세요")
        return round(v * P_TO_HPA[u], 2)
    if key == "ws":
        if u and u not in WS_TO_MS:
            raise ValueError(f"풍속 단위를 알 수 없습니다: {unit!r} — WS_TO_MS 에 추가하세요")
        return round(v * WS_TO_MS.get(u, 1.0), 2)
    if key == "ta" and u in ("°f", "f", "degf"):
        return round((v - 32) * 5 / 9, 2)
    return round(v, 2)


def list_sensors():
    dev = PASCOBLEDevice()
    found = dev.scan()
    if not found:
        print("센서를 찾지 못했습니다. 센서 전원(초록 불 깜박임)과 PC 블루투스를 확인하세요.")
        return
    for i, d in enumerate(found):
        print(f"[{i}] {d}")
    for d in found:
        try:
            dev = PASCOBLEDevice()
            dev.connect(d)
            print("\n==", d)
            for s in dev.get_sensor_list():
                print("  센서:", s)
                for m in dev.get_measurement_list(s):
                    print("    측정:", m, "/", dev.get_measurement_unit(m))
            dev.disconnect()
        except Exception as e:  # 한 센서가 실패해도 나머지는 계속
            print("  (연결 실패)", e)


class Bridge:
    def __init__(self, args):
        self.a = args
        self.dev = None
        self.units: dict[str, str] = {}
        self.wd_name: str | None = None
        self.pending: list[dict] = []
        self.backup = Path(args.backup)
        self.backup.parent.mkdir(parents=True, exist_ok=True)
        if not self.backup.exists():
            with self.backup.open("w", newline="", encoding="utf-8-sig") as f:
                csv.writer(f).writerow(["ts", "ta", "rh", "p", "ws", "wd"])

    def connect(self):
        self.dev = PASCOBLEDevice()
        self.dev.connect_by_id(self.a.weather)
        names = self.dev.get_measurement_list()
        self.units = {k: self.dev.get_measurement_unit(m) for k, m in WANTED.items() if m in names}
        # 풍향(WindDirection)은 센서 내장 나침반으로 늘 값이 나오지만, 날개(PS-3553)가 바람을 받을 때만 의미가 있음.
        # 풍속이 0.3 m/s 미만이면 웹앱이 정온으로 처리한다. 이름이 버전마다 다를 수 있어 찾아서 씀
        cands = [m for m in names if "direction" in m.lower() and "magnetic" not in m.lower()]
        self.wd_name = next((m for m in cands if "true" in m.lower()), cands[0] if cands else None)
        print(f"[연결] {self.a.weather} · 측정 {list(self.units)} · 풍향={self.wd_name} · 단위 {self.units}")

    def read_once(self) -> dict:
        keys = [k for k in WANTED if k in self.units]
        names = [WANTED[k] for k in keys] + ([self.wd_name] if self.wd_name else [])
        vals = self.dev.read_data_list(names) or {}  # 라이브러리는 {측정이름: 값} dict 를 돌려줌
        row = {"ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
        for k in keys:
            row[k] = convert(k, vals.get(WANTED[k]), self.units.get(k))
        wd = vals.get(self.wd_name) if self.wd_name else None
        row["wd"] = round(float(wd)) if wd is not None else None
        return row

    def save_backup(self, row: dict):
        with self.backup.open("a", newline="", encoding="utf-8-sig") as f:
            csv.writer(f).writerow([row.get(k) for k in ["ts", "ta", "rh", "p", "ws", "wd"]])

    def flush(self):
        if self.a.dry_run:
            self.pending.clear()
            return
        if not self.a.gas or not self.pending:
            return
        body = json.dumps({"kind": "live", "token": self.a.token, "rows": self.pending}).encode("utf-8")
        req = urllib.request.Request(self.a.gas, data=body, headers={"Content-Type": "text/plain;charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                res = json.loads(r.read().decode("utf-8"))
            if res.get("ok"):
                print(f"  → 시트 {res.get('saved')}행 저장")
                self.pending.clear()
            else:
                print("  → 거절:", res.get("error"))
                self.pending = self.pending[-2000:]
                if "토큰" in str(res.get("error")):
                    sys.exit("토큰을 확인하세요(스크립트 속성 WRITE_TOKEN).")
        except Exception as e:
            print(f"  → 전송 실패(다음에 다시 보냄, 대기 {len(self.pending)}행):", e)
            self.pending = self.pending[-2000:]

    def run(self):
        self.connect()
        last_send = 0.0
        while True:
            t0 = time.time()
            try:
                row = self.read_once()
                self.save_backup(row)
                self.pending.append(row)
                print(row)
            except Exception as e:
                print("[읽기 실패] 다시 연결합니다:", e)
                try:
                    self.dev.disconnect()
                except Exception:
                    pass
                time.sleep(5)
                try:
                    self.connect()
                except Exception as e2:
                    print("[재연결 실패]", e2)
                continue
            if time.time() - last_send >= self.a.send_every:
                self.flush()
                last_send = time.time()
            time.sleep(max(0.0, self.a.interval - (time.time() - t0)))


def main():
    ap = argparse.ArgumentParser(description="PASCO 날씨센서 → Apps Script 브리지 v" + VERSION)
    ap.add_argument("--list", action="store_true", help="주변 센서와 측정 항목·단위만 출력")
    ap.add_argument("--weather", help="날씨센서 6자리 ID(예: 123-456, 센서 뒷면)")
    ap.add_argument("--gas", help="Apps Script 웹앱 /exec 주소")
    ap.add_argument("--token", default="", help="스크립트 속성 WRITE_TOKEN 값")
    ap.add_argument("--interval", type=float, default=30, help="측정 간격(초), 기본 30")
    ap.add_argument("--send-every", type=float, default=60, help="전송 간격(초), 기본 60")
    ap.add_argument("--backup", default="backup/live_backup.csv", help="로컬 백업 CSV 경로")
    ap.add_argument("--dry-run", action="store_true", help="전송하지 않고 읽기·백업만")
    a = ap.parse_args()

    if PASCOBLEDevice is None:
        sys.exit("pasco 라이브러리가 없습니다: pip install pasco  (Python 3.11 이상 필요)")
    if a.list:
        list_sensors()
        return
    if not a.weather:
        sys.exit("--weather 센서 ID가 필요합니다. 먼저 --list 로 확인하세요.")
    if not a.dry_run and not (a.gas and a.token):
        sys.exit("--gas 주소와 --token 이 필요합니다(또는 --dry-run).")
    try:
        Bridge(a).run()
    except KeyboardInterrupt:
        print("\n종료합니다. 백업:", a.backup)


if __name__ == "__main__":
    main()
