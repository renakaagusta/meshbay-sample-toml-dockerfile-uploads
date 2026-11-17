#!/usr/bin/env bash
# Live check for the meshbay-sample-uploads service.
#
#   bash scripts/smoke.sh https://<domain>
#   bash scripts/smoke.sh https://<domain> --after-redeploy <file-id> <sha256>
#
# The fresh run keeps the uploaded file so the --after-redeploy run can verify it
# still exists, byte for byte, after a redeploy, a restart or a database restore.
# Environment:
#   SMOKE_BYTES=262144      size of the random upload
#   SMOKE_ALLOW_DRIFT=1     ignore unrelated pre-existing drift in /api/integrity
#   SMOKE_LIMIT_CHECK=1     also upload 11 MiB and expect HTTP 413
set -euo pipefail

usage() {
  echo "usage: scripts/smoke.sh <base-url> [--after-redeploy <file-id> <sha256>]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
baseUrl="${1%/}"
mode="fresh"
fileId=""
expectedSha=""
if [[ $# -gt 1 ]]; then
  [[ "${2:-}" == "--after-redeploy" && $# -eq 4 ]] || usage
  mode="after-redeploy"
  fileId="$3"
  expectedSha="$4"
fi

for tool in curl jq; do
  command -v "$tool" > /dev/null || { echo "FAIL $tool is required" >&2; exit 1; }
done

smokeBytes="${SMOKE_BYTES:-262144}"
[[ "$smokeBytes" =~ ^[0-9]+$ ]] || { echo "FAIL SMOKE_BYTES must be a number" >&2; exit 1; }

workDir="$(mktemp -d)"
responseFile="$workDir/response"
errorFile="$workDir/curl-error"
trap 'rm -rf "$workDir"' EXIT

fail() {
  echo "FAIL $*" >&2
  if [[ -s "$responseFile" ]]; then
    echo "--- response body ---" >&2
    cat "$responseFile" >&2
    echo >&2
  fi
  exit 1
}

ok() {
  echo "ok   $*"
}

requestTo() {
  local output="$1"
  shift
  local code
  code="$(curl -sS -m 60 -o "$output" -w '%{http_code}' "$@" 2> "$errorFile")" || code="000"
  printf '%s' "$code"
}

request() {
  requestTo "$responseFile" "$@"
}

expectCode() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    if [[ "$actual" == "000" && -s "$errorFile" ]]; then
      echo "FAIL $label: curl failed: $(cat "$errorFile")" >&2
      exit 1
    fi
    fail "$label: expected HTTP $expected, got $actual"
  fi
  ok "$label ($actual)"
}

sha256File() {
  if command -v sha256sum > /dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

jsonField() {
  jq -r "$1" "$responseFile"
}

checkHealth() {
  expectCode "GET /health" 200 "$(request "$baseUrl/health")"
  [[ "$(jsonField '.status')" == "ok" ]] || fail "health status is not ok: $(jsonField '.status')"
  [[ "$(jsonField '.data_dir_writable')" == "true" ]] || fail "DATA_DIR is not writable: $(jsonField '.data_dir')"
  local host dataDir diskFiles dbFiles
  host="$(jsonField '.host')"
  dataDir="$(jsonField '.data_dir')"
  diskFiles="$(jsonField '.disk_files')"
  dbFiles="$(jsonField '.db_files')"
  ok "health host=$host data_dir=$dataDir disk_files=$diskFiles db_files=$dbFiles"
  if [[ "$(jsonField '.data_dir_fallback')" == "true" ]]; then
    echo "note DATA_DIR fell back to $dataDir ($(jsonField '.data_dir_write_error')); files do not survive this container" >&2
  fi
}

checkIntegrity() {
  expectCode "GET /api/integrity" 200 "$(request "$baseUrl/api/integrity")"
  local status
  status="$(jsonField '.status')"
  if [[ "$status" != "ok" ]]; then
    if [[ "${SMOKE_ALLOW_DRIFT:-0}" == "1" ]]; then
      echo "note /api/integrity reports drift (SMOKE_ALLOW_DRIFT=1): $(jq -c '{missing,orphans,size_mismatch}' "$responseFile")" >&2
    else
      fail "/api/integrity is $status: $(jq -c '.' "$responseFile")"
    fi
  fi
  ok "integrity status=$status"
}

verifyStoredFile() {
  local id="$1" sha="$2"

  expectCode "GET /api/files/$id/meta" 200 "$(request "$baseUrl/api/files/$id/meta")"
  local metaSha metaName metaSize
  metaSha="$(jsonField '.sha256')"
  metaName="$(jsonField '.name')"
  metaSize="$(jsonField '.size')"
  [[ "$metaSha" == "$sha" ]] || fail "metadata sha256 $metaSha does not match $sha"
  ok "metadata row name=$metaName size=$metaSize sha256=$metaSha"

  local downloadFile="$workDir/download"
  expectCode "GET /api/files/$id" 200 "$(requestTo "$downloadFile" "$baseUrl/api/files/$id")"
  local downloadedSha downloadedSize
  downloadedSha="$(sha256File "$downloadFile")"
  downloadedSize="$(wc -c < "$downloadFile" | tr -d ' ')"
  [[ "$downloadedSha" == "$sha" ]] || fail "downloaded sha256 $downloadedSha does not match $sha"
  [[ "$downloadedSize" == "$metaSize" ]] || fail "downloaded size $downloadedSize does not match the metadata size $metaSize"
  ok "download sha256 matches ($downloadedSize bytes)"
}

if [[ "$mode" == "after-redeploy" ]]; then
  echo "after-redeploy check on $baseUrl for file $fileId"
  checkHealth
  verifyStoredFile "$fileId" "$expectedSha"
  checkIntegrity
  echo
  echo "file id: $fileId"
  echo "sha256:  $expectedSha"
  echo "OK"
  exit 0
fi

echo "fresh check on $baseUrl"

checkHealth

uploadFile="$workDir/upload.bin"
head -c "$smokeBytes" /dev/urandom > "$uploadFile"
localSha="$(sha256File "$uploadFile")"
uploadName="smoke-$(date +%s)-$RANDOM.bin"

expectCode "POST /api/files" 201 "$(request -F "file=@$uploadFile;filename=$uploadName;type=application/octet-stream" "$baseUrl/api/files")"
fileId="$(jsonField '.id')"
[[ -n "$fileId" && "$fileId" != "null" ]] || fail "upload did not return an id"
[[ "$(jsonField '.name')" == "$uploadName" ]] || fail "upload returned another name: $(jsonField '.name')"
[[ "$(jsonField '.sha256')" == "$localSha" ]] || fail "server sha256 $(jsonField '.sha256') does not match local $localSha"
[[ "$(jsonField '.size')" == "$smokeBytes" ]] || fail "server size $(jsonField '.size') does not match $smokeBytes"
ok "upload id=$fileId sha256=$localSha"

verifyStoredFile "$fileId" "$localSha"

expectCode "GET /api/files lists it" 200 "$(request "$baseUrl/api/files")"
jq -e --arg wanted "$fileId" 'any(.[]; .id == $wanted)' "$responseFile" > /dev/null \
  || fail "the list does not contain $fileId"
ok "list contains the upload"

checkIntegrity

# Delete path: a second, throwaway file must disappear from both sides.
deleteFile="$workDir/delete.bin"
head -c 1024 /dev/urandom > "$deleteFile"
expectCode "POST /api/files (throwaway)" 201 "$(request -F "file=@$deleteFile;filename=smoke-delete-$RANDOM.bin" "$baseUrl/api/files")"
deleteId="$(jsonField '.id')"
expectCode "DELETE /api/files/$deleteId" 204 "$(request -X DELETE "$baseUrl/api/files/$deleteId")"
expectCode "GET deleted metadata" 404 "$(request "$baseUrl/api/files/$deleteId/meta")"
expectCode "GET deleted file" 404 "$(request "$baseUrl/api/files/$deleteId")"
checkIntegrity

if [[ "${SMOKE_LIMIT_CHECK:-0}" == "1" ]]; then
  oversizedFile="$workDir/oversized.bin"
  head -c $((10 * 1024 * 1024 + 1024)) /dev/urandom > "$oversizedFile"
  expectCode "POST /api/files (11 MiB)" 413 "$(request -F "file=@$oversizedFile;filename=smoke-oversized.bin" "$baseUrl/api/files")"
  checkHealth
fi

echo
echo "file id: $fileId"
echo "sha256:  $localSha"
echo "after a redeploy, run: bash scripts/smoke.sh $baseUrl --after-redeploy $fileId $localSha"
echo "OK"
