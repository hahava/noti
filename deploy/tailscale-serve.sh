#!/usr/bin/env bash
# 집 서버에서 한 번 실행: tailnet 안에서만 열리는 HTTPS 주소를 붙인다.
#   https://<호스트이름>.<tailnet>.ts.net        → Noty (127.0.0.1:4000)
#   https://<호스트이름>.<tailnet>.ts.net:8443   → 어드민 (127.0.0.1:4010)
# 사전 준비: Tailscale 관리 화면 → DNS 에서 MagicDNS 와 HTTPS Certificates 켜기.
# 설정은 재부팅 후에도 유지된다. 끄려면: sudo tailscale serve reset
set -euo pipefail

sudo tailscale serve --bg --https=443 http://127.0.0.1:4000
sudo tailscale serve --bg --https=8443 http://127.0.0.1:4010
tailscale serve status
