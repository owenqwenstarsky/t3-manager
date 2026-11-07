#!/bin/bash
# Go CLIs built with the default Go into /opt/t3m/bin.
. "$(dirname "$0")/common.sh"
mkdir -p /opt/t3m/bin
export GOBIN=/opt/t3m/bin GOPATH=/tmp/gopath GOCACHE=/tmp/gocache GOFLAGS=-modcacherw
while read -r pkg; do
  log "go install $pkg"
  go install "$pkg"
done < <(list "$T3M_BUILD/go-tools.txt")
rm -rf /tmp/gopath /tmp/gocache
