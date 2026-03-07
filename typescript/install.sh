#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"

echo "Installing symphony from ${SCRIPT_DIR}..."

# Install dependencies and build
cd "$SCRIPT_DIR"
npm install
npm run build

# Ensure bin directory exists
mkdir -p "$BIN_DIR"

# Create symlink
ln -sf "${SCRIPT_DIR}/dist/index.js" "${BIN_DIR}/symphony"

# Check if ~/.local/bin is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  SHELL_NAME="$(basename "$SHELL")"
  case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc" ;;
    bash) RC_FILE="$HOME/.bashrc" ;;
    *)    RC_FILE="$HOME/.profile" ;;
  esac

  EXPORT_LINE="export PATH=\"${BIN_DIR}:\$PATH\""
  if ! grep -qF "$BIN_DIR" "$RC_FILE" 2>/dev/null; then
    echo "" >> "$RC_FILE"
    echo "# Added by symphony installer" >> "$RC_FILE"
    echo "$EXPORT_LINE" >> "$RC_FILE"
    echo "Added ${BIN_DIR} to PATH in ${RC_FILE}"
    echo "Run 'source ${RC_FILE}' or open a new terminal to use symphony."
  fi
fi

echo "Installed successfully. Run 'symphony --help' to get started."
