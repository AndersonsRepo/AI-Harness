#!/bin/bash
# Extracts a verified, recurring learning into a new skill.
# Usage: ./scripts/extract-skill.sh <skill-name>
#
# This script scaffolds a new skill directory with Skills 2.0 frontmatter.
# The agent fills in the SKILL.md content.

SKILL_NAME="$1"

if [ -z "$SKILL_NAME" ]; then
  echo "Usage: extract-skill.sh <skill-name>"
  echo "Example: extract-skill.sh fix-prisma-migrations"
  exit 1
fi

SKILL_DIR=".claude/skills/$SKILL_NAME"

if [ -d "$SKILL_DIR" ]; then
  echo "Skill '$SKILL_NAME' already exists at $SKILL_DIR"
  exit 1
fi

mkdir -p "$SKILL_DIR/scripts" "$SKILL_DIR/templates"
touch "$SKILL_DIR/scripts/.gitkeep" "$SKILL_DIR/templates/.gitkeep"

cat > "$SKILL_DIR/SKILL.md" << 'TEMPLATE'
---
name: SKILL_NAME_PLACEHOLDER
description: TODO - describe what this skill does
user-invocable: true
disable-model-invocation: true
argument-hint: "<args>"
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Edit
# context: fork          # Uncomment for isolated execution
# agent: researcher      # Uncomment to use a specific agent type
# model: sonnet          # Uncomment for cheaper model on formulaic tasks
---

# TODO: Skill Instructions

<!-- This skill was auto-extracted from a recurring learning. -->
<!-- Fill in the instructions based on the learning that triggered extraction. -->

## When to Use
<!-- Describe the situation where this skill applies -->

## Steps
<!-- Step-by-step instructions -->

## Extracted From
<!-- Reference the learning entry: LRN-XXXXXXXX-XXX -->
TEMPLATE

# Replace placeholder with actual name
sed -i '' "s/SKILL_NAME_PLACEHOLDER/$SKILL_NAME/" "$SKILL_DIR/SKILL.md"

echo "Skill scaffolded at $SKILL_DIR/SKILL.md (v2 template) — fill in the instructions."
