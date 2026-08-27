import argparse
from .app import build_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    svc = build_app()
    print(svc.login("cli"))


if __name__ == "__main__":
    main()