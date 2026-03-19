"""LLM provider abstraction for heartbeat scripts.

Phase L1 of cross-platform + LLM-agnostic plan.
Provides a unified interface so heartbeat scripts can call any LLM
without changing their core logic. All changes are additive —
existing scripts continue working with Claude CLI until they opt in.

Usage (drop-in replacement for subprocess Claude calls):

    from lib.llm_provider import get_provider

    llm = get_provider()                       # default: claude-cli
    text = llm.complete("Summarize this: ...")  # returns plain text
    text = llm.complete(prompt, model="sonnet", timeout=120)

Environment variables:
    LLM_PROVIDER        — "claude-cli" (default) or "openai"
    OPENAI_API_KEY       — required for openai provider
    OPENAI_MODEL         — default model for openai (default: gpt-4o)
    OPENAI_BASE_URL      — custom base URL (for Azure, local, etc.)
    CLAUDE_CLI_PATH      — path to claude binary (default: ~/.local/bin/claude)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class LLMResponse:
    """Structured response from any LLM provider."""
    text: str
    model: str
    provider: str
    raw: object = field(default=None, repr=False)


class LLMProvider(ABC):
    """Base class for LLM providers.

    Subclasses implement complete() with provider-specific logic.
    The interface is intentionally minimal — prompt in, text out.
    Provider-specific features (tools, sessions) are passed as kwargs
    and silently ignored by providers that don't support them.
    """

    name: str  # e.g. "claude-cli", "openai"

    @abstractmethod
    def complete(
        self,
        prompt: str,
        *,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        timeout: int = 120,
        max_turns: Optional[int] = None,
        allowed_tools: Optional[list[str]] = None,
        cwd: Optional[str] = None,
    ) -> LLMResponse:
        """Send a prompt and get a text response.

        Args:
            prompt: The user prompt.
            model: Model name/alias. Each provider maps these to actual model IDs.
            system_prompt: Optional system-level instruction.
            timeout: Max seconds to wait.
            max_turns: Max agentic turns (Claude-specific, ignored by others).
            allowed_tools: Tool whitelist (Claude-specific, ignored by others).
            cwd: Working directory for subprocess-based providers.

        Returns:
            LLMResponse with the text result.

        Raises:
            LLMError: On any provider failure (timeout, auth, API error).
        """
        ...


class LLMError(Exception):
    """Raised when an LLM call fails."""

    def __init__(self, message: str, *, provider: str = "", returncode: int = 0):
        super().__init__(message)
        self.provider = provider
        self.returncode = returncode


# ─── Claude CLI Provider ──────────────────────────────────────────────


# Model aliases → Claude CLI model flags
_CLAUDE_MODEL_MAP = {
    "sonnet": "sonnet",
    "opus": "opus",
    "haiku": "haiku",
    "claude-sonnet": "sonnet",
    "claude-opus": "opus",
    "claude-haiku": "haiku",
}


class ClaudeCLIProvider(LLMProvider):
    """Calls Claude via the local CLI binary (subprocess).

    This is the existing pattern extracted into a clean interface.
    Handles env sanitization, JSON output parsing, and error mapping.
    """

    name = "claude-cli"

    def __init__(self, cli_path: Optional[str] = None):
        self.cli_path = cli_path or os.environ.get(
            "CLAUDE_CLI_PATH",
            os.path.join(os.environ.get("HOME", ""), ".local", "bin", "claude"),
        )

    def _build_env(self) -> dict[str, str]:
        """Build a clean env with CLAUDE* vars stripped."""
        return {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}

    def _resolve_model(self, model: Optional[str]) -> str:
        if model is None:
            return "sonnet"
        return _CLAUDE_MODEL_MAP.get(model, model)

    def complete(
        self,
        prompt: str,
        *,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        timeout: int = 120,
        max_turns: Optional[int] = None,
        allowed_tools: Optional[list[str]] = None,
        cwd: Optional[str] = None,
    ) -> LLMResponse:
        resolved_model = self._resolve_model(model)

        cmd = [
            self.cli_path, "-p",
            "--output-format", "json",
            "--model", resolved_model,
            "--dangerously-skip-permissions",
        ]

        if system_prompt:
            cmd.extend(["--append-system-prompt", system_prompt])

        if max_turns is not None:
            cmd.extend(["--max-turns", str(max_turns)])

        if allowed_tools:
            cmd.extend(["--allowedTools"] + allowed_tools)

        # -- separator before prompt (Commander.js variadic flag safety)
        cmd.extend(["--", prompt])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=self._build_env(),
                stdin=subprocess.DEVNULL,
                cwd=cwd,
            )
        except subprocess.TimeoutExpired:
            raise LLMError(
                f"Claude CLI timed out after {timeout}s",
                provider=self.name,
            )
        except FileNotFoundError:
            raise LLMError(
                f"Claude CLI not found at {self.cli_path}",
                provider=self.name,
            )

        if result.returncode != 0:
            raise LLMError(
                f"Claude CLI exited {result.returncode}: {result.stderr[:300]}",
                provider=self.name,
                returncode=result.returncode,
            )

        text = self._parse_output(result.stdout)
        return LLMResponse(
            text=text,
            model=resolved_model,
            provider=self.name,
            raw=result,
        )

    @staticmethod
    def _parse_output(stdout: str) -> str:
        """Unwrap Claude's JSON output format.

        Claude CLI with --output-format json returns:
            {"type": "result", "result": "...actual text..."}
        Some scripts also see markdown-fenced JSON. Handle both.
        """
        stdout = stdout.strip()
        if not stdout:
            return ""

        # Try JSON parse first
        try:
            data = json.loads(stdout)
            if isinstance(data, dict):
                return data.get("result", stdout)
            return stdout
        except (json.JSONDecodeError, TypeError):
            pass

        # Strip markdown code fences and retry
        stripped = re.sub(r"^```(?:json)?\s*\n?", "", stdout)
        stripped = re.sub(r"\n?```\s*$", "", stripped)
        if stripped != stdout:
            try:
                data = json.loads(stripped)
                if isinstance(data, dict):
                    return data.get("result", stripped)
                return stripped
            except (json.JSONDecodeError, TypeError):
                pass

        return stdout


# ─── OpenAI Provider ──────────────────────────────────────────────────


# Model aliases → OpenAI model IDs
_OPENAI_MODEL_MAP = {
    "sonnet": "gpt-4o",        # comparable tier
    "opus": "gpt-4o",          # best available
    "haiku": "gpt-4o-mini",    # cheap/fast tier
    "gpt-4o": "gpt-4o",
    "gpt-4o-mini": "gpt-4o-mini",
    "gpt-4-turbo": "gpt-4-turbo",
    "gpt-3.5-turbo": "gpt-3.5-turbo",
    "o1": "o1",
    "o1-mini": "o1-mini",
    "o3-mini": "o3-mini",
}


class OpenAIProvider(LLMProvider):
    """Calls OpenAI-compatible APIs via urllib (no extra dependencies).

    Works with OpenAI, Azure OpenAI, and any compatible endpoint
    (Ollama, vLLM, LiteLLM, etc.) via OPENAI_BASE_URL.
    """

    name = "openai"

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        default_model: Optional[str] = None,
    ):
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self.base_url = (
            base_url
            or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
        ).rstrip("/")
        self.default_model = default_model or os.environ.get("OPENAI_MODEL", "gpt-4o")

    def _resolve_model(self, model: Optional[str]) -> str:
        if model is None:
            return self.default_model
        return _OPENAI_MODEL_MAP.get(model, model)

    def complete(
        self,
        prompt: str,
        *,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        timeout: int = 120,
        max_turns: Optional[int] = None,
        allowed_tools: Optional[list[str]] = None,
        cwd: Optional[str] = None,
    ) -> LLMResponse:
        if not self.api_key:
            raise LLMError(
                "OPENAI_API_KEY not set — required for openai provider",
                provider=self.name,
            )

        resolved_model = self._resolve_model(model)

        # max_turns, allowed_tools, cwd are Claude-specific — silently ignored
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        body = json.dumps({
            "model": resolved_model,
            "messages": messages,
        }).encode()

        url = f"{self.base_url}/chat/completions"
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            error_body = ""
            try:
                error_body = e.read().decode()[:300]
            except Exception:
                pass
            raise LLMError(
                f"OpenAI API error {e.code}: {error_body}",
                provider=self.name,
                returncode=e.code,
            )
        except urllib.error.URLError as e:
            raise LLMError(
                f"OpenAI API connection error: {e.reason}",
                provider=self.name,
            )
        except TimeoutError:
            raise LLMError(
                f"OpenAI API timed out after {timeout}s",
                provider=self.name,
            )

        # Extract text from OpenAI chat completion response
        try:
            text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError):
            raise LLMError(
                f"Unexpected OpenAI response structure: {json.dumps(data)[:300]}",
                provider=self.name,
            )

        return LLMResponse(
            text=text or "",
            model=data.get("model", resolved_model),
            provider=self.name,
            raw=data,
        )


# ─── Provider Factory ─────────────────────────────────────────────────


_PROVIDERS = {
    "claude-cli": ClaudeCLIProvider,
    "openai": OpenAIProvider,
}


def get_provider(name: Optional[str] = None, **kwargs) -> LLMProvider:
    """Get an LLM provider instance.

    Args:
        name: Provider name ("claude-cli", "openai").
              Defaults to LLM_PROVIDER env var, then "claude-cli".
        **kwargs: Passed to provider constructor.

    Returns:
        An LLMProvider instance ready to use.

    Raises:
        LLMError: If the provider name is unknown.
    """
    name = name or os.environ.get("LLM_PROVIDER", "claude-cli")
    cls = _PROVIDERS.get(name)
    if cls is None:
        available = ", ".join(sorted(_PROVIDERS.keys()))
        raise LLMError(
            f"Unknown LLM provider '{name}'. Available: {available}",
            provider=name,
        )
    return cls(**kwargs)


def get_default_model(fallback: str = "sonnet") -> str:
    """Read the default model from LLM_MODEL env var.

    Scripts use this to respect per-task model routing from heartbeat config.
    """
    return os.environ.get("LLM_MODEL", fallback)
