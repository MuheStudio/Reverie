import os
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_reverie_data_dir_can_be_overridden_for_installed_app(tmp_path: Path) -> None:
    data_dir = tmp_path / "installed-user-data" / "data"
    env = os.environ.copy()
    env["REVERIE_DATA_DIR"] = str(data_dir)

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from src.config.settings import DATA_DIR; print(DATA_DIR)",
        ],
        cwd=PROJECT_ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )

    assert Path(result.stdout.strip()) == data_dir.resolve()
