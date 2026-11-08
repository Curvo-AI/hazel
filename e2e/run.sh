#!/usr/bin/env bash
set -euo pipefail

# Builds this checkout as a Docker image and runs the E2E tests against it.
#   e2e/run.sh          scenario suite (current vs BASELINE) and Lambda path
#   e2e/run.sh parity   compare with production using real GitHub data
# BASELINE defaults to origin/master. Parity needs TOKEN with read access to
# Curvo-AI/curvo-companion.

cd "$(dirname "$0")/.."
e2e_dir="$PWD/e2e"
mode="${1:-all}"

# Every container, network and image this run creates is named after the run
# and labelled with it, and cleanup removes only those
run="hazel-e2e-$(date +%s)-$$"
export HAZEL_E2E_RUN="$run"

# shellcheck disable=SC2329 # called by the EXIT trap
cleanup() {
  docker ps -aq --filter "label=hazel-e2e.run=$run" | while read -r id; do
    docker rm -f "$id" >/dev/null
  done
  docker network ls -q --filter "label=hazel-e2e.run=$run" | while read -r id; do
    docker network rm "$id" >/dev/null
  done
  docker image rm "$run:current" "$run:baseline" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo 'Building current image...'
docker build -q --label "hazel-e2e.run=$run" -t "$run:current" . >/dev/null

if [ "$mode" = parity ]; then
  : "${TOKEN:?Set TOKEN to a GitHub token that can read Curvo-AI/curvo-companion}"
  node "$e2e_dir/parity.js"
  exit
fi

baseline="${BASELINE:-origin/master}"
echo "Building baseline image from $baseline..."
git archive "$baseline" | docker build -q --label "hazel-e2e.run=$run" -t "$run:baseline" - >/dev/null

# Throwaway CA so Hazel trusts the mock GitHub over TLS
certs="$e2e_dir/certs"
mkdir -p "$certs"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$certs/ca.key" -out "$certs/ca.pem" \
  -days 1 -subj '/CN=hazel-e2e-ca' 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout "$certs/server.key" -out "$certs/server.csr" \
  -subj '/CN=api.github.com' 2>/dev/null
printf '%s\n' 'subjectAltName=DNS:api.github.com,DNS:github.com,DNS:objects.githubusercontent.com' >"$certs/san.ext"
openssl x509 -req -in "$certs/server.csr" -CA "$certs/ca.pem" -CAkey "$certs/ca.key" \
  -CAcreateserial -out "$certs/server.pem" -days 1 -extfile "$certs/san.ext" 2>/dev/null

docker network create --label "hazel-e2e.run=$run" "$run" >/dev/null
docker run -d --name "$run-mock" --label "hazel-e2e.run=$run" --network "$run" -p 18081:8081 \
  -v "$e2e_dir:/e2e:ro" --entrypoint node "$run:current" /e2e/mock.js >/dev/null
HAZEL_E2E_MOCK_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$run-mock")"
export HAZEL_E2E_MOCK_IP
until curl -sf localhost:18081/log >/dev/null; do sleep 0.2; done

status=0
node "$e2e_dir/scenarios.js" || status=1
printf '\n## Lambda path\n'
node "$e2e_dir/lambda.js" || status=1
exit "$status"
