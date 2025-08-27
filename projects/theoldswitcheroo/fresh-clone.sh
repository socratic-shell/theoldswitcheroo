#!/bin/bash

# Fresh clone script for dialectic project
# Usage: ./fresh-clone.sh <target_directory>

TARGET_DIR="$1"

if [ -z "$TARGET_DIR" ]; then
    echo "Usage: $0 <target_directory>"
    exit 1
fi

# Remove existing directory if it exists
if [ -d "$TARGET_DIR" ]; then
    echo "Removing existing directory: $TARGET_DIR"
    rm -rf "$TARGET_DIR"
fi

# Clone the dialectic repository
echo "Cloning socratic-shell/dialectic to $TARGET_DIR"
git clone https://github.com/socratic-shell/dialectic.git "$TARGET_DIR"

echo "Clone completed successfully"
