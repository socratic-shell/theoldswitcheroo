#!/bin/bash

# Test script to verify bin directory setup
echo "Testing bin directory setup..."

BASE_DIR="~/.socratic-shell/theoldswitcheroo"
BIN_DIR="$BASE_DIR/bin"

# Simulate the PATH setup that VSCode server does
export PATH="$BIN_DIR:$PATH"

echo "PATH now includes: $BIN_DIR"
echo "Current PATH: $PATH"

# Test if theoldswitcheroo command would be found
if command -v theoldswitcheroo >/dev/null 2>&1; then
    echo "✓ theoldswitcheroo command found in PATH"
    echo "Location: $(which theoldswitcheroo)"
else
    echo "✗ theoldswitcheroo command not found in PATH"
    echo "Make sure the CLI tool is deployed to $BIN_DIR/theoldswitcheroo"
fi

# Show what's in the bin directory (if it exists)
if [ -d "$BIN_DIR" ]; then
    echo "Contents of $BIN_DIR:"
    ls -la "$BIN_DIR"
else
    echo "Bin directory $BIN_DIR does not exist yet"
fi
