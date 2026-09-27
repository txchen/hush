#!/usr/bin/env bash
set -euo pipefail

# Parse the complete function before starting an installation piped into bash.
main() {
  if [[ $# -ne 0 ]]; then
    echo 'usage: [HUSH_VERSION=vX.Y.Z] [HUSH_INSTALL_DIR=DIR] bash install.sh' >&2
    return 2
  fi

  local command_name platform architecture
  for command_name in curl tar mktemp install; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      echo "Required command not found: ${command_name}" >&2
      return 1
    fi
  done
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64|Linux/amd64) platform=linux; architecture=amd64 ;;
    Linux/aarch64|Linux/arm64) platform=linux; architecture=arm64 ;;
    Darwin/arm64) platform=darwin; architecture=arm64 ;;
    *) echo 'Supported platforms: Linux x86_64, Linux ARM64, and Apple Silicon macOS.' >&2; return 1 ;;
  esac

  local version="${HUSH_VERSION:-}" install_directory="${HUSH_INSTALL_DIR:-${HOME}/.local/bin}"
  local version_pattern='[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?'
  if [[ -n "${version}" && ! "${version}" =~ ^v${version_pattern}$ ]]; then
    echo 'HUSH_VERSION must be a release tag such as v0.0.2.' >&2
    return 2
  fi
  if [[ "${install_directory}" != /* ]]; then
    echo 'HUSH_INSTALL_DIR must be an absolute path.' >&2
    return 2
  fi
  local -a checksum_command
  if command -v sha256sum >/dev/null 2>&1; then
    checksum_command=(sha256sum)
  elif command -v shasum >/dev/null 2>&1; then
    checksum_command=(shasum -a 256)
  else
    echo 'SHA-256 verification requires sha256sum or shasum.' >&2
    return 1
  fi

  umask 077
  hush_install_staged_binary=''
  hush_install_temporary_directory="$(mktemp -d)"
  trap 'rm -rf -- "${hush_install_temporary_directory}"; if [[ -n "${hush_install_staged_binary}" ]]; then rm -f -- "${hush_install_staged_binary}"; fi' EXIT

  local release_base='https://github.com/txchen/hush/releases'
  local checksum_url="${release_base}/latest/download/SHA256SUMS"
  if [[ -n "${version}" ]]; then
    checksum_url="${release_base}/download/${version}/SHA256SUMS"
  fi
  local -a download=(curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3)
  "${download[@]}" "${checksum_url}" -o "${hush_install_temporary_directory}/SHA256SUMS"

  local digest filename extra archive='' expected_digest='' matched_version=''
  local archive_pattern="^hush_(${version_pattern})_${platform}_${architecture}\.tar\.gz$"
  while read -r digest filename extra || [[ -n "${digest}${filename}${extra}" ]]; do
    if [[ "${filename}" =~ ${archive_pattern} ]]; then
      matched_version="v${BASH_REMATCH[1]}"
      if [[ -n "${archive}" || ! "${digest}" =~ ^[0-9a-f]{64}$ || -n "${extra}" ]]; then
        echo 'Invalid or ambiguous release checksum entry.' >&2
        return 1
      fi
      if [[ -n "${version}" && "${version}" != "${matched_version}" ]]; then
        echo 'Release checksum version does not match HUSH_VERSION.' >&2
        return 1
      fi
      archive="${filename}"
      expected_digest="${digest}"
    fi
  done <"${hush_install_temporary_directory}/SHA256SUMS"
  if [[ -z "${archive}" ]]; then
    echo "Release has no checksummed archive for ${platform}/${architecture}." >&2
    return 1
  fi
  version="${matched_version}"
  echo "Downloading Hush ${version} for ${platform}/${architecture}..."
  # Resolve latest once, then pin the archive to the version in the manifest.
  "${download[@]}" "${release_base}/download/${version}/${archive}" -o "${hush_install_temporary_directory}/${archive}"
  local actual_digest
  actual_digest="$("${checksum_command[@]}" "${hush_install_temporary_directory}/${archive}")"
  actual_digest="${actual_digest%% *}"
  if [[ "${actual_digest}" != "${expected_digest}" ]]; then
    echo 'SHA-256 mismatch; installation cancelled.' >&2
    return 1
  fi

  tar -xzf "${hush_install_temporary_directory}/${archive}" -C "${hush_install_temporary_directory}" hush
  local extracted_binary="${hush_install_temporary_directory}/hush"
  if [[ ! -f "${extracted_binary}" || -L "${extracted_binary}" ]]; then
    echo 'Release archive does not contain a regular binary.' >&2
    return 1
  fi
  chmod 755 "${extracted_binary}"
  "${extracted_binary}" version

  mkdir -p "${install_directory}"
  if [[ -d "${install_directory}/hush" ]]; then
    echo 'Installation destination is a directory.' >&2
    return 1
  fi
  hush_install_staged_binary="$(mktemp "${install_directory}/.hush.XXXXXX")"
  install -m 755 "${extracted_binary}" "${hush_install_staged_binary}"
  mv -f "${hush_install_staged_binary}" "${install_directory}/hush"
  hush_install_staged_binary=''
  echo "Installed ${install_directory}/hush"
  case ":${PATH}:" in
    *":${install_directory}:"*) ;;
    *)
      echo 'Add this to your shell configuration, then run it in this terminal:'
      printf 'export PATH=%q:"$PATH"\n' "${install_directory}"
      ;;
  esac
}

main "$@"
