#!/bin/bash
# Validate agent config files for Claude and VS Code

set -e

CLAUDE_CONFIG="tools/mcp/claude_desktop_config.example.json"
VS_CODE_TASKS=".vscode/tasks.json"
VS_CODE_LAUNCH=".vscode/launch.json"

if [ ! -f "$CLAUDE_CONFIG" ]; then
  echo "Missing Claude config: $CLAUDE_CONFIG"; exit 1
fi
jq . "$CLAUDE_CONFIG" > /dev/null || { echo "Invalid JSON in Claude config"; exit 1; }

if [ ! -f "$VS_CODE_TASKS" ]; then
  echo "Missing VS Code tasks config: $VS_CODE_TASKS"; exit 1
fi
jq . "$VS_CODE_TASKS" > /dev/null || { echo "Invalid JSON in VS Code tasks config"; exit 1; }

if [ ! -f "$VS_CODE_LAUNCH" ]; then
  echo "Missing VS Code launch config: $VS_CODE_LAUNCH"; exit 1
fi
jq . "$VS_CODE_LAUNCH" > /dev/null || { echo "Invalid JSON in VS Code launch config"; exit 1; }

echo "All agent config files are valid."
