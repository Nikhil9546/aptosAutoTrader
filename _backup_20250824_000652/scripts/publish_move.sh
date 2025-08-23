#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../contracts/teletrade"
echo "Publishing Move package…"
echo "Make sure 'aptos' CLI is installed and 'teletrade-testnet' profile exists."
echo "Command:"
echo 'aptos move publish --profile teletrade-testnet --named-addresses teletrade=0x<YOUR_ACCOUNT_ADDRESS>'
