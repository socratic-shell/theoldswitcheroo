#!/bin/bash

# Build the VSCode extension to .vsix file
# Requires: npm install -g vsce

echo "Building theoldswitcheroo extension..."

# Check if vsce is installed
if ! command -v vsce &> /dev/null; then
    echo "vsce not found. Installing..."
    npm install -g vsce
fi

# Package the extension
vsce package

echo "Extension built successfully!"
echo "Output: theoldswitcheroo-extension-0.0.1.vsix"
