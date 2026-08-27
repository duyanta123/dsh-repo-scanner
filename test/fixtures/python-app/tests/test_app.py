from myapp.app import build_app


def test_build():
    assert build_app() is not None