"""Windows entrypoint. Run: python agent/agent.py (SERVER and INTERVAL env vars)."""
if __package__:
    from .telemetry import main, probe_gpu
else:
    from telemetry import main, probe_gpu


def gpu_pct():
    """Compatibility helper: unavailable GPUs return None, never fabricated zero."""
    return probe_gpu()[0]


if __name__ == '__main__':
    raise SystemExit(main())
