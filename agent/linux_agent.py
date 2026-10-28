"""Linux entrypoint. Run: python3 agent/linux_agent.py; see README for systemd."""
if __package__:
    from .telemetry import main
else:
    from telemetry import main


if __name__ == '__main__':
    raise SystemExit(main())
