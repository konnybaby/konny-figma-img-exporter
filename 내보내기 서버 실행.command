#!/bin/bash
# Konny Image Exporter — 로컬 저장 서버 (macOS)
# 이 파일을 더블클릭하면 서버가 켜집니다.

cd "$(dirname "$0")" || exit 1

echo ""
echo "  Konny Image Exporter — 로컬 저장 서버"
echo "  ------------------------------------------------"

# macOS 최신 버전에는 python3 가 기본 포함되지 않을 수 있다.
# 그런 경우 개발자 도구를 한 번만 설치하면 된다.
if ! command -v python3 >/dev/null 2>&1; then
  echo ""
  echo "  python3 를 찾지 못했습니다."
  echo "  아래 명령으로 개발자 도구를 한 번만 설치한 뒤 다시 실행해 주세요."
  echo ""
  echo "      xcode-select --install"
  echo ""
  echo "  설치가 번거로우면 플러그인의 [Figma 내보내기] 방식을 쓰셔도 됩니다."
  echo "  (설정 없이 폴더 한 번만 묻고 개별 파일로 저장됩니다)"
  echo ""
  read -r -p "  창을 닫으려면 Enter 를 누르세요."
  exit 1
fi

python3 ./konny-export-server.py "$@"

echo ""
read -r -p "  창을 닫으려면 Enter 를 누르세요."
