#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "${OPENCODE_CREDENTIAL_TOKEN}" ;;
esac