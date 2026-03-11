---
name: vercel
description: Monitor and manage Vercel deployments for Hey Lexxi.
user-invocable: true
argument-hint: "<status|deploy|logs|rollback>"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
model: sonnet
---

# Vercel Deployment Manager

Hey Lexxi project path: `$HOME/Desktop/Hey-Lexxi-prod`

Current deployments:
!command vercel list --cwd $HOME/Desktop/Hey-Lexxi-prod 2>/dev/null | head -10

## Commands

### `status` — Show recent deployments
```bash
vercel list --cwd $HOME/Desktop/Hey-Lexxi-prod
```
Report the current production URL, latest deployment status, and any recent failures.

### `deploy` — Deploy to production
**REQUIRES USER CONFIRMATION before executing.**
```bash
vercel --prod --cwd $HOME/Desktop/Hey-Lexxi-prod
```
Show the user what will be deployed (current git status, branch, recent commits) and ask for explicit confirmation before running.

### `logs <url>` — View deployment logs
```bash
vercel logs <deployment-url> --cwd $HOME/Desktop/Hey-Lexxi-prod
```
If no URL provided, get the latest deployment URL from `vercel list` first.

### `rollback` — Rollback to previous deployment
**REQUIRES USER CONFIRMATION before executing.**
```bash
vercel rollback --cwd $HOME/Desktop/Hey-Lexxi-prod
```
Show the current and previous deployment before asking for confirmation.

## Notes

- All commands use `--cwd $HOME/Desktop/Hey-Lexxi-prod`
- Deploy and rollback are destructive operations — always confirm first
- The deploy-monitor heartbeat task checks deployment status every 30 minutes
