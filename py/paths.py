"""데이터가 실제로 살아남는 자리를 한 곳에서 정한다.

왜 필요한가:
    Render 같은 PaaS 는 재배포할 때 코드가 놓인 폴더를 통째로 새로 만든다.
    그래서 DB 를 코드 옆(<repo>/data/)에 두면 배포할 때마다 명함·초안·승인 이력이
    전부 사라지고, 화면은 12건짜리 샘플 시드로 되돌아간다.

읽기 전용 자산과 살아남아야 할 상태를 갈라 둔다:
    ASSETS  — 저장소에 커밋된 읽기 전용 파일 (seed-cards.json 등). 항상 코드 옆.
    STATE   — 사용자가 만든 데이터 (proto-rem.db, cards.json). 영구 자리에.

STATE 를 고르는 순서:
    ① DATA_DIR 환경변수 — 운영자가 직접 지정한 자리 (가장 우선)
    ② 마운트된 영구 디스크 — /var/data, /data 중 실제로 쓸 수 있는 곳
    ③ <repo>/data — 로컬 개발 기본값

주의: ③ 은 로컬에서는 영구지만 **배포 환경에서는 휘발성**이다.
Render 에서 진짜로 영구히 두려면 유료 플랜의 Persistent Disk 를 붙이고
mountPath 를 /var/data 로 잡으면 된다 (그러면 ② 가 자동으로 잡힌다).
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 저장소에 함께 커밋된 읽기 전용 자산
ASSETS = ROOT / "data"

# 영구 디스크 후보. 마운트돼 있고 쓸 수 있을 때만 채택한다.
_MOUNTS = ("/var/data", "/data")


def _writable(p: Path) -> bool:
    try:
        p.mkdir(parents=True, exist_ok=True)
        probe = p / ".write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def _resolve_state_dir() -> Path:
    env = (os.environ.get("DATA_DIR") or "").strip()
    if env:
        p = Path(env)
        if _writable(p):
            return p

    # POSIX 절대경로는 Windows 에서 현재 드라이브 기준으로 해석된다.
    # (/var/data -> C:\var\data) 개발 PC 의 엉뚜한 곳에 DB 가 생기므로 배포 환경에서만 본다.
    if os.name == "posix":
        for m in _MOUNTS:
            p = Path(m)
            # 이미 존재하는 마운트만 본다. 없는 경로를 새로 만들면
            # 컨테이너 안 임시 폴더가 생겨 "영구히 저장됐다"는 착각만 준다.
            if p.is_dir() and _writable(p):
                return p

    return ASSETS


STATE = _resolve_state_dir()

#: STATE 가 재배포를 견디는 자리인가. 화면·로그에서 사실대로 알리는 데 쓴다.
PERSISTENT = STATE != ASSETS


def describe() -> dict:
    """지금 어디에 저장하고 있는지, 그게 영구인지."""
    return {
        "stateDir": str(STATE),
        "persistent": PERSISTENT,
        "note": ("영구 디스크에 저장합니다." if PERSISTENT else
                 "저장소 안 data/ 에 저장합니다. 로컬에서는 영구하지만, "
                 "재배포 때 파일 시스템이 초기화되는 배포 환경(Render 무료 등)에서는 사라집니다. "
                 "영구 디스크를 붙이고 mountPath 를 /var/data 로 잡거나 DATA_DIR 을 지정하세요."),
    }
