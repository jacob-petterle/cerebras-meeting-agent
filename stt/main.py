"""Entrypoint: load config, start the pipeline, shut down cleanly on Ctrl-C.

    uv run python main.py [path/to/config.toml]
"""

from __future__ import annotations

import logging
import signal
import sys

from triage_bot.config import DEFAULT_CONFIG_PATH, load_config
from triage_bot.orchestrator import Orchestrator


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )

    config_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CONFIG_PATH
    config = load_config(config_path)

    orchestrator = Orchestrator(config)

    def _handle_signal(signum, _frame):
        logging.getLogger("main").info("Received %s; stopping.", signal.Signals(signum).name)
        orchestrator.request_stop()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    orchestrator.run()


if __name__ == "__main__":
    main()
