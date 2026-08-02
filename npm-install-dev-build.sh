#!/bin/sh

set -eu

repository_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_directory=$(mktemp -d "${TMPDIR:-/tmp}/homebridge-ecoflow-wave3.XXXXXX")

cleanup() {
  rm -rf -- "$package_directory"
}
trap cleanup EXIT HUP INT TERM

cd "$repository_directory"

printf 'Installing dependencies...\n'
npm install

printf 'Verifying and building the plugin...\n'
npm run verify

printf 'Packing the plugin...\n'
package_name=$(npm pack --silent --pack-destination "$package_directory")

printf 'Installing %s globally...\n' "$package_name"
npm install -g "$package_directory/$package_name"

printf 'Installed the EcoFlow WAVE 3 development build.\n'
