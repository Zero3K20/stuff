#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Generator
from zipfile import ZIP_DEFLATED, ZipFile


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a zip archive containing one or more directories."
    )
    parser.add_argument("output", help="Output zip file path")
    parser.add_argument("directories", nargs="+", help="Directories to include")
    return parser.parse_args()


def iter_directory_entries(directory: Path) -> Generator[tuple[Path, str, bool], None, None]:
    """Yield archive entries for a directory tree.

    Yields tuples of (source_path, arcname, is_empty_dir), where `arcname`
    is the path to store inside the zip archive.
    """
    parent = directory.parent

    for current_root, subdirs, files in os.walk(directory):
        current_path = Path(current_root)
        relative_dir = current_path.relative_to(parent).as_posix()

        if not subdirs and not files:
            yield current_path, f"{relative_dir}/", True

        for filename in files:
            file_path = current_path / filename
            arcname = file_path.relative_to(parent).as_posix()
            yield file_path, arcname, False


def main() -> int:
    """Create the archive from CLI arguments and return an exit status code."""
    args = parse_args()

    output_path = Path(args.output).resolve()
    input_directories = [Path(directory_path).resolve() for directory_path in args.directories]

    for directory in input_directories:
        if not directory.exists():
            raise FileNotFoundError(
                f"Directory does not exist: {directory}. "
                "Please verify the path and try again."
            )
        if not directory.is_dir():
            raise NotADirectoryError(
                f"Not a directory: {directory}. Please provide a directory path."
            )

    with ZipFile(output_path, "w", compression=ZIP_DEFLATED) as archive:
        for directory in input_directories:
            contains_output = output_path.is_relative_to(directory)
            for source_path, arcname, is_empty_dir in iter_directory_entries(directory):
                if contains_output and not is_empty_dir and source_path == output_path:
                    continue

                if is_empty_dir:
                    archive.writestr(arcname, "")
                else:
                    archive.write(source_path, arcname)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
